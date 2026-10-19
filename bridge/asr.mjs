/**
 * asr.mjs — 语音识别：本地视频/音频 → SRT 字幕
 *
 *   POST /asr?name=xxx.mp4   请求体直接是文件字节（流式落盘，不进内存）
 *        -> { jobId, state }
 *   GET  /asr/:jobId          -> { state, stage, percent, srt?, error? }
 *   GET  /asr/status          -> 环境自检（whisper.cpp / 模型 / ffmpeg 在不在）
 *
 * 流水线：
 *   上传临时文件
 *     → ffmpeg 抽音轨（-vn -ac 1 -ar 16000 -c:a pcm_s16le）
 *     → whisper-cli 识别
 *     → 读回 <out>.srt
 *
 * 为什么中间要过一道 ffmpeg：
 *   1. whisper.cpp 官方 Windows 预编译包不带媒体解码器，
 *      直接喂 mp4/mkv 多数会失败；喂 wav 则是 100% 可行。
 *   2. ffmpeg 能吃 mp4/mkv/avi/flv/mov/ts 等几乎所有容器，
 *      顺带把多声道混成单声道、重采样到 whisper 想要的 16kHz。
 *
 * 为什么用任务 + 轮询而不是同步 POST：
 *   识别 1 小时视频要几分钟，同步请求期间浏览器完全没反馈。
 *   拆成「上传拿 jobId → 轮询进度」才能显示实时百分比。
 *
 * 可选环境变量：
 *   ASR_DIR       whisper.cpp 可执行文件所在目录，默认 ./whisper
 *   ASR_MODEL     模型文件名，默认 ggml-base.bin（在 ASR_DIR 下）
 *   ASR_LANG      语言代码，默认 auto（自动检测）
 *   ASR_THREADS   识别线程数，默认 min(8, CPU 逻辑核数)
 *   ASR_MAX_MB    单文件大小上限 MB，默认 4096
 *   FFMPEG        ffmpeg 可执行文件路径，默认自动探测
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync,
  statSync, unlinkSync, createWriteStream,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------ 配置 ------------------------------ */

const ASR_DIR    = process.env.ASR_DIR || path.join(HERE, "whisper");
const ASR_MODEL  = process.env.ASR_MODEL || "ggml-base.bin";
const ASR_LANG   = process.env.ASR_LANG || "auto";
const ASR_THREADS = Number(
  process.env.ASR_THREADS || Math.max(4, Math.min(8, os.cpus().length))
);
const MAX_UPLOAD = Number(process.env.ASR_MAX_MB || 4096) * 1024 * 1024;
const JOB_TTL    = 30 * 60 * 1000;   // 30 分钟后清理任务和临时文件

const TMP_DIR = path.join(os.tmpdir(), "yt-asr");
mkdirSync(TMP_DIR, { recursive: true });

/** jobId -> { id, state, stage, percent, srt, error, fileName, tempFiles, createdAt } */
const jobs = new Map();

/* ------------------------------ 依赖探测 ------------------------------ */

