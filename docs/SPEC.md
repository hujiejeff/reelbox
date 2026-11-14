# reelbox 源契约 v1

一份源描述怎么取数据,宿主负责怎么用。两端只通过 JSON 对话,不共享代码、进程或内存。

任何语言只要实现这份契约,就能跑同一批源;源写一次,各端通用。

## 1. 核心模型

宿主的内部模型只有四种对象。**界面只认这四种,不认识任何具体源。**

```jsonc
// Item —— 列表里的一张卡片
{ "id": "abc123", "title": "午夜规则", "kind": "series",
  "poster": "https://.../a.jpg", "subtitle": "更新至4集",
  "rating": { "value": 7.7, "scale": 10, "label": "站点评分" } }

// kind: "movie" | "series" | "unknown"

// Detail —— 详情页
{ "id": "abc123", "kind": "series", "title": "午夜规则",
  "poster": "https://...", "summary": "简介",
  "groups": [
    { "id": "line:1:高清", "name": "高清",
      "episodes": [ { "id": "ep-1", "name": "第1集" } ] }
  ] }

// Source —— 可播放的一条流
{ "id": "1080p", "name": "1080p", "url": "https://.../index.m3u8",
  "mime": "application/vnd.apple.mpegurl",
  "headers": { "User-Agent": "...", "Referer": "..." },
  "downloadable": false }
```

`groups` 是"线路",`episodes` 是"选集"。电影也走同一结构,只有一个 line、一个 episode(名字叫"正片")。

## 2. 五个钩子

宿主只调用这五个函数,别的一概不碰。

| 钩子 | 入参 | 返回 |
|---|---|---|
| `filters(ctx)` | — | `Field[]` |
| `list(ctx, req)` | `{ cursor?, filters? }` | `{ items, nextCursor }` |
| `search(ctx, req)` | `{ query, cursor? }` | `{ items, nextCursor }` |
| `detail(ctx, req)` | `{ id }` | `Detail` |
| `play(ctx, req)` | `{ contentId, groupId, episodeId, purpose }` | `{ sources }` |

### 2.1 filters

```jsonc
[ { "key": "classify", "label": "分类", "type": "select", "default": "",
    "options": [ { "label": "全部", "value": "" }, { "label": "电影", "value": "1" } ] } ]
```

- `key` 会原样出现在 `list` 的 `filters` 里
- 宿主约定:第一个 `key == "classify"` 的字段作为界面左侧的一级导航,其余进筛选面板
- 拿不到就说 `[]`,不要报错

### 2.2 list / search

`cursor` 的语义是**页码字符串,第一页不给**。这条是硬约定:

```
第一页:  req 里没有 cursor      → 实现自己当第 1 页
后续页:  cursor = "2"、"3" …
```

别把第一页写成 `"1"`,很多源会判非法(详见第 6 节)。

`nextCursor` 为 `null` 表示没有下一页。

### 2.3 detail / play

`play` 的 `purpose` 目前只有 `"playback"`。要下载就返回错误码 `UNSUPPORTED`,不要假装支持。

`play` 每次都必须重新取地址:**签名 URL 有时效,缓存复用一定会 403。**

## 3. ctx —— 宿主给源的全部能力

源拿不到 `fs`、进程、全局 `window`。所有能力都从这里注入。

```ts
interface Ctx {
  http: {
    get(url: string, opts?: {
      query?: Record<string, string>
      headers?: Record<string, string>
      responseType?: "text" | "base64"
      timeoutMs?: number
    }): Promise<{ status: number, data: string, url: string }>
  }
  html: { load(text: string): Document }
  url: { resolve(raw: string, base: string): string, origin(url: string): string }
  settings: Record<string, any>
  compute?: { run(req: { code: string, input: any, binaries: Record<string, string>, timeoutMs?: number }): Promise<any> }
  signal: { throwIfAborted(): void }
  fail(code: string, message: string): never
}
```

### 3.1 http

- 必须做**域名白名单**:不在清单里的域直接拒绝,返回 `PERMISSION`
- 请求要能带任意头(UA、Referer 是这类站的命门)
- `responseType: "base64"` 用于拉二进制(wasm 模块)

### 3.2 html

`load()` 返回一个 **可调用对象**,不是普通对象:

```js
const page = ctx.html.load(html);
const $ = page.$;        // 或者直接 const $ = ctx.html.load(html)
$('main a[data-vod]').each((i, el) => { ... });
```

