# 源与插件

## 源管理

源存放在 `%APPDATA%/reelbox/sources.json`,由 `load_sources` / `save_sources` 读写。
**默认没有源**:文件缺失、读不出来、解析失败、里面是空数组,`load_sources` 都返回空列表,
界面三处(首页 / 顶栏源下拉 / 源管理页)给空态,由用户「导入源」或「批量导入」自己加。

设置页可:添加、编辑、删除、导入 JSON(数组 / {sites} / {sources} / TVBox {key,name,type,api})、导入 `.webox.js`。

## 一条源有哪些字段

`sources.json` 里每条源长这样(空值的字段不会写进去):

| 字段 | 说明 |
| --- | --- |
| `id` | 内部标识,界面上的"当前源"记的是它 |
| `name` | 显示名 |
| `type` | `vod` / `xml` / `live` / `webox`。**界面还在用它**(徽标、分组、分型判定) |
| `url` | 源地址:接口地址、iplayr 配置地址、插件文件路径 |
| `adapter` | 运行时走哪条路:`vod` / `vod-rs` / `iplayr` / `m3u` / `webox` / `reelbox` |
| `probe` | 导入时判定它可用的证据(`{at, ok, items, sample, error}`) |
| `options` | 引擎/插件自己要用的一份配置(目前 iplayr / vod / m3u 都用 `url`) |
| `verify` | 需要人工校验:第一次取数据自动弹校验页 |
| `verifyUrl` | 校验页要打开的站点地址(配置类源的 `url` 不是站点本身,必须显式填) |
| `posterRatio` | 列表封面比例:`2:3`(默认,空着就是这个)/ `3:4` / `4:3` / `16:9` / `1:1` |
| `health` | 最近一次"测试连接"的结果 |

`posterRatio` 是给"封面图形状不统一"的站用的:渲染时它会变成网格上的
`--poster-ratio` 变量,只影响列表卡片,不动详情页。

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