/** whisper.cpp 的可执行文件名各版本不统一，新版是 whisper-cli，旧版是 main */
function findWhisperCli() {
  if (process.env.ASR_CLI) return process.env.ASR_CLI;
  for (const name of ["whisper-cli.exe", "main.exe", "whisper-cli", "main"]) {
    const p = path.join(ASR_DIR, name);
    if (existsSync(p)) return p;
  }
  // 有些包会多套一层目录（Release/、bin/）
  if (existsSync(ASR_DIR)) {
    for (const dir of readdirSync(ASR_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const name of ["whisper-cli.exe", "main.exe"]) {
        const p = path.join(ASR_DIR, dir.name, name);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

let ffmpegCache;
function findFfmpeg() {
  if (ffmpegCache !== undefined) return ffmpegCache;
  const list = [];
  if (process.env.FFMPEG) list.push(process.env.FFMPEG);
  // conda / scoop / winget / choco 的常见安装位置
  list.push(
    "ffmpeg",
    path.join(process.env.USERPROFILE || "", "scoop", "shims", "ffmpeg.exe"),
    "D:\\Environment\\Mconda\\Library\\bin\\ffmpeg.exe",
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
    "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe"
  );
  for (const c of list) {
    // 绝对路径直接查存在性；PATH 里的名字探一次 spawn 看能不能跑起来
    if (path.isAbsolute(c)) {
      if (existsSync(c)) return (ffmpegCache = c);
      continue;
    }
    const r = spawnSync(c, ["-version"], { windowsHide: true, timeout: 5000 });
    if (!r.error && r.status === 0) return (ffmpegCache = c);
  }
  ffmpegCache = null;
  return null;
}

function modelPath() {
  return path.isAbsolute(ASR_MODEL) ? ASR_MODEL : path.join(ASR_DIR, ASR_MODEL);
}

/** /asr/status 用：一次性把所有前置条件体检一遍 */
export function asrStatus() {
  const cli = findWhisperCli();
  const mp  = modelPath();
  const ff  = findFfmpeg();
  return {
    ok: !!(cli && existsSync(mp) && ff),
    cli, model: mp, modelExists: existsSync(mp),
    ffmpeg: ff, lang: ASR_LANG, threads: ASR_THREADS,
    modelUrl: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" + ASR_MODEL,
  };
}

/* ------------------------------ 任务管理 ------------------------------ */

export function createJob(fileName, lang) {
  const id = crypto.randomBytes(8).toString("hex");
  const job = {
    id,
    state: "uploading",      // uploading -> extracting -> transcribing -> done | error
    stage: "上传中",
    percent: 0,
    fileName: fileName || "video",
    lang: lang || ASR_LANG,
    srt: null,
    error: null,
    tempFiles: [],
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  sweep();
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

/**
 * 当前是否已有任务在跑。
 * whisper.cpp 一次就吃掉 8 个线程，两个任务并发会把 CPU 抢光、两边都变慢，
 * 所以这里只允许串行，第二个请求直接回 409。
 */
export function activeJob() {
  for (const job of jobs.values()) {
    if (job.state === "uploading" || job.state === "extracting" || job.state === "transcribing") {
      return job;
    }
  }
  return null;
}

/** 定期清掉过期任务（正常情况下临时文件已经即时删掉了，这里兜底） */
function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL) {
      cleanupTemp(job);
      jobs.delete(id);
    }
  }
}

/* ------------------------------ 上传落盘 ------------------------------ */

/**
 * 把请求体流式写到临时文件。必须用 pipeline，不能先收进内存——
 * 2GB 的视频会让 Node 直接 OOM。
 */
export async function saveUpload(req, job) {
  const ext = path.extname(job.fileName) || ".mp4";
  const dest = path.join(TMP_DIR, job.id + "_in" + ext);
  job.tempFiles.push(dest);

  let written = 0;
  req.on("data", c => {
    written += c.length;
    if (written > MAX_UPLOAD) {
      job.state = "error";
      job.error = `文件超过上限 ${Math.round(MAX_UPLOAD / 1024 / 1024)} MB`;
      req.destroy();
    }
  });

  try {
    await pipeline(req, createWriteStream(dest));
  } catch (e) {
    // 上传中断是常态（用户取消、页��关闭），不算致命错误
    if (job.state !== "error") {
      job.state = "error";
      job.error = "上传中断: " + (e.message || e);
    }
    return null;
  }

  if (job.state === "error") return null;
  if (!existsSync(dest) || statSync(dest).size === 0) {
    job.state = "error";
    job.error = "上传内容为空";
    return null;
  }
  return dest;
}

/* ------------------------------ 识别流水线 ------------------------------ */

/** 上传完成后调用；内部推进 state/percent，外部只管轮询 */
export async function runPipeline(job, inputPath) {
  try {
    const ff = findFfmpeg();
    if (!ff) throw new Error("找不到 ffmpeg，请安装后设置 FFMPEG 环境变量指向可执行文件");

    /* --- 1. 抽音轨 --- */
    job.state = "extracting";
    job.stage = "抽取音频";
    job.percent = 0;

    const wav = path.join(TMP_DIR, job.id + ".wav");
    job.tempFiles.push(wav);
    await runFfmpeg(ff, inputPath, wav, job);

    // ffmpeg 对没有音轨的输入会以非 0 退出，wav 也不会生成
    if (!existsSync(wav) || statSync(wav).size <= 44) {
      throw new Error("这个文件里没有可用的音轨");
    }

    /* --- 2. 识别 --- */
    const cli = findWhisperCli();
    if (!cli) throw new Error("找不到 whisper.cpp 可执行文件，请确认 bridge/whisper 目录");
    const mp = modelPath();
    if (!existsSync(mp)) {
      throw new Error(`找不到模型 ${ASR_MODEL}，下载地址：${asrStatus().modelUrl}`);
    }

    job.state = "transcribing";
    job.stage = "语音识别";
    job.percent = 0;

    const outPrefix = path.join(TMP_DIR, job.id);
    const srtPath = outPrefix + ".srt";
    job.tempFiles.push(srtPath);

    await runWhisper(cli, mp, wav, outPrefix, job);

    if (!existsSync(srtPath)) throw new Error("识别结束但没有生成 SRT");
    const srt = readFileSync(srtPath, "utf8");
    if (!srt.trim()) throw new Error("没有识别出任何语音内容");

    job.srt = srt;
    job.state = "done";
    job.stage = "完成";
    job.percent = 100;
  } catch (e) {
    job.state = "error";
    job.stage = "失败";
    job.error = String(e.message || e);
    console.error("[asr] 失败:", job.error);
  } finally {
    // SRT 已经读进内存了，磁盘上的东西（上传的视频、抽出的 wav）没必要留。
    // 不马上删的话，连续识别几个大视频就能在临时目录堆出好几 GB。
    cleanupTemp(job);
  }
}

/** 删掉这个任务产生的所有临时文件 */
function cleanupTemp(job) {
  for (const f of job.tempFiles) {
    try { unlinkSync(f); } catch { /* 不存在就算了 */ }
  }
  job.tempFiles.length = 0;
}

/**
 * ffmpeg 的报错长这样：
 *   [mov,mp4,m4a,3gp,3g2,mj2 @ 000001E5E4E4000] moov atom not found
 * 里面的 @ 地址对用户毫无意义，而且每次都不一样。这里剥掉这类前缀，
 * 只留人话部分，方便在播放器的状态栏里直接显示。
 */
function firstFfmpegError(stderr, exitCode) {
  for (const line of stderr.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // 去掉 "[xxx @ 0x7ff...]" 前缀
    const msg = t.replace(/^\[[^\]]*@[^\]]*\]\s*/, "");
    if (msg) return msg.slice(0, 200);
  }
  return "ffmpeg 退出码 " + exitCode;
}

/** ffmpeg -i <in> -vn -ac 1 -ar 16000 -c:a pcm_s16le <out.wav> */
function runFfmpeg(ff, input, output, job) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", input,
      "-vn",                 // 丢掉视频轨
      "-ac", "1",            // 混成单声道
      "-ar", "16000",        // whisper 只要 16kHz
      "-c:a", "pcm_s16le",
      output,
    ];
    const child = spawn(ff, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => reject(new Error("ffmpeg 启动失败: " + e.message)));
    child.on("close", code => {
      if (code === 0) return resolve();
      reject(new Error("音频抽取失败: " + firstFfmpegError(err, code)));
    });
  });
}

