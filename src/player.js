/**
 * player.js — 本地视频双语字幕播放器
 *
 * 功能：
 *   1. 拖入/选择本地视频文件播放
 *   2. 拖入/选择 SRT 或 VTT 字幕文件，解析成时间轴数组
 *   3. 复用扩展 background.js 的翻译管道（Google + AI 混合）
 *   4. 按播放时间渲染原文+译文双语字幕叠层
 *   5. 右侧字幕列表可点击跳转
 *   6. 支持导出翻译好的 SRT 双语字幕
 */

"use strict";

/* ============================== 目标语言 ============================== */
const TARGET_LANGS = [
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
  ["en",    "English"],
  ["ja",    "日本語"],
  ["ko",    "한국어"],
  ["fr",    "Français"],
  ["de",    "Deutsch"],
  ["es",    "Español"],
  ["pt",    "Português"],
  ["ru",    "Русский"],
];

/* ============================== 状态 ============================== */
let cueList = [];                   // [{ start, end, text }]  毫秒
const translationCache = new Map(); // text -> { t, s }
let syncTimer = null;
let lastIdx = -1;
let currentVideoUrl = null;
let currentFile = null;             // 当前本地视频的 File 对象（ASR 上传用）
let asrRunning = false;

/* ============================== 元素引用 ============================== */
const $ = id => document.getElementById(id);
const dropZone     = $("drop-zone");
const playerArea   = $("player-area");
const video        = $("video");
const overlay      = $("subtitle-overlay");
const subOrig      = $("sub-orig");
const subTran      = $("sub-tran");
const subList      = $("sub-list");
const subPanel     = $("sub-panel");
const fileInfo     = $("file-info");
const statusEl     = $("translate-status");
const progressFill = $("progress-fill");
const progressThumb= $("progress-thumb");
const timeCur      = $("time-cur");
const timeDur      = $("time-dur");
const videoInput   = $("videoInput");
const subInput     = $("subInput");
const translateBtn = $("translateBtn");
const exportBtn    = $("exportBtn");
const asrBtn       = $("asrBtn");
const targetLangSel= $("targetLang");
const translatorSel= $("translator");

/* ============================== 初始化 ============================== */
(function init() {
  // 填目标语言选项
  for (const [v, l] of TARGET_LANGS) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = l;
    targetLangSel.appendChild(opt);
  }

  // 从扩展 storage 读上次的配置（同步）
  try {
    chrome.storage.sync.get(
      { targetLang: "zh-CN", translator: "ai", aiBaseUrl: "http://localhost:8788/v1", aiApiKey: "", aiModel: "agent2/auto" },
      stored => {
        targetLangSel.value = stored.targetLang || "zh-CN";
        translatorSel.value = stored.translator || "ai";
        window._aiCfg = {
          aiBaseUrl: stored.aiBaseUrl,
          aiApiKey:  stored.aiApiKey,
          aiModel:   stored.aiModel,
        };
      }
    );
  } catch (e) {
    window._aiCfg = { aiBaseUrl: "http://localhost:8788/v1", aiApiKey: "", aiModel: "agent2/auto" };
  }

  bindEvents();
})();

