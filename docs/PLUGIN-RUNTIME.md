# 插件运行时(两套引擎)

> 相关文件:`ui/plugin-host.js`(父页桥)、`ui/plugin-sandbox.js`(iframe 内宿主桩)、
> `src-tauri/src/commands.rs`(IO 与白名单)、`core/src/plugin/net.rs`(内网拦截)、
> `docs/PLUGIN-RUNTIME.md`(本文)。

Reelbox 的 `.webox.js` / `.reelbox.js` 插件由 JS 执行。同一份插件现在有两套引擎:

| 引擎 | 跑在哪 | 默认 | 怎么开 |
| --- | --- | --- | --- |
| **WebView 沙箱** | 前端 `ui/plugin-host.js` 的 sandbox iframe | ✅ 是 | 什么都不用做 |
| boa 0.22 | Rust `core/src/plugin/{runtime,shim}.rs` | 否(保留回退) | `REELBOX_PLUGIN_ENGINE=boa` 或启动参数 `--engine=boa` |

boa 引擎留在仓库里当逃生舱:它不需要 WebView、能在 `cargo test` 里跑,但慢(详情要 3.6s)、
DOM 是手写的玩具实现。沙箱引擎是主路径:用的是浏览器原生 `DOMParser` + `querySelectorAll`
和真正的 `WebAssembly`,速度快一个数量级(详情 ~0.5s)。

## 架构

```
   ┌──────────────────────────── WebView 主页面(app.js)────────────────────────────┐
   │  invoke("list_items"/"detail"/"play")  ← 内置源(CMS/XML)                       │
   │  callPlugin(path, hook, arg)           ← 插件源                                 │
   │        │                                                                       │
   │        │ postMessage {kind:"run", path, source, hook, arg}                      │
   │        ▼                                                                       │
   │  ┌────────── iframe sandbox="allow-scripts"(unique origin)──────────┐          │
   │  │  WeBox.define / reelbox.define 契约                              │          │
   │  │  ctx.http.get ──► postMessage {kind:"http.get", url, headers} ───┼──► 父页  │
   │  │  ctx.html.load  → DOMParser + querySelectorAll                   │          │
   │  │  ctx.compute.run → WebAssembly.instantiate + new Function(code)  │          │
   │  └──────────────────────────────────────────────────────────────────┘          │
   └────────────────────────────────────────────────────────────────────────────────┘
                                        │
                     invoke("plugin_read" / "plugin_fetch") │
                                        ▼
                              Rust:Rust 只做 IO 和进程内状态
```

1. Rust 侧**只做 IO**:
   * `plugin_read(path)` 把插件源码当文本读出来(限 8MB)
   * `plugin_fetch(url, headers)` 真正发 HTTP(见下面的内网拦截)
   * `plugin_stream_allow(urls)` / `player_url(stream)` 维护"本次会话可反代播放"的白名单
2. 前端把源码丢进 iframe 执行。插件是第三方代码,**不能**直接拿到 `invoke`。
3. 钩子结果直接在前端消费:`list` → 卡片,`detail` → 详情页,`play` → 交 `player_url` 反代后播。

### 调用协议

父页 → iframe

```jsonc
{ "kind": "run", "id": "c1", "path": "C:/…/user-4kvm.webox.js", "source": "<插件源码>", "hook": "list", "arg": {…} }
```

iframe → 父页

```jsonc
{ "kind": "ready", "probe": { "tauriIpc": "undefined", "storage": "blocked:SecurityError" } }
{ "kind": "log", "msg": "…" }
{ "kind": "http.get", "id": 3, "url": "https://www.4kvm.net/filter", "headers": { "User-Agent": "…" } }
{ "kind": "run.result", "id": "c1", "ok": true, "data": { … } }
```

父页 → iframe(RPC 应答)

```jsonc
{ "kind": "rpc.result", "id": 3, "ok": true, "data": { "status": 200, "body": "<html>…", "url": "…", "mime": "text/html" } }
```

所有消息都带 `__rb: "reelbox-plugin"` 前缀标记,并且父页只认 `ev.source === iframe.contentWindow`。

## iframe 里实现的 ctx

| API | 行为 |
| --- | --- |
| `ctx.http.get(url, opts)` | 走 postMessage 到父页;返回 `new String(body)` 并挂 `.status/.data/.url/.headers`,所以既能当字符串用也能读状态码。`opts.query` 拼查询串,`opts.headers` 覆盖默认 UA,`opts.responseType:"base64"` 返回 base64 |
| `ctx.html.load(input)` | 含 `http(s)://` 且不含 `<` 时当 URL(返回 Promise,要 `await`),否则当 HTML 直接同步解析。返回值是可调用的 `$`(原生 `querySelectorAll`),支持 `find/closest/filter/first/last/parent/children/prev/next/map/get/eq/each/text/attr/html/is/not/val` |
| `ctx.compute.run({code, input, binaries:{module}, timeoutMs})` | 关键能力。`binaries.module` 是 base64,先 `atob` 成 `Uint8Array`,再用 `new Function("module","input","binaries","document","window","console", code)` 执行插件给的 JS 源码;源码是整段函数(`kvmBuildRequest.toString()`)时自动按 `(input, binaries)` 调用它,里面自己做 `WebAssembly.instantiate`。带超时 |
| `ctx.url.resolve/origin` | 原生 `new URL` |
| `ctx.settings` | 由 `define({settings:{fields:[…]}})` 的 `default` 生成 |
| `ctx.signal.throwIfAborted()` | 空实现(宿主没有取消机制) |
| `ctx.fail(code, msg)` | 抛带 `code` 的 Error,沙箱把它变成 `run.result{ok:false,error:"CODE: msg"}` |