/**
 * whisper-cli -m <model> -f <wav> -l <lang> -t <threads> -osrt -of <prefix> -pp
 * 进度从 stderr 的 `progress = NN%` 里抠。
 */
function runWhisper(cli, model, wav, outPrefix, job) {
  return new Promise((resolve, reject) => {
    const args = [
      "-m", model,
      "-f", wav,
      "-l", job.lang,
      "-t", String(ASR_THREADS),
      "-osrt",
      "-of", outPrefix,
      "-pp",
    ];
    const child = spawn(cli, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    let buf = "";

    const onData = d => {
      err += d;
      buf += d;
      // 按行扫，避免一条日志里塞了多个进度导致漏解析
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        const m = line.match(/progress\s*=\s*(\d+)\s*%/i);
        if (m) job.percent = Math.min(99, Number(m[1]));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", e => reject(new Error("whisper.cpp 启动失败: " + e.message)));
    child.on("close", code => {
      // 最后一坨数据可能没换行，兜底再扫一次
      const tail = buf.match(/progress\s*=\s*(\d+)\s*%/i);
      if (tail) job.percent = Math.min(99, Number(tail[1]));

      if (code === 0) return resolve();
      const first = err.split(/\r?\n/).find(l => /error|fail|invalid|cannot/i.test(l))
                 || err.trim().split(/\r?\n/).pop()
                 || ("退出码 " + code);
      reject(new Error("识别失败: " + String(first).trim().slice(0, 200)));
    });
  });
}
