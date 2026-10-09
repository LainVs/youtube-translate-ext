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

document.addEventListener("DOMContentLoaded", async () => {
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
});

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
