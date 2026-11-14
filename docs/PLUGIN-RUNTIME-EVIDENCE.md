# 插件运行时验收证据

目标:插件在 **WebView 的 sandbox iframe** 中执行,并能完整播放。

结论:同一二进制连续 3 次自检全 PASS,每次至少 2 集达到 `readyState=4` + `videoWidth>0` + `currentTime` 前进。

## 1. 沙箱隔离探针

```
11:17:35 sandbox ready {"tauriIpc":"object","tauriGlobal":"undefined","ipcInvoke":"function","parentDoc":"blocked:SecurityError","storage":"blocked:SecurityError","origin":"null","ipcReachable":"blocked:Error"}
```

- `origin: null` → iframe 是 opaque origin(属性值只有 `allow-scripts`,没有 allow-same-origin)
- `storage / parentDoc: blocked:SecurityError` → 读不到父页 localStorage 与 DOM
- `ipcReachable: blocked:Error` → `__TAURI_INTERNALS__.invoke` 被封死(WebView2 会向子框架注入)

## 2. 自检摘要(docs/selftest-report.json)

```json
{
  "source": "4k影视",
  "list": {
    "ms": 554,
    "items": 30,
    "first": "谷雨",
    "poster": true,
    "ok": true
  },
  "detail": {
    "ms": 485,
    "title": "谷雨",
    "episodes": 22,
    "ok": true
  },
  "play": {
    "ms": 6938,
    "tries": 2,
    "passed": 2,
    "needed": 2,
    "ok": true
  },
  "cms": {
    "name": "电影天堂",
    "ok": true
  },
  "result": "PASS"
}
```

play 每一集的实测:

```
  - 第1集 ok=true readyState=4 1920x800 t=0 -> 0.62
  - 第2集 ok=true readyState=4 1920x800 t=0 -> 0.57
```

## 3. 连跑稳定性

```
> powershell -NoProfile -ExecutionPolicy Bypass -File ./verify-plugin-playback.ps1
[PASS] run 1  源=4k 片名=谷雨  play=2/2  ms=6938  cms=ok
[PASS] run 2  源=4k 片名=谷雨  play=2/2  cms=ok
[PASS] run 3  源=4k 片名=谷雨  play=2/2  cms=ok
PASS: 3/3 次自检全部通过
```

## 4. 回归

```
> cargo test -p reelbox-core


> powershell -ExecutionPolicy Bypass -File ./verify-playback.ps1
PASS: playback implemented and wired
```

## 5. 复现

```bash
cd /d/AI WorkSpace/reelbox
./verify-plugin-playback.ps1      # 连跑 3 次自检,自动判 PASS/FAIL
./verify-playback.ps1             # 静态接线 + 沙箱属性检查
```

## 6. 实现位置

| 文件 | 职责 |
| --- | --- |
| `ui/plugin-host.js` | 父页桥:sandbox iframe 管理 + postMessage 协议 |
| `ui/plugin-sandbox.js` | iframe 内宿主桩:DOMParser / querySelectorAll / WebAssembly |
| `src-tauri/src/commands.rs` | plugin_read / plugin_fetch(内网拦截) / plugin_stream_allow / stream_kind / selftest_report |
| `src-tauri/src/proxy.rs` | 反代:只改写真清单、媒体流式透传、Range 透传 |
| `docs/PLUGIN-RUNTIME.md` | 两套引擎与切换说明 |
