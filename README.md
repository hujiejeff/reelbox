# Reelbox

全平台的影视资源解析播放器。**源是契约,解析归后端,渲染归 WebView。**

选型:Tauri 2(WebView2 / WKWebView / WebKitGTK),一套 Web UI 跑全平台。

## 目录

```
reelbox/
  ui/            前端(Tauri 直接内嵌这个目录)
  src-tauri/     Rust 外壳(Tauri 2)
  core/          Rust 后端核心:模型 + 源适配器(不依赖 Tauri,可独立测试)
  docs/SPEC.md   源契约 —— 这个项目的核心资产
```

## 工具链(全部在 D 盘,免管理员)

这台机器上 Visual Studio Build Tools 装不了(没有管理员),所以走 MinGW:

```
D:\rust\rustup        Rust 1.100,默认工具链 x86_64-pc-windows-gnu
D:\rust\cargo         crates(走清华镜像)
D:\rust\w64devkit     MinGW-w64 GCC 16.2
D:\rt                  编译产物
```

新开终端后需要:

```bash
export RUSTUP_HOME='D:\rust\rustup'
export CARGO_HOME='D:\rust\cargo'
export PATH="/d/rust/cargo/bin:/d/rust/w64devkit/bin:$PATH"

cargo test -p reelbox-core          # 6 个测试,离线
REELBOX_NET=1 cargo test -p reelbox-core -- --nocapture   # 打真站点
cargo build -p reelbox --target x86_64-pc-windows-gnu
D:/rt/x86_64-pc-windows-gnu/debug/reelbox.exe
```

## 踩过的坑(都已写进配置)

| 现象 | 原因 | 处理 |
|---|---|---|
| `link.exe: extra operand` | 机器上只有 Git 的 `link.exe` | 用 GNU 工具链 |
| `cannot find -lgcc_eh` | w64devkit 不带这个库 | 复制 `libgcc.a` 为 `libgcc_eh.a` |
| `windres` 报 `No such file` | 路径 `D:\AI WorkSpace` 有空格 | `target-dir` 设到 `D:/rt` |
| `export ordinal too large` | MinGW 不支持大 cdylib | `crate-type = ["rlib"]` |
| 界面被放大、错位 | exe 没有 DPI 清单 | `build.rs` 里自定义 PerMonitorV2 清单 |

## 现在能做什么

- Rust 核心:苹果 CMS(JSON + XML)的 列表 / 搜索 / 详情 / 取流 / 分类
- Tauri 窗口能起来,加载内嵌的 `ui/`(现在是占位页)

## 下一步

1. Tauri 命令层:`list_sources` / `list_items` / `detail` / `play` / `filters`
2. 前端:先用最简页面调通数据,再做海报墙
3. 播放:HLS 反代 + hls.js(Windows 的 WebView 不认 m3u8)
4. 插件源 `.webox.js`:Rust 侧嵌 JS 运行时(最硬的一块,放最后)
