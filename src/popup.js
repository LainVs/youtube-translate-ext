/** popup.js — 设置面板逻辑 */

const DEFAULTS = {
  enabled: true,
  bilingual: true,
  hideNative: false,
  targetLang: "zh-CN",
  translator: "ai",
  aiBaseUrl: "http://localhost:8788/v1",
  aiApiKey: "",
  aiModel: "opencode/big-pickle",
  fontFamily: "common",
  mergeBySentence: true,
  mergeMaxChars: 160,
  mergeMaxGapMs: 2500,
  revealAsSpoken: true,
  domKeepLatest: true,
  originalColor: "#39ff6a",
  translatedColor: "#ffe14d",
  originalSize: 30,
  translatedSize: 26,
  fontScale: 1,
  originalWeight: 400,
  translatedWeight: 400,
  bgColor: "#000000",
  bgOpacity: 0,
  boxRadius: 0,
  boxPadding: 0,
  outline: 2,
  stylePreset: "neon",
  exportFormat: "srt",
  exportMode: "bilingual",
  trackLang: "",
};

/**
 * 风格预设：一键套用配色和背景。
 *
 * ⚠️刻意不包含 originalSize / translatedSize / fontScale / fontFamily。
 * 字号和字体是用户自己的偏好，预设一旦覆盖就会被「锁死」——
 * 之前版本就是因为预设里带了字号，导致点了预设后字号改不动。
 * 所以预设只管「长什么样」，不管「多大、用什么字」。
 */
const PRESETS = {
  neon: {
    // 霓虹：亮绿+亮黄，透明底+强描边，任何画面都跳出来
    originalColor: "#39ff6a",
    translatedColor: "#ffe14d",
    bgColor: "#000000",
    bgOpacity: 0,
    boxRadius: 0,
    boxPadding: 0,
    outline: 2,
  },
  cinema: {
    // 影院：白字+青色，圆角黑底，对比最强
    originalColor: "#ffffff",
    translatedColor: "#7fe3ff",
    bgColor: "#000000",
    bgOpacity: 62,
    boxRadius: 10,
    boxPadding: 10,
    outline: 0,
  },
  paper: {
    // 纸感：米白底+墨色字+砖红译文，浅色/雪景画面友好
    originalColor: "#1a1a1a",
    translatedColor: "#c1440e",
    bgColor: "#f5f0e6",
    bgOpacity: 82,
    boxRadius: 6,
    boxPadding: 8,
    outline: 0,
  },
  amber: {
    // 琥珀：暖色系，久看不刺眼
    originalColor: "#fff4d6",
    translatedColor: "#ffa62b",
    bgColor: "#2a1c0e",
    bgOpacity: 55,
    boxRadius: 12,
    boxPadding: 10,
    outline: 1,
  },
  ocean: {
    // 深海：白字+天蓝，沉稳
    originalColor: "#ffffff",
    translatedColor: "#6ec6ff",
    bgColor: "#0a1a2f",
    bgOpacity: 58,
    boxRadius: 10,
    boxPadding: 10,
    outline: 0,
  },
  noir: {
    // 极简：纯黑白，靠字号和粗细区分两行
    originalColor: "#f2f2f2",
    translatedColor: "#ffffff",
    bgColor: "#000000",
    bgOpacity: 78,
    boxRadius: 4,
    boxPadding: 8,
    outline: 0,
  },
};

/** 预设只覆盖这些键——注意不含任何字号/字体键 */
const PRESET_KEYS = Object.keys(PRESETS.neon);

/** 手动微调后需要取消预设高亮的键 */
const STYLE_KEYS = PRESET_KEYS.concat(["outline"]);

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

/** 一键套用预设：写控件 → 存盘 → 立刻预览高亮。不会碰字号和字体。 */
async function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  PRESET_KEYS.forEach((k) => {
    const el = $(k);
    if (el) el.value = p[k];
  });
  $("outline").value = String(p.outline);
  updateLabels();
  markPreset(name);
  await save(Object.assign({ stylePreset: name }, p));
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
    "fontFamily",
    "exportFormat",
    "exportMode",
    "mergeBySentence",
    "revealAsSpoken",
    "domKeepLatest",
    "originalWeight",
    "translatedWeight",
  ].forEach((id) => {
    $(id).addEventListener("change", () => {
      const el = $(id);
      const value = el.type === "checkbox" ? el.checked : el.value;
      // 手动改样式就不再高亮预设（提示「你已经在预设之外微调了」）
      if (id !== "fontFamily" && STYLE_KEYS.includes(id)) markPreset(null);
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
      // 字号是用户自己的偏好，改它不应该取消预设高亮
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
