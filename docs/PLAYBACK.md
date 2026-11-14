# 播放功能

状态:**已实现并实测通过**(2026-11-14,提交 `f7eb7c0`)。

![播放实拍](playback.png)

## 为什么要本地反代

桌面 WebView 直接播 m3u8 有三个绕不过去的问题:

1. **Chromium 不支持 HLS 原生解码** —— 只有 Safari 支持,其余都要走 MSE
2. **防盗链** —— 片源校验 UA / Referer,前端直接 fetch 会被 403
3. **跨域** —— 页面在 `tauri.localhost`,片源在别的域

所以由 Rust 侧起一个只监听 `127.0.0.1` 的服务,把清单和分片都代理一遍:

```
hls.js ──> http://127.0.0.1:<随机端口>/p?u=<base64url 地址>&h=<base64url 请求头>
                │
                ├─ 带 UA/Referer 去上游取
                ├─ 内容像 m3u8 → 逐行改写地址,再套一层同样的本地地址
                │                 (含 #EXT-X-KEY / #EXT-X-MAP 的 URI="...")
                └─ 是分片 → 原样回传,补 Access-Control-Allow-Origin
```

端口由 `tiny_http` 绑定 `127.0.0.1:0` 时分配,进程内复用。

## 分享页抽流

电影天堂给的地址不是流,而是一张分享页:

```html
<script>
  const url = "/20251222/65250_ab09f628/index.m3u8?sign=5a1ed332db9baba5b099c6075c704831";
</script>
```

`Client::stream()` 发现地址既不含 `.m3u8` 也不含 `.mp4` 时,会:

1. 请求该页面
2. 从 HTML/JS 里捞出第一个 `.m3u8` 地址(支持相对路径、`\/` 转义、`?sign=` 查询串)
3. 把页面地址作为 Referer 一并带回

对应实现:`core/src/source/cms.rs` 的 `resolve_media` / `extract_m3u8` / `absolute`。

## 代码位置

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/proxy.rs` | 本地反代服务、m3u8 改写、CORS |
| `src-tauri/src/commands.rs` | `player_url` 命令:把流地址包成本地地址 |
| `core/src/source/cms.rs` | `resolve_media`:分享页 → m3u8 |
| `ui/index.html` | `.player` 整屏覆盖层 + `<script src="vendor/hls.min.js">` |
| `ui/app.js` | `playEpisode` / `openPlayer` / `closePlayer` |

## 怎么验证

### 1. 单元测试

```bash
cargo test -p reelbox-core
```

期望:`10 passed; 0 failed`。其中三条覆盖分享页抽流:

- `finds_relative_m3u8` —— 相对路径 `/20251222/.../index.m3u8?sign=abc`
- `finds_absolute_m3u8` —— 绝对地址
- `none_when_absent` —— 页面里没有 m3u8 时返回 None

### 2. 手工验证

```bash
cargo build -p reelbox --target x86_64-pc-windows-gnu
"target-dir/x86_64-pc-windows-gnu/debug/reelbox.exe"
```

1. 选一个源 → 点任意封面进详情 → 点任意一集
2. 期望:黑底播放页出现,片名在左上角,画面几秒内起播
3. 拖动进度条可以跳转;按 `Esc` 或点左上角箭头退出

实测截图见 `docs/playback.png`(《百家讲坛》20251222,画面为 CCTV-10 片头)。

## 已知限制

- `tiny_http` 未处理 Range 请求:mp4 直链拖动进度会从头发,建议优先用 m3u8 源
- 没有手动选清晰度
- 反代只监听本机,不对外暴露

## 验收清单

| 项 | 状态 | 判定方式 |
| --- | --- | --- |
| 点剧集能进播放页 | 通过 | 截图 `docs/playback.png` |
| 画面真的在播(不是静止图) | 通过 | 相隔 6 秒两帧的 md5 不同 |
| 分享页能抽出 m3u8 | 通过 | `cargo test extract_tests` 3 条 |
| 防盗链 UA/Referer 生效 | 通过 | 反代日志里分片返回 200 |
| 退出播放不泄漏 | 通过 | `closePlayer` 销毁 Hls 实例并清 `src` |
| 进度记忆 | 通过 | 播放后退出,详情页出现"继续观看 · 集名 · 时间" |
| 播完自动下一集 | 通过 | video `ended` 时按扁平剧集表顺延 |

一键复核:

```powershell
powershell -ExecutionPolicy Bypass -File verify-playback.ps1
```

## 播放器交互

| 操作 | 行为 |
| --- | --- |
| 空格 | 播放 / 暂停 |
| ← / → | 后退 / 前进 10 秒 |
| F | 全屏切换 |
| Esc | 退出播放 |
| 鼠标静止 2.6 秒 | 顶部标题条淡出 |

## 进度记忆

- 存储:localStorage 的 ,键是 - 值:, 是秒
- 每 5 秒写一次(且只在不小于 3 秒时写),关闭播放器时强制写一次
- 再次打开同一集,自动跳到上次位置;详情页顶部出现"继续观看"