必须支持的方法(全部按 jQuery 语义):

```
$(sel) $(el) .attr(name) .text() .html() .find(sel) .closest(sel)
.parent() .first() .last() .prev(sel) .filter(fn) .each(fn) .map(fn).get() .length
```

十五个,写一次所有源通用。**如果只支持对象不支持函数调用,源会在第一行就崩**——`const $ = ctx.html.load(text)` 之后立刻 `$('main')`。

### 3.3 compute

跑不可信的 JS + wasm,必须是独立沙箱:没有网络、没有真实 DOM、没有宿主 API。

`binaries` 里的值是 base64。很多源会把自己的 wasm 直接内嵌在脚本里(base64 字符串),这里原样传进来即可。

### 3.4 fail

抛结构化错误,源码里到处是 `ctx.fail("INVALID_RESPONSE", "...")`。宿主捕获后要能拿到 `code`——**异步钩子里抛出的错误也必须保留 code**,不能只留 message。

## 4. 错误码

| code | 含义 | 界面提示 |
|---|---|---|
| `INVALID_RESPONSE` | 源站结构变了 / 解析失败 | 提示源可能需要更新 |
| `NETWORK` | 网络或 HTTP 状态异常 | 允许重试 |
| `RATE_LIMITED` | 429 | 稍后重试 |
| `AUTH_REQUIRED` | 401/403,或提示登录/会员 | 引导去源站,不要在本应用里登录 |
| `NOT_FOUND` | 内容不存在 | 返回列表 |
| `UNSUPPORTED` | 本端/本源不支持(下载、需要 compute 但没启用) | 明确告知 |
| `PERMISSION` | 命中域名白名单限制 | 明确告知 |
| `CONFIG_REQUIRED` | 设置项缺失或非法 | 打开设置 |

## 5. 三种源格式

宿主认得三种"源",对界面完全等价。

### 5.1 `webox.js` —— 带代码的源

一个目录,两个文件:

```
plugins/<id>/
  plugin.json
  index.js
```

```json
{
  "id": "4kvm", "name": "4k影视", "version": "1.0.0", "main": "index.js",
  "requires": ["html", "compute"],
  "permissions": { "network": ["www.4kvm.net"] },
  "cache": { "list": 120, "detail": 60, "filters": 3600 },
  "settings": [
    { "key": "quality", "label": "优先清晰度", "type": "select", "default": "1080",
      "options": [{ "label": "1080P", "value": "1080" }] }
  ]
}
```

```js
WeBox.define({
  async filters(ctx) { ... },
  async list(ctx, req) { ... },
  async search(ctx, req) { ... },
  async detail(ctx, req) { ... },
  async play(ctx, req) { ... }
});
```

- `requires`:用到 `compute` 就必须声明,宿主据此判断能不能跑
- `permissions.network`:域名白名单,**空数组等于什么都访问不了**
- `cache`:各钩子的缓存秒数,宿主执行;`play` 永不缓存

### 5.2 `vod` —— 苹果CMS v10 JSON 接口

接口地址形如 `https://host/api.php/provide/vod`。

| 用途 | 请求 | 说明 |
|---|---|---|
| 分类 | `?ac=list` | 读 `class[]` 的 `type_id` / `type_name` / `type_pid` |
| 列表 | `?ac=detail&pg=N[&t=分类]` | **必须用 `ac=detail`,不是 `ac=list`** |
| 搜索 | `?ac=detail&wd=关键词` | |
| 详情 | `?ac=detail&ids=ID` | |

字段映射:

```
Item.id      ← vod_id            Item.title  ← vod_name
Item.poster  ← vod_pic           Item.sub  ← vod_remarks
线路名       ← vod_play_from     按 $$$ 拆
线路内容     ← vod_play_url      按 $$$ 拆线路、# 拆集、$ 拆"名字$地址"
```

### 5.3 `xml` —— 同一个接口的 XML 版

`?ac=detail&pg=N` 返回:

```xml
<rss><list page="1" pagecount="8179">
  <video><id>90385</id><name>娱乐百分百</name><type>港台综艺</type>
         <note>更新至20261112期</note>
         <dl><dd flag="lzm3u8"><![CDATA[第01集$https://.../index.m3u8#第02集$...]]></dd></dl>
  </video>
</list></rss>
```

