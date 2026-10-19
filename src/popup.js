/** popup.js — 设置面板逻辑 */

const DEFAULTS = {
  enabled: true,
  bilingual: true,
  hideNative: false,
  targetLang: "zh-CN",
  translator: "ai",
  aiBaseUrl: "http://localhost:8788/v1",
  aiApiKey: "",
  aiModel: "agent2/auto",
  fontFamily: "common",
  mergeBySentence: true,
  mergeMaxChars: 160,
  mergeMaxGapMs: 2500,
  revealAsSpoken: true,
  domKeepLatest: true,
  originalColor: "#00ff66",
  translatedColor: "#ffd900",
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
  exportFormat: "srt",
  exportMode: "bilingual",
  trackLang: "",
};

/** 手动输入模型 ID 时下拉框用的特殊值 */
const AI_MODEL_CUSTOM = "custom";

/**
 * 一次性迁移用的「旧默认 / 已不可用」模型列表。
 *
 * 只认这些值本身——存了别的模型的用户不受影响（与下面 originalColor /
 * translatedColor 的迁移同规则："只认旧默认值"）。
 *
 * 实测（2026-10，opencode 2.0.29）：
 *  - exo-free、ling-3.0-flash-fin-free、ling-3.1-flash-free 已从 opencode 下线；
 *  - cat-jam-free、muse-spark-1.x-contributor-free 返回 RegionError 地区不可用；
 *  - big-pickle 仍可用，但实测 29.1s，已被新的顶配默认（2.2s）取代。
 *
 * 用独立的 __modelMigrated 标记做一次性迁移：否则用户手动把模型改回
 * big-pickle 后，每次打开面板又会被迁走。
 */
const SUPERSEDED_MODELS = [
  "opencode/big-pickle",
  "opencode/exo-free",
  "opencode/ling-3.0-flash-fin-free",
  "opencode/ling-3.1-flash-free",
  "opencode/cat-jam-free",
  "opencode/muse-spark-1.2-contributor-free",
  "opencode/muse-spark-1.3-contributor-free",
];
const MODEL_MIGRATION_KEY = "__modelMigrated";

/**
 * agent2 网关上线（2026-10）的一次性迁移：旧默认 opencode/space-bunny-free
 * → agent2/auto 智能模式（优先 GLM-5.3-Flash，挂了自动换，见 bridge/server.mjs）。
 *
 * 用独立标记而不是塞进 SUPERSEDED_MODELS：__modelMigrated 标记对老用户多半
 * 已经置位，那里加值不会再跑；独立标记保证这次迁移一定执行一次。
 * 只认旧默认值本身——手动选过别的模型的用户不受影响。
 */
const OLD_DEFAULT_MODEL = "opencode/space-bunny-free";
const AGENT2_MIGRATION_KEY = "__modelMigratedAgent2";

/** 常用色：三处颜色（原文/译文/背景）共用这 8 个，一键点选 */
const COMMON_COLORS = [
  "#ffffff",
  "#000000",
  "#00ff66",
  "#ffd900",
  "#7fe3ff",
  "#ffa62b",
  "#ff6b6b",
  "#f5f0e6",
];
const COLOR_KEYS = ["originalColor", "translatedColor", "bgColor"];

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

  // 旧默认 / 已下架模型 → 一次性迁到新的顶配默认（别停在慢的或跑不通的模型上）
  if (!stored[MODEL_MIGRATION_KEY]) {
    if (SUPERSEDED_MODELS.includes(stored.aiModel)) {
      stored.aiModel = DEFAULTS.aiModel;
      $("aiModel").value = DEFAULTS.aiModel;
      $("aiModelCustom").value = "";
      save({ aiModel: DEFAULTS.aiModel });
    }
    save({ [MODEL_MIGRATION_KEY]: true });
  }

  // 存过的模型不在下拉里（历史手输值）→ 落到 custom 并回填
  if (!modelOptionExists(stored.aiModel)) {
    $("aiModel").value = AI_MODEL_CUSTOM;
    $("aiModelCustom").value = stored.aiModel || "";
  }
  updateModelCustomVisibility();

  // agent2 网关上线：停在旧默认（opencode/space-bunny-free）的一次性迁到智能模式
  if (!stored[AGENT2_MIGRATION_KEY]) {
    if (stored.aiModel === OLD_DEFAULT_MODEL) {
      stored.aiModel = DEFAULTS.aiModel;
      $("aiModel").value = DEFAULTS.aiModel;
      $("aiModelCustom").value = "";
      save({ aiModel: DEFAULTS.aiModel });
    }
    save({ [AGENT2_MIGRATION_KEY]: true });
  }

  // 颜色加鲜迁移（与 content.js loadConfig 同规则）：只认旧默认值
  if (stored.originalColor === "#39ff6a" || stored.translatedColor === "#ffe14d") {
    const patch = {};
    if (stored.originalColor === "#39ff6a") { patch.originalColor = "#00ff66"; $("originalColor").value = "#00ff66"; }
    if (stored.translatedColor === "#ffe14d") { patch.translatedColor = "#ffd900"; $("translatedColor").value = "#ffd900"; }
    save(patch);
  }

  renderSwatches();
  syncSwatches();

  updateAiBox();
  updateLabels();
  bindEvents();

  $("openPlayerBtn").addEventListener("click", () => {
    const url = chrome.runtime.getURL("src/player.html");
    chrome.tabs.create({ url });
  });
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

