/**
 * opencode-translate-bridge
 *
 * 作用：把本机的 OpenCode CLI 包装成 OpenAI 兼容的翻译后端，
 * 于是浏览器扩展里「AI 翻译」只需把 Base URL 填 http://localhost:8788/v1 即可。
 *
 *   POST /v1/chat/completions  { messages:[...], model? }  ->  { choices:[{message:{content}}] }
 *
 * 为什么用 CLI 而不是 HTTP /api/experimental/generate：
 *   OpenCode 的免费模型（含 opencode/big-pickle）在 HTTP generate 接口上会被拒：
 *   "OpenCode's free tier can only be used from within OpenCode"。
 *   而命令行 `opencode run` 属于「OpenCode 内部」，可以正常使用免费模型。
 *
 * 启动：
 *   npm start          (无任何第三方依赖)
 *
 * 可选环境变量：
 *   BRIDGE_PORT       桥接服务端口，默认 8788
 *   OPENCODE_CLI      OpenCode CLI 可执行文件路径（默认自动探测）
 *   OPENCODE_MODEL    强制模型，格式 "providerID/id"，默认 opencode/big-pickle
 *   OPENCODE_TIMEOUT  单次翻译超时毫秒数，默认 120000
 *   BRIDGE_MOCK       设为 1 时不调用模型，返回 [译] 前缀的假数据（用于联调）
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.BRIDGE_PORT || 8788);
const FORCED_MODEL = process.env.OPENCODE_MODEL || "";
// 超时上限。opencode run 每次都要 spawn 新进程，冷启动波动很大：
// 实测同一批 8 条字幕，快的 17s、慢的 45s 就超时挂了。
// 所以要给足余量——反正失败重试会在更外层兜住，多等一会儿
// 比整批重跑划算得多。
const TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT || 90000);
const MOCK = process.env.BRIDGE_MOCK === "1";
const DEFAULT_MODEL = "opencode/big-pickle";

/* ------------------------------ CLI 探测 ------------------------------ */

/** 找出可能的 OpenCode CLI 路径（按优先级） */
function candidates() {
  const list = [];
  if (process.env.OPENCODE_CLI) list.push(process.env.OPENCODE_CLI);

  // 桌面版自带的 V2 CLI：%APPDATA%\ai.opencode.desktop\cli\<version>\opencode-cli.exe
  try {
    const base = path.join(process.env.APPDATA || "", "ai.opencode.desktop", "cli");
    if (existsSync(base)) {
      const versions = readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) {
        const exe = path.join(base, v, "opencode-cli.exe");
        if (existsSync(exe)) list.push(exe);
      }
    }
  } catch {
    /* ignore */
  }

  // PATH 上的 opencode（chocolatey / npm）
  list.push("opencode");
  list.push("opencode.cmd");
  return list;
}

let cliPath = null;

/** 逐个探测，返回第一个能跑 `--version` 的 */
function resolveCli() {
  if (cliPath) return Promise.resolve(cliPath);
  return new Promise((resolve, reject) => {
    const list = candidates();
    let i = 0;
    const tryNext = () => {
      if (i >= list.length) return reject(new Error("找不到可用的 OpenCode CLI，请设置 OPENCODE_CLI 环境变量"));
      const candidate = list[i++];
      const child = spawn(candidate, ["--version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch {}
        tryNext();
      }, 15000);
      child.stdout.on("data", (d) => (out += d));
      child.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        tryNext();
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          cliPath = candidate;
          console.log("[bridge] 使用 OpenCode CLI:", candidate, "(" + out.trim() + ")");
          resolve(candidate);
        } else {
          tryNext();
        }
      });
    };
    tryNext();
  });
}

/* ------------------------------ 调用模型 ------------------------------ */

