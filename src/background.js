/**
 * background.js — Service Worker
 * 承接 content script 的翻译请求（跨域请求放这里做，绕开页面 CORS 限制）
 */

const LANG_NAMES = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  "en": "English",
  "ja": "日本語",
  "ko": "한국어",
  "fr": "Français",
  "de": "Deutsch",
  "es": "Español",
  "pt": "Português",
  "ru": "Русский",
  "it": "Italiano",
  "ar": "العربية",
  "hi": "हिन्दी",
  "th": "ไทย",
  "vi": "Tiếng Việt",
  "id": "Bahasa Indonesia",
  "tr": "Türkçe",
  "pl": "Polski",
  "nl": "Nederlands",
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "TRANSLATE_BATCH") {
    translateBatch(msg.texts || [], msg.config || {})
      .then((translations) => sendResponse({ translations }))
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true; // 异步响应，保持通道开启
  }
});

async function translateBatch(texts, cfg) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (cfg.translator === "ai") return translateAI(texts, cfg);
  return translateGoogle(texts, cfg.targetLang || "zh-CN");
}

/* ============================== Google 免费端点 ============================== */

async function googleOnce(text, targetLang) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx" +
    "&sl=auto&dt=t&tl=" +
    encodeURIComponent(targetLang) +
    "&q=" +
    encodeURIComponent(text);
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) throw new Error("Google 翻译失败: HTTP " + resp.status);
  const data = await resp.json();
  // data[0] = [[译文, 原文, ...], ...]
  return (data && data[0] ? data[0] : []).map((x) => (x && x[0]) || "").join("");
}

async function translateGoogle(texts, targetLang) {
  if (texts.length === 1) {
    return [await safeOne(texts[0], targetLang)];
  }

  // 先用换行拼接成一次请求，成功且行数对齐则直接返回
  const joined = texts.join("\n");
  if (joined.length <= 4500) {
    try {
      const out = await googleOnce(joined, targetLang);
      const lines = out.split("\n");
      if (lines.length === texts.length) return lines;
    } catch (e) {
      /* 落到逐条兜底 */
    }
  }

  // 逐条翻译（有限并发）
  return await mapLimit(texts, 4, (t) => safeOne(t, targetLang));
}

async function safeOne(text, targetLang) {
  try {
    return await googleOnce(text, targetLang);
  } catch (e) {
    return text; // 失败保留原文
  }
}

/* ================================== AI 翻译 =================================== */

async function translateAI(texts, cfg) {
  const targetLang = cfg.targetLang || "zh-CN";
  const langName = LANG_NAMES[targetLang] || targetLang;
  const base = (cfg.aiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = base + "/chat/completions";

  const system =
    `你是一名专业的字幕翻译。请把用户提供的 JSON 数组里的每一条翻译成${langName}。` +
    `要求：保持数组元素数量与顺序完全不变；只输出翻译后的 JSON 字符串数组，不要输出任何解释、编号或 Markdown 代码块；` +
    `译文要口语化、简洁，适合作为视频字幕。`;

  const headers = { "Content-Type": "application/json" };
  if (cfg.aiApiKey) headers["Authorization"] = "Bearer " + cfg.aiApiKey;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.aiModel || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(texts) },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error("AI 翻译失败: HTTP " + resp.status + " " + body.slice(0, 200));
  }

  const data = await resp.json();
  let content = (data && data.choices && data.choices[0] && data.choices[0].message.content) || "";
  content = content.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();

  let arr = null;
  try {
    arr = JSON.parse(content);
  } catch (e) {
    const m = content.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        arr = JSON.parse(m[0]);
      } catch (e2) {
        arr = null;
      }
    }
  }

  if (!Array.isArray(arr)) {
    // 解析失败：逐条退回 AI 单句翻译成本高，这里退回原文
    throw new Error("AI 返回格式无法解析");
  }

  return texts.map((t, i) => (typeof arr[i] === "string" ? arr[i] : t));
}

/* ================================== 工具 =================================== */

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}