/* ============================== 事件绑定 ============================== */
function bindEvents() {
  // 拖放区
  dropZone.addEventListener("dragover",  e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
  dropZone.addEventListener("drop",      e => { e.preventDefault(); dropZone.classList.remove("drag-over"); handleDropFiles(e.dataTransfer.files); });
  dropZone.addEventListener("click",     e => { if (e.target === dropZone) videoInput.click(); });

  $("pickVideoBtn").addEventListener("click", () => videoInput.click());
  $("pickSubBtn").addEventListener("click",   () => subInput.click());

  videoInput.addEventListener("change", e => handleVideoFile(e.target.files[0]));
  subInput.addEventListener("change",   e => { if (e.target.files[0]) loadSubtitleFile(e.target.files[0]); });

  $("changeVideoBtn").addEventListener("click", () => videoInput.click());
  $("addSubBtn").addEventListener("click",       () => subInput.click());
  $("togglePanelBtn").addEventListener("click",  () => subPanel.classList.toggle("open"));

  translateBtn.addEventListener("click", startTranslation);
  exportBtn.addEventListener("click", exportSrt);
  asrBtn.addEventListener("click", startAsr);

  // 视频事件
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("loadedmetadata", () => { timeDur.textContent = fmtTime(video.duration); });

  // 进度条点击 seek
  $("progress-wrap").addEventListener("click", e => {
    if (!video.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    video.currentTime = ratio * video.duration;
  });

  // 播放区也接受拖放
  playerArea.addEventListener("dragover",  e => e.preventDefault());
  playerArea.addEventListener("drop",      e => { e.preventDefault(); handleDropFiles(e.dataTransfer.files); });
}

/* ============================== 文件处理 ============================== */
function handleDropFiles(files) {
  const arr = Array.from(files);
  const videoFile = arr.find(f => f.type.startsWith("video/") || /\.(mp4|mkv|webm|avi|mov|flv|m4v)$/i.test(f.name));
  const subFile   = arr.find(f => /\.(srt|vtt|ass)$/i.test(f.name));
  if (videoFile) handleVideoFile(videoFile);
  if (subFile)   loadSubtitleFile(subFile);
}

function handleVideoFile(file) {
  if (!file) return;
  if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
  currentVideoUrl = URL.createObjectURL(file);
  currentFile = file;
  video.src = currentVideoUrl;
  video.load();
  fileInfo.textContent = file.name;
  showPlayerArea();
  asrBtn.disabled = asrRunning;
}

function showPlayerArea() {
  dropZone.style.display = "none";
  playerArea.classList.add("active");
}

/* ============================== SRT / VTT 解析 ============================== */
function loadSubtitleFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    const ext  = file.name.split(".").pop().toLowerCase();
    let cues;
    try {
      cues = ext === "vtt" ? parseVtt(text) : parseSrt(text);
    } catch (err) {
      setStatus("字幕解析失败: " + err.message, true);
      return;
    }
    if (!cues.length) {
      setStatus("字幕文件为空或格式不支持", true);
      return;
    }
    applyCues(cues, "已加载 " + cues.length + " 条字幕，点「翻译字幕」开始");
  };
  reader.readAsText(file, "utf-8");
}

/**
 * 把一批 cue 装进播放器并重置翻译缓存。
 * 加载 SRT 文件和 ASR 识别完走的是同一条路径，所以抽出来共用。
 */
function applyCues(cues, msg) {
  cueList = cues;
  translationCache.clear();
  lastIdx = -1;
  setStatus(msg);
  translateBtn.disabled = false;
  exportBtn.disabled = false;
  renderSubList();
  startSync();
}

function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    // 跳过序号行（纯数字）
    let i = 0;
    if (/^\d+$/.test(lines[i].trim())) i++;
    const timeLine = lines[i];
    if (!timeLine) continue;
    const m = timeLine.match(/(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})/);
    if (!m) continue;
    const start = parseSrtTime(m[1]);
    const end   = parseSrtTime(m[2]);
    const bodyLines = lines.slice(i + 1);
    // 去掉 HTML 标签（<i> <b> 之类）
    const text2 = bodyLines.join(" ").replace(/<[^>]+>/g, "").trim();
    if (!text2) continue;
    cues.push({ start, end, text: text2 });
  }
  return cues;
}

function parseSrtTime(s) {
  const p = s.replace(",", ".").split(":");
  return (
    parseInt(p[0]) * 3600000 +
    parseInt(p[1]) * 60000  +
    Math.round(parseFloat(p[2]) * 1000)
  );
}

