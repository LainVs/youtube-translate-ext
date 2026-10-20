# OpenCode 翻译桥接服务

把本机的 **OpenCode CLI** 变成扩展可用的 **OpenAI 兼容**翻译后端。**零第三方依赖。**

模型前缀即后端路由（详见下文）：

| 模型前缀 | 后端 |
|----------|------|
| `agent2/…` | 本机 Agent2API 网关（OpenAI 兼容 HTTP，默认 `127.0.0.1:3065/v1`） |
| `codebuddy/…` | 本机 CodeBuddy CLI |
| 其余 | 本机 OpenCode CLI |

## 为什么需要它

- 扩展的「AI 翻译」需要一个 OpenAI 兼容端点 `POST /v1/chat/completions`。
- OpenCode 原生 API 是会话式的，不兼容该格式。
- **关键**：OpenCode 的免费模型（含 `opencode/big-pickle`）通过 HTTP
  `POST /api/experimental/generate` 调用时会被拒绝：

  ```text
  Model unavailable: opencode/big-pickle
  OpenCode's free tier can only be used from within OpenCode
  ```

  而命令行 `opencode run` 属于「OpenCode 内部调用」，可以正常使用免费模型。

所以桥改为：**扩展 → 桥 → 本机 `opencode` CLI**。

```
扩展  ──POST /v1/chat/completions──▶  桥(本服务)  ──spawn──▶  opencode run --format json --model <m> <prompt>
        (OpenAI 格式)                          (把 system+user 拼成 prompt)         (解析事件流里的 text 片段)
```

## 运行

```bash
cd bridge
npm start          # 默认监听 http://localhost:8788
```

> 无需 `npm install`：本服务不使用任何第三方包。
> 依赖的是已经安装好的 OpenCode（命令行 `opencode`，或桌面版自带的 CLI）。

## 开机自启（推荐，装一次就不用管了）

双击一次 **`install-autostart.bat`**：

- 在 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` 写入
  `yt-subtitle-bridge.vbs`，登录 Windows 时以**隐藏窗口**拉起桥，平时看不到任何窗口
- 守护脚本 `autostart-supervisor.bat` 会在桥异常退出后 5 秒自动重启
- 日志追加到 `bridge/bridge.log`（超过 5MB 自动清空；该文件不入库）
- 安装脚本会顺便做一次健康检查，失败会提示看日志

取消：双击 **`uninstall-autostart.bat`**（删启动项 + 停桥）。
临时手动启动仍然可以用 `start-bridge.bat` 或 `npm start`（检测到 8788
已被自启实例占用时会提示并退出，不会打架）。

> 注意：启动项里写的是本目录的绝对路径。如果移动了项目文件夹，
> 重新双击一次 `install-autostart.bat` 即可。

## 在扩展里配置

设置面板 → 翻译引擎选「AI 翻译」：

| 字段 | 值 |
|------|-----|
| 接口地址 Base URL | `http://localhost:8788/v1` |
| API Key | 随便填或留空（桥不校验） |
| 模型 | `agent2/auto`（默认，智能模式：哪个能用用哪个）或下表里的任意一个 |

## Agent2 网关后端（智能选模型）

模型前缀 `agent2/` 的请求直接转发到本机 **Agent2API** 网关（桌面版监听
`http://127.0.0.1:3065`，本身就是 OpenAI 兼容的 HTTP）。

### 智能模式 `agent2/auto`

按优先级表逐个试，**哪个能用用哪个**：

1. 上次成功的模型（lastGood，不在冷却中时优先复用）
2. 优先级表（可用 `AGENT2_SMART_MODELS` 环境变量改）：默认
   `glm-5.3-flash → deepseek-v4.1-flash → deepseek-v4.1-flash-sg → zcode-glm-5.3-flash → space-bunny → glm-5.3 → deepseek-v4-pro → minimax-m3`
3. 优先级表全灭时，从网关 `/v1/models` 里捞没试过的兜底（最多 6 个）

失败自动进冷却并换下一个：429 限流 → 冷却 60s；404/400（模型不存在）→ 600s；
超时 → 45s；5xx / 空回复 → 30s；网关连不上 → 全局冷却 15s 直接报错。
响应里的 `model` 字段如实报告实际选中的模型，一眼看出是谁翻的。

实测（2026-10-20）：`glm-5.3-flash` 下发 `reasoning_effort=none` 后单批 3~8s，
`deepseek-v4.1-flash` 恒定 ~60s（关思考也不提速），所以 GLM 排在前面。

### 指定模型

- `agent2/glm-5.3-flash` 等具体 ID：优先用该模型；挂了同样按智能模式换下一个
  （`AGENT2_FALLBACK=0` 变严格模式，挂了就报错）。
- 网关上的全部模型见 `GET /agent2/models`（桥会转发网关清单）。

## opencode / codebuddy 说明

## 原理：CLI 探测顺序

桥启动后第一次收到请求时，会按以下顺序探测可用的 CLI（探测方式：跑一次 `--version`）：

1. 环境变量 `OPENCODE_CLI` 指定的路径
2. 桌面版自带的 V2 CLI：`%APPDATA%\ai.opencode.desktop\cli\<version>\opencode-cli.exe`（取版本号最大的）
3. PATH 上的 `opencode`（chocolatey / npm）

命中后会缓存。`GET /health` 可以看到当前使用的 CLI 路径。

## 环境变量

