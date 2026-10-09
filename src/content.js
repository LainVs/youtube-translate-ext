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
    originalColor: "#ffffff",
    translatedColor: "#a7e8ff",
    originalSize: 18,
    translatedSize: 24,
    fontScale: 1,
    // 导出
    exportFormat: "srt", // srt | vtt | txt
    exportMode: "bilingual", // bilingual | translation | original
    // 选定的原始字幕语言（空 = 自动）
    trackLang: "",
  };

  let config = Object.assign({}, DEFAULTS);

  // ============================== 运行时状态 ==============================
  let currentVideoId = null;
  let loadToken = 0;

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

  // InnerTube：用 ANDROID 客户端取字幕轨道。页面里的 baseUrl 现在带 &exp=xpe，
  // 直接 fetch 会被 PoToken 风控返回 200 空 body；ANDROID 客户端的字幕 URL 不受此限制。
  const INNERTUBE_KEY_FALLBACK = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const ANDROID_CLIENT_VERSION = "20.10.38";

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
          if (["originalColor", "translatedColor", "originalSize", "translatedSize", "fontScale", "bilingual"].includes(key)) {
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

    // 优先用 ANDROID InnerTube 客户端取字幕轨道（绕开页面 baseUrl 的 PoToken 风控）
    let tracks = [];
    try {
      tracks = await fetchCaptionTracksAndroid(videoId);
    } catch (e) {
      LOG("ANDROID 取字幕轨道失败:", e.message);
    }

    if (!tracks || tracks.length === 0) {
      // 兜底：页面 ytInitialPlayerResponse
      const playerResponse = await getPlayerResponse();
      if (token !== loadToken) return;
      tracks = extractTracks(playerResponse) || [];
    }

    if (!tracks || tracks.length === 0) {
      LOG("该视频没有可用字幕轨道");
      showToast("该视频没有可用字幕轨道（需要视频本身带 CC 字幕）", true);
      return;
    }

    const track = pickTrack(tracks);
    if (!track) return;

    const cues = await fetchCues(track.baseUrl);
    if (token !== loadToken) return;
    if (!cues.length) {
      LOG("字幕内容为空");
      showToast("字幕内容为空：可能被 YouTube 风控拦截（需要 PO token）", true);
      return;
    }

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

  /** 从页面脚本里找 InnerTube API Key（找不到就用公开 key） */
  function getInnertubeKey() {
    try {
      const scripts = document.querySelectorAll("script");
      for (const s of scripts) {
        const t = s.textContent;
        if (!t || t.indexOf("INNERTUBE_API_KEY") === -1) continue;
        const m = t.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
        if (m && m[1]) return m[1];
      }
    } catch (e) {
      /* ignore */
    }
    return INNERTUBE_KEY_FALLBACK;
  }

  /** 用 ANDROID InnerTube 客户端拿字幕轨道（其 baseUrl 不带 PoToken 风控） */
  async function fetchCaptionTracksAndroid(videoId) {
    const key = getInnertubeKey();
    const version = ANDROID_CLIENT_VERSION;
    const body = {
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: version,
          androidSdkVersion: 30,
          hl: "en",
          gl: "US",
          userAgent: "com.google.android.youtube/" + version + " (Linux; U; Android 11) gzip",
        },
      },
      videoId: videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    };

    const resp = await fetch(
      "https://www.youtube.com/youtubei/v1/player?key=" + encodeURIComponent(key) + "&prettyPrint=false",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-YouTube-Client-Name": "3",
          "X-YouTube-Client-Version": version,
        },
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const j = await resp.json();
    return (
      (j.captions &&
        j.captions.playerCaptionsTracklistRenderer &&
        j.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      []
    );
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

    cues.sort((a, b) => a.start - b.start);

    // 计算结束时间，并合并相邻完全相同的文本
    const merged = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const next = cues[i + 1];
      const end = c.start + (c.dur > 0 ? c.dur : next ? next.start - c.start : 4000);
      const prev = merged[merged.length - 1];
      if (prev && prev.text === c.text && c.start <= prev.end + 200) {
        prev.end = Math.max(prev.end, end);
        continue;
      }
      merged.push({ start: c.start, end: Math.max(end, c.start + 300), dur: c.dur, text: c.text });
    }
    return merged;
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

      done += chunk.length;
      if (statusEl) statusEl.textContent = "翻译中… " + done + "/" + pending.length;
      renderCue(lastIndex, true);
      scheduleSavePersistent();
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

  function applyStyles() {
    if (!box) return;
    const s = config.fontScale || 1;
    if (originalEl) {
      originalEl.style.color = config.originalColor;
      originalEl.style.fontSize = Math.round((config.originalSize || 18) * s) + "px";
    }
    if (translatedEl) {
      translatedEl.style.color = config.translatedColor;
      translatedEl.style.fontSize = Math.round((config.translatedSize || 24) * s) + "px";
    }
    if (originalEl) originalEl.style.display = config.bilingual ? "" : "none";
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