function parseVtt(text) {
  const cues = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  // 跳过 WEBVTT 头
  while (i < lines.length && !lines[i].startsWith("WEBVTT")) i++;
  i++;
  while (i < lines.length) {
    // 跳过空行和注释
    while (i < lines.length && !lines[i].includes("-->")) i++;
    if (i >= lines.length) break;
    const m = lines[i].match(/(\d{1,2}:?\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:?\d{2}:\d{2}\.\d{3})/);
    i++;
    if (!m) continue;
    const start = parseVttTime(m[1]);
    const end   = parseVttTime(m[2]);
    const body  = [];
    while (i < lines.length && lines[i].trim()) {
      body.push(lines[i].replace(/<[^>]+>/g, "").trim());
      i++;
    }
    const text2 = body.join(" ").trim();
    if (!text2) continue;
    cues.push({ start, end, text: text2 });
  }
  return cues;
}

function parseVttTime(s) {
  const p = s.split(":");
  if (p.length === 2) p.unshift("0"); // mm:ss.xxx
  return (
    parseInt(p[0]) * 3600000 +
    parseInt(p[1]) * 60000  +
    Math.round(parseFloat(p[2]) * 1000)
  );
}

/* ============================== 翻译 ============================== */
const CHUNK = 12;
const MAX_RETRIES = 2;
const failedAttempts = new Map();

function buildCfg() {
  return {
    translator: translatorSel.value,
    targetLang: targetLangSel.value,
    ...(window._aiCfg || {}),
  };
}

async function startTranslation() {
  if (!cueList.length) return;
  translateBtn.disabled = true;
  setStatus("翻译中…");

  const cfg = buildCfg();
  const seen = new Set();
  const texts = [];
  for (const c of cueList) {
    if (!seen.has(c.text)) { seen.add(c.text); texts.push(c.text); }
  }
  const pending = texts.filter(t => !translationCache.has(t));
  if (!pending.length) {
    setStatus("全部已翻译 ✓");
    translateBtn.disabled = false;
    renderSubList();
    return;
  }

  const totalBatches = Math.ceil(pending.length / CHUNK);
  let done = 0;

  // 第一阶段：Google 打底（AI 模式才有，纯 google 跳过）
  if (cfg.translator === "ai") {
    for (let i = 0; i < pending.length; i += CHUNK) {
      const chunk = pending.slice(i, i + CHUNK);
      await runChunk(chunk, "google", cfg);
      done += chunk.length;
      setStatus("Google 打底 " + Math.min(done, pending.length) + "/" + pending.length + "…");
      renderSubList();
    }
    done = 0;
  }

  // 第二阶段：AI 覆盖（或纯 google 模式的唯一阶段）
  const engine = cfg.translator === "ai" ? "ai" : "google";
  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK).filter(t => {
      const e = translationCache.get(t);
      return engine === "ai" ? (!e || e.s !== "ai") : !e;
    });
    if (!chunk.length) { done += CHUNK; continue; }
    await runChunk(chunk, engine, cfg);
    done += chunk.length;
    const batchNo = Math.floor(i / CHUNK) + 1;
    const label = engine === "ai" ? "AI 翻译" : "Google 翻译";
    setStatus(label + " " + Math.min(done, pending.length) + "/" + pending.length + " · 第 " + batchNo + "/" + totalBatches + " 批");
    renderSubList();
  }

  const final = texts.filter(t => translationCache.has(t)).length;
  setStatus("✓ 已翻译 " + final + "/" + texts.length + " 条");
  translateBtn.disabled = false;
  exportBtn.disabled = false;
}

async function runChunk(chunk, engine, cfg) {
  const cfgForBg = { ...cfg, translator: engine };
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(
        { type: "TRANSLATE_BATCH", texts: chunk, config: cfgForBg },
        res => {
          if (chrome.runtime.lastError || !res || !Array.isArray(res.translations)) {
            // 全批失败：记失败次数，不进缓存
            for (const t of chunk) {
              const k = engine + "|" + t;
              failedAttempts.set(k, (failedAttempts.get(k) || 0) + 1);
            }
            return resolve();
          }
          for (let j = 0; j < chunk.length; j++) {
            const tr = res.translations[j];
            if (!tr || tr.trim() === chunk[j].trim()) continue; // 失败回退的原文不存
            const cur = translationCache.get(chunk[j]);
            if (cur && cur.s === "ai" && engine !== "ai") continue; // 不降级
            translationCache.set(chunk[j], { t: tr.trim(), s: engine });
          }
          resolve();
        }
      );
    } catch (e) {
      resolve();
    }
  });
}

