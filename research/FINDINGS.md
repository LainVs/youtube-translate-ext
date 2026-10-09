# 竞品调研与实现方案

> 目标：复刻“快捷翻译”一类 Chrome 扩展的 **YouTube 字幕翻译** 功能。
> 日期：2026-10-09

## 1. 它到底怎么工作的

YouTube 字幕翻译扩展**不破解 YouTube**，而是“拿官方字幕数据 + 自己渲染一层”。完整链路：

```
YouTube 页面
  │
  ├─ (1) 获取字幕数据
  │      ├─ 方式A：ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
  │      │        → 取 baseUrl → 追加 fmt=json3 → fetch 得到全片带时间轴字幕
  │      └─ 方式B：MutationObserver 监听原生字幕 DOM .ytp-caption-segment（逐句）
  │
  ├─ (2) 翻译文本
  │      Google 免费端点 / DeepL / LLM，带批量 + 缓存
  │
  ├─ (3) 重新渲染
  │      隐藏/覆盖原生字幕层，注入自己的 DOM，原文+译文双语显示
  │
  └─ (4) 同步
        监听 video.currentTime，匹配当前时间对应的字幕条目
```

关键点：字幕源是 YouTube 的 **timedtext** 接口，返回 JSON3 格式：
```
{ "events": [ { "tStartMs": 1234, "dDurationMs": 2000, "segs": [ { "utf8": "Hello" } ] } ] }
```

## 2. 三个开源参考项目

| 项目 | 字幕获取 | 翻译 | 渲染 | 技术栈 |
|------|---------|------|------|--------|
| [outhsics/youtube-subtitle-translator](https://github.com/outhsics/youtube-subtitle-translator) | ytInitialPlayerResponse → json3 全片 | 每 20 条一批，Google/DeepL/OpenAI | timeupdate 二分定位，双语，可拖拽 | 原生 JS，MV3 |
| [orange2ai/youtube-subtitle-translator](https://github.com/orange2ai/youtube-subtitle-translator) | MutationObserver `.ytp-caption-segment` 逐句 | Google 免费端点 | 注入 `.ytp-caption-window-container` | 原生 JS，MV3 |
| [wangruofeng/youtube-live-translate](https://github.com/wangruofeng/youtube-live-translate) | MutationObserver + 120ms 轮询 | Google 免费端点 + LRU 缓存 | wrapper/overlay 默认底部居中，广告检测，序列号防旧结果 | React+TS+Webpack |

### 两种获取方式的取舍

- **方式A（预取全片）**
  - 优点：一次拿到全片时间轴；可批量预翻译；双语精准对齐；可缓存整片、导出 SRT；不受“必须开着 CC”限制（自己拉数据）。
  - 缺点：依赖 captionTracks 存在；部分客户端 timedtext 需 PO token；需自己隐藏/同步原生字幕层。
- **方式B（监听原生 DOM）**
  - 优点：实现极简、即时可用、几乎不会因 YouTube 改版而全崩。
  - 缺点：逐句翻译有延迟、无法预翻译、必须依赖原生 CC 显示、滚动/追加文本处理麻烦。

> 工业级体验（如沉浸式翻译）＝ **方式A 为主**（甚至用 main-world 脚本 hook fetch/XHR 拦截 timedtext），**方式B 作降级**。

## 3. 关键技术细节（可直接抄的）

- **取字幕轨道**：`window.ytInitialPlayerResponse`，兜底解析页面 script、兜底再 fetch watch 页正则提取。
- **取字幕数据**：`track.baseUrl + '&fmt=json3'`，`fetch(url, { credentials:'include' })`。
- **翻译批处理**：一批多条用 `\n` 拼接一次请求，按行拆回（注意行数与原文对齐）。
- **缓存**：`Map<原文, 译文>`，LRU + TTL 24h。
- **防旧结果**：请求带自增 `seq`，只有 `seq === latestSeq` 才写 UI。
- **节流/防抖**：throttle 60ms + debounce 180ms + 请求间隔 300~500ms。
- **广告**：检测 `.ad-showing` / `.ytp-ad-*`，广告时隐藏 overlay。
- **SPA 路由**：MutationObserver 监听 URL 变化，切视频后 cleanup 重建。
- **位置持久化**：`chrome.storage.sync` 存拖拽位置。

## 4. 推荐方案（本项目）

**MVP：Manifest V3 + 原生 JS（无构建，load unpacked 即可跑）**

```
youtube-translate-ext/
├── manifest.json
├── src/
│   ├── content.js        # 字幕获取 + 渲染 + 时间同步
│   ├── background.js     # 翻译请求（避免 CORS）
│   ├── popup.html/js/css # 设置界面
│   └── content.css       # 字幕样式
└── research/             # 本调研
```

- 字幕获取：**A 为主，B 降级**
- 翻译：**Google 免费端点默认**，可切换 OpenAI/DeepL（自带 key）
- 后续可升级 React+TS+Webpack + 导出 SRT + 网络拦截方案
