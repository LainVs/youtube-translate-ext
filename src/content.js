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
    // google = 免费端点，秒回但质量一般
    // ai     = 本地 LLM 桥接（8788），质量高但每批几秒
    translator: "ai",
    // AI（OpenAI 兼容接口，默认指向本地 bridge）
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
    // 断句阈值。实测 1200ms 太激进：人说话的自然换气经常超过
    // 1.2 秒，会把完整的一句从中间切断
    //（"I think some part of me just knew before" + "I did." 被切成两句）。
    // 提到 2500，且当上一句还没收尾时会自动放宽到 8.75 秒。
    mergeMaxGapMs: 2500,
    // 逐字揭示：整句送翻译（保证质量），但只显示"人已经说到"的部分。
    // 关掉就是整句一次性显示。
    revealAsSpoken: true,
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
  // 逐字揭示用：记录上一帧显示到第几个字符，避免无谓重排
  let lastRevealCount = -1;
  // 长句自动缩字号：记录是为哪条字幕量的高，避免每帧重排
  let fitScale = 1;
  let fitForIdx = -1;
  let fitHadTr = false;
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
          cues = finalizeCues(parseCuesFromBody(r.body), config.mergeBySentence);
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
 * 在一段已攒好的文本里找出「内部句末标点」的位置。
 * 返回断点之后**下一个词的起始下标**；没有可断点返回 -1。
 *
 * 例："And you were struggling, too. It was really hard."
 *     -> 返回 "It" 的下标（已跳过中间的空格）
 *
 * 用途见 mergeCuesToSentences 里的兜底收口：
 * 防止两条都以句号结尾的碎片被粘成一句。
 */
  function findInnerSentenceEnd(text) {
    const t = String(text || "");
    if (!t) return -1;
    const re = /[.!?…。！？]["'”’)\]】》」』]*(\s+\S)/g;
    const hits = [];
    let m;
    while ((m = re.exec(t)) !== null) {
      hits.push({ punct: m.index, cut: m.index + m[0].length - m[1].length });
    }
    if (!hits.length) return -1;

    // 从最后一个断点往前找，选第一个「真句末」。
    // 从后往前是必要的：只取最后一个的话，
    //   "He left. Then see Mr. Smith"
    // 的最后一个句点在 "Mr." 后面，会被缩写规则挡掉，
    // 于是前面那个合法的 "left." 断点也一起丢了。
    for (let k = hits.length - 1; k >= 0; k--) {
      if (t.charAt(hits[k].punct) === "." && isAbbreviationBefore(t.slice(0, hits[k].punct))) {
        continue; // "Mr." / "p.m." / "J." 这类不是句末
      }
      // cut 目前紧贴句末标点，往后跳过空白，让 tail 从**词首**开始。
      // 否则 splitBuf 切出来的 tail 会带前导空格，
      // 叠加后续的 " " + piece 连接后就出现双空格，译文里可能变成断词。
      let cut = hits[k].cut;
      while (/\s/.test(t.charAt(cut))) cut++;
      const tail = t.slice(cut);
      if (!tail.trim()) continue;
      // ⚠️ tail 必须像一个新句子的开头（大写字母 / 数字 / CJK），
      // 否则很可能是 ASR 标点错误，把一句话从中间劈开了。
      // 真实数据："…don't tell me your truth. to see."
      // 的 "to see." 是上一句的延续（小写开头），切开会留下一个
      // 2 词孤立残句；宁可保持粘连，也不要制造碎片。
      const first = tail.replace(/^["'“”‘’（(\[]+/, "").charAt(0);
      if (first && /[a-z]/.test(first)) continue;
      return cut;
    }
    return -1;
  }

  /**
   * 判断句点前的那个词是不是缩写 —— 它后面的点不能当句末标点。
   *
   * 实测会被误切的写法：
   *   "Mr. Smith went home."    -> 断成 "Mr." + "Smith went home."
   *   "She left at 5 p.m. yesterday." -> 断成 "…p.m." + "yesterday."
   *   "J. Smith arrived."       -> 断成 "J." + "Smith arrived."
   * 小数 "28.5" 天然安全（句点后没有空格，正则匹配不到）。
   */
  const ABBREVIATIONS =
    /^(?:mr|mrs|ms|dr|prof|rev|hon|gen|col|capt|cmdr|lt|sgt|jr|sr|st|mt|vs|etc|no|vol|fig|dept|est|inc|ltd|co|corp|approx|min|max|ca|cf|al|jd|phd|md|ba|ma|bs|am|pm|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i;

  function isAbbreviationBefore(s) {
    // s = 句点之前的内容（不含句点），取最后一个词
    const tok = (String(s || "").match(/[A-Za-z.]+$/) || [""])[0];
    if (!tok) return false;
    // ⚠️ "I" 永远不是缩写，它是代词"我"。
    // 不加这个例外，"…and so do I. I feel…" 的 "I." 会被当成首字母缩写，
    // 导致两个完整句粘在一起分不开（真实数据里实测踩到）。
    // 小写 "a" 是冠词，也不可能是缩写；大写 "A" 保留（可能是 "A. Smith"）。
    if (tok === "I" || tok === "i" || tok === "a") return false;
    if (tok.length === 1) return true; // J. K. 这类首字母
    if (tok.indexOf(".") >= 0) return true; // e.g. i.e. p.m. u.s.
    return ABBREVIATIONS.test(tok);
  }

  /**
   * 判断一条字幕是否是「残句」—— 语法上依附前句、不能独立翻译的片段。
   *
   * 实测踩到的坑：ASR 把
   *   "I think some part of me just knew before"  +  "I did."
   * 切成两条。第一条没有谓语收尾，第二条只有「代词 + 助动词」。
   * 各自翻译就得到：
   *   "我想我内心深处早就知道了"  +  "我懂了"
   * 而原文里的 did 是 know 的省略（"在我知道之前"），
   * 单独看只能译成「我做了 / 我懂了」，意思完全跑偏。
   *
   * 特征：代词/关系词 + 助动词开头，且没有自己的主语。
   */
  const FRAGMENT_STARTERS =
    /^(?:i|you|he|she|it|we|they|who|which|that|there)\s+(?:did|do|does|was|were|am|is|are|had|has|have|can|could|will|would|should|shall|may|might|must|been|being)\b/i;

  // 允许残句以连接词开头（and/but/or/so/because…），
  // 但要求连接词后面紧跟「代词+助动词」，否则 "That was a great movie."
  // 这种正常句会被误判。
  const FRAGMENT_CONNECTED =
    /^(?:and|but|or|so|because|then|though|although|while|when|if)\s+(?:i|you|he|she|it|we|they)\s+(?:did|do|does|was|were|am|is|are|had|has|have|can|could|will|would|should|shall|may|might|must|been|being)\b/i;

  function isSentenceFragment(text) {
    const t = String(text || "").trim();
    if (!t) return false;

    // ⚠️ 有句末标点不代表是完整句，得先看它是不是只有「代词+助动词」。
    //
    // "And you were struggling, too." 带句号，但你 were 后面还有宾语，
    // 是完整句 -> 不能当残句，否则不会收口，会把下一句拖进来粘在一起。
    //
    // "I did." 同样带句号，但整条只有代词+助动词，没有主语也没有宾语，
    // 语法上依附前句 -> 必须当残句接回去，
    // 否则 "…before I did." 会被切成两句，did 译成「我做了」。
    //
    // 所以判据是「去掉句末标点后，是否只剩代词+助动词」。
    const bare = t.replace(/[.!?…。！？]+$/, "").trim();
    // "只有代词+助动词"才算残句；只要后面还跟着别的成分
    // （宾语/表语/状语…）就是完整句。
    // "I did." 去掉句号后是 "I did" -> 纯残句
    // "And you were struggling, too." 去掉句号后还有 4 个词 -> 完整句
    const bareWords = bare.split(/\s+/).filter(Boolean);
    const onlyPronounAux =
      bareWords.length <= 3 &&
      (FRAGMENT_STARTERS.test(bare) || FRAGMENT_CONNECTED.test(bare));
    if (endsSentence(t) && !onlyPronounAux) return false;

    const words = t.replace(/[.!?]+$/, "").split(/\s+/).filter(Boolean);
    // 超过 8 个词，多半是真句子而不是残句
    if (words.length > 8) return false;
    if (FRAGMENT_CONNECTED.test(t)) return true;
    // 主形态：整条几乎就是「代词 + 助动词 (+ 最多两个修饰词)」
    if (words.length <= 3 && FRAGMENT_STARTERS.test(t)) return true;
    // 以逗号/顿号结尾的短插入语
    if (/[,，、]$/.test(t) && words.length <= 6) return true;
    return false;
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

  /**
   * 拼接碎片成完整句，但**同时保留每个碎片在整句里的字符偏移与时间**。
   *
   * 这是「翻译用整句、显示用切片」的基础：
   *   - text是整句 -> 送去翻译，质量有保证（不会断头断尾）
   *   - parts[]   -> 播放时按当前时间算出「已经说到哪」，只显示到那
   *
   * 不保留 parts 的话，合并后就只剩一条从 0ms 持续到 13s 的长字幕，
   * 开口第一个字整句就全显示出来了（这正是上一版的毛病）。
   */
  function mergeCuesToSentences(cues, maxChars, maxGapMs) {
    const out = [];
    let buf = null;

    const flush = () => {
      if (buf && buf.text.trim()) out.push(buf);
      buf = null;
    };

    const startNew = (c, piece) => {
      buf = {
        start: c.start, end: c.end, dur: c.dur, text: piece,
        parts: [{ startChar: 0, endChar: piece.length, start: c.start, end: c.end }],
      };
    };

    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      // 过滤 [Music]/[音乐]/[Applause] 这类非语音标记，
      // 过滤后变成空的碎片直接丢（例如整条只有 "[Music]"）。
      const piece = stripNonSpeech(c.text);
      if (!piece) continue; // 纯空白或纯音乐标记

      if (!buf) {
        startNew(c, piece);
      } else {
        // 间隔过大（> maxGapMs）视为另一段话，不硬拼
        const gap = c.start - buf.end;
        const tooLong = (buf.text + " " + piece).length > maxChars;

        // 上一句还没收尾（没有句末标点）时，间隔阈值放宽到 8 秒。
        // 原因：人说话的自然换气经常超过 1.2 秒，原来的 maxGapMs=1200
        // 太激进，会把一句完整的话从中间切断。
        const prevOpen = !endsSentence(buf.text);
        // 上一句还缺收尾时，把「换气停顿」和「真的换话题」区分开：
        // 人说话中间的换气很少超过 8 秒，超过这个量级基本是另起一段了。
        const limit = prevOpen ? Math.max(maxGapMs, 8000) : maxGapMs;
        let tooFar = gap > limit;

        // 「残句」豁免：I did. / and he was. 这类依附前句的片段，
        // 无论间隔多久、前面有没有收尾，都必须接回上一句，
        // 否则会被当成独立句子翻译，意思完全跑偏。
        const frag = isSentenceFragment(piece);
        // 前一句残缺（没谓语收尾）时更该接回去
        const prevIncomplete = prevOpen;
        if (frag && prevIncomplete && !tooLong) {
          tooFar = false;
        }

        if (tooFar || tooLong) {
          // 先收口已有内容，当前句另起（保持顺序，不丢字）
          flush();
          startNew(c, piece);
        } else {
          // 追加前先记下偏移：分隔符是 1 个空格
          const startChar = buf.text.length + 1;
          buf.text = buf.text + " " + piece;
          buf.parts.push({
            startChar: startChar,
            endChar: buf.text.length,
            start: c.start,
            end: c.end,
          });
          buf.end = Math.max(buf.end, c.end);
          buf.dur = buf.end - buf.start;
        }
      }

      // 兜底收口：buf 里如果已经出现了「句末标点 + 后面还有内容」，
      // 说明前面的碎片已经自成一句，必须在那个句号处断开。
      //
      // 修复的实际案例（用户截图）：ASR 把
      //   "And you were struggling, too." + "It was really hard."
      // 切成两条，第一条是完整句却不收口（被残句规则挡住），
      // 结果粘成 "And you were struggling, too. It was really hard."。
      //
      // 这里必须走 splitBuf —— 直接改 buf.end 是上一版的 bug：
      //   buf.end = Math.max(buf.start, splitAt)   // splitAt 是字符下标！
      // 毫秒和字符混用，结果 end 恒等于 start，
      // 而 findCue 要求 t 落在 [start,end] 内，于是头部那句**永远不显示**。
      if (findInnerSentenceEnd(buf.text) > 0) {
        const pieces = splitAll(buf);
        // 前 n-1 段都是完整句，直接收口；最后一段继续攒
        for (let k = 0; k < pieces.length - 1; k++) out.push(pieces[k]);
        buf = pieces[pieces.length - 1];
      }

      // 拼到句末标点就收口；但如果这条本身是残句（I did.），
      // 它不该结束句子 —— 前一句还等着它补完谓语。
      if (buf && endsSentence(buf.text) && !isSentenceFragment(piece)) flush();
    }
    flush();
    return out;
  }

  /**
   * 把一条已攒好的 cue 从字符下标 cut 处拆成 head / tail 两段，
   * **同时按字符比例把时间轴和 parts[] 一起切开**。
   *
   * 这是上一版 bug 的正解：拆文本时必须连带拆时间，
   * 否则 head.end 要么退化成 start（字幕不显示），
   * 要么被算成 tail 的时间（头部整段被跳过）。
   *
   * 一段 part 横跨断点时（说明切在了某个 cue 内部），
   * 按字符比例插值出边界时间，这样 head 和 tail 严丝合缝、不重不漏。
   */
  function splitBuf(buf, cut) {
    const t = buf.text;
    const headText = t.slice(0, cut).trimEnd();
    const tailText = t.slice(cut);
    if (!headText || !tailText.trim()) return null;

    const parts =
      buf.parts && buf.parts.length
        ? buf.parts
        : [{ startChar: 0, endChar: t.length, start: buf.start, end: buf.end }];

    const headParts = [];
    const tailParts = [];
    let headEnd = buf.start;
    let tailStart = buf.end;

    for (const p of parts) {
      const s = p.startChar;
      const e = p.endChar;
      if (e <= cut) {
        headParts.push({ startChar: s, endChar: Math.min(e, headText.length), start: p.start, end: p.end });
        headEnd = Math.max(headEnd, p.end);
      } else if (s >= cut) {
        tailParts.push({ startChar: s - cut, endChar: e - cut, start: p.start, end: p.end });
        tailStart = Math.min(tailStart, p.start);
      } else {
        // 横跨断点：按字符占比把这一片的时间劈开
        const frac = e > s ? (cut - s) / (e - s) : 0;
        const b = Math.round(p.start + (p.end - p.start) * frac);
        headParts.push({ startChar: s, endChar: headText.length, start: p.start, end: b });
        tailParts.push({ startChar: 0, endChar: Math.max(0, e - cut), start: b, end: p.end });
        headEnd = Math.max(headEnd, b);
        tailStart = Math.min(tailStart, b);
      }
    }

    // parts 覆盖不全时的兜底：保证 head/tail 都有可用的时间与偏移
    if (!headParts.length) {
      headEnd = buf.start;
      headParts.push({ startChar: 0, endChar: headText.length, start: buf.start, end: headEnd });
    }
    if (!tailParts.length) {
      tailStart = buf.end;
      tailParts.push({ startChar: 0, endChar: tailText.length, start: tailStart, end: buf.end });
    }

    // 关键 1：head.end 必须严格大于 head.start，
    // 否则 findCue 的 [start,end] 区间是空集，这条字幕永远选不中。
    const headEndFinal = Math.max(headEnd, buf.start + 300);
    // 关键 2：tail.start 必须不早于 head.end。
    // 两条 start 相同时（整条 cue 被从中间劈开就是这种情况），
    // findCue 的二分会优先返回**下标更大**的那条，head 就永远轮不到显示。
    const tailStartFinal = Math.max(tailStart, headEndFinal);
    const tailEndFinal = Math.max(buf.end, tailStartFinal + 300);
    const head = {
      start: buf.start,
      end: headEndFinal,
      dur: headEndFinal - buf.start,
      text: headText,
      parts: headParts,
    };
    const tail = {
      start: tailStartFinal,
      end: tailEndFinal,
      dur: tailEndFinal - tailStartFinal,
      text: tailText,
      parts: tailParts,
    };
    return { head, tail };
  }

  /** 递归把一条 cue 里所有内部句末断点都切开（一次只能切最后一个） */
  function splitAll(buf) {
    const queue = [buf];
    const done = [];
    let guard = 0;
    while (queue.length && guard++ < 64) {
      const cur = queue.shift();
      if (findInnerSentenceEnd(cur.text) <= 0) {
        done.push(cur);
        continue;
      }
      const sp = splitBuf(cur, findInnerSentenceEnd(cur.text));
      if (!sp) {
        done.push(cur);
        continue;
      }
      // head 在前、tail 在后，保证输出顺序
      queue.unshift(sp.tail);
      queue.unshift(sp.head);
    }
    // 守卫触发时把剩余的段全部补上 —— 丢一段就是丢一段字幕
    while (queue.length) done.push(queue.shift());
    return done.length ? done : [buf];
  }

  /**
   * 按当前播放位置算出「已经显示到第几个小句」。
   *
   * 粒度是**小句**（ASR 碎片），不是单字：
   * 一句话常常是 "Back when we were kids," + "we'd be at recess" +
   * "and I'd look over at you" + ... 这样一串短句拼起来的。
   * 显示时按小句整段推进，读起来才是一句一句，而不是一个字一个字蹦。
   *
   * 依据 parts[] 里的碎片时间轴 —— 来自真实 ASR 字幕，
   * 比按字数平均分配准得多。
   *
   * @returns {number} 已说出的字符数（对齐到小句边界）
   */
  function spokenCharCount(cue, t) {
    if (!cue) return 0;
    const total = cue.text.length;
    const parts = cue.parts;
    if (!parts || !parts.length) return total;
    if (t >= cue.end) return total;
    if (t < cue.start) return 0;

    // 小句一旦开始就整段显示（字幕惯例：不等说完再亮）
    // 这样每片平均 2~3 秒，视觉上是「一句一句」推进。
    //
    // ⚠️ 必须取 max 而不是「最后一个满足条件的」：
    // ASR 相邻 cue 的时间窗本来就互相重叠，splitBuf 切完之后
    // parts[] 里完全可能出现后一个 part 的 start 比前一个还早。
    // 实测真实数据：parts=[[207582,211879],[206840,208100]] ——
    // 用「最后一个」会让已显示的文本又缩回去，肉眼看到字幕倒退。
    let reached = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (t >= p.start && p.endChar > reached) reached = p.endChar;
    }
    return reached;
  }

  /**
   * 把 n 处的切点回退到词边界，避免译文/原文被劈成两半：
   *   "imagin" + "两个人..."  ->  "imagine" + "两个人..."
   * 中文没有词间空格，逐字切是正常的，原样返回。
   */
  function cutAtWord(text, n) {
    const s = String(text || "");
    if (n >= s.length) return s;
    if (n <= 0) return "";
    const before = s.charAt(n - 1);
    const at = s.charAt(n);
    // 只有「切进了拉丁词中间」才需要回退
    if (!/[A-Za-z0-9]/.test(before) || !/[A-Za-z0-9]/.test(at)) return s.slice(0, n);
    let i = n;
    while (i > 0 && /[A-Za-z0-9'’-]/.test(s.charAt(i - 1))) i--;
    // 退太多（整个长词占了切点前一大半）就不退了，宁可切在词里
    if (i <= 0 || i < n * 0.5) return s.slice(0, n);
    return s.slice(0, i);
  }

  /**
   * 「这句话还没说完」的视觉标记。
   *
   * 分句合并后，一条字幕里常有好几句，逐小句揭示时中间态必须有提示，
   * 否则读者会以为句子到此结束了（"We were struggling," 看着像结尾）。
   * 竞品给的正是这个省略号语感。
   *
   * 已经落在句末标点上时不加 —— 那说明这一句确实说完了。
   */
  function incompleteMark(s) {
    const t = String(s || "").replace(/\s+$/, "").replace(/[,，、;；:：]+$/, "");
    if (!t) return t;
    if (/[.!?…。！？]["'”’)\]】》」』]*$/.test(t)) return t;
    return t + "…";
  }

  /** 把整句译文按比例切成对应长度的片段，用于「贴合语音」地显示 */
  function sliceByRatio(text, ratio) {
    const s = String(text || "");
    if (!s) return "";
    if (ratio >= 1) return s;
    const n = Math.max(1, Math.round(s.length * ratio));
    let cut = cutAtWord(s, n);
    const m = cut.match(/[，,、。.!?！？；;：:]\s*$/);
    if (m) cut = cut.slice(0, cut.length - m[0].length);
    if (cut.length < 2 && s.length > 2) cut = cutAtWord(s, Math.min(s.length, 4));
    return cut.trim() || s.slice(0, n);
  }

  /**
   * 过滤掉非语音的听觉提示标记。
   *
   * YouTube 的 ASR 字幕里会夹带这类标签：
   *   [Music]  [音乐]  [Applause]  [Laughter]  [无声]
   *   (upbeat music)  (background music)
   * 它们不是台词，翻译出来是「[音乐]」，显示出来纯属噪音。
   * 实测一集视频里能遇到几十处，直接过滤掉。
   *
   * 只删这些已知的声音/画面提示，不动正常台词里的括号（如 "(pause)"）。
   */
  // 用两段拼出来，是因为 "upbeat music" / "background music" 这类
  // 带形容词的写法，单个 \s* 连不起来。
  const NON_SPEECH_RE = new RegExp(
    "[\\[（(]\\s*(?:" +
      "(?:upbeat|background|soft|loud|tense|up|tempo)?\\s*\\**\\s*music|" +
      "musical|sound\\s*track|bgm|" +
      "applause|applauding|clapping|clap|" +
      "laughter|laughing|laugh|chuckle|" +
      "cheering|cheer|audience|" +
      "silence|inaudible|unintelligible|muffled|" +
      "no\\s*speech|ambient\\s*(?:noise|sound)|crowd\\s*(?:noise|chatter|roar)|" +
      "gunshot|door\\s*slam|noise|" +
      "声音|音乐|纯音乐|背景音乐|" +
      "掌声|掌声雷动|笑声|笑声不断|欢呼|欢呼声|" +
      "寂静|无声|安静|听不清|模糊不清|噪音|人声嘈杂" +
    ")\\s*[\\]）)]",
    "gi"
  );

  function stripNonSpeech(text) {
    if (!text) return "";
    let out = String(text);
    // ASR 滚动字幕用 ">>" 标记「新增内容的起点」，
    // 例如 "I didn't understand it then, but >> [music] >> and now I do"
    // 这个标记不是台词，原文会显示成裸的 ">>"，译文里也可能被翻出来。
    // 这里直接去掉（保留它前后的文字）。
    out = out.replace(/\s*>>\s*/g, " ");
    out = out.replace(NON_SPEECH_RE, "");
    // 还有一种写法是直接裸写不带括号：Music / Applause / 笑声
    // 只在整条就是这些词时删，避免误伤正常句子里的 "music"。
    // 清理过滤后残留的孤立括号，如 "()"、"[]"
    out = out.replace(/[\[\(（]\s*[\]\)）]/g, "");
    // 清理因删除留下的多余空格（连续两个以上）
    out = out.replace(/\s{2,}/g, " ").trim();
    // 清理悬空的标点，如 "，" 开头或 " ，"
    // 只清「删除标记后遗留在边界」的标点：
    // 行首的逗号顿号，以及行尾的逗号顿号。
    // 行尾的句号/问号/叹号要留着 —— 那是字幕的结束标记，
    // 删了会让 endsSentence 失效，进而把整段话错误地并成一句。
    out = out.replace(/^[,，、;；]\s*/, "").replace(/[ \t]+[,，、;；]+$/, "");
    return out.trim();
  }

  /**
   * 排序 + 去重滚动窗口 + 计算结束时间
   * @param {boolean} bySentence 是否把碎片合并成完整句（决定翻译质量的关键开关）
   */
  /** 不合并时的出口：仍然要过滤 [Music] 这类非语音标记 */
  function stripAll(cues) {
    const out = [];
    for (const c of cues) {
      const t = stripNonSpeech(c.text);
      if (t) out.push(Object.assign({}, c, { text: t }));
    }
    return out;
  }

  function finalizeCues(cues, bySentence) {
    if (!cues.length) return [];
    cues.sort((a, b) => a.start - b.start);

    // 先算每条的结束时间
    //
    // ⚠️ ASR 的 d 是「识别窗口时长」，不是这句话真正说完的时间。
    // 实测真实 json3：cue(39559, "feeling. Got to make you understand.", d=6281)
    // 的原始 end = 45840，而下一句 "Never going to give you up." 在 43120 就开始了 ——
    // 重叠 2.7 秒。直接用 start+dur 当结束时间，会让相邻两条字幕互相重叠，
    // 而 findCue 只返回「start 更大且时间匹配」的那条：
    // 实测 44 条字幕里有 3 条（7%）永远显示不出来，读者会觉得字幕漏句。
    //
    // 所以有下一句时，把结束时间压到下一句的开始时间。
    // （人工字幕轨 d 准确，这个 clamp 依然成立：下一句开始就是上一句结束。）
    const withEnd = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      const next = cues[i + 1];
      const rawEnd = c.start + (c.dur > 0 ? c.dur : next ? next.start - c.start : 4000);
      const end = next && next.start > c.start + 100 ? Math.min(rawEnd, next.start) : rawEnd;
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
    // 160 是默认值，不能写 2500 —— 一旦 config.mergeMaxChars 未设置，
    // 2500 意味着几乎永不切分，长段落会攒成一坨。
    const maxChars = config.mergeMaxChars || 160;
    const maxGapMs = config.mergeMaxGapMs || 2500;

    // bySentence 只在明确为 false 时才关闭。
    // 之前写的是 if (!bySentence)，导致调用方漏传参数（undefined）
    // 时会静默退回「不合并」，连带把 stripNonSpeech 也跳过了，
    // 于是 [音乐] 这类标记漏到画面上。
    if (bySentence === false) return stripAll(deduped);
    const merged = mergeCuesToSentences(deduped, maxChars, maxGapMs);
    return deoverlap(merged);
  }

  /**
   * 兜底去重叠：把每条的结束时间压到下一条的开始时间。
   *
   * 上面已经把 end 压到 next.start 了，但拆分/clamp 的组合仍可能漏出重叠，
   * 而重叠的后果是实打实的：findCue 只返回 start 更大的那条，
   * 前一条字幕整段不显示（读者看到的就是「字幕漏了一句话」）。
   * 所以合成完之后再统一扫一遍，保证每个区间非空。
   */
  function deoverlap(list) {
    if (!list || list.length < 2) return list || [];
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (b.start < a.end) {
        // 起点相同（连压 end 的余地都没有）时，也给前一条留一段
        a.end = b.start > a.start ? b.start : a.start + 150;
        if (a.end <= a.start) a.end = a.start + 150;
        a.dur = a.end - a.start;
      }
    }
    return list;
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

  /**
   * 字号 = 配置字号 × 全局缩放 × 长句自适应缩放。
   * 单独抽出来是因为 fitTextToBox() 要反复调它试算高度。
   */
  function applyFontSizes(scale) {
    const k = (config.fontScale || 1) * (scale > 0 ? scale : 1);
    if (originalEl) originalEl.style.fontSize = Math.round((config.originalSize || 18) * k) + "px";
    if (translatedEl) translatedEl.style.fontSize = Math.round((config.translatedSize || 24) * k) + "px";
  }

  /**
   * 长句自动缩字号。
   *
   * 分句合并后单条字幕最长能到 160 个英文字符 + 对应译文，
   * 在小窗口里会折成 5~6 行，字幕框从底部往上顶，盖掉小半块画面
   * （字幕是 bottom 定位的，只会往上长，不会被裁掉）。
   *
   * 做法是**先用整句量高再缩**，而不是等揭示到一半再缩：
   *   - 整句高度是这条字幕的固定值 -> 量一次即可，不会随揭示进度抖动
   *   - 用整句算出的缩放能保证**任何时刻都不超限**
   *
   * 高度与字号近似成平方关系（字号变大 -> 每行字数变少 -> 行数变多），
   * 所以用 sqrt 迭代，2~3 轮就能收敛。
   * 缩放下限 0.6，再小就不如让它高一点了。
   */
  function fitTextToBox() {
    if (!box || !playerEl || !originalEl || !translatedEl) return -1;
    const ph = playerEl.clientHeight || 0;
    if (!ph) return -1;
    const maxH = Math.max(100, Math.round(ph * 0.42));
    const pad = (isFinite(Number(config.boxPadding)) ? Number(config.boxPadding) : 10) * 2;
    // 只量**两行字幕本身**，不要用 box.offsetHeight：
    //   - #ytbs-status 的「翻译中… 0/N」也在 box 里，量进去会多缩一截，
    //     而 status 很快就消失了，字号却不会自己变回来
    //   - 广告期间 box 是 display:none，两行都是 0，这时去量会记下错误基准
    const LINE_GAP = 4; // 与 content.css 的 gap 保持一致
    const lineH = () => originalEl.offsetHeight + translatedEl.offsetHeight + LINE_GAP;
    if (!lineH()) return -1;
    let scale = fitScale;

    for (let i = 0; i < 5; i++) {
      applyFontSizes(scale);
      // 强制回流拿真实高度。renderCue 每换一条字幕才走一次，开销可接受。
      const h = lineH();
      const avail = maxH - pad;
      if (h <= avail || scale <= 0.6) break;
      const ratio = Math.sqrt(Math.max(0.15, avail / Math.max(1, h)));
      scale = Math.max(0.6, scale * ratio);
    }
    applyFontSizes(scale);
    fitScale = scale;
    return scale;
  }

  function applyStyles() {
    if (!box) return;
    // 设置变了 -> 量高基准作废，下一条字幕重新算
    fitScale = 1;
    fitForIdx = -1;
    applyFontSizes(1);
    if (originalEl) {
      originalEl.style.color = config.originalColor;
      originalEl.style.fontWeight = fixCJKWeight(config.originalWeight);
    }
    if (translatedEl) {
      translatedEl.style.color = config.translatedColor;
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
      if (config.domKeepLatest) text = pickLatestSegment(text);
      // 同样要过滤 [Music]/[音乐] 这类非语音标记，
      // 否则 DOM 实时模式会把 "[音乐]" 一起翻出来显示。
      // 过滤后为空（整条只有音乐标记）时返回空串，
      // checkDomCaption 会把它当成「字幕消失」处理。
      return stripNonSpeech(text);
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

    // 逐字揭示：同一条字幕内部也要随播放进度刷新，
    // 否则整句会在开口第一帧就全部显示出来（剧透后面还没说到的内容）。
    let needRender = idx !== lastIndex;
    if (!needRender && config.revealAsSpoken && idx >= 0) {
      const cue = cueList[idx];
      if (cue && cue.parts && cue.parts.length > 1) {
        const n = spokenCharCount(cue, t);
        if (n !== lastRevealCount) needRender = true;
      }
    }

    if (needRender) {
      lastIndex = idx;
      renderCue(idx, false, t);
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

  /**
   * @param idx当前字幕下标
   * @param force 强制刷新
   * @param timeMs 当前播放位置（毫秒）。传入时用于逐字揭示计算，
   *              缺省则取当前时间。
   */
  function renderCue(idx, force, timeMs) {
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
    const tr = translationCache.get(cacheKey(cue.text));

    // 长句自适应缩字号：**先用整句量高**（高度是这条字幕的固定值，
    // 用整句量才不会随揭示进度抖，也能保证任何时刻都不超限），
    // 量完再切成揭示态。
    // 译文从无到有会改变高度，所以它也算一个重算触发条件。
    const hadTr = !!tr;
    const cueChanged = idx !== fitForIdx;
    if (cueChanged || hadTr !== fitHadTr) {
      // 换字幕必须从 1.0 重新量 —— 否则上一句缩到 0.6 后，
      // 后面所有短句都会跟着变小。
      if (cueChanged) fitScale = 1;
      originalEl.textContent = cue.text;
      translatedEl.textContent = tr || "…";
      // 量不到真实高度（还没布局 / 被隐藏）就**不记录**，
      // 让下一次渲染重新量，避免把错误的基准固化下来。
      if (fitTextToBox() >= 0) {
        fitForIdx = idx;
        fitHadTr = hadTr;
      }
    }

    // 逐字揭示：只显示"人已经说到"的部分。
    // 翻译仍然是对整句做的（缓存 key 是整句 text），
    // 只是显示时按比例切开译文，不剧透后面的内容。
    let showRatio = 1;
    let spoken = cue.text.length;
    if (config.revealAsSpoken && cue.parts && cue.parts.length > 1) {
      const t = typeof timeMs === "number" ? timeMs : nowMs();
      spoken = spokenCharCount(cue, t);
      showRatio = cue.text.length > 0 ? spoken / cue.text.length : 1;
      lastRevealCount = spoken;
    }

    // 切点先对齐词边界（避免 "imagin" 这种劈半的词），
    // 再补省略号表示「这句话还没说完」——
    // 分句合并后一条字幕里常有好几句，没有省略号读者会以为句子结束了。
    if (config.revealAsSpoken && showRatio < 1) {
      originalEl.textContent = incompleteMark(cutAtWord(cue.text, Math.max(1, spoken)));
    } else {
      originalEl.textContent = cue.text;
    }

    if (!tr) {
      translatedEl.textContent = "…";
    } else if (config.revealAsSpoken && showRatio < 1) {
      translatedEl.textContent = incompleteMark(sliceByRatio(tr, showRatio));
    } else {
      translatedEl.textContent = tr;
    }
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
