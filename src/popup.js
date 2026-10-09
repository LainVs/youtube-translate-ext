/** popup.js — 设置面板逻辑 */

const DEFAULTS = {
  enabled: true,
  bilingual: true,
  hideNative: false,
  targetLang: "zh-CN",
  translator: "google",
  aiBaseUrl: "http://localhost:8788/v1",
  aiApiKey: "",
  aiModel: "opencode/big-pickle",
  originalColor: "#ffffff",
  translatedColor: "#a7e8ff",
  originalSize: 18,
  translatedSize: 24,
  fontScale: 1,
  exportFormat: "srt",
  exportMode: "bilingual",
  trackLang: "",
};

const TARGET_LANGS = [
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
  ["en", "English"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["es", "Español"],
  ["pt", "Português"],
  ["ru", "Русский"],
  ["it", "Italiano"],
  ["ar", "العربية"],
  ["hi", "हिन्दी"],
  ["th", "ไทย"],
  ["vi", "Tiếng Việt"],
];

const TRACK_LANGS = [["", "自动选择"]] .concat(TARGET_LANGS);

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  try {
    init();
  } catch (e) {
    showFatal(e);
  }
});

async function init() {
  fillSelect($("targetLang"), TARGET_LANGS);
  fillSelect($("trackLang"), TRACK_LANGS);

  const stored = await get(DEFAULTS);
  Object.keys(DEFAULTS).forEach((key) => {
    const el = $(key);
    if (!el) return;
    if (el.type === "checkbox") el.checked = !!stored[key];
    else el.value = stored[key];
  });

  updateAiBox();
  updateLabels();
  bindEvents();
}

function showFatal(e) {
  const el = $("fatal");
  if (!el) return;
  el.style.display = "block";
  el.textContent = "设置面板加载出错：" + (e && (e.stack || e.message || e));
}

function fillSelect(sel, list) {
  sel.innerHTML = "";
  for (const [value, label] of list) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
}

function get(defaults) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(defaults, (r) => resolve(Object.assign({}, defaults, r || {})));
  });
}

function save(patch) {
  chrome.storage.sync.set(patch, () => {
    const saved = $("saved");
    if (saved) {
      saved.classList.add("show");
      clearTimeout(save._t);
      save._t = setTimeout(() => saved.classList.remove("show"), 900);
    }
  });
}

function showExportMsg(text, isError) {
  const el = $("exportMsg");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ff8b8b" : "#7bd88f";
  el.classList.add("show");
  clearTimeout(showExportMsg._t);
  showExportMsg._t = setTimeout(() => el.classList.remove("show"), 2500);
}

function showTestMsg(text, isError) {
  const el = $("testMsg");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ff8b8b" : "#7bd88f";
  el.classList.add("show");
}

function showStatusMsg(text, isError) {
  const el = $("statusMsg");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ff8b8b" : "#7bd88f";
  el.classList.add("show");
}

function updateAiBox() {
  const isAi = $("translator").value === "ai";
  $("aiBox").classList.toggle("hidden", !isAi);
}

function updateLabels() {
  $("originalSizeVal").textContent = $("originalSize").value;
  $("translatedSizeVal").textContent = $("translatedSize").value;
  $("fontScaleVal").textContent = Number($("fontScale").value).toFixed(1);
}

function bindEvents() {
  // 复选/下拉/颜色
  [
    "enabled",
    "bilingual",
    "hideNative",
    "targetLang",
    "trackLang",
    "translator",
    "originalColor",
    "translatedColor",
    "exportFormat",
    "exportMode",
  ].forEach((id) => {
    $(id).addEventListener("change", () => {
      const el = $(id);
      const value = el.type === "checkbox" ? el.checked : el.value;
      save({ [id]: value });
      if (id === "translator") updateAiBox();
    });
  });

  // 数字输入（AI 三件套）
  ["aiBaseUrl", "aiApiKey", "aiModel"].forEach((id) => {
    $(id).addEventListener("input", () => save({ [id]: $(id).value }));
  });

  // 滑块
  ["originalSize", "translatedSize", "fontScale"].forEach((id) => {
    $(id).addEventListener("input", () => {
      updateLabels();
      save({ [id]: Number($(id).value) });
    });
  });

  // 导出
  $("exportBtn").addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        showExportMsg("未找到标签页", true);
        return;
      }
      chrome.tabs.sendMessage(
        tab.id,
        {
          type: "EXPORT_SUBTITLES",
          format: $("exportFormat").value,
          mode: $("exportMode").value,
        },
        (res) => {
          if (chrome.runtime.lastError) {
            showExportMsg("请在 YouTube 视频页使用", true);
            return;
          }
          if (res && res.ok) {
            showExportMsg("已导出 " + res.count + " 条 ✓");
          } else {
            showExportMsg((res && res.error) || "导出失败", true);
          }
        }
      );
    });
  });

  // 诊断：用当前引擎翻译一句话
  $("testBtn").addEventListener("click", () => {
    const cfg = {
      translator: $("translator").value,
      targetLang: $("targetLang").value,
      aiBaseUrl: $("aiBaseUrl").value,
      aiApiKey: $("aiApiKey").value,
      aiModel: $("aiModel").value,
    };
    showTestMsg("测试中…");
    chrome.runtime.sendMessage(
      { type: "TRANSLATE_BATCH", texts: ["Hello, world."], config: cfg },
      (res) => {
        if (chrome.runtime.lastError) {
          showTestMsg("失败：" + chrome.runtime.lastError.message, true);
          return;
        }
        if (res && Array.isArray(res.translations) && res.translations.length) {
          showTestMsg("成功：" + res.translations[0]);
        } else {
          showTestMsg("失败：" + ((res && res.error) || "无返回"), true);
        }
      }
    );
  });

  // 诊断：当前页字幕加载/翻译情况
  $("statusBtn").addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) return showStatusMsg("未找到标签页", true);
      chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" }, (res) => {
        if (chrome.runtime.lastError) return showStatusMsg("请在 YouTube 视频页使用", true);
        if (res) {
          let msg = "已加载 " + res.loaded + " 条 / 已翻译 " + res.translated + " 条";
          if (res.source) msg += "（来源 " + res.source + "）";
          if (res.error) msg += " 错误：" + res.error;
          showStatusMsg(msg, !!res.error || res.loaded === 0);
        } else showStatusMsg("无返回", true);
      });
    });
  });

  $("reset").addEventListener("click", () => {
    Object.keys(DEFAULTS).forEach((key) => {
      const el = $(key);
      if (!el) return;
      if (el.type === "checkbox") el.checked = DEFAULTS[key];
      else el.value = DEFAULTS[key];
    });
    updateAiBox();
    updateLabels();
    save(Object.assign({}, DEFAULTS));
  });
}
