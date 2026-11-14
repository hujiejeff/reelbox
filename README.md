# Reelbox

自用的影视聚合播放器。**源是契约,解析归后端,渲染归 WebView。**

Tauri 2 + Rust 核心 + 原生 Web UI,一套代码跑 Windows / macOS / Linux。

## 能力

- **三类源**:苹果 CMS(`vod` / `xml`)、`.webox.js` 插件、网络索引批量导入
- **播放**:本地 HLS 反代 + hls.js;mp4 直链按内容判型走原生 `<video>`;支持 Range 拖动
- **插件沙箱**:插件在 WebView 的 sandbox iframe 中执行(`origin: null`,读不到父页 DOM 与宿主 IPC),支持 `ctx.compute.run` 运行 wasm
- **界面**:Material 3 Expressive(m3e)+ Material You 动态取色,明 / 暗 / 纯黑 / 多配色
- **细节**:进度记忆、自动连播、手动清晰度、收藏、源测速、列表与详情的加载 / 空 / 错误三态

## 目录

```
reelbox/
  ui/          前端,纯静态,无构建步骤
  src-tauri/   Rust 外壳:命令层、HLS 反代、日志
  core/        后端核心:模型 + 源适配器 + 插件宿主,不依赖 Tauri,可独立测试
  docs/        契约与设计文档
  sdk/         插件 TypeScript 类型定义
  examples/    示例插件
```

## 构建

需要 Rust 稳定版。前端没有构建步骤,`cargo` 会把 `ui/` 内嵌进二进制。

```bash
cargo build --release
# 产物:target/release/reelbox
```

```bash
cargo test -p reelbox-core     # 核心逻辑测试,离线可跑
```

验收脚本在仓库根目录:`verify-playback.ps1`(静态接线检查)、`verify-plugin-playback.ps1`(连跑插件源自检)。二进制支持 `--selftest`,会自己跑一遍列表 → 详情 → 播放并把结果写进日志。

## 关于源

首次启动、`%APPDATA%\reelbox\sources.json` 不存在时会写入三个内置源(见 `core/src/source/mod.rs` 的 `defaults()`)。之后所有源的增删改都在这个文件里,跟安装目录无关 —— 卸载重装不会带走,换机器也不会自动同步。

源与插件、内置源与自定义源的关系见 [docs/SOURCES.md](docs/SOURCES.md)。

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/SPEC.md](docs/SPEC.md) | 源契约 |
| [docs/PLUGIN.md](docs/PLUGIN.md) | 插件契约(`reelbox.define`,兼容 WeBox) |
| [docs/PLUGIN-QUICKSTART.md](docs/PLUGIN-QUICKSTART.md) | 三分钟写一个插件 |
| [docs/PLUGIN-RUNTIME.md](docs/PLUGIN-RUNTIME.md) | 插件运行时与两套引擎 |
| [docs/SOURCES.md](docs/SOURCES.md) | 源与插件的区别、存放位置、回落规则 |
| [docs/PLAYBACK.md](docs/PLAYBACK.md) | 播放架构、反代设计、已知限制 |
| [docs/DESIGN-SPEC-UI.md](docs/DESIGN-SPEC-UI.md) | 界面规格 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 迭代路线 |

## 设计原则

1. **源是数据,插件是代码** —— 对方给了 CMS 接口就别写插件
2. **按能力位表达** —— 界面只问"能搜吗 / 能看详情吗 / 能记进度吗",不问来源类型
3. **不信任插件** —— 沙箱执行、HTTP 出口拦内网、播放地址白名单
4. **契约优先** —— 加新源不改界面

## 状态

开发中。已覆盖点播(三类源、播放、收藏、源管理);直播源在路线图 v0.3。
