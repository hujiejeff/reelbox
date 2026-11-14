# Reelbox

全平台的影视资源解析播放器。**源是契约,解析归后端,渲染归 WebView。**

选型:Tauri 2(WebView2 / WKWebView / WebKitGTK),一套 Web UI 跑全平台。

## 目录

```
reelbox/
  ui/            前端(Tauri 直接吃这个目录)
  src-tauri/     Rust 外壳
  docs/SPEC.md   源契约 —— 这个项目的核心资产
```

## 现在能做什么

外壳和占位页已经就位,**还差 Rust 工具链**才能 `tauri dev`:

```bash
# 需要一次性安装(约 2–4 GB):
#   1) Rust:        https://rustup.rs
#   2) MSVC 构建工具: Visual Studio Build Tools + "使用 C++ 的桌面开发"
# 装好后:
pnpm install
pnpm dev
```

## 后端走哪条路(待定)

**A. Tauri + 现有 Go 后端(边车)**

```
Tauri 窗口 ──HTTP──► 127.0.0.1:8787(Go:插件宿主 / 苹果 CMS / HLS 反代)
```

- 解析层一行不用重写,mygo-wox 里那套直接编译成边车
- 前端把 `fetch("/api/list")` 换成绝对地址即可
- 代价:包里多一个 20MB 的 Go 进程

**B. Tauri + Rust 后端**

- 解析层重写成 Rust(reqwest + scraper + 一个 JS 运行时)
- 包体最小,单进程
- 代价:重写约 1500 行,且 JS 运行时(跑 `.webox.js`)要自己选

## 已经验证过的结论(从上一版搬来的,不用再试)

- 苹果 CMS 的 `t=` 只认**二级分类**,传一级返回 0 条
- `ac=list` 不带封面,列表要用 `ac=detail`
- 部分源的封面是 `.webp`,Windows 原生控件解不了 → 走本地代理转 jpeg
- Windows 的 WebView 不认 m3u8,需要 hls.js + 本地反代(带 UA/Referer、改写分片地址)
- 隐藏的 WebView 能当脚本沙箱,且自带 WebAssembly

## 许可

自用。