| 变量 | 说明 |
|------|------|
| `BRIDGE_PORT` | 桥端口，默认 8788 |
| `OPENCODE_CLI` | 直接指定 OpenCode CLI 可执行文件路径（可跳过自动探测） |
| `CODEBUDDY_CLI` | 直接指定 CodeBuddy CLI 可执行文件路径（默认探测 PATH 上的 `codebuddy`/`cbc`） |
| `OPENCODE_MODEL` | 强制模型，如 `opencode/space-bunny-free`；`codebuddy/` 前缀会改走 CodeBuddy CLI（覆盖请求里的 model） |
| `OPENCODE_TIMEOUT` | 单次翻译超时毫秒数，默认 120000 |
| `BRIDGE_MOCK` | 设为 `1` 时不调用模型，返回 `[译]` 前缀的假数据，方便联调 |
| `AGENT2_BASE_URL` | Agent2API 网关地址，默认 `http://127.0.0.1:3065/v1` |
| `AGENT2_API_KEY` | 网关 API Key（本地默认不校验；也透传请求里的 Authorization） |
| `AGENT2_TIMEOUT_MS` | 单次网关调用超时毫秒数，默认 75000 |
| `AGENT2_SMART_MODELS` | 智能模式优先级表，逗号分隔模型 ID |
| `AGENT2_NO_THINK` | 设为 `0` 时不下发 `reasoning_effort=none`（默认下发，字幕不需要思考） |
| `AGENT2_FALLBACK` | 设为 `0` 时 `agent2/指定模型` 挂了不自动换（严格模式） |
| `AGENT2_SWEEP_MAX` | 优先级表全灭后从网关清单捞兜底模型的个数上限，默认 6 |
| `ASR_DIR` | whisper.cpp 可执行文件目录，默认 `./whisper` |
| `ASR_MODEL` | 模型文件名，默认 `ggml-base.bin` |
| `ASR_LANG` | 识别语言，默认 `auto` |
| `ASR_THREADS` | 识别线程数，默认 `min(8, CPU 逻辑核数)` |
| `FFMPEG` | ffmpeg 可执行文件路径，默认自动探测 |

## 语音识别（本地视频自动生成字幕）

本地视频播放器里没有字幕文件时，点 **🎤 识别字幕** 会走这条链路：

```
本地视频 → POST /asr（流式落盘）→ ffmpeg 抽 16kHz 单声道 WAV → whisper.cpp → SRT → 现有翻译管道
```

翻译那一步完全复用已有的 Google 打底 + AI 覆盖，识别只负责产出字幕。

### 依赖

| 组件 | 说明 |
|------|------|
| ffmpeg | 抽音轨用，PATH 上有即可（或用 `FFMPEG` 指定） |
| whisper.cpp | `whisper-bin-x64.zip` 解压到 `bridge/whisper/`，桥会自动找 `whisper-cli.exe` / `main.exe` |
| 模型 | `bridge/whisper/ggml-base.bin`，从 <https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin> 下载 |

启动时桥会打印体检结果；`GET /asr/status` 可随时复查。

### 换模型

默认 `ggml-base.bin`（148 MB，英文够用，中文一般）。
想换只需改环境变量 `ASR_MODEL`，把对应 `.bin` 丢进 `bridge/whisper/` 即可：

| 模型 | 体积 | 适用 |
|------|------|------|
| `ggml-base.bin` | 148 MB | 先跑通流程 |
| `ggml-small.bin` | 466 MB | 日常够用 |
| `ggml-large-v3-turbo.bin` | 1.6 GB | 中英文质量最好，约慢 5 倍 |

### 加速

官方 Windows 预编译包是纯 CPU 的。要用上 Intel Arc 核显需自己按 Vulkan 后端编译
（`-DGGML_VULKAN=ON`，需要 Vulkan SDK + MSVC），官方数据是相对纯 CPU 有 3~4 倍提升。
Intel NPU 目前没有可用的 whisper 后端，别指望。

### 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/asr/status` | 环境体检：whisper.cpp / 模型 / ffmpeg |
| `POST` | `/asr?name=x.mp4` | 请求体是文件字节，返回 `{ jobId }` |
| `GET` | `/asr/:jobId` | `{ state, stage, percent, srt, error }` |

`state` 依次为 `uploading` → `extracting` → `transcribing` → `done` / `error`。
识别 1 小时视频要几分钟，所以拆成「上传拿 jobId → 轮询进度」而不是同步等待。

## 自检

```bash
# 健康检查（顺便看用了哪个 CLI）
curl http://localhost:8788/health

# Agent2 网关模型清单
curl http://localhost:8788/agent2/models

# Agent2 智能模式（响应的 model 字段是实际选中的模型）
curl http://localhost:8788/v1/chat/completions ^
  -H "content-type: application/json" ^
  -d "{\"model\":\"agent2/auto\",\"messages\":[{\"role\":\"system\",\"content\":\"只输出译文\"},{\"role\":\"user\",\"content\":\"Translate to Chinese: Good morning.\"}]}"

# 真实翻译一次
curl http://localhost:8788/v1/chat/completions ^
  -H "content-type: application/json" ^
  -d "{\"model\":\"opencode/space-bunny-free\",\"messages\":[{\"role\":\"system\",\"content\":\"只输出译文\"},{\"role\":\"user\",\"content\":\"Translate to Chinese: Good morning.\"}]}"
```

## 一个容易踩的坑

用 `child_process.spawn` 调 CLI 时，**stdin 必须设为 `ignore`**：

```js
spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
```

如果 stdin 留成打开的 pipe（spawn 的默认行为），`opencode run` 会一直等待 stdin 的 EOF，
表现为**进程挂起、零输出**。本服务已按此处理。

## 参考

- 模型引用格式：`providerID/id`（可选 `#variant`）
- OpenCode 客户端/API 文档：<https://opencode.ai/v2/docs>
