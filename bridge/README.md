# OpenCode 翻译桥接服务

把 OpenCode 变成扩展可用的 **OpenAI 兼容**翻译后端。

## 为什么需要它

OpenCode 的 HTTP API 是**会话式**的（session / prompt / generate），
并不直接暴露 OpenAI 的 `/chat/completions`。
而扩展的「AI 翻译」需要一个 OpenAI 兼容端点，所以中间加一个几十行的桥。

桥做的事：

```
扩展  ──POST /v1/chat/completions──▶  桥(本服务)  ──POST /api/experimental/generate──▶  OpenCode
        (OpenAI 格式)                          (把 system+user 拼成 prompt)                (返回 data.text)
```

## 运行

```bash
cd bridge
npm install
npm start        # 默认监听 http://localhost:8788
```

## 在扩展里配置

设置面板 → 翻译引擎选「AI 翻译」：

| 字段 | 值 |
|------|-----|
| 接口地址 Base URL | `http://localhost:8788/v1` |
| API Key | 随便填或留空（桥不校验） |
| 模型 | 留空用 OpenCode 默认模型；或填 `providerID/id` |

## 环境变量

| 变量 | 说明 |
|------|------|
| `BRIDGE_PORT` | 桥端口，默认 8788 |
| `OPENCODE_MODEL` | 强制模型，如 `anthropic/claude-sonnet-4` |
| `OPENCODE_URL` | 直接指定 OpenCode 服务地址（跳过自动发现） |
| `OPENCODE_TOKEN` | 配合 `OPENCODE_URL` 的 Bearer token |

## 参考

- 接口定义：`POST /api/experimental/generate`，请求 `{ prompt, model? }`，返回 `{ data: { text } }`
- 模型引用：`{ providerID, id, variant? }`
- 客户端文档：<https://opencode.ai/v2/docs/build/client>
- API 参考：<https://opencode.ai/v2/docs/api>
