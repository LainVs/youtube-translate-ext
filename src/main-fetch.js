/**
 * main-fetch.js — 在「页面主世界」里发字幕请求
 *
 * 为什么必须跑在主世界：
 *   - 从 service worker 或隔离世界的 content script 发 innertube 请求，
 *     请求带 Origin: chrome-extension://...，YouTube 会直接返回
 *     HTTP 403 + Google 的 “Sorry...” 反滥用页面。
 *   - 跑在页面主世界里就是普通同源请求（和页面自己发的一模一样），实测可用。
 *
 * 通信：与 content.js 用 window.postMessage 约定
 *   请求 { __ytbs_main__: true, from: "content", id, type, ... }
 *   响应 { __ytbs_main__: true, id, result }
 *
 * 注册在 manifest.json 中 world: "MAIN"，run_at: "document_start"。
 */

(() => {
  const TAG = "__ytbs_main__";
  const VER = "20.10.38";
  const PUBLIC_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

  function post(obj) {
    window.postMessage(Object.assign({ [TAG]: true }, obj), "*");
  }

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

  /** 用 ANDROID InnerTube 客户端取字幕轨道（该轨道的 baseUrl 不带 PoToken 风控） */
  async function getTracks(videoId) {
    const body = {
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: VER,
          androidSdkVersion: 30,
          hl: "en",
          gl: "US",
          userAgent: "com.google.android.youtube/" + VER + " (Linux; U; Android 11) gzip",
        },
      },
      videoId: videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    };

    const resp = await fetch(
      "https://www.youtube.com/youtubei/v1/player?key=" + encodeURIComponent(getKey()) + "&prettyPrint=false",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-YouTube-Client-Name": "3",
          "X-YouTube-Client-Version": VER,
        },
        body: JSON.stringify(body),
      }
    );
    const txt = await resp.text();
    if (!resp.ok) {
      return { error: "innertube HTTP " + resp.status + " " + txt.slice(0, 120), tracks: [] };
    }
    let j;
    try {
      j = JSON.parse(txt);
    } catch (e) {
      return { error: "innertube 返回非 JSON", tracks: [] };
    }
    const tracks =
      (j.captions &&
        j.captions.playerCaptionsTracklistRenderer &&
        j.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      [];
    return { source: "android", tracks: tracks };
  }

  /** 取字幕正文（覆盖 fmt=json3；ANDROID 轨道的 baseUrl 自带 fmt=srv3） */
  async function getCueBody(baseUrl) {
    let url;
    try {
      const u = new URL(baseUrl);
      u.searchParams.set("fmt", "json3");
      url = u.toString();
    } catch (e) {
      url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "fmt=json3";
    }
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) return { error: "字幕正文 HTTP " + resp.status };
    return { body: await resp.text() };
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[TAG] !== true || d.from !== "content" || !d.id) return;
    let result;
    try {
      if (d.type === "GET_TRACKS") result = await getTracks(d.videoId);
      else if (d.type === "GET_CUES") result = await getCueBody(d.baseUrl);
      else result = { error: "未知请求: " + d.type };
    } catch (err) {
      result = { error: String((err && err.message) || err) };
    }
    post({ id: d.id, result: result });
  });
})();