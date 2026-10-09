/**
 * content.js — YouTube 字幕翻译器 Content Script
 * 注入 YouTube 页面，获取字幕、翻译并展示
 */

(function () {
  "use strict";

  // ==================== 配置 ====================
  let config = {
    enabled: true,
    bilingual: true,
    targetLang: "zh-CN",
    fontSize: "medium",
    translator: "google",
    apiKey: "",
    apiEndpoint: "",
  };

  // ==================== 状态 ====================
  let translateBtn = null;
  let subtitleContainer = null;
  let isTranslating = false;
  let translatedCache = new Map(); // 缓存已翻译的文本
  let currentVideoId = null;
  let captionTracks = []; // 可用字幕轨道列表
  let selectedTrack = null;
  let originalTimedtextUrl = null;
  let captionsData = []; // 解析后的字幕 [{start, duration, text}]
  let lastShownIndex = -1;

  // ==================== 初始化 ====================
  function init() {
    loadConfig();
    observePageChanges();
  }

  /** 从 storage 加载配置 */
  function loadConfig() {
    chrome.storage.sync.get(config, (stored) => {
      config = { ...config, ...stored };
    });
  }

  /** 监听来自 popup 的配置更新 */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "CONFIG_UPDATED") {
      config = { ...config, ...msg.config };
      // 更新字幕样式
      updateSubtitleStyle();
    }
  });

  /** 观察 YouTube SPA 页面变化 */
  function observePageChanges() {
    // 等待播放器出现
    const observer = new MutationObserver(() => {
      const videoId = getVideoId();
      if (videoId !== currentVideoId) {
        currentVideoId = videoId;
        cleanup();
        if (videoId) {
          waitForPlayer().then(() => {
            injectTranslateButton();
            if (config.enabled) {
              loadCaptionTracks();
            }
          });
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // 初始加载
    const videoId = getVideoId();
    if (videoId) {
      currentVideoId = videoId;
      waitForPlayer().then(() => {
        injectTranslateButton();
        if (config.enabled) {
          loadCaptionTracks();
        }
      });
    }
  }

  /** 获取当前视频 ID */
  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("v") || null;
  }

  /** 等待播放器加载完成 */
  function waitForPlayer() {
    return new Promise((resolve) => {
      const check = () => {
        const player = document.querySelector("#movie_player") || document.querySelector("video");
        if (player) {
          resolve(player);
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    });
  }

  // ==================== 翻译按钮注入 ====================
  function injectTranslateButton() {
    if (document.getElementById("yt-sub-translator-btn")) return;

    // 找到控制栏右侧按钮区域
    const controlsRight = document.querySelector(".ytp-right-controls");
    if (!controlsRight) return;

    translateBtn = document.createElement("button");
    translateBtn.id = "yt-sub-translator-btn";
    translateBtn.innerHTML = '<span class="icon">🌐</span><span>翻译</span>';
    translateBtn.title = "翻译字幕";

    if (config.enabled) {
      translateBtn.classList.add("active");
    }

    translateBtn.addEventListener("click", toggleTranslation);

    // 插入到控制栏最前面
    controlsRight.parentNode.insertBefore(translateBtn, controlsRight);
  }

  /** 切换翻译状态 */
  async function toggleTranslation() {
    config.enabled = !config.enabled;

    if (translateBtn) {
      translateBtn.classList.toggle("active", config.enabled);
    }

    // 保存状态
    chrome.storage.sync.set({ enabled: config.enabled });

    if (config.enabled) {
      if (captionsData.length === 0) {
        await loadCaptionTracks();
      } else {
        startSubtitleDisplay();
      }
    } else {
      removeSubtitleContainer();
    }
  }

  // ==================== 字幕获取 ====================
  /** 从 YouTube 页面数据中提取字幕轨道 */
  async function loadCaptionTracks() {
    try {
      // 方法1: 从 ytInitialPlayerResponse 获取
      let playerResponse = null;

      // 尝试从页面脚本获取
      if (window.ytInitialPlayerResponse) {
        playerResponse = window.ytInitialPlayerResponse;
      }

      // 方法2: 从页面 HTML 中解析
      if (!playerResponse) {
        playerResponse = extractPlayerResponseFromPage();
      }

      // 方法3: 通过 YouTube API 获取
      if (!playerResponse) {
        playerResponse = await fetchPlayerResponse();
      }

      if (playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
        captionTracks = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
        selectBestTrack();
      } else {
        console.log("[字幕翻译器] 未找到字幕轨道");
      }
    } catch (err) {
      console.error("[字幕翻译器] 获取字幕轨道失败:", err);
    }
  }

  /** 从页面 HTML 提取 playerResponse */
  function extractPlayerResponseFromPage() {
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const content = script.textContent;
      const match = content.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch (e) {
          continue;
        }
      }
    }
    return null;
  }

  /** 通过网络请求获取 playerResponse */
  async function fetchPlayerResponse() {
    const videoId = getVideoId();
    if (!videoId) return null;

    try {
      const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
      const html = await resp.text();
      const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
      if (match) {
        return JSON.parse(match[1]);
      }
    } catch (e) {
      console.error("[字幕翻译器] fetchPlayerResponse 失败:", e);
    }
    return null;
  }

  /** 选择最佳字幕轨道（优先英文字幕） */
  function selectBestTrack() {
    if (captionTracks.length === 0) return;

    // 优先选择英文
    let track = captionTracks.find(
      (t) => t.languageCode === "en" || t.languageCode?.startsWith("en")
    );

    // 其次选择第一个非目标语言字幕
    if (!track) {
      track = captionTracks.find((t) => t.languageCode !== config.targetLang);
    }

    // 最后选第一个
    if (!track) {
      track = captionTracks[0];
    }

    selectedTrack = track;
    loadSubtitleData(track.baseUrl);
  }

  /** 加载字幕 XML 数据 */
  async function loadSubtitleData(url) {
    if (!url) return;

    // 添加格式参数获取 JSON3 格式
    const separator = url.includes("?") ? "&" : "?";
    const fetchUrl = url + separator + "fmt=json3";

    try {
      const resp = await fetch(fetchUrl, { credentials: "include" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      captionsData = [];
      if (data.events) {
        for (const event of data.events) {
          if (!event.segs) continue;
          const text = event.segs.map((s) => s.utf8 || "").join("").trim();
          if (text) {
            captionsData.push({
              start: event.tStartMs || 0,
              duration: event.dDurationMs || 0,
              text: text,
            });
          }
        }
      }

      console.log(`[字幕翻译器] 已加载 ${captionsData.length} 条字幕`);

      // 预翻译所有字幕
      if (config.enabled) {
        preTranslateAll();
        startSubtitleDisplay();
      }
    } catch (err) {
      console.error("[字幕翻译器] 加载字幕数据失败:", err);
    }
  }

  // ==================== 翻译 ====================
  /** 预翻译全部字幕 */
  async function preTranslateAll() {
    if (captionsData.length === 0) return;

    // 批量翻译：每 20 条一批
    const batchSize = 20;
    isTranslating = true;

    for (let i = 0; i < captionsData.length; i += batchSize) {
      if (!config.enabled) break; // 用户关闭了翻译

      const batch = captionsData.slice(i, i + batchSize);
      const textsToTranslate = batch
        .map((c) => c.text)
        .filter((t) => t && !translatedCache.has(t));

      if (textsToTranslate.length === 0) continue;

      // 用换行符连接，一次翻译
      const combinedText = textsToTranslate.join("\n");

      try {
        const result = await sendMessageToBackground("TRANSLATE", {
          text: combinedText,
          targetLang: config.targetLang,
          translator: config.translator,
          apiKey: config.apiKey,
          apiEndpoint: config.apiEndpoint,
        });

        if (result.error) {
          console.error("[字幕翻译器] 翻译错误:", result.error);
          continue;
        }

        const translatedLines = result.split("\n");

        // 匹配回原文
        let transIdx = 0;
        for (const cap of batch) {
          if (cap.text && !translatedCache.has(cap.text)) {
            translatedCache.set(cap.text, translatedLines[transIdx] || cap.text);
            transIdx++;
          }
        }
      } catch (err) {
        console.error("[字幕翻译器] 批量翻译失败:", err);
      }

      // 间隔避免频率限制
      await sleep(300);
    }

    isTranslating = false;
  }

  /** 发送消息给 background script */
  function sendMessageToBackground(type, data) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...data }, resolve);
    });
  }

  // ==================== 字幕显示 ====================
  function startSubtitleDisplay() {
    if (!subtitleContainer) {
      createSubtitleContainer();
    }

    // 监听视频时间更新
    const video = document.querySelector("video");
    if (!video) return;

    video.addEventListener("timeupdate", onTimeUpdate);
    // 确保只绑定一次
    video._ytSubListenerAdded = true;
  }

  function onTimeUpdate() {
    if (!config.enabled) return;

    const video = document.querySelector("video");
    if (!video) return;

    const currentTime = video.currentTime * 1000; // 转为毫秒
    const newIndex = findCurrentCaptionIndex(currentTime);

    if (newIndex !== lastShownIndex && newIndex >= 0) {
      lastShownIndex = newIndex;
      displayCaption(captionsData[newIndex]);
    } else if (newIndex < 0 && lastShownIndex >= 0) {
      lastShownIndex = -1;
      clearCaptionDisplay();
    }
  }

  function findCurrentCaptionIndex(timeMs) {
    for (let i = 0; i < captionsData.length; i++) {
      const cap = captionsData[i];
      if (timeMs >= cap.start && timeMs <= cap.start + cap.duration) {
        return i;
      }
    }
    return -1;
  }

  /** 显示单条字幕 */
  function displayCaption(caption) {
    if (!subtitleContainer) return;

    const translated = translatedCache.get(caption.text) || caption.text;

    let html = "";
    if (config.bilingual) {
      html = `
        <div class="yt-sub-line">
          <span class="original">${escapeHtml(caption.text)}</span>
          <span class="translated">${escapeHtml(translated)}</span>
        </div>
      `;
    } else {
      html = `
        <div class="yt-sub-line">
          <span class="translated">${escapeHtml(translated)}</span>
        </div>
      `;
    }

    subtitleContainer.innerHTML = html;
  }

  function clearCaptionDisplay() {
    if (subtitleContainer) {
      subtitleContainer.innerHTML = "";
    }
  }

  // ==================== 字幕容器 ====================
  function createSubtitleContainer() {
    const playerContainer = document.querySelector("#movie_player") || document.querySelector(".html5-video-container");
    if (!playerContainer) return;

    // 确保容器可以定位
    const container = playerContainer.closest(".ytd-player") || playerContainer;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    subtitleContainer = document.createElement("div");
    subtitleContainer.id = "yt-translated-subtitles";
    subtitleContainer.className = `yt-sub-${config.fontSize}`;

    // 拖拽提示
    const hint = document.createElement("div");
    hint.id = "yt-sub-drag-hint";
    hint.textContent = "↕ 拖拽调整位置";
    subtitleContainer.appendChild(hint);

    container.appendChild(subtitleContainer);

    // 启用拖拽
    enableDrag(subtitleContainer, container);
  }

  function updateSubtitleStyle() {
    if (subtitleContainer) {
      subtitleContainer.className = `yt-sub-${config.fontSize}`;
    }
  }

  function removeSubtitleContainer() {
    if (subtitleContainer) {
      subtitleContainer.remove();
      subtitleContainer = null;
    }
    clearCaptionDisplay();
    lastShownIndex = -1;

    // 移除 timeupdate 监听
    const video = document.querySelector("video");
    if (video && video._ytSubListenerAdded) {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video._ytSubListenerAdded = false;
    }
  }

  // ==================== 拖拽功能 ====================
  function enableDrag(element, boundary) {
    let isDragging = false;
    let startY = 0;
    let startBottom = 0;

    element.style.pointerEvents = "auto";

    element.addEventListener("mousedown", (e) => {
      // 仅在字幕内容区域拖拽
      if (e.target.closest(".yt-sub-line") || e.target === element || e.target.id === "yt-sub-drag-hint") {
        isDragging = true;
        startY = e.clientY;
        startBottom = parseInt(element.style.bottom) || 60;
        element.classList.add("dragging");
        e.preventDefault();
      }
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const deltaY = startY - e.clientY; // 向上拖 = 增大 bottom
      const newBottom = Math.max(10, Math.min(startBottom + deltaY, boundary.offsetHeight - 50));
      element.style.bottom = newBottom + "px";
    });

    document.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        element.classList.remove("dragging");
      }
    });
  }

  // ==================== 清理 ====================
  function cleanup() {
    removeSubtitleContainer();
    if (translateBtn) {
      translateBtn.remove();
      translateBtn = null;
    }
    captionsData = [];
    translatedCache.clear();
    captionTracks = [];
    selectedTrack = null;
    lastShownIndex = -1;
    isTranslating = false;
  }

  // ==================== 工具函数 ====================
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ==================== 启动 ====================
  init();
})();
