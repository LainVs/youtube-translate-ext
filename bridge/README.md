# OpenCode 翻译桥接服务

把本机的 **OpenCode CLI** 变成扩展可用的 **OpenAI 兼容**翻译后端。**零第三方依赖。**

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

## 在扩展里配置

设置面板 → 翻译引擎选「AI 翻译」：

| 字段 | 值 |
|------|-----|
| 接口地址 Base URL | `http://localhost:8788/v1` |
| API Key | 随便填或留空（桥不校验） |
| 模型 | `opencode/big-pickle`（默认） |

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
| `OPENCODE_MODEL` | 强制模型，如 `opencode/big-pickle`（覆盖请求里的 model） |
| `OPENCODE_TIMEOUT` | 单次翻译超时毫秒数，默认 120000 |
| `BRIDGE_MOCK` | 设为 `1` 时不调用模型，返回 `[译]` 前缀的假数据，方便联调 |

## 自检

```bash
# 健康检查（顺便看用了哪个 CLI）
curl http://localhost:8788/health

# 真实翻译一次
curl http://localhost:8788/v1/chat/completions ^
  -H "content-type: application/json" ^
  -d "{\"model\":\"opencode/big-pickle\",\"messages\":[{\"role\":\"system\",\"content\":\"只输出译文\"},{\"role\":\"user\",\"content\":\"Translate to Chinese: Good morning.\"}]}"
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