`<dd flag>` 是线路名,CDATA 里是同样的 `$` / `#` 结构。

## 6. 已经踩过的坑(照抄能省一晚上)

**6.1 `ac=list` 不带封面**

`ac=list` 只返回精简字段,里面**没有 `vod_pic`**。必须用 `ac=detail&pg=N` 取列表——响应从 6KB 变 87KB,换回 20/20 的封面。

**6.2 第一页不能传 cursor**

`cursor: "1"` 会被不少源判非法(它们的校验是 `2..100000`)。宿主应该在 `page == 1` 时**根本不传** cursor。

**6.3 `url: "1"` 是占位符**

播放接口的 `quality_urls[]` 里只有 `current_quality` 那一档是真的,其他档位是字符串 `"1"`。把 `"1"` 当地址请求会得到 404,必须按 `current_quality` 索引取,其余跳过。

**6.4 签名里的时间公式**

以 4kvm 为例,请求参数 `t = 客户端当前时间 + (服务器时间 − 页面加载时间)`。

- 服务器时间来自 `<meta id="nb-st" content="毫秒时间戳">`
- 页面加载时间来自 `<meta id="nb-plt">`,但**这个标签的 content 是空的**,由页面内联脚本 `document.getElementById('nb-plt').content = Date.now()` 填
- 少给任何一个,都会 401

**6.5 客户端签名一定拿得到**

浏览器必须执行那个 wasm,所以它一定可下载。内嵌副本的文件名 hash 就是它的 sha256 前八位(`...d5d51939.wasm`),可以直接校验一致性。宿主复刻调用约定即可,算法永远不用逆。

**6.6 播放要带 Referer / UA**

很多 CDN 校验请求头。桌面端浏览器改不了分片请求头,标准做法是**本地反代**:宿主注入头、改写 m3u8 里的分片地址;移动端不需要,ExoPlayer / AVPlayer 都可以自定义数据源直接加头。

**6.7 采集站会慢到超时**

有的接口 TLS 握手要 30 秒以上。超时给到 35~45 秒并重试一次,比直接报错好。

## 7. 各端怎么实现这份契约

契约是语言无关的。下表是"同一个能力,各端用什么",按已经验证过的选型填。

| 能力 | Android (Kotlin) | iOS (Swift) | 桌面 (Go,参考实现) |
|---|---|---|---|
| 跑 `webox.js` | 隐藏 WebView(`addJavascriptInterface` 桥 ctx) | 隐藏 WKWebView(`WKScriptMessageHandler`) | moejs(纯 Go 解释器) |
| wasm | WebView 自带 | WebView 自带 | wazero |
| HTML 解析 | Jsoup | SwiftSoup | goquery |
| 带头的 HTTP | OkHttp(Interceptor) | URLSession | net/http |
| 播放 | Media3 ExoPlayer(`HttpDataSource.Factory` 加头) | AVPlayer(`AVURLAsset` 加头) | hls.js + 本地反代 |
| 持久化 | Room / DataStore | SwiftData / UserDefaults | JSON 文件 |

**桌面端有个平台差异要记住**:浏览器内核不让改 `<video>` 发出的请求头,所以桌面必须走本地反代(`/proxy?u=...`)。移动端不需要这层——播放器是原生的,头可以自己塞。

**另一件事**:Android/iOS 的 WebView 本身就是浏览器环境,源里的 `document.getElementById` / `WebAssembly.instantiate` / wasm-bindgen 胶水**可以原样跑**,不用像 Go 那样手写 14 个导入。这是移动端实现的成本优势。

## 8. 版本与兼容

- 契约版本写在插件清单的 `api` 字段(建议 `"1.0"`)
- 宿主遇到不认识的版本:拒绝加载并明确报错,不要"尽力而为"
- 新增能力只能通过 `requires` 声明,老宿主看不懂 `requires` 里的值时应当拒绝而不是忽略

## 9. 参考资料

- `mygo-wox`(Go 参考实现):五钩子、ctx、wasm 签名、HLS 反代、声明式源全部已跑通,`verify.cmd` 一条命令验收
- 参考实现里的 `PLAN.md` 记录了每个决策的来由(为什么用 moejs 而不是 goja、为什么 first page 不传 cursor、t 的公式怎么试出来的)

---

这份文档的判定标准只有一条:**加一个新源的时候,如果不需要改界面、不需要给源开放新能力,契约就是对的。**
