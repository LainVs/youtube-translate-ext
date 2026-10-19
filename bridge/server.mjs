/**
 * opencode-translate-bridge
 *
 * 作用：把本机的 AI CLI 包装成 OpenAI 兼容的翻译后端，
 * 于是浏览器扩展里「AI 翻译」只需把 Base URL 填 http://localhost:8788/v1 即可。
 *
 *   POST /v1/chat/completions  { messages:[...], model? }  ->  { choices:[{message:{content}}] }
 *
 * 为什么用 CLI 而不是 HTTP /api/experimental/generate：
 *   OpenCode 的免费模型（含 opencode/big-pickle）在 HTTP generate 接口上会被拒：
 *   "OpenCode's free tier can only be used from within OpenCode"。
 *   而命令行 `opencode run` 属于「OpenCode 内部」，可以正常使用免费模型。
 *   CodeBuddy 同理：用 `codebuddy -p --model <id>` 走 CLI 内部额度，
 *   模型形如 `codebuddy/deepseek-v4.1-flash`（前缀即后端路由，传给 CLI 时剥掉）。
 *
 *   Agent2API 网关（本机桌面版，默认 http://127.0.0.1:3065/v1）本身就是 OpenAI
 *   兼容的 HTTP，模型前缀 `agent2/` 直接转发过去。`agent2/auto` 是智能模式：
 *   按优先级表逐个试，哪个能用用哪个，失败的进冷却自动换下一个。
 *
 * 启动：
 *   npm start          (无任何第三方依赖)
 *
 * 语音识别（给本地视频播放器用，见 asr.mjs）：
 *   POST /asr?name=x.mp4   请求体=文件字节   -> { jobId }
 *   GET  /asr/:jobId                         -> { state, stage, percent, srt }
 *   GET  /asr/status                         -> whisper.cpp / 模型 / ffmpeg 自检
 *
 * 可选环境变量：
 *   BRIDGE_PORT       桥接服务端口，默认 8788
 *   OPENCODE_CLI      OpenCode CLI 可执行文件路径（默认自动探测）
 *   CODEBUDDY_CLI     CodeBuddy CLI 可执行文件路径（默认自动探测 PATH 上的 codebuddy）
 *   OPENCODE_MODEL    强制模型，格式 "providerID/id" 或 "codebuddy/<id>"，默认 opencode/space-bunny-free
 *   OPENCODE_TIMEOUT  单次翻译超时毫秒数，默认 120000
 *   BRIDGE_MOCK       设为 1 时不调用模型，返回 [译] 前缀的假数据（用于联调）
 *   AGENT2_BASE_URL   Agent2API 网关地址，默认 http://127.0.0.1:3065/v1
 *   AGENT2_API_KEY    网关 API Key（本地默认不校验；也透传请求里的 Authorization）
 *   AGENT2_TIMEOUT_MS 单次网关调用超时毫秒数，默认 75000
 *   AGENT2_SMART_MODELS 智能模式优先级表（逗号分隔模型 ID），默认 glm-5.3-flash 打头
 *   AGENT2_NO_THINK   设为 0 时不下发 reasoning_effort=none（默认下发，字幕不需要思考）
 *   AGENT2_FALLBACK   设为 0 时 agent2/指定模型 挂了不自动换（严格模式）
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createJob, saveUpload, runPipeline, getJob, activeJob, asrStatus } from "./asr.mjs";

const PORT = Number(process.env.BRIDGE_PORT || 8788);
const FORCED_MODEL = process.env.OPENCODE_MODEL || "";
// 超时上限。opencode run 每次都要 spawn 新进程，冷启动波动很大：
// 实测同一批 8 条字幕，快的 17s、慢的 45s 就超时挂了。
// 所以要给足余量——反正失败重试会在更外层兜住，多等一会儿
// 比整批重跑划算得多。
const TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT || 90000);
const MOCK = process.env.BRIDGE_MOCK === "1";

// 默认模型：opencode 免费层里参数最高的一个（1M 上下文 / 512K 输出，
// 比 opencode 全部 123 个模型里的付费模型还高），且实测 2.2s，比旧的
// big-pickle（200K/32K，29.1s）快约 13 倍。免费模型只能在 OpenCode 内部
// 调用（直接打 HTTP 会 403 FreeTierError），所以必须走 `opencode run`。
const DEFAULT_MODEL = "opencode/space-bunny-free";

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
let codebuddyPath = null;

/** 后端路由：模型前缀是 agent2/ 就走 Agent2API 网关，codebuddy/ 走 CodeBuddy CLI，
 *  否则走 OpenCode CLI */
