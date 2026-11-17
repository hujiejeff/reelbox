# 源与插件

## 源管理

源存放在 `%APPDATA%/reelbox/sources.json`,由 `load_sources` / `save_sources` 读写。
**默认没有源**:文件缺失、读不出来、解析失败、里面是空数组,`load_sources` 都返回空列表,
界面三处(首页 / 顶栏源下拉 / 源管理页)给空态,由用户「导入源」或「批量导入」自己加。

设置页可:添加、编辑、删除、导入 JSON(数组 / {sites} / {sources} / TVBox {key,name,type,api})、导入 `.webox.js`。

## 苹果 CMS 源

`kind: "vod"`(JSON)与 `kind: "xml"`(XML)走 `core/src/source/cms.rs`。
播放地址若为分享页,由 `resolve_media` 抽出 m3u8 并把页面地址作为 Referer。

## .webox.js 插件源

`kind: "webox"`,`url` 是本地插件文件路径。命令层三条分支都走宿主:

- `list`   → `Host::call("list")` → `adapt::page_from_json`
- `play`   → `Host::call("play")` → `Stream{url,headers}`
- `filters`→ `plugin::plugin_filters`

宿主实现在 `core/src/plugin/`:

| 文件 | 作用 |
| --- | --- |
| `mod.rs` | 元信息解析、文件入口、筛选器转换 |
| `runtime.rs` | boa 引擎嵌入、异步钩子、HTTP 桥 |
| `shim.js` | 沙箱兼容层 + 极简 DOM |
| `adapt.rs` | 插件 JSON → Page |

已支持:`WeBox.define`、`ctx.http.get`、`ctx.html.load`(`$ / text / attr / each`,支持后代选择器)。
未支持:`compute` / WebAssembly。

## 移动端前置(Tauri 2 Android)

当前机器缺:JDK、Android SDK platform/build-tools、NDK、rust target。
另外本地 HTTP 反代在手机上需要换成 Tauri 自定义协议或插件通道。