/* ============================== 语音识别（ASR） ============================== */

/**
 * 桥接服务根地址。设置里的 Base URL 形如 http://localhost:8788/v1，
 * ASR 挂在同端口的 /asr 下，所以要把结尾的 /v1 摘掉。
 */
function bridgeRoot() {
  const base = (window._aiCfg && window._aiCfg.aiBaseUrl) || "http://localhost:8788/v1";
  return String(base).replace(/\/+$/, "").replace(/\/v1$/, "");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function startAsr() {
  if (!currentFile || asrRunning) return;

  // 开工前先体检，省得传完 2GB 才发现 whisper 没装
  setStatus("检查识别环境…");
  let st;
  try {
    const r = await fetch(bridgeRoot() + "/asr/status");
    if (!r.ok) throw new Error("HTTP " + r.status);
    st = await r.json();
  } catch (e) {
    return fail("连不上桥接服务 " + bridgeRoot() + "，请确认已启动且「接口地址」指向它");
  }
  if (!st.ok) {
    const miss = [];
    if (!st.cli)        miss.push("whisper.cpp");
    if (!st.modelExists) miss.push("模型文件");
    if (!st.ffmpeg)     miss.push("ffmpeg");
    return fail("语音识别环境缺失：" + miss.join(" / "));
  }

  asrRunning = true;
  asrBtn.disabled = true;
  translateBtn.disabled = true;

  try {
    setStatus("上传视频 0%…");
    const jobId = await uploadVideo(currentFile, p => setStatus("上传视频 " + p + "%…"));
    const srt = await pollAsr(jobId);

    const cues = parseSrt(srt);
    if (!cues.length) return fail("识别完成，但没能解析出字幕条目");

    applyCues(cues, "✓ 识别出 " + cues.length + " 条字幕（" + st.threads + " 线程）· 点「翻译字幕」开始");
  } catch (e) {
    fail(e.message || String(e));
  } finally {
    asrRunning = false;
    asrBtn.disabled = false;
    translateBtn.disabled = !cueList.length;
  }

  function fail(msg) {
    setStatus(msg, true);
  }
}

/** POST 视频字节到 /asr，返回 jobId。用 XHR 而不是 fetch，因为只有 XHR 有上传进度。 */
function uploadVideo(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", bridgeRoot() + "/asr?name=" + encodeURIComponent(file.name));
    xhr.timeout = 0; // 大文件慢，别让 XHR 自己超时

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(Math.min(99, Math.round(e.loaded / e.total * 100)));
    };
    xhr.onload = () => {
      let j = null;
      try { j = JSON.parse(xhr.responseText); } catch { /* 非 JSON */ }
      if (xhr.status >= 400 || !j || !j.jobId) {
        reject(new Error((j && j.error) || ("桥接服务返回 HTTP " + xhr.status)));
        return;
      }
      resolve(j.jobId);
    };
    xhr.onerror   = () => reject(new Error("上传失败，请确认桥接服务还在运行"));
    xhr.ontimeout = () => reject(new Error("上传超时"));

    xhr.send(file);
  });
}

/** 轮询任务直到出 SRT 或报错 */
async function pollAsr(jobId) {
  for (;;) {
    await sleep(1000);
    let j;
    try {
      const r = await fetch(bridgeRoot() + "/asr/" + jobId);
      j = await r.json();
    } catch {
      continue; // 偶发断连不算失败，下一轮再试
    }
    if (j.state === "done") return j.srt;
    if (j.state === "error") throw new Error(j.error || "识别失败");
    setStatus((j.stage || "处理中") + (typeof j.percent === "number" && j.percent ? " " + j.percent + "%" : "…"));
  }
}

