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
  if (msg && msg.type === "GET_TRACKS") {
    getTracks(msg.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }
  if (msg && msg.type === "GET_CUES") {
    getCueBody(msg.baseUrl)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }
});

/* ===================== 字幕获取（放 background，绕开页面 CORS/隔离环境） ===================== */

// 公开的 InnerTube key；ANDROID 客户端的字幕轨道 URL 不带 PoToken 风控
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const ANDROID_CLIENT_VERSION = "20.10.38";

/** 用 ANDROID InnerTube 客户端取字幕轨道 */
async function getTracks(videoId) {
  if (!videoId) return { error: "缺少 videoId", tracks: [] };
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
    "https://www.youtube.com/youtubei/v1/player?key=" + encodeURIComponent(INNERTUBE_KEY) + "&prettyPrint=false",
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
  const txt = await resp.text();
  if (!resp.ok) return { error: "innertube HTTP " + resp.status + " " + txt.slice(0, 160), tracks: [] };
  let j;
  try {
    j = JSON.parse(txt);
  } catch (e) {
    return { error: "innertube 返回非 JSON", tracks: [] };
  }
  const tracks =
    (j.captions &&
      j.captions.playerCaptionsTracklistRenderer &&
      j.captions.playerCaptionsTracklistRenderer.captionTracks) ||
    [];
  return { source: "android", tracks };
}

/** 按 baseUrl 取字幕正文（覆盖 fmt=json3） */
async function getCueBody(baseUrl) {
  if (!baseUrl) return { error: "缺少 baseUrl" };
  let url;
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("fmt", "json3");
    url = u.toString();
  } catch (e) {
    url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "fmt=json3";
  }
  const resp = await fetch(url);
  if (!resp.ok) return { error: "字幕正文 HTTP " + resp.status };
  const body = await resp.text();
  return { body: body };
}

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

  // 逐条翻译（有限并发；每条之间停 400ms，别触发 Google 的突发限流）
  return await mapLimit(texts, 4, async (t) => {
    const r = await safeOne(t, targetLang);
    await sleep(400);
    return r;
  });
}

async function safeOne(text, targetLang) {
  try {
    return await googleOnce(text, targetLang);
  } catch (e) {
    return text; // 失败保留原文
  }
}

/* ================================== AI 翻译 =================================== */

/**
 * AI 翻译。
 *
 * 两个现实约束（都是实测踩出来的）：
 *  1. 本地桥接是 spawn `opencode run`，单条 5~30 秒。逐条串行的话
 *     一集几百条字幕要等几十分钟。所以按 BATCH 条一组、CONCURRENCY 组并发。
 *  2. 模型很爱输出「解释 + 备选方案 + 反问」，对字幕全是噪音。
 *     所以提示词写死输出格式，返回后再做一次清洗。
 */
/**
 * 批量参数。
 *
 * 实测：本地桥接每次都要 spawn `opencode run` 新进程，冷启动波动大
 * （同一批 8 条，快的 17s，慢的 45s 就超时）。所以：
 *   - 批次别贪大，6 条一批比较稳
 *   - 并发压到 2，避免多个 opencode 进程互相抢资源导致更慢
 *   - 超时由桥接的 90s 兜住，这里再留一点余量
 */
const AI_BATCH = 6;
const AI_CONCURRENCY = 2;
const AI_TIMEOUT_MS = 120000;

async function aiOnce(texts, cfg, targetLang, langName) {
  const base = (cfg.aiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = base + "/chat/completions";

  const system =
    `你是一名专业的字幕翻译。把用户提供的 JSON 数组里的每一条翻译成${langName}。\n` +
    `硬性要求：\n` +
    `1. 输出必须是一个 JSON 字符串数组，长度和顺序与输入完全一致。\n` +
    `2. 只输出这个数组，不要任何解释、前言、markdown 标题、编号或代码块标记。\n` +
    `3. 不要给备选方案，不要反问，不要要求补充上下文。\n` +
    `4. 译文口语化、自然，贴合口语表达，不要直译腔。`;

  const headers = { "Content-Type": "application/json" };
  if (cfg.aiApiKey) headers["Authorization"] = "Bearer " + cfg.aiApiKey;

  // AI_TIMEOUT_MS 之前只定义没用过：fetch 一旦 hang 住，
  // 整个 TRANSLATE_BATCH 永远不返回，后面的句子连试的机会都没有。
  // 用 AbortController 强制超时，失败交给外层的逐条重试。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
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
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error("AI 翻译超时或网络失败: " + ((e && e.message) || e));
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error("AI 翻译失败: HTTP " + resp.status + " " + body.slice(0, 160));
  }

  const data = await resp.json();
  let content = (data && data.choices && data.choices[0] && data.choices[0].message.content) || "";
  content = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // 剥掉可能混入的思维链（英文思考句）
  content = content
    .split(/\r?\n/)
    .filter((line) => {
      const l = line.trim();
      if (!l) return false;
      if (/[一-鿿぀-ヿ]/.test(l)) return true;
      if (/^(the user|i need to|let me|i should|i will|to translate|the translation|here is|here's|note:)/i.test(l)) return false;
      return true;
    })
    .join(" ")
    .trim();
  if (!content) content = String(data.choices[0].message.content || "");

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
    throw new Error("AI 返回格式无法解析");
  }
  // 数量对不上就按位置补原文，绝不丢内容
  return texts.map((t, i) => (typeof arr[i] === "string" && arr[i].trim() ? arr[i].trim() : t));
}

async function translateAI(texts, cfg) {
  const targetLang = cfg.targetLang || "zh-CN";
  const langName = LANG_NAMES[targetLang] || targetLang;

  // 切批
  const batches = [];
  for (let i = 0; i < texts.length; i += AI_BATCH) {
    batches.push(texts.slice(i, i + AI_BATCH));
  }

  // 批间并发（串行会被单条 30 秒拖死）
  const results = new Array(texts.length);
  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const bi = cursor++;
      const slice = batches[bi];
      const offset = bi * AI_BATCH;
      try {
        const out = await aiOnce(slice, cfg, targetLang, langName);
        for (let j = 0; j < slice.length; j++) results[offset + j] = out[j];
      } catch (e) {
        // 整批失败时逐条再试一次（有时是长度问题），仍失败就保留原文
        for (let j = 0; j < slice.length; j++) {
          try {
            const one = await aiOnce([slice[j]], cfg, targetLang, langName);
            results[offset + j] = one[0];
          } catch (e2) {
            results[offset + j] = slice[j];
          }
          // 别把免费层打爆：上一轮失败很可能就是被限流，
          // 无间隔地连发只会让后面也一起挂（前半正常、后半全英文就是这么来的）
          await sleep(1000);
        }
      }
      // 批之间也喘一口气，给免费层恢复配额的时间
      await sleep(1500);
    }
  }
  const n = Math.min(AI_CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/* ================================== 工具 =================================== */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
