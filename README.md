# YouTube 双语字幕翻译（复刻版）

复刻“快捷翻译”一类 Chrome 扩展的 **YouTube 字幕翻译** 功能：
在 YouTube 播放器上叠加一层自己渲染的 **原文 + 译文双语字幕**，支持分别设置字体颜色、字号和整体缩放比例。

## 功能

- ✅ 预取全片字幕，双语显示（原文 / 译文各自可调颜色、字号、缩放）
- ✅ 时间轴精准同步（二分匹配当前字幕）
- ✅ 批量翻译 + 缓存，视频切换自动重载
- ✅ 可隐藏 YouTube 原生字幕
- ✅ 可拖拽调整字幕位置，位置自动保存
- ✅ 广告播放时自动隐藏字幕
- ✅ 翻译引擎：Google 免费端点（默认，无需 Key）/ AI 翻译（OpenAI 兼容接口）
- ✅ 导出字幕文件：SRT / VTT / TXT，内容可选 双语 / 仅译文 / 仅原文

## 安装（开发版）

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本项目根目录（含 `manifest.json` 的那一层）
4. 打开任意有字幕的 YouTube 视频即可看到效果

> 视频必须有 CC 字幕轨道（“CC”按钮高亮）。没有字幕的视频无法翻译。

## 使用

1. 点击工具栏扩展图标打开设置面板
2. 选择目标语言、翻译引擎、字幕样式（颜色 / 字号 / 缩放）
3. 回到视频页，字幕会自动出现

## 工作原理

```
① 取字幕轨道   页面 script 中的 ytInitialPlayerResponse
               → captions.playerCaptionsTracklistRenderer.captionTracks
② 取字幕内容   baseUrl + "&fmt=json3" → fetch → events[]（带时间轴）
③ 翻译         content.js 批量发给 background.js
               → Google 免费端点 / AI 接口 → 结果写缓存
④ 渲染         player 内注入 #ytbs-wrapper 双语字幕层
⑤ 同步         setInterval(100ms) 读取 video.currentTime，二分查找当前字幕
```

详细调研见 [`research/FINDINGS.md`](research/FINDINGS.md)。

## 目录结构

```
youtube-translate-ext/
├── manifest.json              # MV3 配置
├── src/
│   ├── content.js             # 字幕获取 + 渲染 + 同步 + 导出（核心）
│   ├── content.css            # 字幕层样式
│   ├── background.js          # 翻译请求（Google / AI）
│   ├── popup.html/js/css      # 设置面板
│   └── icons/                 # 扩展图标
├── bridge/                    # OpenCode → OpenAI 兼容 桥接服务
├── preview/ui-preview.html    # UI 预览
├── scripts/generate-icons.ps1 # 图标生成脚本
└── research/                  # 竞品调研 + 参考源码
```

## 翻译引擎说明

- **Google 免费端点**：`translate.googleapis.com/translate_a/single`，无需 Key，开箱可用。
- **AI 翻译**：任何 OpenAI 兼容的 `/chat/completions` 接口。填写 Base URL、API Key、模型即可，
  也可以指向本地的 opencode / 自建网关，例如 `http://localhost:xxxx/v1`。
  AI 翻译更懂上下文、更口语化，但需要自备 Key。
- **接入 OpenCode**：OpenCode 原生 API 是会话式的，不兼容 `/chat/completions`。
  本项目在 [`bridge/`](bridge/) 提供了一个零依赖的桥接服务，内部调用本机 OpenCode CLI
  （`opencode run --format json`）并包装成 OpenAI 格式。**注意**：OpenCode 免费模型（含
  `opencode/big-pickle`）在 HTTP `POST /api/experimental/generate` 上会被拒
  （"free tier can only be used from within OpenCode"），但命令行 `opencode run` 属于内部调用，可用。
  详见 [bridge/README.md](bridge/README.md)。AI 引擎的默认配置即为
  `http://localhost:8788/v1` + `opencode/big-pickle`。

## 持久化翻译缓存

- 翻译结果按「视频 + 引擎 + 目标语言」缓存在 `chrome.storage.local`。
- 同一视频再次打开时直接命中缓存，无需重新翻译。

## 已知限制 / 后续可做

- 部分视频的 `timedtext` 链接需要 PO token，可能返回空字幕（YouTube 风控变化）。
  后续可增加 innertube ANDROID client 兜底，或降级为“监听原生字幕 DOM”模式。
- 目前字幕按“整条”翻译，超长视频首次翻译需要一点时间（有进度提示）。
- 后续可选：自动检测原字幕语言。
