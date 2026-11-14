# Reelbox

自用的影视聚合播放器。**源是契约,解析归后端,渲染归 WebView。**

Tauri 2 + Rust 核心 + 原生 Web UI,一套代码跑 Windows / macOS / Linux。

## 它现在能做什么

- **三类源**:苹果 CMS(vod / xml)、`.webox.js` 插件、从网络索引批量导入
- **播放**:本地 HLS 反代 + hls.js;mp4 直链按内容判型走原生 `<video>`;支持 Range 拖动
- **插件沙箱**:`.webox.js` 在 WebView 的 sandbox iframe 里执行(`origin: null`,拿不到 IPC 与父页 DOM),支持 `ctx.compute.run` 跑 wasm
- **界面**:Material 3 Expressive,m3e 组件 + Material You 动态取色(明 / 暗 / 纯黑 / 多配色)
- **细节**:进度记忆、自动连播、手动清晰度、收藏、源测速、列表/详情/播放三态与重试

## 目录

```
reelbox/
  ui/            前端(Tauri 直接内嵌这个目录,纯静态,无构建步骤)
  src-tauri/     Rust 外壳:命令层、HLS 反代、日志
  core/          后端核心:模型 + 源适配器 + 插件宿主(不依赖 Tauri,可独立测试)
  docs/          契约与设计文档
  sdk/           插件 TypeScript 类型定义
  examples/      示例插件
```

## 快速开始

```bash
cargo build --release
D:/rt/release/reelbox.exe
```

首次启动带三个内置源(电影天堂 / 量子资源 / 非凡资源),不需要配置。

**换源**:顶栏源按钮 → 面板(宽屏)或底部弹窗(窄屏)。
**加源**:设置 → 源 → 添加源;或「网络导入」贴一个索引地址批量导入。

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/SPEC.md](docs/SPEC.md) | 源契约 —— 这个项目的核心资产 |
| [docs/PLUGIN.md](docs/PLUGIN.md) | 插件契约(`reelbox.define` 与 WeBox 兼容) |
| [docs/PLUGIN-QUICKSTART.md](docs/PLUGIN-QUICKSTART.md) | 三分钟写一个插件 |
| [docs/PLUGIN-RUNTIME.md](docs/PLUGIN-RUNTIME.md) | 插件运行时:WebView 沙箱与 boa 两套引擎 |
| [docs/SOURCES.md](docs/SOURCES.md) | 源与插件的区别、存放位置、回落规则 |
| [docs/PLAYBACK.md](docs/PLAYBACK.md) | 播放架构、反代设计、多源实测与已知限制 |
| [docs/DESIGN-SPEC-UI.md](docs/DESIGN-SPEC-UI.md) | 界面规格:布局、组件、动效数值 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 迭代路线与源解析 backlog |

## 开发

本机没有管理员权限,Visual Studio Build Tools 装不了,所以走 MinGW:

```
D:\rust\rustup        Rust(默认工具链 x86_64-pc-windows-gnu)
D:\rust\cargo         crates(清华镜像)
D:\rust\w64devkit     MinGW-w64 GCC
D:\rt                 编译产物(避开路径空格)
```

```bash
export RUSTUP_HOME='D:\rust\rustup'
export CARGO_HOME='D:\rust\cargo'
export PATH="/d/rust/cargo/bin:/d/rust/w64devkit/bin:$PATH"

cargo test -p reelbox-core                                   # 40 个测试,离线
cargo build --release

# 验收
./verify-playback.ps1            # 静态接线检查 + 核心测试
./verify-plugin-playback.ps1     # 连跑 3 次插件源自检(需真实网络)
D:/rt/release/reelbox.exe --selftest   # 单次自检:列表 → 详情 → 播放
```

> CI 上不需要这些:`windows-latest` 自带 MSVC 与 Windows SDK,直接用标准工具链。

## 设计原则

1. **源是数据,插件是代码** —— 有 CMS 接口就别写插件
2. **能力按能力位表达** —— 界面只问"能搜吗/能看详情吗/能记进度吗",不问来源类型
3. **插件不信任** —— 沙箱 iframe 执行,HTTP 出口拦内网,播放地址白名单
4. **契约优先** —— 加新源不改界面

## 状态

开发中。当前版本覆盖点播(三类源 + 播放 + 收藏 + 源管理),直播源在路线图 v0.3。