钩子调用:`fn.call(def, ctx, arg)`。`filters` 拿 `{}`;`list` 拿 `{page, cursor, filters}`;
`search` 拿 `{query, cursor}`;`detail` 拿 `{id}`;`play` 拿 `{contentId, groupId, episodeId, purpose:"playback"}`。

## 安全模型

* iframe `sandbox="allow-scripts"`,**不加** `allow-same-origin` → unique(不透明)origin:
  * 读不到父页 `localStorage` / cookie / `document`
  * 拿不到 `__TAURI_INTERNALS__` / `__TAURI__`(沙箱开头还会主动 `delete` 一遍兜底)
  * `postMessage` 是唯一出口
* 插件所有网络请求都经 `plugin_fetch`,它:
  * 只放行 `http(s)`
  * 拒绝 `127.*`、`localhost`、`10.*`、`192.168.*`、`172.16-31.*`、`169.254.*`、`100.64-127.*`、`::1`、`fe80:`、`fc00:/fd00:`
  * 关掉自动重定向,手动跟最多 6 跳,**每一跳都重新检查**
  * 丢掉插件想改的 `host`/`content-length`/`connection`/`transfer-encoding`
  * 实现和测试在 `core/src/plugin/net.rs`
* `player_url` 只接受本次会话里由 `play` 拿到的地址(内置源由 Rust `play` 登记,
  插件源由 `plugin_stream_allow` 登记)。插件在沙箱里根本没 IPC,没法自己塞地址。

## 自检与验收

```bash
# 全流程:列表 → 详情 → 播放(最多试 3 集,至少 2 集真的在走),
# 结果写进 %APPDATA%/reelbox/reelbox.log,摘要写进 docs/selftest-report.json
D:/rt/release/reelbox.exe --selftest

# 复现"某个具体片名播不了":片名走插件自己的 search 钩子去找
D:/rt/release/reelbox.exe --selftest --selftest-title=折月亮
REELBOX_SELFTEST_TITLE=折月亮 D:/rt/release/reelbox.exe --selftest

# 稳定性验收:连跑 N 次(默认 3),每次都要 PASS,否则非零退出
powershell -NoProfile -ExecutionPolicy Bypass -File ./verify-plugin-playback.ps1
powershell ... -File ./verify-plugin-playback.ps1 -Runs 5 -Title 折月亮

# 静态 + 单测 + (可选)上面的实跑
powershell -NoProfile -ExecutionPolicy Bypass -File ./verify-playback.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ./verify-playback.ps1 -Live
```

日志里会看到(一次通过的三集尝试):

```
sandbox ready {"tauriIpc":"undefined","storage":"blocked:SecurityError",…}
SELFTEST list ms=520 n=30 first="谷雨" poster=yes
SELFTEST detail ms=541 title="谷雨" summary=255 groups=1 eps=22
SELFTEST play 1/3 ep="第1集" ok=yes ms=3760 readyState=4 size=1920x800 t=0→0.74
SELFTEST play 2/3 ep="第2集" ok=yes ms=3312 readyState=4 size=1920x800 t=0→0.67
SELFTEST play summary ok=2/2 tries=2 ms=7072
SELFTEST cms ok source=电影天堂
SELFTEST PASS play=2/2
SELFTEST DONE
```

判定 PASS 的条件:至少 2 集同时满足 `readyState>=3`、`videoWidth>0`、
`currentTime` 比开始时前进 0.5 秒以上。失败时会把 `HLS ERR` / `VIDEO ERR` /
`PROBE` / `M3U8 probe` 证据行一起打出来,并写进 `docs/selftest-report.json`
(`play.attempts[].reason`)。

### 插件说的 mime 不算数

插件常按地址后缀猜 mime,签名地址没有后缀就会猜错(4k影视 有的片名给的是
598 MB 直链 mp4,却写成 `application/vnd.apple.mpegurl`)。宿主在 `play` 之后
调 `stream_kind` 看一眼真实字节,再决定用 hls.js 还是原生 `<video>`。
详见 `docs/PLAYBACK.md` 的「识别真实流类型」。

## 回退到 boa

```bash
REELBOX_PLUGIN_ENGINE=boa D:/rt/release/reelbox.exe     # 环境变量
D:/rt/release/reelbox.exe --engine=boa                  # 启动参数
```

回退后前端仍然以为自己在走插件通道?不会:插件源在前端就被 `isPluginSource()` 拦下,
请求根本不会发到 Rust 的 `list_items/detail/play`。要真正用 boa,把前端 `pluginMode()`
说明的那三个 `fetchXxx` 换回 `invoke`,或者直接用 `REELBOX_PLUGIN_ENGINE=boa` 跑
`cargo test -p reelbox-core` 里的插件测试(那里不需要前端)。

## 已知限制

* `ctx.html.load(url)` 必须 `await`(浏览器里没法同步发请求);传 HTML 文本时仍是同步的
* `ctx.compute.run` 里的 `document` 只是空桩:模块只能读 `input`,不能真去查页面 DOM
* 沙箱没有 `require`/网络以外的副作用;插件想写文件就是做不到
