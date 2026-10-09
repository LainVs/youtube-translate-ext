/**
 * background.js — Service Worker
 * 处理来自 content script 的翻译请求（避免 CORS 问题）
 */

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "TRANSLATE") {
    handleTranslate(request).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true; // 保持消息通道开启（异步响应）
  }

  if (request.type === "FETCH_SUBTITLES") {
    fetchSubtitles(request.url)
      .then((text) => sendResponse({ text }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

/**
 * 获取字幕 XML/JSON 内容
 */
async function fetchSubtitles(url) {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`字幕请求失败: ${resp.status}`);
  return await resp.text();
}

/**
 * 分发翻译请求
 */
async function handleTranslate({ text, targetLang, translator, apiKey, apiEndpoint }) {
  switch (translator) {
    case "google":
      return await translateGoogle(text, targetLang);
    case "deepl":
      return await translateDeepL(text, targetLang, apiKey, apiEndpoint);
    case "openai":
      return await translateOpenAI(text, targetLang, apiKey, apiEndpoint);
    default:
      throw new Error("未知的翻译服务: " + translator);
  }
}

/**
 * Google 翻译（免费，无需 API Key）
 * 使用 translate.googleapis.com 的公开端点
 */
async function translateGoogle(text, targetLang) {
  // 拆分成短句批量翻译，每段不超过 500 字符
  const chunks = splitText(text, 500);
  const results = [];

  for (const chunk of chunks) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(chunk)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Google 翻译失败: ${resp.status}`);
    const data = await resp.json();
    // data[0] 是翻译结果数组 [[translated_text, original_text, ...], ...]
    if (data && data[0]) {
      const translated = data[0].map((item) => item[0]).join("");
      results.push(translated);
    }
  }

  return results.join("\n");
}

/**
 * DeepL 翻译
 */
async function translateDeepL(text, targetLang, apiKey, customEndpoint) {
  if (!apiKey) throw new Error("DeepL 需要 API Key");

  const endpoint = customEndpoint || "https://api-free.deepl.com/v2/translate";
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `text=${encodeURIComponent(text)}&target_lang=${targetLang.toUpperCase()}`,
  });

  if (!resp.ok) throw new Error(`DeepL 翻译失败: ${resp.status}`);
  const data = await resp.json();
  return data.translations?.[0]?.text || text;
}

/**
 * OpenAI (GPT) 翻译
 */
async function translateOpenAI(text, targetLang, apiKey, customEndpoint) {
  if (!apiKey) throw new Error("OpenAI 需要 API Key");

  const endpoint = customEndpoint
    ? `${customEndpoint.replace(/\/$/, "")}/chat/completions`
    : "https://api.openai.com/v1/chat/completions";

  const langNames = {
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
    en: "English",
    ja: "日本語",
    ko: "한국어",
    fr: "Français",
    de: "Deutsch",
    es: "Español",
    pt: "Português",
    ru: "Русский",
    ar: "العربية",
  };

  const langName = langNames[targetLang] || targetLang;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a professional translator. Translate the following text to ${langName}. Only output the translation, nothing else.`,
        },
        {
          role: "user",
          content: text,
        },
      ],
      temperature: 0.3,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`OpenAI 翻译失败: ${resp.status} - ${errBody}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || text;
}

/**
 * 按最大长度拆分文本
 */
function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    if ((current + "\n" + line).length > maxLen) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