/** 下拉框里有没有这个模型 ID（没有就是历史遗留的手输值，走 custom） */
function modelOptionExists(value) {
  const sel = $("aiModel");
  for (const opt of sel.options) {
    if (opt.value === value) return true;
  }
  return false;
}

/** 当前生效的模型 ID：custom 时读手输框 */
function getAiModel() {
  if ($("aiModel").value === AI_MODEL_CUSTOM) {
    return $("aiModelCustom").value.trim() || DEFAULTS.aiModel;
  }
  return $("aiModel").value;
}

function updateModelCustomVisibility() {
  const custom = $("aiModel").value === AI_MODEL_CUSTOM;
  $("aiModelCustomWrap").style.display = custom ? "" : "none";
}

/** 生成三处颜色的常用色卡 */
function renderSwatches() {
  COLOR_KEYS.forEach((key) => {
    const box = $("sw_" + key);
    if (!box) return;
    box.innerHTML = "";
    COMMON_COLORS.forEach((c) => {
      const b = document.createElement("button");
      b.className = "sw";
      b.style.background = c;
      b.title = c;
      b.dataset.color = c;
      b.dataset.for = key;
      b.addEventListener("click", () => {
        const el = $(key);
        if (el) el.value = c;
        save({ [key]: c });
        syncSwatches(key);
      });
      box.appendChild(b);
    });
  });
}

/** 高亮与当前值一致的色卡（取色盘改了也要同步过来） */
function syncSwatches(onlyKey) {
  COLOR_KEYS.forEach((key) => {
    if (onlyKey && key !== onlyKey) return;
    const cur = String(($(key) && $(key).value) || "").toLowerCase();
    document.querySelectorAll('#sw_' + key + " .sw").forEach((b) => {
      b.classList.toggle("active", b.dataset.color === cur);
    });
  });
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
      save({ [id]: value });
      if (id === "translator") updateAiBox();
      // 高级取色盘改了，常用色卡的高亮同步过去
      if (COLOR_KEYS.includes(id)) syncSwatches(id);
    });
  });

  // 模型下拉：custom 时显示手输框，存手输值；否则存选项值
  $("aiModel").addEventListener("change", () => {
    updateModelCustomVisibility();
    if ($("aiModel").value !== AI_MODEL_CUSTOM) {
      save({ aiModel: $("aiModel").value });
    } else if ($("aiModelCustom").value.trim()) {
      save({ aiModel: $("aiModelCustom").value.trim() });
    }
  });
  $("aiModelCustom").addEventListener("input", () => {
    const v = $("aiModelCustom").value.trim();
    if (v) save({ aiModel: v });
  });

  // 文本输入（AI 地址三件套里的前两个）
  ["aiBaseUrl", "aiApiKey"].forEach((id) => {
    $(id).addEventListener("input", () => save({ [id]: $(id).value }));
  });

  // 滑块
  ["originalSize", "translatedSize", "fontScale", "bgOpacity", "boxRadius", "boxPadding"].forEach((id) => {
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
      aiModel: getAiModel(),
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
          // 翻译来源拆分：AI 覆盖了几条、Google 打底几条，一眼看出混合进度
          if (typeof res.ai === "number" || typeof res.google === "number") {
            msg += "（AI " + (res.ai || 0) + "，Google " + (res.google || 0) + "）";
          }
          if (res.source) msg += "（轨道来源 " + res.source + "）";
          // 当前句来源：眼前这句是谁翻的（只显示一次，避免重复）
          if (typeof res.videoTimeMs === "number" && res.loaded) {
            msg += " / 播放 " + Math.round(res.videoTimeMs / 1000) + "s";
            if (res.cueIdx >= 0) {
              const srcLabel = res.currentSource === "ai" ? "AI" : res.currentSource === "google" ? "Google" : "未翻译";
              msg += " 当前第 " + (res.cueIdx + 1) + " 条：" + srcLabel;
            } else {
              msg += " 当前无字幕（间奏或空档）";
            }
          } else if (typeof res.currentIdx === "number" && res.currentIdx >= 0) {
            const srcLabel = res.currentSource === "ai" ? "AI" : res.currentSource === "google" ? "Google" : "未翻译";
            msg += " / 当前第 " + (res.currentIdx + 1) + " 句：" + srcLabel;
          }
          if (res.enabled === false) msg += " 【扩展被关掉】";
          if (res.isAdPlaying) msg += " 【检测到广告，字幕暂停】";
          if (res.boxVisible === false) msg += " 【字幕层被隐藏】";
          if (res.overlayInDom === false) msg += " 【覆盖层不在页面】";
          if (res.domMode) msg += "（实时模式）";
          if (res.error) msg += " 错误：" + res.error;
          showStatusMsg(msg, !!res.error || res.loaded === 0 || res.boxVisible === false);
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
    $("aiModelCustom").value = "";
    updateModelCustomVisibility();
    syncSwatches();
    updateAiBox();
    updateLabels();
    save(Object.assign({}, DEFAULTS));
  });
}