function backendOf(model) {
  const value = FORCED_MODEL || model || DEFAULT_MODEL;
  if (String(value).startsWith("agent2/")) return "agent2";
  return String(value).startsWith("codebuddy/") ? "codebuddy" : "opencode";
}

/** 剥掉 codebuddy/ 前缀，CLI 要的是裸模型 ID（如 deepseek-v4.1-flash） */
function stripBackendPrefix(model) {
  const value = FORCED_MODEL || model || DEFAULT_MODEL;
  return String(value).replace(/^codebuddy\//, "");
}

/** CodeBuddy CLI 候选（按优先级）。注意 Windows 上 npm 装的 codebuddy
 * 只是 extensionless 调度文件 + .cmd 垫片，Node spawn 喂它们会直接 EINVAL，
 * 所以优先用 node 直跑 JS 入口（和 codebuddy.cmd 垫片干的是同一件事）。 */
function codebuddyCandidates() {
  const list = [];
  if (process.env.CODEBUDDY_CLI) list.push({ cmd: process.env.CODEBUDDY_CLI, pre: [] });
  try {
    const entry = path.join(
      process.env.APPDATA || "", "npm", "node_modules",
      "@tencent-ai", "codebuddy-code", "bin", "codebuddy"
    );
    if (existsSync(entry)) list.push({ cmd: process.execPath, pre: [entry] });
  } catch {
    /* ignore */
  }
  // 兜底：PATH 上万一有真 exe（不用 shell，.cmd 在无 shell 下起不来，不放这里添乱）
  list.push({ cmd: "codebuddy", pre: [] });
  list.push({ cmd: "cbc", pre: [] });
  return list;
}

/** 逐个探测，返回第一个能跑 `--version` 的 CodeBuddy CLI（{cmd, pre}，pre 是前置参数） */
function resolveCodebuddy() {
  if (codebuddyPath) return Promise.resolve(codebuddyPath);
  return new Promise((resolve, reject) => {
    const list = codebuddyCandidates();
    let i = 0;
    const tryNext = () => {
      if (i >= list.length) return reject(new Error("找不到可用的 CodeBuddy CLI，请设置 CODEBUDDY_CLI 环境变量"));
      const candidate = list[i++];
      let child;
      try {
        child = spawn(candidate.cmd, candidate.pre.concat(["--version"]), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        // 同步抛错（如 EINVAL）说明这个候选根本起不来，换下一个，别把整个桥崩了
        return tryNext();
      }
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
          codebuddyPath = candidate;
          console.log("[bridge] 使用 CodeBuddy CLI:", candidate.cmd, candidate.pre.join(" "), "(" + out.trim() + ")");
          resolve(candidate);
        } else {
          tryNext();
        }
      });
    };
    tryNext();
  });
}

