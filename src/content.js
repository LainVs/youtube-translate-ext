/**
 * content.js — YouTube 双语字幕翻译 Content Script
 *
 * 思路：
 *   1. 从 ytInitialPlayerResponse 拿字幕轨道(captionTracks)
 *   2. 拼接 &fmt=json3 拉全片带时间轴字幕
 *   3. 批量送去 background 翻译（Google 免费端点 / AI），带缓存
 *   4. 自己在播放器上渲染“原文 + 译文”双语字幕
 *   5. 用 video.currentTime 做时间同步
 */

(function () {
  "use strict";

  const LOG_PREFIX = "[YT双语字幕]";

  const DEFAULTS = {
    enabled: true,
    bilingual: true,
    hideNative: false,
    targetLang: "zh-CN",
    translator: "google", // google | ai
    // AI（OpenAI 兼容接口）
    aiBaseUrl: "http://localhost:8788/v1",
    aiApiKey: "",
    aiModel: "opencode/big-pickle",
    // 样式
    // 字体：只存 key，实际字体栈见 FONT_STACKS
    fontFamily: "common",
    originalColor: "#39ff6a",
    translatedColor: "#ffe14d",
    originalSize: 30,
    translatedSize: 26,
    fontScale: 1,
    // 字重：中文只用 400/700（详见 fixCJKWeight 的注释）
    originalWeight: 400,
    translatedWeight: 400,
    // 字幕背景
    bgColor: "#000000",
    bgOpacity: 0,
    boxRadius: 0,
    boxPadding: 0,
    // 文字描边强度：0 无 / 1 柔和阴影 / 2 强描边（无底色时靠它保证可读）
    outline: 2,
    // 当前套用的风格预设（仅用于面板高亮）
    stylePreset: "neon",
    // 导出
    exportFormat: "srt", // srt | vtt | txt
    exportMode: "bilingual", // bilingual | translation | original
    // 选定的原始字幕语言（空 = 自动）
    trackLang: "",
    mergeBySentence: true,
    mergeMaxChars: 160,
    mergeMaxGapMs: 1200,
    // DOM 实时模式：只显示 ASR 滚动字幕里"最后一个 >> 之后"的新内容，
    // 否则会把整条滚动历史（可能上百字符）连同 >> 标记一起显示出来。
    domKeepLatest: true,
  };

  let config = Object.assign({}, DEFAULTS);

  // ============================== 运行时状态 ==============================
  let currentVideoId = null;
  let loadToken = 0;
  let lastError = "";
  let lastSource = "";
  // DOM 实时字幕模式（读取 YouTube 自绘字幕，不依赖 timedtext 接口）
  let domMode = false;
  let domObserver = null;
  let domCheckTimer = null;
  let domLastText = "";
  const domQueue = new Set();
  let domQueueTimer = null;
  let domHintTimer = null;

  let cueList = [];               // [{ start, end, dur, text }]
  const translationCache = new Map(); // cacheKey -> 译文

  let wrapper = null;             // 全尺寸定位层
  let box = null;                 // 字幕框
  let originalEl = null;
  let translatedEl = null;
  let statusEl = null;

  let lastIndex = -1;
  let syncTimer = null;
  let adTimer = null;
  let isAdPlaying = false;
  let position = null;            // { left, bottom }
  let playerEl = null;
  let saveTimer = null;

  const CACHE_PREFIX = "ytbs_cache_";

  /**
   * 字体栈。每个栈都**同时给拉丁字形和中文字形安排了字体**，
   * 所以一行里英中文各自取到合适的那个，不会出现「英文一种字体、
   * 中文掉到后备字体」的割裂感。
   * 注意：不要用 "YouTube Sans" —— 它没有中文字形，会造成中英割裂。
   */
  const FONT_STACKS = {
    common: 'Arial, Helvetica, "Microsoft YaHei", "微软雅黑", "PingFang SC", sans-serif',
    segoe: '"Segoe UI", "Microsoft YaHei", "微软雅黑", "PingFang SC", sans-serif',
    // 微软雅黑优先给中文，但拉丁字形也给它（它自带西文字形，比掉到 sans-serif 更协调）
    yahei: '"Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", sans-serif',
    songti: 'Georgia, "SimSun", "宋体", "Microsoft YaHei", serif',
    mono: 'Consolas, "Cascadia Mono", "Microsoft YaHei", "微软雅黑", monospace',
    round: '"Trebuchet MS", Verdana, "Microsoft YaHei", "微软雅黑", sans-serif',
  };

  function resolveFont(key) {
    return FONT_STACKS[key] || FONT_STACKS.common;
  }

  // ============================== 启动 ==============================
  boot();

  // ============================== 与 popup 通信 ==============================
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === "EXPORT_SUBTITLES") {
        const res = exportSubtitles(msg.format || config.exportFormat, msg.mode || config.exportMode);
        sendResponse(res);
        return;
      }
      if (msg.type === "GET_STATUS") {
        sendResponse({
          loaded: cueList.length,
          translated: countTranslated(),
          videoId: currentVideoId,
          source: lastSource,
          error: lastError,
          trackLang: config.trackLang || "",
        });
        return;
      }
    });
  } catch (e) {
    /* ignore */
  }

  async function boot() {
    await loadConfig();
    watchConfig();
    startAdDetection();
    watchNavigation();
    handleVideoChange(getVideoId());
  }

  function loadConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (stored) => {
          config = Object.assign({}, DEFAULTS, stored || {});
          chrome.storage.sync.get(["subtitlePosition"], (r) => {
            position = r && r.subtitlePosition ? r.subtitlePosition : null;
            resolve();
          });
        });
      } catch (e) {
        resolve();
      }
    });
  }

  function watchConfig() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        const next = Object.assign({}, config);
        let needRetranslate = false;
        let needRestyle = false;

        for (const key of Object.keys(changes)) {
          if (key === "subtitlePosition") continue;
          next[key] = changes[key].newValue;
          if (["targetLang", "translator", "aiBaseUrl", "aiApiKey", "aiModel"].includes(key)) {
            needRetranslate = true;
          }
          if (["originalColor", "translatedColor", "originalSize", "translatedSize", "fontScale", "bilingual", "bgColor", "bgOpacity", "boxRadius", "boxPadding", "outline", "fontFamily", "originalWeight", "translatedWeight"].includes(key)) {
            needRestyle = true;
          }
        }

        const wasEnabled = config.enabled;
        const wasHideNative = config.hideNative;
        config = next;

        if (config.hideNative !== wasHideNative) applyNativeVisibility();
        if (needRestyle) applyStyles();

        if (needRetranslate) {
          translationCache.clear();
        }

        if (!wasEnabled && config.enabled) {
          // 重新打开
          if (cueList.length) {
            ensureTranslations();
            startSync();
          } else {
            handleVideoChange(getVideoId(), true);
          }
        } else if (wasEnabled && !config.enabled) {
          stopSync();
          if (box) box.style.display = "none";
        } else if (config.enabled) {
          if (box) box.style.display = "";
          if (needRetranslate && cueList.length) ensureTranslations();
          renderCue(lastIndex, true);
        }
      });
    } catch (e) {
      /* ignore */
    }
  }

  // ============================== 页面/视频切换 ==============================
  function getVideoId() {
    try {
      return new URLSearchParams(location.search).get("v") || null;
    } catch (e) {
      return null;
    }
  }

  function watchNavigation() {
    // YouTube 自带的导航完成事件
    window.addEventListener("yt-navigate-finish", onNav, true);
    // 兜底：轮询 URL
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onNav();
      }
    }, 1000);
  }

  function onNav() {
    const id = getVideoId();
    if (id !== currentVideoId) handleVideoChange(id);
  }

  async function handleVideoChange(videoId, force) {
    if (!videoId) {
      cleanup();
      return;
    }
    if (!force && videoId === currentVideoId) return;

    const token = ++loadToken;
    currentVideoId = videoId;
    cleanupUI();
    cueList = [];
    translationCache.clear();
    lastIndex = -1;

    if (!config.enabled) return;

    await waitForPlayer();
    if (token !== loadToken) return;

    // 取字幕轨道（页面里的 baseUrl 带 &exp=xpe 被 PoToken 风控，必须走 ANDROID 客户端）
    // 顺序：页面主世界（同源，实测最稳）→ background → 页面 ytInitialPlayerResponse
    lastError = "";
    lastSource = "";
    let tracks = [];

    try {
      const r = await askMain("GET_TRACKS", { videoId: videoId });
      if (r && r.error) lastError = r.error;
      tracks = (r && r.tracks) || [];
      if (tracks.length) lastSource = (r && r.source) || "android";
    } catch (e) {
      lastError = String((e && e.message) || e);
    }

    if (!tracks.length) {
      try {
        const r = await sendBg("GET_TRACKS", { videoId });
        if (r && r.error && !lastError) lastError = r.error;
        tracks = (r && r.tracks) || [];
        if (tracks.length) lastSource = "android-bg";
      } catch (e) {
        /* ignore */
      }
    }

    if (!tracks.length) {
      // 兜底：页面 ytInitialPlayerResponse
      const playerResponse = await getPlayerResponse();
      if (token !== loadToken) return;
      const pageTracks = extractTracks(playerResponse) || [];
      if (pageTracks.length) {
        tracks = pageTracks;
        lastSource = "page";
      }
    }

    if (!tracks || tracks.length === 0) {
      // 拿不到轨道也别放弃：DOM 实时模式只需要原生字幕在屏幕上
      LOG("拿不到字幕轨道, 转入 DOM 实时模式, 错误:", lastError);
      await loadPersistentCache(videoId);
      if (token !== loadToken) return;
      startDomFallback(lastError || "no caption tracks");
      return;
    }

    const track = pickTrack(tracks);
    if (!track) return;

    // 取字幕正文
    //
    // 两条路，顺序不能反：
    //   A. 重放 baseUrl —— 只有 ANDROID 轨道的 baseUrl（ip=0.0.0.0 签名）能重复取，
    //      成功时是毫秒级，所以先试它。
    //   B. hook 播放器的请求 —— 页面 `ytInitialPlayerResponse` 里那份 baseUrl 带 PoToken，
    //      是**一次性**的，重放只会得到 HTTP 200 + 空 body；而且 innertube 撞 403 时
    //      根本拿不到可用 baseUrl。此时唯一的解法是截获播放器自己那一次请求的响应。
    //      这条路用页面自己的合法身份（真 cookies + PoToken），所以**永远不会被 403**。
    let cues = [];
    const langCode = track.languageCode || "";
    const replayable = !!track.baseUrl && !track.__fromPlayer;

    if (replayable) {
      try {
        const r = await askMain("GET_CUES", { baseUrl: track.baseUrl });
        if (r && r.body) cues = finalizeCues(parseCuesFromBody(r.body), config.mergeBySentence);
        else if (r && r.error && !lastError) lastError = r.error;
      } catch (e) {
        /* ignore */
      }
      if (!cues.length) {
        try {
          const r = await sendBg("GET_CUES", { baseUrl: track.baseUrl });
          if (r && r.body) cues = finalizeCues(parseCuesFromBody(r.body), config.mergeBySentence);
          else if (r && r.error && !lastError) lastError = r.error;
        } catch (e) {
          /* ignore */
        }
      }
      if (!cues.length) {
        cues = await fetchCues(track.baseUrl); // 内容脚本直连兜底
      }
      if (token !== loadToken) return;
    }

    if (!cues.length) {
      try {
        const r = await askMain("GET_CUES_VIA_PLAYER", { videoId: videoId, langCode: langCode }, 15000);
        if (r && r.body) {
          cues = finalizeCues(parseCuesFromBody(r.body));
          if (cues.length) lastError = ""; // 拿到了就清掉上一步的残留错误
        } else if (r && r.error) {
          lastError = r.error;
        }
      } catch (e) {
        /* ignore */
      }
    }

    if (!cues.length) {
      cues = await fetchCues(track.baseUrl); // 最后兜底
    }
    if (token !== loadToken) return;
    if (!cues.length) {
      // 各路都失败 → DOM 实时模式兜底（只要原生字幕在屏幕上就能翻）
      LOG("字幕正文为空, 转入 DOM 实时模式, 来源=" + lastSource + ", 错误=" + lastError);
      cueList = [];
      await loadPersistentCache(videoId);
      if (token !== loadToken) return;
      startDomFallback(lastError || "empty cues");
      return;
    }

    stopDomMode(); // 预取成功，退出可能残留的实时模式
    cueList = cues;
    LOG(`已加载 ${cueList.length} 条字幕`);

    await loadPersistentCache(videoId);
    if (token !== loadToken) return;

    createOverlay();
    applyStyles();
    applyNativeVisibility();
    startSync();
    renderCue(-1, true);

    ensureTranslations(); // 后台批量翻译
  }

  function waitForPlayer() {
    return new Promise((resolve) => {
      const check = () => {
        const el =
          document.querySelector("#movie_player") ||
          document.querySelector(".html5-video-player") ||
          document.querySelector("video");
        if (el) {
          playerEl = el;
          resolve(el);
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    });
  }

  // ============================== 获取字幕数据 ==============================
  async function getPlayerResponse() {
    // 1) 页面全局变量
    if (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.captions) {
      return window.ytInitialPlayerResponse;
    }
    // 2) 页面内联脚本
    const fromScript = parseFromScripts();
    if (fromScript) return fromScript;
    // 3) 兜底：请求 watch 页
    try {
      const html = await (await fetch(location.href, { credentials: "include" })).text();
      return extractJsonAfter(html, "ytInitialPlayerResponse");
    } catch (e) {
      return null;
    }
  }

  function parseFromScripts() {
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      const txt = s.textContent;
      if (!txt || txt.indexOf("ytInitialPlayerResponse") === -1) continue;
      const parsed = extractJsonAfter(txt, "ytInitialPlayerResponse");
      if (parsed) return parsed;
    }
    return null;
  }

  /** 从文本中定位 marker 后的第一个 JSON 对象（花括号计数，字符串安全） */
  function extractJsonAfter(text, marker) {
    const markerIdx = text.indexOf(marker);
    if (markerIdx < 0) return null;
    const start = text.indexOf("{", markerIdx);
    if (start < 0) return null;

    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch (e) {
            return null;
          }
        }
      }
    }
    return null;
  }

  function extractTracks(playerResponse) {
    if (!playerResponse) return null;
    return (
      (playerResponse.captions &&
        playerResponse.captions.playerCaptionsTracklistRenderer &&
        playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      null
    );
  }

  function pickTrack(tracks) {
    // 指定语言优先
    if (config.trackLang) {
      const exact = tracks.find((t) => t.languageCode === config.trackLang);
      if (exact) return exact;
    }
    const target = config.targetLang || "";
    const base = target.split("-")[0];

    // 优先英文
    const en = tracks.find((t) => t.languageCode === "en");
    if (en) return en;

    // 优先与目标语言不同的
    const other = tracks.find((t) => {
      const code = (t.languageCode || "").split("-")[0];
      return code !== base;
    });
    if (other) return other;

    return tracks[0];
  }

  async function fetchCues(baseUrl) {
    if (!baseUrl) return [];
    // 用 URL API 覆盖 fmt：ANDROID 轨道的 baseUrl 默认带 fmt=srv3，
    // 直接拼 &fmt=json3 会变成两个 fmt，结果仍是 srv3 XML。
    let url;
    try {
      const u = new URL(baseUrl);
      u.searchParams.set("fmt", "json3");
      url = u.toString();
    } catch (e) {
      url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "fmt=json3";
    }

    let body;
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      body = await resp.text();
    } catch (e) {
      LOG("拉取字幕失败:", e.message);
      return [];
    }

    const cues = parseCuesFromBody(body);
    if (!cues.length) {
      LOG("字幕响应为空或无法解析，长度:", body ? body.length : 0);
      return [];
    }
    return finalizeCues(cues, config.mergeBySentence);
  }

  /**
   * 判断一条字幕是否构成一个「可独立翻译的句子」。
   *
   * YouTube 的 ASR（自动生成）字幕切得非常碎，实测一条典型长视频的字幕是：
   *   "This is a three. It's sloppily written"
   *   "and rendered at an extremely low"
   *   "resolution of 28x 28 pixels. But your"
   *   "brain has no trouble recognizing it as a"
   * 每条都是半句话。逐条翻译必然得到断头断尾的译文
   *（"想象两个人到达同一个" —— 后半句还在下一条里）。
   * 所以必须先拼成完整句再翻。
   */
  function endsSentence(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    // 剥掉结尾的引号/括号，再看真正的句末标点
    const core = t.replace(/["'”’)\]】》」』]+\s*$/, "");
    if (!core) return false;
    // 中英文句末标点 + 省略号（… 视为可断句）
    if (/[.!?…。！？]["'”’)\]】》」』]*\s*$/.test(core)) return true;
    // 无句末标点但已经很长，也该断，否则会一直累积成一大段
    return false;
  }

  /** 拼接碎片：一直拼到句末标点，或达到长度/时间上限 */
  function mergeCuesToSentences(cues, maxChars, maxGapMs) {
    const out = [];
    let buf = null;

    const flush = () => {
      if (buf && buf.text.trim()) out.push(buf);
      buf = null;
    };

    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const piece = c.text.trim();
      if (!piece) continue; // 纯空白的占位 cue（ASR 里很常见）直接丢

      if (!buf) {
        buf = { start: c.start, end: c.end, dur: c.dur, text: piece };
      } else {
        // 间隔过大（> maxGapMs）视为另一段话，不硬拼
        const gap = c.start - buf.end;
        const tooFar = gap > maxGapMs;
        const tooLong = (buf.text + " " + piece).length > maxChars;

        if (tooFar) {
          // 时间跳跃处断开：先把已攒的句子收口，再以当前句另起
          flush();
          buf = { start: c.start, end: c.end, dur: c.dur, text: piece };
        } else if (tooLong) {
          // 超长才切：先收口已有内容，当前句另起（保持顺序，不丢字）
          flush();
          buf = { start: c.start, end: c.end, dur: c.dur, text: piece };
        } else {
          buf.text = buf.text + " " + piece;
          buf.end = Math.max(buf.end, c.end);
          buf.dur = buf.end - buf.start;
        }
      }

      // 拼到句末标点就收口
      if (buf && endsSentence(buf.text)) flush();
    }
    flush();
    return out;
  }

  /**
   * 排序 + 去重滚动窗口 + 计算结束时间
   * @param {boolean} bySentence 是否把碎片合并成完整句（决定翻译质量的关键开关）
   */
  function finalizeCues(cues, bySentence) {
    if (!cues.length) return [];
    cues.sort((a, b) => a.start - b.start);

    // 先算每条的结束时间
    const withEnd = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const next = cues[i + 1];
      const end = c.start + (c.dur > 0 ? c.dur : next ? next.start - c.start : 4000);
      withEnd.push({
        start: c.start,
        end: Math.max(end, c.start + 300),
        dur: c.dur,
        text: c.text,
      });
    }

    // 去重：ASR 滚动窗口会反复出现同一段文本，只保留时间轴更长/更早的那次
    const deduped = [];
    for (let i = 0; i < withEnd.length; i++) {
      const c = withEnd[i];
      const prev = deduped[deduped.length - 1];
      if (prev && prev.text === c.text && c.start <= prev.end + 200) {
        prev.end = Math.max(prev.end, c.end);
        continue;
      }
      deduped.push(c);
    }

    // 合并成完整句：这是翻译质量的关键。
    // 关掉时退回「一条碎片一条字幕」，方便对比和排查。
    const maxChars = config.mergeMaxChars || 160;
    const maxGapMs = config.mergeMaxGapMs || 1200;
    if (!bySentence) return deduped;
    return mergeCuesToSentences(deduped, maxChars, maxGapMs);
  }

  /** 解析 timedtext 响应：json3（JSON）或 srv3 / srv1（XML） */
  function parseCuesFromBody(body) {
    const cues = [];
    if (!body) return cues;
    const text = body.replace(/^\s*\)\]\}'\s*/, "").trim(); // 去掉 XSSI 前缀
    if (text.charAt(0) === "{") {
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return cues;
      }
      for (const ev of data.events || []) {
        if (!ev.segs) continue;
        let line = ev.segs.map((s) => s.utf8 || "").join("");
        line = line.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
        if (!line) continue;
        cues.push({ start: ev.tStartMs || 0, dur: ev.dDurationMs || 0, text: line });
      }
      return cues;
    }
    if (text.charAt(0) === "<") {
      // srv3: <p t="1360" d="1680">text</p>
      let m;
      const reP = /<p\s+[^>]*\bt="(\d+)"[^>]*\bd="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
      while ((m = reP.exec(text))) {
        const line = cleanXmlText(m[3]);
        if (line) cues.push({ start: +m[1], dur: +m[2], text: line });
      }
      if (!cues.length) {
        // srv1: <text start="1.36" dur="1.68">text</text>
        const reT = /<text\s+[^>]*\bstart="([\d.]+)"[^>]*\bdur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
        while ((m = reT.exec(text))) {
          const line = cleanXmlText(m[3]);
          if (line) cues.push({ start: Math.round(+m[1] * 1000), dur: Math.round(+m[2] * 1000), text: line });
        }
      }
    }
    return cues;
  }

  function cleanXmlText(s) {
    return decodeEntities(String(s).replace(/<[^>]*>/g, ""))
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeEntities(s) {
    return s
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");
  }

  // ============================== 翻译 ==============================
  function cacheKey(text) {
    return config.translator + "|" + config.targetLang + "|" + text;
  }

  // ---- 持久化缓存（存 chrome.storage.local，按视频 + 引擎 + 目标语言隔离）----
  function persistentKey(videoId) {
    return CACHE_PREFIX + videoId;
  }

  function loadPersistentCache(videoId) {
    return new Promise((resolve) => {
      try {
        const key = persistentKey(videoId);
        chrome.storage.local.get([key], (r) => {
          const entry = r && r[key];
          if (
            entry &&
            entry.lang === config.targetLang &&
            entry.translator === config.translator &&
            entry.map
          ) {
            let n = 0;
            for (const text in entry.map) {
              if (!translationCache.has(cacheKey(text))) {
                translationCache.set(cacheKey(text), entry.map[text]);
                n++;
              }
            }
            LOG(`已从本地缓存加载 ${n} 条翻译`);
          }
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  function scheduleSavePersistent() {
    if (!currentVideoId) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePersistentNow, 1500);
  }

  function savePersistentNow() {
    if (!currentVideoId || !cueList.length) return;
    const map = {};
    let count = 0;
    for (const c of cueList) {
      const tr = translationCache.get(cacheKey(c.text));
      if (tr) {
        map[c.text] = tr;
        count++;
        if (count >= 4000) break; // 单视频上限，避免存储过大
      }
    }
    if (!count) return;
    const key = persistentKey(currentVideoId);
    try {
      chrome.storage.local.set({
        [key]: {
          lang: config.targetLang,
          translator: config.translator,
          updatedAt: Date.now(),
          map,
        },
      });
      LOG(`已保存 ${count} 条翻译到本地缓存`);
    } catch (e) {
      /* ignore */
    }
  }

  async function ensureTranslations() {
    if (!cueList.length || !config.enabled) return;
    const token = loadToken;

    const texts = [];
    const seen = new Set();
    for (const c of cueList) {
      if (!seen.has(c.text)) {
        seen.add(c.text);
        texts.push(c.text);
      }
    }

    const pending = texts.filter((t) => !translationCache.has(cacheKey(t)));
    if (!pending.length) return;

    if (statusEl) {
      statusEl.textContent = "翻译中… 0/" + pending.length;
      statusEl.style.display = "";
    }

    const CHUNK = 12;
    let done = 0;

    for (let i = 0; i < pending.length; i += CHUNK) {
      if (token !== loadToken || !config.enabled) return;
      const chunk = pending.slice(i, i + CHUNK);
      await runChunk(chunk, token);
      done += chunk.length;
      if (statusEl) statusEl.textContent = "翻译中… " + done + "/" + pending.length;
      await sleep(120);
    }

    if (statusEl) {
      statusEl.textContent = "已翻译 " + done + " 条";
      setTimeout(() => {
        if (statusEl) statusEl.style.display = "none";
      }, 1500);
    }
    renderCue(lastIndex, true);
    savePersistentNow();
  }

  /** 翻译一批文本（预取模式与 DOM 实时模式共用） */
  async function runChunk(chunk, token) {
    if (!chunk || !chunk.length) return 0;
    if (token !== loadToken || !config.enabled) return 0;
    const res = await sendBg("TRANSLATE_BATCH", {
      texts: chunk,
      config: {
        translator: config.translator,
        targetLang: config.targetLang,
        aiBaseUrl: config.aiBaseUrl,
        aiApiKey: config.aiApiKey,
        aiModel: config.aiModel,
      },
    });

    if (res && Array.isArray(res.translations)) {
      for (let j = 0; j < chunk.length; j++) {
        const tr = res.translations[j];
        if (typeof tr === "string" && tr) translationCache.set(cacheKey(chunk[j]), tr);
      }
    } else if (res && res.error) {
      LOG("翻译错误:", res.error);
      if (statusEl) statusEl.textContent = "翻译失败：" + res.error;
      showToast("翻译失败：" + res.error, true);
      await sleep(800);
    }

    renderCue(lastIndex, true);
    scheduleSavePersistent();
    return chunk.length;
  }

  // ---- 页面主世界桥（main-fetch.js 在 world: MAIN 中执行，避免被 YT 判为扩展流量）----
  const MAIN_TAG = "__ytbs_main__";
  const mainPending = new Map();
  let mainReqId = 0;

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    // 只接受主世界的响应；必须过滤掉自己刚发出去的请求（postMessage 会回送给自己）
    if (!d || d[MAIN_TAG] !== true || d.from !== "main" || !d.id) return;
    const resolve = mainPending.get(d.id);
    if (!resolve) return;
    mainPending.delete(d.id);
    resolve(d.result || {});
  });

  function askMain(type, payload, timeoutMs) {
    return new Promise((resolve) => {
      const id = ++mainReqId;
      mainPending.set(id, resolve);
      try {
        window.postMessage(
          Object.assign({ [MAIN_TAG]: true, from: "content", id: id, type: type }, payload || {}),
          "*"
        );
      } catch (e) {
        mainPending.delete(id);
        resolve({ error: String((e && e.message) || e) });
        return;
      }
      setTimeout(() => {
        if (!mainPending.has(id)) return;
        mainPending.delete(id);
        resolve({ error: "主世界请求超时（main-fetch.js 可能没注入）" });
      }, timeoutMs || 20000);
    });
  }

  function sendBg(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, payload), (r) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(r);
        });
      } catch (e) {
        resolve({ error: String(e) });
      }
    });
  }

  // ============================== 字幕渲染 ==============================
  function createOverlay() {
    if (wrapper && wrapper.isConnected) return;

    if (!playerEl || !playerEl.isConnected) {
      playerEl = document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
    }
    if (!playerEl) return;

    if (getComputedStyle(playerEl).position === "static") {
      playerEl.style.position = "relative";
    }

    wrapper = document.createElement("div");
    wrapper.id = "ytbs-wrapper";

    box = document.createElement("div");
    box.id = "ytbs-box";

    const handle = document.createElement("div");
    handle.id = "ytbs-handle";
    handle.textContent = "⠿";
    handle.title = "拖动调整位置";

    const downloadBtn = document.createElement("div");
    downloadBtn.id = "ytbs-download";
    downloadBtn.textContent = "⤓";
    downloadBtn.title = "导出字幕文件";
    downloadBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const res = exportSubtitles(config.exportFormat, config.exportMode);
      if (!res.ok) LOG(res.error);
    });

    originalEl = document.createElement("div");
    originalEl.className = "ytbs-line ytbs-original";

    translatedEl = document.createElement("div");
    translatedEl.className = "ytbs-line ytbs-translated";

    statusEl = document.createElement("div");
    statusEl.id = "ytbs-status";
    statusEl.style.display = "none";

    box.appendChild(handle);
    box.appendChild(downloadBtn);
    box.appendChild(originalEl);
    box.appendChild(translatedEl);
    box.appendChild(statusEl);
    wrapper.appendChild(box);
    playerEl.appendChild(wrapper);

    enableDrag(handle);
    applyPosition();
  }

  function applyPosition() {
    if (!wrapper) return;
    if (position && typeof position.left === "number" && typeof position.bottom === "number") {
      wrapper.style.left = position.left + "px";
      wrapper.style.bottom = position.bottom + "px";
      wrapper.style.transform = "none";
    } else {
      wrapper.style.left = "50%";
      wrapper.style.bottom = "80px";
      wrapper.style.transform = "translateX(-50%)";
    }
  }

  /** #rgb / #rrggbb -> rgba(r,g,b,a) */
  function hexToRgba(hex, alpha) {
    let h = String(hex || "").trim().replace(/^#/, "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return "rgba(0, 0, 0, " + alpha + ")";
    const n = parseInt(h, 16);
    return "rgba(" + ((n >> 16) & 255) + ", " + ((n >> 8) & 255) + ", " + (n & 255) + ", " + alpha + ")";
  }

  /** 描边强度 -> text-shadow。无底色时靠 2 级强描边保证任何画面上都读得清。 */
  function outlineShadow(level) {
    if (level >= 2) {
      return [
        "-1px -1px 0 #000",
        "1px -1px 0 #000",
        "-1px 1px 0 #000",
        "1px 1px 0 #000",
        "-2px -2px 0 #000",
        "2px -2px 0 #000",
        "-2px 2px 0 #000",
        "2px 2px 0 #000",
        "0 3px 7px rgba(0, 0, 0, 0.85)",
      ].join(", ");
    }
    if (level === 1) {
      return "0 2px 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.85)";
    }
    return "0 1px 2px rgba(0,0,0,0.9)";
  }

  /**
   * 字重修正：中文不能随便用 500/600。
   *
   * 实测（Arial + 微软雅黑，"想象两个人到达同一个晚宴" 40px）：
   *   300/400/500/600/700 的文字宽度**完全相同（480px）**
   *   ——说明微软雅黑没有真正的 500/600 中间字重，浏览器只能做
   *      「合成加粗」（对字形外描边），视觉上笔画变粗、边缘发毛，
   *      但宽度不变。这正是「中文看起来像被加粗了」的成因。
   * 对照拉丁字体（Arial）：400=329px，600/700=356px（有真 Bold 字形）。
   *
   * 所以中文只用 400（Regular）和 700（Bold，字体里真实存在），
   * 中间值一律降级到 400，避免伪粗体。
   */
  function fixCJKWeight(weight) {
    const w = Number(weight);
    if (!isFinite(w)) return 400;
    if (w >= 650) return 700; // 真 Bold
    return 400; // 其余（含 500/600）一律 Regular，避开合成加粗
  }

  function applyStyles() {
    if (!box) return;
    const s = config.fontScale || 1;
    if (originalEl) {
      originalEl.style.color = config.originalColor;
      originalEl.style.fontSize = Math.round((config.originalSize || 18) * s) + "px";
      originalEl.style.fontWeight = fixCJKWeight(config.originalWeight);
    }
    if (translatedEl) {
      translatedEl.style.color = config.translatedColor;
      translatedEl.style.fontSize = Math.round((config.translatedSize || 24) * s) + "px";
      translatedEl.style.fontWeight = fixCJKWeight(config.translatedWeight);
    }
    if (originalEl) originalEl.style.display = config.bilingual ? "" : "none";

    // 背景色 + 不透明度（0 = 完全透明）
    let o = Number(config.bgOpacity);
    if (!isFinite(o)) o = 0.68;
    if (o > 1) o = o / 100; // >1 视为百分数（popup 存的就是 0-100）
    o = Math.max(0, Math.min(1, o));
    box.style.background = o > 0 ? hexToRgba(config.bgColor, o) : "transparent";

    // 圆角 + 内边距
    const r = Number(config.boxRadius);
    const pd = Number(config.boxPadding);
    const rr = isFinite(r) ? r : 10;
    const pp = isFinite(pd) ? pd : 10;
    box.style.borderRadius = rr + "px";
    box.style.padding = pp + "px " + Math.round(pp * 1.8) + "px";

    // 描边
    const shadow = outlineShadow(Number(config.outline) || 0);
    if (originalEl) originalEl.style.textShadow = shadow;
    if (translatedEl) translatedEl.style.textShadow = shadow;

    // 字体
    const ff = resolveFont(config.fontFamily);
    if (originalEl) originalEl.style.fontFamily = ff;
    if (translatedEl) translatedEl.style.fontFamily = ff;
  }

  function applyNativeVisibility() {
    let style = document.getElementById("ytbs-native-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "ytbs-native-style";
      document.documentElement.appendChild(style);
    }
    style.textContent = config.hideNative
      ? ".ytp-caption-window-container{display:none !important;}"
      : "";
  }

  // ======================= DOM 实时字幕模式（兜底，不走 timedtext）=======================
  //
  // "快捷翻译"这类成熟插件就是这样做的：不请求 YouTube 的字幕 API，
  // 而是用 MutationObserver 直接读播放器已经画出来的原生字幕，读到一行翻一行。
  // 好处是完全不受 PoToken 风控影响；代价是必须开着原生 CC，且没有全片时间轴（导出会只有已看到的部分）。

  function nowMs() {
    const v = document.querySelector("video");
    return v ? Math.round(v.currentTime * 1000) : Date.now();
  }

  /**
   * YouTube 的 ASR（自动生成）字幕是「滚动窗口」式的：随着语音识别推进，
   * 同一行会不断往前追加新内容，并用 ">>" 打头标记**新增部分的起点**。
   *
   * 实测（用户在视频里看到的真实画面）：
   *   屏幕上原文 = "I didn't understand it then, but >> [music] >>
   *                I think some part of me just knew before I did."
   *   如果照单全收地拼接，就会显示成一长串 117 字符的巨型字幕，
   *   而且把 ">>" 这种标记也一起显示出来（截图里那行就是这么来的）。
   *
   * 正确做法：按 ">>" 切开，**只取最后一个非空段**—— 那才是当前
   * 正在说的新内容。同一段实测从 117 字符缩到 47 字符，缩短 60%，
   * 正好就是竞品那种「一句一句跟着说」的效果。
   */
  function pickLatestSegment(text) {
    const raw = String(text || "");
    if (raw.indexOf(">>") < 0) return raw.replace(/\s+/g, " ").trim();
    const parts = raw.split(">>");
    for (let i = parts.length - 1; i >= 0; i--) {
      const t = parts[i].replace(/\s+/g, " ").trim();
      if (t) return t;
    }
    // 全是空白分段（纯 ">>"），退回去掉标记的原文，
    // 避免字幕里出现裸的 ">>"，也不至于整体消失
    const cleaned = raw.replace(/>>/g, "").replace(/\s+/g, " ").trim();
    return cleaned;
  }

  function readNativeCaption() {
    try {
      const win = document.querySelector(".ytp-caption-window-container");
      if (!win) return "";
      const segs = win.querySelectorAll(".ytp-caption-segment");
      let text = "";
      if (segs.length) {
        for (const s of segs) {
          const t = (s.textContent || "").replace(/\s+/g, " ").trim();
          if (t) text += (text ? " " : "") + t;
        }
      } else {
        text = (win.innerText || win.textContent || "").replace(/\s+/g, " ").trim();
      }
      // 只保留 ">>" 之后的最新片段（ASR 滚动字幕专用）
      return config.domKeepLatest ? pickLatestSegment(text) : text;
    } catch (e) {
      return "";
    }
  }

  function startDomMode(reason) {
    if (domMode) return;
    domMode = true;
    LOG("切换到 DOM 实时字幕模式:", reason || "");
    showToast("预取字幕失败，已切换为实时模式（读取原生字幕，需打开 CC）");

    const root =
      document.querySelector("#movie_player") ||
      document.querySelector(".html5-video-player") ||
      document.body;
    try {
      domObserver = new MutationObserver(() => scheduleDomCheck());
      domObserver.observe(root, { subtree: true, childList: true, characterData: true });
    } catch (e) {
      LOG("DOM 观察失败:", e.message);
    }

    scheduleDomCheck();

    // 3 秒后还没读到原生字幕 → 大概率是原生 CC 没开
    clearTimeout(domHintTimer);
    domHintTimer = setTimeout(() => {
      if (domMode && !cueList.length && !readNativeCaption()) {
        showToast("未读到原生字幕：请点播放器右下角 CC 打开字幕（快捷键 c）", true);
      }
    }, 3000);
  }

  /** 统一降级入口：建覆盖层 + 启动同步 + 切到 DOM 实时模式 */
  function startDomFallback(reason) {
    createOverlay();
    applyStyles();
    applyNativeVisibility();
    startSync();
    startDomMode(reason);
  }

  function stopDomMode() {
    if (domObserver) {
      try {
        domObserver.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    domObserver = null;
    clearTimeout(domCheckTimer);
    domCheckTimer = null;
    clearTimeout(domHintTimer);
    domHintTimer = null;
    if (domQueueTimer) clearTimeout(domQueueTimer);
    domQueueTimer = null;
    domQueue.clear();
    domMode = false;
    domLastText = "";
  }

  function scheduleDomCheck() {
    if (domCheckTimer) return;
    domCheckTimer = setTimeout(() => {
      domCheckTimer = null;
      checkDomCaption();
    }, 100);
  }

  function checkDomCaption() {
    if (!domMode || !config.enabled) return;
    const text = readNativeCaption();
    const now = nowMs();

    if (text === domLastText) {
      // 同一句还在，把结束时间往后延
      const last = cueList[cueList.length - 1];
      if (last && text) last.end = Math.max(last.end, now + 2500);
      return;
    }
    domLastText = text;

    if (!text) {
      // 字幕消失：收短当前条，让 overlay 隐藏
      const last = cueList[cueList.length - 1];
      if (last && now > last.start + 200) last.end = now;
      lastIndex = -1;
      renderCue(-1, true);
      return;
    }

    const last = cueList[cueList.length - 1];
    if (last && last.text === text) {
      last.end = now + 2500;
    } else {
      if (cueList.length >= 3000) cueList.shift(); // 防止无限增长
      cueList.push({ start: now, end: now + 2500, dur: 2500, text: text });
    }
    lastIndex = cueList.length - 1;
    renderCue(lastIndex, true);
    requestDomTranslate(text);
  }

  /** 攒一小批再翻译，避免每翻一行都请求 */
  function requestDomTranslate(text) {
    if (translationCache.has(cacheKey(text))) return;
    domQueue.add(text);
    if (domQueueTimer) return;
    domQueueTimer = setTimeout(() => {
      domQueueTimer = null;
      const chunk = Array.from(domQueue);
      domQueue.clear();
      if (!chunk.length || !domMode || !config.enabled) return;
      runChunk(chunk, loadToken);
    }, 400);
  }

  function startSync() {
    stopSync();
    syncTimer = setInterval(tick, 100);
  }

  function stopSync() {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  function tick() {
    if (!config.enabled) return;
    if (!wrapper || !wrapper.isConnected) {
      if (playerEl && playerEl.isConnected) createOverlay();
    }
    if (isAdPlaying) return;

    // DOM 实时模式由 MutationObserver 驱动渲染，不走二分时间轴
    if (domMode) return;

    const v = document.querySelector("video");
    if (!v) return;
    const t = v.currentTime * 1000;
    const idx = findCue(t);
    if (idx !== lastIndex) {
      lastIndex = idx;
      renderCue(idx);
    }
  }

  function findCue(t) {
    const n = cueList.length;
    if (!n) return -1;
    // 二分找最后一个 start <= t
    let lo = 0;
    let hi = n - 1;
    let res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cueList[mid].start <= t) {
        res = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (res < 0) return -1;
    // 向前回溯几条，处理重叠
    for (let i = res; i >= 0 && i >= res - 3; i--) {
      if (t >= cueList[i].start && t <= cueList[i].end) return i;
    }
    return -1;
  }

  function renderCue(idx, force) {
    if (!box || !originalEl || !translatedEl) return;
    if (!config.enabled) return;

    if (idx < 0 || !cueList[idx]) {
      originalEl.textContent = "";
      translatedEl.textContent = "";
      if (!force) box.style.visibility = "hidden";
      box.style.visibility = "hidden";
      return;
    }
    box.style.visibility = "visible";
    const cue = cueList[idx];
    originalEl.textContent = cue.text;

    const tr = translationCache.get(cacheKey(cue.text));
    translatedEl.textContent = tr || "…";
  }

  // ============================== 广告检测 ==============================
  function startAdDetection() {
    adTimer = setInterval(() => {
      const player = document.querySelector("#movie_player");
      let ad = false;
      if (player) {
        ad =
          player.classList.contains("ad-showing") ||
          player.classList.contains("ad-interrupting");
      }
      if (!ad) {
        ad = !!document.querySelector(".ytp-ad-player-overlay, .ytp-ad-skip-button");
      }
      if (ad && !isAdPlaying) {
        isAdPlaying = true;
        if (box) box.style.display = "none";
      } else if (!ad && isAdPlaying) {
        isAdPlaying = false;
        if (box && config.enabled) box.style.display = "";
      }
    }, 800);
  }

  // ============================== 拖拽 ==============================
  function enableDrag(handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startBottom = 0;

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      const rect = wrapper.getBoundingClientRect();
      const parentRect = playerEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left - parentRect.left;
      startBottom = parentRect.bottom - rect.bottom;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    function onMove(e) {
      if (!dragging) return;
      const parentRect = playerEl.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      let left = startLeft + (e.clientX - startX);
      let bottom = startBottom - (e.clientY - startY);
      left = Math.max(0, Math.min(left, parentRect.width - boxRect.width));
      bottom = Math.max(0, Math.min(bottom, parentRect.height - boxRect.height));
      wrapper.style.transform = "none";
      wrapper.style.left = left + "px";
      wrapper.style.bottom = bottom + "px";
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      position = {
        left: parseFloat(wrapper.style.left) || 0,
        bottom: parseFloat(wrapper.style.bottom) || 80,
      };
      try {
        chrome.storage.sync.set({ subtitlePosition: position });
      } catch (e) {
        /* ignore */
      }
    }
  }

  // ============================== 导出字幕 ==============================
  function countTranslated() {
    let n = 0;
    for (const c of cueList) {
      if (translationCache.has(cacheKey(c.text))) n++;
    }
    return n;
  }

  function exportSubtitles(format, mode) {
    if (!cueList.length) {
      return { ok: false, error: "字幕尚未加载完成，请稍候重试" };
    }
    format = format || "srt";
    mode = mode || "bilingual";

    const content = buildSubtitleContent(format, mode);
    const base = sanitizeName(document.title || "youtube") + "_" + modeLabel(mode);
    const ext = format === "txt" ? "txt" : format;
    const filename = base + "." + ext;

    try {
      triggerDownload(filename, content);
      LOG("已导出字幕:", filename);
      return { ok: true, count: cueList.length, filename };
    } catch (e) {
      return { ok: false, error: "导出失败: " + e.message };
    }
  }

  function modeLabel(mode) {
    return mode === "translation" ? "译文" : mode === "original" ? "原文" : "双语";
  }

  function buildSubtitleContent(format, mode) {
    const bodyOf = (cue) => {
      const tr = translationCache.get(cacheKey(cue.text));
      if (mode === "original") return cue.text;
      if (mode === "translation") return tr || cue.text;
      // 双语：有译文则两行，没有则只显示原文
      return tr ? cue.text + "\n" + tr : cue.text;
    };

    if (format === "txt") {
      return cueList.map((c) => bodyOf(c)).join("\n");
    }

    if (format === "vtt") {
      const parts = ["WEBVTT", ""];
      for (const c of cueList) {
        parts.push(formatTime(c.start, false) + " --> " + formatTime(c.end, false));
        parts.push(bodyOf(c));
        parts.push("");
      }
      return parts.join("\n");
    }

    // 默认 SRT
    const parts = [];
    for (let i = 0; i < cueList.length; i++) {
      const c = cueList[i];
      parts.push(String(i + 1));
      parts.push(formatTime(c.start, true) + " --> " + formatTime(c.end, true));
      parts.push(bodyOf(c));
      parts.push("");
    }
    return parts.join("\n");
  }

  function formatTime(ms, comma) {
    ms = Math.max(0, Math.round(ms || 0));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const msec = ms % 1000;
    const pad = (n, l) => String(n).padStart(l, "0");
    return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + (comma ? "," : ".") + pad(msec, 3);
  }

  function sanitizeName(name) {
    return String(name).replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "youtube";
  }

  function triggerDownload(filename, content) {
    // 加 BOM，保证 Windows 记事本正确识别 UTF-8
    const blob = new Blob(["\uFEFF" + content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  // ============================== 清理 ==============================
  function cleanupUI() {
    stopSync();
    stopDomMode();
    if (wrapper && wrapper.isConnected) wrapper.remove();
    wrapper = null;
    box = null;
    originalEl = null;
    translatedEl = null;
    statusEl = null;
    applyNativeVisibility();
  }

  function cleanup() {
    loadToken++;
    cleanupUI();
    cueList = [];
    translationCache.clear();
    lastIndex = -1;
    currentVideoId = null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 页面内提示条：让“静默失败”变成可见原因 */
  function showToast(text, isError) {
    try {
      const host =
        (playerEl && playerEl.isConnected ? playerEl : null) ||
        document.querySelector("#movie_player") ||
        document.querySelector(".html5-video-player") ||
        document.body;
      if (!host) return;
      let el = document.getElementById("ytbs-toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "ytbs-toast";
      }
      if (el.parentNode !== host) host.appendChild(el);
      el.textContent = text;
      el.className = isError ? "ytbs-toast-error" : "";
      el.style.display = "block";
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => {
        el.style.display = "none";
      }, isError ? 6000 : 3000);
    } catch (e) {
      /* ignore */
    }
  }

  function LOG() {
    try {
      console.log.apply(console, [LOG_PREFIX].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
  }
})();
