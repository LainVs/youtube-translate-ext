/**
 * main-fetch.js — 在「页面主世界」里发字幕请求
 *
 * 运行位置：manifest.json 中 world: "MAIN"，run_at: "document_start"。
 * 必须跑在主世界：从 service worker 或隔离世界发出时请求带
 * Origin: chrome-extension://…，YouTube 直接回 HTTP 403 + “Sorry…” 反滥用页。
 *
 * ─────────────────────────────────────────────────────────────
 * 三条取字幕的路径（按可靠性排序）
 * ─────────────────────────────────────────────────────────────
 * ① HOOK 播放器自己的字幕请求（最稳，优先用）
 *    在 document_start 就劫持 XMLHttpRequest / fetch，把播放器自己发的
 *    /api/timedtext 请求的响应正文缓存下来。
 *    这条路用的是**页面自己的合法身份**（真实 cookies + PoToken），
 *    永远不会吃 403，也不需要伪装任何客户端。
 *    关键：PoToken URL 是**一次性**的 —— 播放器先取走了数据，
 *    我们再拿同一个 URL 去 fetch 会得到 HTTP 200 + **空 body**。
 *    所以只能「截获」，不能「重放」。
 *
 * ② ANDROID 客户端 innertube（拿轨道列表用）
 *    ANDROID 轨道的 baseUrl 是 ip=0.0.0.0 签名的，可重复取，实测 2 次都拿到 46KB。
 *    但登录状态下容易撞 403（登录 cookie + Android UA 被判为机器人），
 *    所以这里做了多客户端回退 + 退避重试。
 *
 * ③ 播放器轨道列表兜底
 *    player.getOption("captions","tracklist") 是纯本地读取，零网络请求。
 *    拿到轨道后正文只能走①。
 *
 * 通信：与 content.js 用 window.postMessage 约定
 *   请求 { __ytbs_main__: true, from: "content", id, type, ... }
 *   响应 { __ytbs_main__: true, id, result }
 */