/* ============================== 时间同步 & 字幕渲染 ============================== */
function startSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(onTimeUpdate, 100);
}

function onTimeUpdate() {
  if (!cueList.length) return;
  const t = Math.round(video.currentTime * 1000);

  // 更新进度条
  if (video.duration) {
    const p = t / (video.duration * 1000) * 100;
    progressFill.style.width = p + "%";
    progressThumb.style.left = p + "%";
    timeCur.textContent = fmtTime(video.currentTime);
  }

  const idx = findCue(t);
  if (idx !== lastIdx) {
    lastIdx = idx;
    renderCue(idx);
    highlightListItem(idx);
  }
}

function findCue(t) {
  for (let i = 0; i < cueList.length; i++) {
    if (t >= cueList[i].start && t <= cueList[i].end) return i;
  }
  return -1;
}

function renderCue(idx) {
  if (idx < 0 || !cueList[idx]) {
    overlay.classList.remove("visible");
    subOrig.textContent = "";
    subTran.textContent = "";
    return;
  }
  overlay.classList.add("visible");
  const cue = cueList[idx];
  const e   = translationCache.get(cue.text);
  subOrig.textContent = cue.text;
  subTran.textContent = e ? e.t : "…";
}

/* ============================== 字幕列表 ============================== */
function renderSubList() {
  subList.innerHTML = "";
  if (!cueList.length) {
    subList.innerHTML = '<div class="no-sub-hint">暂无字幕<br/>点右上角「加载字幕」添加 SRT/VTT 文件</div>';
    return;
  }
  for (let i = 0; i < cueList.length; i++) {
    const c = cueList[i];
    const e = translationCache.get(c.text);
    const item = document.createElement("div");
    item.className = "sub-item" + (i === lastIdx ? " active" : "");
    item.dataset.idx = i;
    item.innerHTML = `
      <div class="time-stamp">${fmtMsTime(c.start)} → ${fmtMsTime(c.end)}</div>
      <div class="orig">${escHtml(c.text)}</div>
      ${e ? `<div class="tran">${escHtml(e.t)}<span class="src-tag ${e.s}">${e.s === "ai" ? "AI" : "G"}</span></div>` : ""}
    `;
    item.addEventListener("click", () => {
      video.currentTime = c.start / 1000;
    });
    subList.appendChild(item);
  }
}

function highlightListItem(idx) {
  const old = subList.querySelector(".sub-item.active");
  if (old) old.classList.remove("active");
  if (idx < 0) return;
  const el = subList.querySelector(`[data-idx="${idx}"]`);
  if (el) {
    el.classList.add("active");
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

/* ============================== 导出 SRT ============================== */
function exportSrt() {
  if (!cueList.length) return;
  const targetLang = targetLangSel.value;
  const lines = [];
  for (let i = 0; i < cueList.length; i++) {
    const c = cueList[i];
    const e = translationCache.get(c.text);
    lines.push(String(i + 1));
    lines.push(fmtSrtTime(c.start) + " --> " + fmtSrtTime(c.end));
    lines.push(c.text);
    if (e) lines.push(e.t);
    lines.push("");
  }
  const content = lines.join("\n");
  const blob = new Blob(["\uFEFF" + content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "bilingual_" + targetLang + ".srt";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

/* ============================== 工具函数 ============================== */
function fmtTime(sec) {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ":" + String(s).padStart(2, "0");
}

function fmtMsTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return m + ":" + String(s).padStart(2, "0");
}

function fmtSrtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h   = Math.floor(ms / 3600000);
  const m   = Math.floor((ms % 3600000) / 60000);
  const s   = Math.floor((ms % 60000) / 1000);
  const msec= ms % 1000;
  const pad = (n, l) => String(n).padStart(l, "0");
  return pad(h,2)+":"+pad(m,2)+":"+pad(s,2)+","+pad(msec,3);
}

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.className = "translate-status" + (isError ? " error" : "");
}