function stripFences(s) {
  return String(s).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * 清洗模型输出：字幕只需要一句纯译文。
 *
 * 实测不加约束时模型会返回这种东西：
 *   "这句意思其实是：**我心里早就有感觉了…**
 *    口语化一点，可以翻成：
 *    - 主版本：「我觉得我心底里其实早就知道了…」
 *    几个备选，语气略有不同：..."
 *
 * 这些对字幕全是噪音 —— 会把整块 UI 撑爆。所以这里逐层剥离：
 *   1) markdown 强调符号
 *   2)「主版本 / 备选 / 推荐」这类小标题
 *   3) 项目符号行
 *   4) 引号 / 方括号包裹
 * 保留第一句有实质内容的译文。
 */
function cleanSubtitle(s) {
  let t = stripFences(s);

  // 剥掉模型泄漏出来的思维链。实测出现过整句思考被当译文返回：
  //   "The user wants me to translate subtitles. Let me output only the translation."
  // 判据：整段是英文、且不含中日韩字符、且含第三人称/指令式口气。
  t = t
    .split(/\r?\n/)
    .filter((line) => {
      const l = line.trim();
      if (!l) return false;
      const hasCJK = /[一-鿿぀-ヿ]/.test(l);
      if (hasCJK) return true;
      // 纯英文行：只有当它看起来是译文本身才留。
      // 指令/思考口气的特征词一律丢弃。
      if (/^(the user|i need to|let me|i should|i will|i'll|to translate|translation:|note:|here is|here's|the translation)/i.test(l)) {
        return false;
      }
      // 英文句子很少出现在中译字幕里，除非原文就是英文专有名词
      return l.length <= 40 && !/[.!?]$/.test(l);
    })
    .join("\n")
    .trim();
  if (!t) t = stripFences(s);

  // 去掉 markdown 强调与行内标记
  t = t.replace(/\*\*|__|`{1,3}|~~/g, "");

  // 如果是多行结构说明，取「有内容的第一个引号译文」优先
  const quoted = t.match(/[「『"“]([^」』"”\n]{2,})[」』"”]/);
  const lines = t.split(/\r?\n/).map((l) => l.trim());

  // 丢掉明显的说明性行
  const NOISE = /^(译文|主版本|备选|推荐|口语化|如果|需要|可以|以下是|几种|说明|注[:：]|例如|希望|如果你|请)/;
  const useful = [];
  for (const line of lines) {
    if (!line) continue;
    if (NOISE.test(line)) continue;
    if (/^[-*+•]\s*/.test(line)) continue;       // 项目符号
    if (/^\d+[.、)]\s*/.test(line)) continue;     // 编号
    if (line.length < 2) continue;
    useful.push(line);
  }

  let out;
  if (useful.length) {
    out = useful[0];
  } else if (quoted) {
    out = quoted[1];
  } else {
    out = t.replace(/\s+/g, " ");
  }

  // 剥掉包裹引号和多余前缀
  out = out.replace(/^[「『"“]+/, "").replace(/[」』"”]+$/, "");
  out = out.replace(/^(译文|主版本|推荐译法)\s*[:：]\s*/, "");
  return out.replace(/\s+/g, " ").trim();
}

/** 解析 `opencode run --format json` 的事件流，拼接 text 片段 */
function extractText(stdout) {
  const texts = [];
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    try {
      const ev = JSON.parse(s);
      // 跳过思维链。实测带「只输出译文」约束时，部分模型会先吐一段
      // 英文思考（"The user wants me to translate…"）再给译文，
      // 直接拼起来会把思考过程当成译文显示出来。
      if (ev.type === "reasoning" || ev.type === "thinking") continue;
      if (ev.type === "text" && ev.part && typeof ev.part.text === "string") texts.push(ev.part.text);
    } catch {
      /* 跳过非 JSON 行 */
    }
  }
  return texts.join("");
}

function normalizeModel(model) {
  const value = FORCED_MODEL || model || DEFAULT_MODEL;
  return value;
}

function runCli(prompt, model) {
  return new Promise(async (resolve, reject) => {
    let cli;
    try {
      cli = await resolveCli();
    } catch (e) {
      return reject(e);
    }

    // Windows 命令行长度上限约 32767，预留余量
    if (prompt.length > 30000) {
      return reject(new Error("提示词过长 (" + prompt.length + " 字符)，请减小批大小"));
    }

    // 字幕翻译必须短平快：
    // --format json          输出可解析的事件流
    // 批量 JSON 翻译与单句翻译的输出约束是互斥的，不能共用同一套后缀：
    // 用户原提示词同时要求「输出 JSON 数组」和「只输出一句译文」，
    // 模型会困惑并输出解释+备选，单批耗时 6~33 秒且解析失败。
    // 这里按是否为批量 JSON 自动选择后缀，保持与上游要求一致。
    const isBatchJson = /\[[\s\S]*\]/.test(prompt) && /JSON|数组|array/i.test(prompt);
    const TIGHT_SUFFIX = isBatchJson
      ? "\n\n只输出JSON数组，首字符必须是[，无解释、无markdown、无备选。"
      : "\n\n只输出译文一句，无解释、无引号，首字符即译文。";

    const args = ["run", "--format", "json", "--model", normalizeModel(model), prompt + TIGHT_SUFFIX];
    // stdin 必须是 ignore：若留成打开的 pipe，CLI 会一直等待 EOF 而卡死。
    const child = spawn(cli, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("OpenCode CLI 超时 (" + TIMEOUT_MS + "ms)"));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("启动 OpenCode CLI 失败: " + e.message));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error("OpenCode CLI 退出码 " + code + ": " + (err || out).slice(0, 300)));
      }
      const text = extractText(out);
      if (!text) return reject(new Error("OpenCode CLI 没有返回文本: " + (err || out).slice(0, 300)));
      resolve(text);
    });
  });
}

/** 联调用：从 prompt 里抠出最后一个 JSON 数组，加上 [译] 前缀返回 */
function mockTranslate(prompt) {
  const m = prompt.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) return JSON.stringify(arr.map((s) => "[译] " + s));
    } catch {
      /* ignore */
    }
  }
  return "[译] " + prompt.slice(0, 120);
}

async function generate(prompt, model) {
  if (MOCK) return mockTranslate(prompt);
  const raw = await runCli(prompt, model);
  // 批量 JSON 必须原样返回：cleanSubtitle 是单句清洗器，
  // 会只取第一行而把 ["a","b"] 切碎，导致上游 JSON 解析失败、
  // 整批重试退化成逐条（慢 6 倍）。单句才走清洗。
  const maybeJson = stripFences(raw);
  if (maybeJson.startsWith("[")) return maybeJson;
  const m = maybeJson.match(/\[[\s\S]*\]/);
  if (m && /JSON|数组|array/i.test(prompt)) {
    try {
      JSON.parse(m[0]);
      return m[0];
    } catch {
      /* 非合法 JSON，继续走单句清洗 */
    }
  }
  return cleanSubtitle(raw);
}

/* ------------------------------ HTTP 服务 ------------------------------ */

function send(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});

  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, mock: MOCK, cli: cliPath });
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = "";
    for await (const chunk of req) raw += chunk;

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: { message: "invalid JSON body" } });
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    const user = messages
      .filter((m) => m.role !== "system")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    const prompt = system ? system + "\n\n" + user : user;

    try {
      const text = await generate(prompt, body.model);
      return send(res, 200, {
        id: "chatcmpl-opencode-bridge",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model || normalizeModel(""),
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
      });
    } catch (e) {
      console.error("[bridge] 失败:", e.message);
      return send(res, 502, { error: { message: String(e.message || e) } });
    }
  }

  return send(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[bridge] 已启动： http://localhost:" + PORT + "/v1/chat/completions");
  console.log("[bridge] 扩展里把「接口地址 Base URL」填成 http://localhost:" + PORT + "/v1");
  if (MOCK) console.log("[bridge] 当前为 MOCK 模式（不调用模型）");
});