(() => {
  const TAG = "__ytbs_main__";
  const PUBLIC_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

  /** 截获到的字幕正文：key = videoId + "|" + lang */
  const cueCache = new Map();
  /** 正在等待的请求：key -> [resolve] */
  const cueWaiters = new Map();
  /** 轨道短缓存：videoId -> {at, res} */
  const trackCache = new Map();
  /** 客户端冷却：label -> {at}，刚被 403/429 打过的先跳过 */
  const clientCooldown = new Map();

  function post(obj) {
    window.postMessage(Object.assign({ [TAG]: true }, obj), "*");
  }

  /* ==================================================================
   * ① HOOK：截获播放器自己的字幕请求
   * ================================================================== */

  function cacheKey(videoId, lang, kind) {
    return videoId + "|" + (lang || "") + "|" + (kind || "manual");
  }

  function rememberCue(videoId, lang, kind, body) {
    if (!body || !body.length) return;
    const keys = [cacheKey(videoId, lang, kind), cacheKey(videoId, lang, null), cacheKey(videoId, null, kind)];
    keys.forEach((k) => cueCache.set(k, body));
    const ws = cueWaiters.get(keys[0]) || cueWaiters.get(cacheKey(videoId, null, kind));
    if (ws && ws.length) ws.splice(0).forEach((fn) => fn(body));
  }

  /** 从 timedtext URL 里抠出 videoId / lang / kind */
  function parseTimedtext(url) {
    try {
      const u = new URL(url);
      if (!u.pathname.includes("/api/timedtext")) return null;
      return {
        videoId: u.searchParams.get("v") || "",
        lang: u.searchParams.get("lang") || "",
        kind: (u.searchParams.get("kind") || "") + (u.searchParams.get("tlang") ? "|t" : ""),
      };
    } catch (e) {
      return null;
    }
  }

  function onCueBody(meta, body) {
    if (!meta || !body) return;
    const clean = body.replace(/^\s*\)\]\}'\s*/, "");
    // 空 body 是 PoToken 被用过的典型症状，直接丢弃，不要污染缓存
    if (!clean || clean.length < 2) return;
    rememberCue(meta.videoId, meta.lang, meta.kind, clean);
  }

  function installHooks() {
    // --- XMLHttpRequest ---
    try {
      const proto = XMLHttpRequest.prototype;
      const oOpen = proto.open;
      const oSend = proto.send;
      proto.open = function (method, url) {
        try {
          this.__ytbsMeta = parseTimedtext(String(url));
        } catch (e) {
          this.__ytbsMeta = null;
        }
        return oOpen.apply(this, arguments);
      };
      proto.send = function () {
        const meta = this.__ytbsMeta;
        if (meta) {
          const self = this;
          this.addEventListener("load", function () {
            let body = "";
            try {
              body = self.responseText || "";
            } catch (e) {
              body = "";
            }
            onCueBody(meta, body);
          });
        }
        return oSend.apply(this, arguments);
      };
    } catch (e) {
      /* ignore */
    }

    // --- fetch ---
    try {
      const of = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const meta = parseTimedtext(url);
        const p = of.apply(this, arguments);
        if (meta) {
          p
            .then((resp) =>
              resp
                .clone()
                .text()
                .then((t) => onCueBody(meta, t))
                .catch(() => {})
            )
            .catch(() => {});
        }
        return p;
      };
    } catch (e) {
      /* ignore */
    }
  }

  function getPlayer() {
    return (
      document.getElementById("movie_player") ||
      document.querySelector(".html5-video-player") ||
      null
    );
  }

  /** 读取播放器本地轨道列表（零网络） */
  function playerTracklist() {
    const p = getPlayer();
    if (!p) return [];
    let tl = [];
    try {
      tl = p.getOption("captions", "tracklist") || [];
    } catch (e) {
      tl = [];
    }
    return tl.map((t) => ({
      languageCode: t.languageCode || "",
      name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.languageCode || "",
      vssId: t.vssId || "",
      isTranslatable: !!t.isTranslatable,
      // 播放器轨道的 baseUrl 是一次性的 PoToken URL，这里只当元数据用
      __fromPlayer: true,
    }));
  }

  /**
   * 逼播放器自己去拉一次字幕，然后把截获到的正文交回去。
   * 这是唯一能在 403 环境下仍然拿到字幕的路径。
   */
  async function getCuesViaPlayer(videoId, langCode, timeoutMs) {
    // 1) 已经有缓存就直接用（播放器可能早就拉过了）
    const hit =
      cueCache.get(cacheKey(videoId, langCode, "")) ||
      cueCache.get(cacheKey(videoId, langCode, "asr")) ||
      cueCache.get(cacheKey(videoId, langCode, null)) ||
      cueCache.get(cacheKey(videoId, null, "")) ||
      cueCache.get(cacheKey(videoId, null, "asr"));
    if (hit) return { body: hit, via: "hook-cache" };

    const player = getPlayer();
    if (!player) return { error: "播放器未就绪" };

    const tl = playerTracklist();
    if (!tl.length) return { error: "播放器轨道列表为空" };

    const pick =
      tl.find((t) => t.languageCode === langCode) ||
      tl.find((t) => t.languageCode && t.languageCode.split("-")[0] === (langCode || "").split("-")[0]) ||
      tl[0];
    if (!pick) return { error: "找不到可用字幕轨" };

    // 2) 等一个可能已经在路上的响应
    const waiterKey = cacheKey(videoId, pick.languageCode, "");
    const body = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const arr = cueWaiters.get(waiterKey) || [];
      arr.push(finish);
      cueWaiters.set(waiterKey, arr);

      // 3) 强制播放器重新拉一次（setOption 会触发 timedtext 请求）
      try {
        const rawTl = player.getOption("captions", "tracklist") || [];
        const raw = rawTl.find((t) => t.languageCode === pick.languageCode) || rawTl[0];
        player.setOption("captions", "track", raw);
      } catch (e) {
        try {
          const btn = document.querySelector(".ytp-subtitles-button");
          if (btn && btn.getAttribute("aria-pressed") !== "true") btn.click();
        } catch (e2) {
          /* ignore */
        }
      }

      setTimeout(() => finish(null), timeoutMs || 8000);
    });

    if (!body) {
      return { error: "等不到播放器的字幕请求（可能被当前视频无字幕 / PoToken 未能触发）" };
    }
    return { body: body, via: "hook-live" };
  }

  /* ==================================================================
   * ② innertube：拿字幕轨道
   * ================================================================== */

  function getKey() {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === "function") {
        const k = window.ytcfg.get("INNERTUBE_API_KEY");
        if (k) return k;
      }
    } catch (e) {
      /* ignore */
    }
    return PUBLIC_KEY;
  }

  function getPageClientVersion() {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === "function") {
        const v = window.ytcfg.get("INNERTUBE_CLIENT_VERSION");
        if (v) return v;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function getVisitorData() {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === "function") {
        const v = window.ytcfg.get("VISITOR_DATA");
        if (v) {
          try {
            return decodeURIComponent(v);
          } catch (e) {
            return v;
          }
        }
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  /** 客户端候选链：ANDROID 的 baseUrl 可重复取，所以放第一位 */
  function buildClients() {
    const list = [
      {
        label: "ANDROID",
        client: {
          clientName: "ANDROID",
          clientVersion: "20.10.38",
          androidSdkVersion: 30,
          hl: "en",
          gl: "US",
          userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
        },
        headerName: "3",
      },
      {
        label: "ANDROID_VR",
        client: {
          clientName: "ANDROID_VR",
          clientVersion: "1.60.19",
          deviceMake: "Oculus",
          deviceModel: "Quest 3",
          androidSdkVersion: 32,
          hl: "en",
          gl: "US",
          osName: "Android",
          osVersion: "12",
        },
        headerName: "28",
      },
      {
        label: "IOS",
        client: {
          clientName: "IOS",
          clientVersion: "20.10.4",
          deviceMake: "Apple",
          deviceModel: "iPhone16,2",
          hl: "en",
          gl: "US",
          osName: "iOS",
          osVersion: "18.3.1.22D72",
        },
        headerName: "5",
      },
    ];

    // WEB 客户端：完全照抄页面自己的身份，最不容易被风控
    const webVer = getPageClientVersion();
    if (webVer) {
      const vd = getVisitorData();
      const c = {
        clientName: "WEB",
        clientVersion: webVer,
        hl: "en",
        gl: "US",
        userAgent: navigator.userAgent,
      };
      if (vd) c.visitorData = vd;
      list.push({ label: "WEB(页面身份)", client: c, headerName: "1", extraHeaders: vd ? { "X-Goog-Visitor-Id": vd } : {} });
    }
    return list;
  }

  async function innertubePlayer(videoId, cand) {
    const headers = {
      "content-type": "application/json",
      "X-YouTube-Client-Name": cand.headerName,
      "X-YouTube-Client-Version": cand.client.clientVersion,
      "X-Goog-Api-Format-Version": "2",
    };
    if (cand.extraHeaders) Object.assign(headers, cand.extraHeaders);

    const resp = await fetch(
      "https://www.youtube.com/youtubei/v1/player?key=" + encodeURIComponent(getKey()) + "&prettyPrint=false",
      {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          context: { client: cand.client },
          videoId: videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      }
    );

    const txt = await resp.text();
    if (!resp.ok) {
      const isAbuse = /<title>Sorry/i.test(txt) || resp.status === 403;
      return {
        ok: false,
        status: resp.status,
        error: "innertube HTTP " + resp.status + (isAbuse ? "（Google 反滥用页：登录 cookie + 客户端伪装被判机器人）" : " " + txt.replace(/\s+/g, " ").slice(0, 90)),
      };
    }
    let j;
    try {
      j = JSON.parse(txt);
    } catch (e) {
      return { ok: false, status: resp.status, error: "innertube 返回非 JSON" };
    }
    const tracks =
      (j.captions &&
        j.captions.playerCaptionsTracklistRenderer &&
        j.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      [];
    return { ok: true, tracks: tracks, status: resp.status };
  }

  /** 逐个客户端试；403/429 属于「换个身份可能就行」，直接换下一个 */
  async function getTracksViaInnertube(videoId) {
    // 短缓存：同一视频 3 分钟内不重复打 innertube（避免突发频率风控）
    const hit = trackCache.get(videoId);
    if (hit && Date.now() - hit.at < 3 * 60 * 1000) {
      return Object.assign({}, hit.res, { cached: true });
    }

    const tried = [];
    for (const cand of buildClients()) {
      // 刚被 403/429 打到过的客户端先冷却 90 秒
      const cd = clientCooldown.get(cand.label);
      if (cd && Date.now() - cd.at < 90 * 1000) {
        tried.push(cand.label + ": 冷却中");
        continue;
      }
      try {
        const r = await innertubePlayer(videoId, cand);
        if (r.ok) {
          if (r.tracks && r.tracks.length) {
            const res = { ok: true, source: "innertube:" + cand.label, tracks: r.tracks, tried: tried };
            trackCache.set(videoId, { at: Date.now(), res: res });
            clientCooldown.delete(cand.label);
            return res;
          }
          tried.push(cand.label + ": 0 条轨道");
        } else {
          tried.push(cand.label + ": " + r.error);
          if (/HTTP 403|HTTP 429/.test(r.error)) {
            clientCooldown.set(cand.label, { at: Date.now() });
          }
        }
      } catch (e) {
        tried.push(cand.label + ": 异常 " + String((e && e.message) || e));
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const res = { ok: false, error: tried.join(" | ") || "没有可用客户端", tried: tried };
    trackCache.set(videoId, { at: Date.now(), res: res });
    return res;
  }

  /* ==================================================================
   * 消息分发
   * ================================================================== */

  async function handle(d) {
    if (d.type === "GET_TRACKS") {
      // 1) innertube 拿完整轨道（带可重复取的 baseUrl）
      const r = await getTracksViaInnertube(d.videoId);
      if (r.ok) {
        return { source: r.source, tracks: r.tracks, tried: r.tried, via: "innertube" };
      }
      // 2) 兜底：直接读播放器本地轨道列表（零网络）
      const tl = playerTracklist();
      if (tl.length) {
        return { source: "player-tracklist", tracks: tl, via: "player", innertubeError: r.error };
      }
      // 3) 最后：页面 player response（只有元数据，正文走 hook）
      try {
        const pr = window.ytInitialPlayerResponse;
        const tr =
          pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
        if (tr && tr.length) {
          return { source: "page-playerResponse", tracks: tr, via: "hook-only", innertubeError: r.error };
        }
      } catch (e) {
        /* ignore */
      }
      return { error: r.error, tracks: [], tried: r.tried };
    }

    if (d.type === "GET_CUES") {
      let url;
      try {
        const u = new URL(d.baseUrl);
        u.searchParams.set("fmt", "json3");
        url = u.toString();
      } catch (e) {
        url = d.baseUrl + (d.baseUrl.includes("?") ? "&" : "?") + "fmt=json3";
      }
      const resp = await fetch(url, { credentials: "include" });
      const txt = await resp.text();
      if (!resp.ok) return { error: "字幕正文 HTTP " + resp.status };
      if (!txt || txt.length < 2) {
        return { error: "字幕正文为空（PoToken URL 一次性，重放无效）" };
      }
      return { body: txt };
    }

    // ★ 新增：走 hook，复用播放器自己那一次请求
    if (d.type === "GET_CUES_VIA_PLAYER") {
      const r = await getCuesViaPlayer(d.videoId, d.langCode || "", d.timeoutMs);
      if (r.error) return { error: r.error };
      return { body: r.body, via: r.via };
    }

    return { error: "未知请求: " + d.type };
  }

  installHooks();

  window.addEventListener("message", async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[TAG] !== true || d.from !== "content" || !d.id) return;
    let result;
    try {
      result = await handle(d);
    } catch (err) {
      result = { error: String((err && err.message) || err) };
    }
    post({ id: d.id, from: "main", result: result });
  });

  // 供 content.js 探测主世界是否注入成功
  window.postMessage({ [TAG]: true, from: "main", ready: true }, "*");
})();