/** 逐个探测，返回第一个能跑 `--version` 的 */
function resolveCli() {
  if (cliPath) return Promise.resolve(cliPath);
  return new Promise((resolve, reject) => {
    const list = candidates();
    let i = 0;
    const tryNext = () => {
      if (i >= list.length) return reject(new Error("找不到可用的 OpenCode CLI，请设置 OPENCODE_CLI 环境变量"));
      const candidate = list[i++];
      let child;
      try {
        child = spawn(candidate, ["--version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        return tryNext();
      }
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

/**
 * CodeBuddy 后端：`codebuddy -p --model <裸ID> --output-format text <prompt>`。
 * 与 opencode run 不同：输出就是纯文本（非 JSON 事件流），直接 trim 可用；
 * 批量 JSON 数组原样可解析，generate() 里同样走"数组原样返回"分支。
 */
function runCodebuddy(prompt, model) {
  return new Promise(async (resolve, reject) => {
    let candidate;
    try {
      candidate = await resolveCodebuddy();
    } catch (e) {
      return reject(e);
    }

    // Windows 命令行长度上限约 32767，预留余量（与 opencode 后端同限）
    if (prompt.length > 30000) {
      return reject(new Error("提示词过长 (" + prompt.length + " 字符)，请减小批大小"));
    }

    const isBatchJson = /\[[\s\S]*\]/.test(prompt) && /JSON|数组|array/i.test(prompt);
    const TIGHT_SUFFIX = isBatchJson
      ? "\n\n只输出JSON数组，首字符必须是[，无解释、无markdown、无备选。"
      : "\n\n只输出译文一句，无解释、无引号，首字符即译文。";

    const args = candidate.pre.concat(["-p", "--model", stripBackendPrefix(model), "--output-format", "text", prompt + TIGHT_SUFFIX]);
    // stdin 必须是 ignore：留成 pipe 会等 EOF 卡死（与 opencode 同坑）。
    let child;
    try {
      child = spawn(candidate.cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(new Error("启动 CodeBuddy CLI 失败: " + (e.message || e)));
    }

    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("CodeBuddy CLI 超时 (" + TIMEOUT_MS + "ms)"));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("启动 CodeBuddy CLI 失败: " + e.message));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error("CodeBuddy CLI 退出码 " + code + ": " + (err || out).slice(0, 300)));
      }
      const text = String(out || "").trim();
      if (!text) return reject(new Error("CodeBuddy CLI 没有返回文本: " + (err || out).slice(0, 300)));
      resolve(text);
    });
  });
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
    let child;
    try {
      child = spawn(cli, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(new Error("启动 OpenCode CLI 失败: " + (e.message || e)));
    }

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

/** 模型返回统一后处理。
 * 批量 JSON 必须原样返回：cleanSubtitle 是单句清洗器，
 * 会只取第一行而把 ["a","b"] 切碎，导致上游 JSON 解析失败、
 * 整批重试退化成逐条（慢 6 倍）。单句才走清洗。 */
function postProcess(raw, prompt) {
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

async function generate(prompt, model, opts = {}) {
  if (MOCK) return { text: mockTranslate(prompt), model: null };
  // agent2/ 前缀走 Agent2API 网关（智能选模型），codebuddy/ 走 CodeBuddy CLI，其余走 OpenCode CLI
  const backend = backendOf(model);
  let raw;
  let usedModel = null;
  if (backend === "agent2") {
    const out = await generateAgent2({
      prompt,
      messages: opts.messages,
      authHeader: opts.authHeader,
      srcBody: opts.srcBody,
      model,
    });
    raw = out.content;
    usedModel = out.model;
  } else if (backend === "codebuddy") {
    raw = await runCodebuddy(prompt, model);
  } else {
    raw = await runCli(prompt, model);
  }
  return { text: postProcess(raw, prompt), model: usedModel };
}

/* ------------------------- Agent2 网关后端（智能选模型） ------------------------- */

// 本机 Agent2API 桌面版的 OpenAI 兼容端点。模型前缀 agent2/ 的请求直接转发过去。
const AGENT2_BASE = (process.env.AGENT2_BASE_URL || "http://127.0.0.1:3065/v1").replace(/\/+$/, "");
const AGENT2_API_KEY = process.env.AGENT2_API_KEY || "";
const AGENT2_TIMEOUT_MS = Number(process.env.AGENT2_TIMEOUT_MS || 75000);
// 智能模式候选（按优先级）。实测（2026-10-20，单批 2 条小请求）：
//   glm-5.3-flash        3~8s（网关认 reasoning_effort=none，偶尔排队到 70s）
//   deepseek-v4.1-flash  恒定 ~63s（关思考也不提速，疑似该渠道强制思考）
// 所以快的排前面，DeepSeek 作次选兜质量。挂了的进冷却自动换下一个。
const AGENT2_SMART_MODELS = (process.env.AGENT2_SMART_MODELS ||
  "glm-5.3-flash,deepseek-v4.1-flash,deepseek-v4.1-flash-sg,zcode-glm-5.3-flash,space-bunny,glm-5.3,deepseek-v4-pro,minimax-m3")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// 字幕只要一句译文，思考纯属烧时间。网关对多数模型认 reasoning_effort=none。
const AGENT2_NO_THINK = process.env.AGENT2_NO_THINK !== "0";
// 指定模型挂了要不要自动换：默认要（哪个能用用哪个）。AGENT2_FALLBACK=0 变严格模式。
const AGENT2_FALLBACK = process.env.AGENT2_FALLBACK !== "0";
// 优先级表全灭后，从 /v1/models 捞兜底的个数上限（防止扫全表烧太久）
const AGENT2_SWEEP_MAX = Number(process.env.AGENT2_SWEEP_MAX || 6);

const agent2State = {
  lastGood: null,        // 最近一次成功的模型，下次智能模式优先用
  cooldowns: new Map(),  // model -> { until, reason }
  gatewayDownUntil: 0,   // 连接级失败（网关没起）的全局冷却，别拿每个模型去撞墙
  lastError: null,       // { at, model, message }
  modelsCache: null,     // { at, list }
};

function agent2Headers(authHeader) {
  const h = { "content-type": "application/json" };
  // 网关本地默认不校验 Key；设了 AGENT2_API_KEY 用它，否则透传扩展请求里的 Authorization
  const key = AGENT2_API_KEY || authHeader || "";
  if (key) h["authorization"] = /^bearer /i.test(key) ? key : "Bearer " + key;
  return h;
}

function agent2SetCooldown(model, ms, reason) {
  agent2State.cooldowns.set(model, { until: Date.now() + ms, reason });
  console.log("[bridge] agent2 模型冷却 " + model + " " + Math.round(ms / 1000) + "s（" + reason + "）");
}

function agent2Ok(model) {
  const c = agent2State.cooldowns.get(model);
  return !c || c.until <= Date.now();
}

function agent2Health() {
  const now = Date.now();
  const cooldowns = [];
  for (const [model, c] of agent2State.cooldowns) {
    if (c.until > now) {
      cooldowns.push({ model, reason: c.reason, seconds: Math.round((c.until - now) / 1000) });
    }
  }
  return {
    base: AGENT2_BASE,
    down: agent2State.gatewayDownUntil > now,
    lastGood: agent2State.lastGood,
    smartOrder: AGENT2_SMART_MODELS,
    modelsCached: agent2State.modelsCache ? agent2State.modelsCache.list.length : 0,
    cooldowns,
    lastError: agent2State.lastError,
  };
}

/** 网关模型清单（缓存 60s）。只留能出文字的：图片模型翻译用不上 */
async function agent2ListModels() {
  const cache = agent2State.modelsCache;
  if (cache && Date.now() - cache.at < 60000) return cache.list;
  const r = await fetch(AGENT2_BASE + "/models", {
    headers: agent2Headers(),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error("models HTTP " + r.status);
  const j = await r.json();
  const list = (Array.isArray(j.data) ? j.data : [])
    .filter((m) => m && typeof m.id === "string")
    .filter((m) => !Array.isArray(m.input_modalities) || m.input_modalities.includes("text"))
    .map((m) => m.id);
  agent2State.modelsCache = { at: Date.now(), list };
  return list;
}

/** 单次调网关：成功返回 content；失败抛错，用标志位标注类别（给冷却分类用） */
async function agent2Chat(model, payload, authHeader) {
  const body = { ...payload, model };
  if (AGENT2_NO_THINK && body.reasoning_effort == null) body.reasoning_effort = "none";
  let r;
  try {
    r = await fetch(AGENT2_BASE + "/chat/completions", {
      method: "POST",
      headers: agent2Headers(authHeader),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AGENT2_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && e.name === "AbortError") {
      const err = new Error("网关超时 (" + AGENT2_TIMEOUT_MS + "ms)");
      err.timeout = true;
      throw err;
    }
    const err = new Error("网关不可达: " + ((e && e.cause && e.cause.code) || (e && e.message) || e));
    err.network = true;
    throw err;
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    const err = new Error("HTTP " + r.status + " " + txt.slice(0, 160));
    err.status = r.status;
    throw err;
  }
  const j = await r.json().catch(() => null);
  const msg = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message : null;
  let content = msg && typeof msg.content === "string" ? msg.content : "";
  // 个别模型把正文塞 reasoning_content、content 留空——兜底取思考产物，别白跑
  if (!content.trim() && msg && typeof msg.reasoning_content === "string") content = msg.reasoning_content;
  if (!content.trim()) {
    const err = new Error("空回复");
    err.empty = true;
    throw err;
  }
  return content;
}

/** 试一个模型：成功记住 lastGood 并返回；失败按类别进冷却后原样抛出 */
async function agent2Try(model, payload, authHeader) {
  try {
    const content = await agent2Chat(model, payload, authHeader);
    agent2State.lastGood = model;
    agent2State.lastError = null;
    return { content, model };
  } catch (e) {
    agent2State.lastError = { at: new Date().toISOString(), model, message: e.message };
    if (e.network) {
      agent2State.gatewayDownUntil = Date.now() + 15000;
      console.log("[bridge] agent2 网关不可达，全局冷却 15s");
    } else if (e.timeout) agent2SetCooldown(model, 45000, "超时");
    else if (e.status === 429) agent2SetCooldown(model, 60000, "限流");
    else if (e.status === 404 || e.status === 400) agent2SetCooldown(model, 600000, "模型不存在");
    else agent2SetCooldown(model, 30000, e.empty ? "空回复" : e.status ? "HTTP " + e.status : "失败");
    throw e;
  }
}

/**
 * Agent2 智能选模型：哪个能用用哪个。
 *
 * 尝试顺序：
 *   1) 请求点名的模型（agent2/xxx；AGENT2_FALLBACK=0 时严格只用它）
 *   2) 上次成功的模型 lastGood（智能模式 & 不在冷却中）
 *   3) AGENT2_SMART_MODELS 优先级表（跳过冷却中的）
 *   4) 都灭了你再从 /v1/models 捞没试过的兜底（最多 AGENT2_SWEEP_MAX 个）
 *
 * 失败分类进冷却：429→60s，404/400→600s，超时→45s，5xx/空回复→30s，
 * 网关连不上→全局 15s 直接报错。总死线内还没成，把最后的错误抛上去。
 */
async function generateAgent2({ prompt, messages, model, authHeader, srcBody }) {
  if (Date.now() < agent2State.gatewayDownUntil) {
    throw new Error("Agent2 网关不可达（刚探测失败，冷却中），请确认 Agent2API 是否在运行");
  }

  // 网关是 OpenAI 兼容的，messages 原样透传（保留 system/user 角色）；
  // 拿不到 messages 才退化成拼好的 prompt。temperature/max_tokens 透传调用方的。
  const payload = {};
  if (Array.isArray(messages) && messages.length) {
    payload.messages = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
  } else {
    payload.messages = [{ role: "user", content: prompt }];
  }
  if (srcBody && Number.isFinite(srcBody.temperature)) payload.temperature = srcBody.temperature;
  if (srcBody && Number.isFinite(srcBody.max_tokens)) payload.max_tokens = srcBody.max_tokens;

  const PREFIX = "agent2/";
  const asked = String(model || "").startsWith(PREFIX) ? String(model).slice(PREFIX.length) : "";
  const smart = asked && asked !== "auto" && asked !== "smart" ? asked : null;

  const order = [];
  const push = (m) => {
    if (m && !order.includes(m)) order.push(m);
  };
  if (smart) push(smart);
  if (!smart || AGENT2_FALLBACK) {
    if (!smart && agent2State.lastGood && agent2Ok(agent2State.lastGood)) push(agent2State.lastGood);
    for (const m of AGENT2_SMART_MODELS) if (agent2Ok(m)) push(m);
  }

  const tried = new Set();
  let lastErr = null;
  const t0 = Date.now();
  // 总死线：最多熬一次超时 + 换一个模型。再往上拖，扩展侧自己的 120s
  // 也已经放弃了，翻译结果会被丢弃，白烧。
  const DEADLINE_MS = AGENT2_TIMEOUT_MS + 75000;

  const attempt = async (m) => {
    tried.add(m);
    try {
      return await agent2Try(m, payload, authHeader);
    } catch (e) {
      lastErr = e;
      if (e.network || (smart && !AGENT2_FALLBACK)) throw { stop: true, cause: e };
      return null;
    }
  };

  for (const m of order) {
    if (Date.now() - t0 > DEADLINE_MS) break;
    try {
      const out = await attempt(m);
      if (out) return out;
    } catch (e) {
      if (e && e.stop) { lastErr = e.cause; break; }
      if (Date.now() - t0 > DEADLINE_MS) break;
    }
  }

  // 优先级表全灭：从网关模型清单里捞几个没试过的兜底（只在这种时刻才扫全表）
  if ((!smart || AGENT2_FALLBACK) && Date.now() >= agent2State.gatewayDownUntil && Date.now() - t0 <= DEADLINE_MS) {
    try {
      const list = await agent2ListModels();
      let swept = 0;
      for (const m of list) {
        if (swept >= AGENT2_SWEEP_MAX || Date.now() - t0 > DEADLINE_MS) break;
        if (tried.has(m) || !agent2Ok(m)) continue;
        swept++;
        try {
          const out = await attempt(m);
          if (out) return out;
        } catch (e) {
          if (e && e.stop) { lastErr = e.cause; break; }
        }
      }
    } catch (e) {
      lastErr = lastErr || e;
    }
  }

  throw new Error("Agent2 网关没有可用模型" + (lastErr ? "，最后错误: " + lastErr.message : ""));
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
    return send(res, 200, { ok: true, mock: MOCK, cli: cliPath, codebuddy: codebuddyPath, agent2: agent2Health() });
  }

  // Agent2 网关模型清单（调试 / 扩展侧想动态铺下拉框时用）
  if (req.method === "GET" && req.url === "/agent2/models") {
    try {
      const list = await agent2ListModels();
      return send(res, 200, { base: AGENT2_BASE, count: list.length, models: list });
    } catch (e) {
      return send(res, 502, { error: { message: "Agent2 网关不可达: " + (e.message || e) } });
    }
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
      const out = await generate(prompt, body.model, {
        messages: body.messages,
        authHeader: req.headers.authorization,
        srcBody: body,
      });
      return send(res, 200, {
        id: "chatcmpl-opencode-bridge",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        // agent2 时如实报告智能模式实际选中的模型，一眼看出是谁翻的
        model: out.model ? "agent2/" + out.model : body.model || normalizeModel(""),
        choices: [
          { index: 0, message: { role: "assistant", content: out.text }, finish_reason: "stop" },
        ],
      });
    } catch (e) {
      console.error("[bridge] 失败:", e.message);
      return send(res, 502, { error: { message: String(e.message || e) } });
    }
  }

  /* ------------------------------ 语音识别（ASR） ------------------------------ */

  if (req.method === "GET" && req.url === "/asr/status") {
    return send(res, 200, asrStatus());
  }

  // 上传视频 → 立刻返回 jobId，识别在后台跑
  if (req.method === "POST" && req.url.startsWith("/asr?")) {
    // 串行保护：已有任务在跑就直接拒，别让两个 whisper 抢 CPU
    const busy = activeJob();
    if (busy) {
      req.resume(); // 把请求体排空，否则客户端可能一直等着
      return send(res, 409, {
        error: { message: "已有识别任务在进行中（" + busy.stage + " " + busy.percent + "%），请等它完成" },
      });
    }

    const q = new URL(req.url, "http://localhost").searchParams;
    const job = createJob(decodeURIComponent(q.get("name") || "video"), q.get("lang"));
    let inputPath = null;
    try {
      inputPath = await saveUpload(req, job);
    } catch (e) {
      job.state = "error";
      job.error = String(e.message || e);
    }
    if (inputPath) {
      // 不 await：响应要先发出去，否则浏览器要空等几分钟
      runPipeline(job, inputPath);
    }
    return send(res, job.state === "error" ? 400 : 200, {
      jobId: job.id, state: job.state, error: job.error,
    });
  }

  // 轮询进度 / 取结果
  if (req.method === "GET" && req.url.startsWith("/asr/")) {
    const id = req.url.slice("/asr/".length).split("?")[0];
    const job = getJob(id);
    if (!job) return send(res, 404, { error: { message: "任务不存在或已过期" } });
    return send(res, 200, {
      state: job.state, stage: job.stage, percent: job.percent,
      srt: job.srt, error: job.error,
    });
  }

  return send(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[bridge] 已启动： http://localhost:" + PORT + "/v1/chat/completions");
  console.log("[bridge] 扩展里把「接口地址 Base URL」填成 http://localhost:" + PORT + "/v1");
  console.log("[bridge] Agent2 网关: " + AGENT2_BASE + "（智能模式优先: " + AGENT2_SMART_MODELS.slice(0, 3).join(" → ") + "）");
  if (MOCK) console.log("[bridge] 当前为 MOCK 模式（不调用模型）");

  // 启动时把 ASR 体检结果打出来，省得用户点按钮才发现没装依赖
  const asr = asrStatus();
  const miss = [];
  if (!asr.cli)       miss.push("whisper.cpp 可执行文件（bridge/whisper/ 下）");
  if (!asr.modelExists) miss.push("模型 " + path.basename(asr.model) + "（" + asr.modelUrl + "）");
  if (!asr.ffmpeg)    miss.push("ffmpeg");
  if (miss.length) {
    console.log("[bridge] 语音识别不可用，缺少: " + miss.join(" / "));
    console.log("[bridge] 装齐后 POST /asr 即可，无需重启本进程");
  } else {
    console.log("[bridge] 语音识别就绪: " + path.basename(asr.model) + " · " + asr.threads + " 线程 · " + asr.ffmpeg);
  }
});
