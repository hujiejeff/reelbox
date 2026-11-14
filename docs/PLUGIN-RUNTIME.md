# 插件运行时(两套引擎)

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
# 全流程:列表 → 详情 → 播放(视频真的在走),结果写进 %APPDATA%/reelbox/reelbox.log
D:/rt/release/reelbox.exe --selftest

# 静态 + 单测 + (可选)上面的实跑
powershell -NoProfile -ExecutionPolicy Bypass -File ./verify-playback.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ./verify-playback.ps1 -Live
```

日志里会看到:

```
sandbox ready {"tauriIpc":"undefined","storage":"blocked:SecurityError",…}
SELFTEST list ms=579 n=30 first="光阴之外" poster=yes
SELFTEST detail ms=521 title="光阴之外" summary=65 groups=1 eps=48
SELFTEST play ms=1873 readyState=4 t=0.25 playing=true
SELFTEST PASS
```

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
