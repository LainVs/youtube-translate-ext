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
  originalColor: "#2ee62e",
  translatedColor: "#ffd633",
  originalSize: 32,
  translatedSize: 34,
  fontScale: 1,
  bgColor: "#000000",
  bgOpacity: 0,
  boxRadius: 0,
  boxPadding: 0,
  outline: 2,
  stylePreset: "nobg",
  exportFormat: "srt",
  exportMode: "bilingual",
  trackLang: "",
};

/**
 * 风格预设：一键套用，用户不需要碰任何取色器/滑块。
 * 每项只覆盖样式键，不碰启用/语言/翻译引擎等。
 */
const PRESETS = {
  // 无框大字：透明底 + 强描边，靠描边在任意画面上保持可读（用户偏好的样式）
  nobg: {
    originalColor: "#2ee62e",
    translatedColor: "#ffd633",
    originalSize: 32,
    translatedSize: 34,
    fontScale: 1,
    bgColor: "#000000",
    bgOpacity: 0,
    boxRadius: 0,
    boxPadding: 0,
    outline: 2,
  },
  // 影院黑底：圆角黑框，对比最强，背景再乱也稳
  cinema: {
    originalColor: "#2ee62e",
    translatedColor: "#ffd633",
    originalSize: 20,
    translatedSize: 26,
    fontScale: 1,
    bgColor: "#000000",
    bgOpacity: 62,
    boxRadius: 10,
    boxPadding: 10,
    outline: 0,
  },
  // 护眼柔和：无框但用中性白/暖黄，久看不刺眼
  soft: {
    originalColor: "#f0f0f0",
    translatedColor: "#ffc94d",
    originalSize: 30,
    translatedSize: 32,
    fontScale: 1,
    bgColor: "#000000",
    bgOpacity: 0,
    boxRadius: 0,
    boxPadding: 0,
    outline: 2,
  },
  // 磨砂浮层：半透明深色底，浅色/复杂背景下最稳
  frost: {
    originalColor: "#ffffff",
    translatedColor: "#ffd633",
    originalSize: 22,
    translatedSize: 28,
    fontScale: 1,
    bgColor: "#101014",
    bgOpacity: 50,
    boxRadius: 14,
    boxPadding: 14,
    outline: 1,
  },
};

const PRESET_KEYS = Object.keys(PRESETS.nobg);

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
  markPreset(stored.stylePreset);
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
  $("bgOpacityVal").textContent = $("bgOpacity").value;
  $("boxRadiusVal").textContent = $("boxRadius").value;
  $("boxPaddingVal").textContent = $("boxPadding").value;
}

/** 把预设写进控件 + 标高亮当前预设 */
function markPreset(name) {
  document.querySelectorAll("#presets .preset").forEach((b) => {
    b.classList.toggle("active", b.dataset.preset === name);
  });
}

/** 一键套用预设：写控件 → 存盘 → 立刻预览高亮 */
async function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  const patch = Object.assign({}, p);
  PRESET_KEYS.forEach((k) => {
    const el = $(k);
    if (el) el.value = patch[k];
  });
  // outline 是 select，也要同步
  $("outline").value = String(patch.outline);
  updateLabels();
  markPreset(name);
  await save(Object.assign({ stylePreset: name }, patch));
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
    "bgColor",
    "outline",
    "exportFormat",
    "exportMode",
  ].forEach((id) => {
    $(id).addEventListener("change", () => {
      const el = $(id);
      const value = el.type === "checkbox" ? el.checked : el.value;
      // 手动改样式就不再高亮预设（提示「你已经在预设之外微调了」）
      if (PRESET_KEYS.includes(id) || id === "outline") markPreset(null);
      save({ [id]: value });
      if (id === "translator") updateAiBox();
    });
  });

  // 数字输入（AI 三件套）
  ["aiBaseUrl", "aiApiKey", "aiModel"].forEach((id) => {
    $(id).addEventListener("input", () => save({ [id]: $(id).value }));
  });

  // 滑块
  ["originalSize", "translatedSize", "fontScale", "bgOpacity", "boxRadius", "boxPadding"].forEach((id) => {
    $(id).addEventListener("input", () => {
      updateLabels();
      if (PRESET_KEYS.includes(id)) markPreset(null);
      save({ [id]: Number($(id).value) });
    });
  });

  // 风格预设：一键套用
  document.querySelectorAll("#presets .preset").forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
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
