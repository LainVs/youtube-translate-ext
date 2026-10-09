/**
 * opencode-translate-bridge
 *
 * 作用：把 OpenCode 的「一次性生成」接口
 *   POST /api/experimental/generate   { prompt, model? }  ->  { data: { text } }
 * 包装成 OpenAI 兼容的
 *   POST /v1/chat/completions
 * 于是浏览器扩展里「AI 翻译」只需把 Base URL 填 http://localhost:8788/v1 即可。
 *
 * 启动：
 *   npm install
 *   npm start
 *
 * 可选环境变量：
 *   BRIDGE_PORT     桥接服务端口，默认 8788
 *   OPENCODE_MODEL  强制使用的模型，格式 "providerID/id"，默认用 OpenCode 默认模型
 *   OPENCODE_URL    直接指定 OpenCode 服务地址（跳过自动发现）
 *   OPENCODE_TOKEN  配合 OPENCODE_URL 使用的 Bearer token
 */

import http from "node:http";
import { Service } from "@opencode/client/service";

const PORT = Number(process.env.BRIDGE_PORT || 8788);
const FORCED_MODEL = process.env.OPENCODE_MODEL || "";

let cached = null; // { url, headers }

async function getEndpoint() {
  if (process.env.OPENCODE_URL) {
    return {
      url: process.env.OPENCODE_URL,
      headers: process.env.OPENCODE_TOKEN
        ? { authorization: "Bearer " + process.env.OPENCODE_TOKEN }
        : {},
    };
  }
  if (cached) return cached;
  const endpoint = await Service.ensure();
  cached = { url: endpoint.url, headers: Service.headers(endpoint) };
  console.log("[bridge] OpenCode 服务:", cached.url);
  return cached;
}

/** "providerID/id" -> { providerID, id }；否则返回 null（用默认模型） */
function parseModel(model) {
  const value = FORCED_MODEL || model || "";
  const idx = value.indexOf("/");
  if (idx > 0) return { providerID: value.slice(0, idx), id: value.slice(idx + 1) };
  return null;
}

async function generate(prompt, modelRef) {
  const { url, headers } = await getEndpoint();
  const body = { prompt };
  if (modelRef) body.model = modelRef;

  const resp = await fetch(url.replace(/\/+$/, "") + "/api/experimental/generate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error("opencode generate HTTP " + resp.status + " " + text.slice(0, 300));
  }
  const json = await resp.json();
  return (json && json.data && json.data.text) || "";
}

function send(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "POST, OPTIONS",
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});

  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = "";
    for await (const chunk of req) raw += chunk;

    let body;
    try {
      body = JSON.parse(raw);
    } catch (e) {
      return send(res, 400, { error: { message: "invalid JSON body" } });
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const user = messages
      .filter((m) => m.role !== "system")
      .map((m) => m.content)
      .join("\n");
    const prompt = system ? system + "\n\n" + user : user;

    try {
      const text = await generate(prompt, parseModel(body.model));
      return send(res, 200, {
        id: "chatcmpl-opencode-bridge",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model || "opencode-default",
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
});
