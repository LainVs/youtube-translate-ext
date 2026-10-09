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
const TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT || 120000);
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

/** 解析 `opencode run --format json` 的事件流，拼接 text 片段 */
function extractText(stdout) {
  const texts = [];
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    try {
      const ev = JSON.parse(s);
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

    const args = ["run", "--format", "json", "--model", normalizeModel(model), prompt];
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
  return stripFences(raw);
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
