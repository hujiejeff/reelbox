# 插件契约(v1)

Reelbox 自己的插件格式。与 `.webox.js` 不冲突:那种文件走兼容模式,见文末。

> 若你的目标是「吃某种现成配置格式」(iplayr 那类 XPath 规则),看 [ENGINE-PLUGINS.md](ENGINE-PLUGINS.md)。

## 一个插件长什么样

```js
reelbox.define({
  id: "example.demo",          // 全局唯一
  name: "示例源",
  version: "1.0.0",
  api: 1,                      // 契约版本
  caps: ["http", "html"],      // 需要的能力,宿主只给这些

  async filters(ctx) { ... },  // 可省
  async list(ctx, { page, cursor, filters }) { ... },
  async search(ctx, { keyword, page }) { ... },
  async detail(ctx, { id }) { ... },
  async play(ctx, { id }) { ... },
});
```

## 钩子

| 钩子 | 入参 | 返回 |
| --- | --- | --- |
| `filters` | ctx | `[{key,label,options:[{label,value}]}]` |
| `list` | `{page, cursor, filters}` | `{items, next}` |
| `search` | `{keyword, page}` | `{items, next}` |
| `detail` | `{id}` | `{title, poster, summary, groups:[{name,episodes:[{id,name}]}]}` |
| `play` | `{id}` | `{url, headers}` **或** `[{quality,url}]` |

`items` 里每条:`{id, title, poster?, subtitle?, kind?}`

钩子签名固定为 `(ctx, args)`;宿主会把同一个合并对象同时作为这两个参数传入,所以老式 `function (ctx) { ctx.page }` 的写法也还能跑。

`items` 也可以写成 `list`(WeBox 风格),两种都认。

**`next` 是游标不是页码** —— 有下一页就返回任意非空字符串,没有了就返回 `""`。

**`play` 可以返回数组** —— 多档清晰度会出现在播放器的画质菜单里。

## ctx

| 能力 | 说明 |
| --- | --- |
| `ctx.http.get(url, {headers})` | 返回响应文本;真实请求在 Rust 里发 |
| `ctx.html.load(url)` | 取页面并返回 `page.$(sel)`;`$` 支持 `tag`、`.cls`、`#id`、`tag.cls`、`a[href]`、后代组合 |
| `ctx.html.load(html)` | 直接吃一段 HTML 文本(不再发请求),同样返回 `page` |
| `page.xpath(expr)` | 用 XPath 取节点/属性:`//li` → 节点数组,`//a/@href` → 字符串数组;详见 [ENGINE-PLUGINS.md](ENGINE-PLUGINS.md) |
| `ctx.human.verify({url, reason})` | 开一个真实窗口让用户过 Cloudflare / 登录 / 扫码;返回 `{id, host, origin}`。**cookie 留在宿主,插件只拿到会话 id** |
| `ctx.http.get(url, {session})` | 带上那次人工校验攒下的 cookie 再请求(cookie 不出宿主) |
| `ctx.fail(code, msg)` | 抛出分类错误,code ∈ `network` / `parse` / `auth` / `unsupported` |
| `ctx.log(...)` | 写进调试日志 |

选择器对象的方法:`length`、`each(i, el)`、`text()`、`attr(name)`、`html()`、`eq(i)`、
`xpath(expr)`(相对**该批节点**求值,`p(node).xpath(".//a/@href")`)。

## 需要人工过的站点(Cloudflare / 登录)

沙箱 iframe 的 origin 是 `null`,既没有 cookie 也过不了人机校验。所以这类站点要先
让用户在 **app 里的校验页**(真实子 WebView,外面是我们自己的壳)点一次,之后用会话去取数据:

```js
const s = await ctx.human.verify({
  url: "https://某个站点/",
  reason: "站点要求人机验证",
});                                  // 用户点「我已完成」之后才 resolve
const html = await ctx.http.get("https://某个站点/list", { session: s.id });
```

几条硬规则:

- **cookie 永远不出宿主**:插件只拿到会话 id,拿不到 `cf_clearance` 这类东西;
  每次请求是宿主现从窗口的 cookie 罐里取。
- **请求用的 UA / Referer 跟窗口一致**:Cloudflare 的 `cf_clearance` 绑 UA,
  换了就白过。
- 会话按 origin 隔离,不跨站复用;用户点「完成」时 cookie 快照进会话,窗口关掉也不影响。

### 给源打开「需要人工校验」

源编辑里有一个开关:

| 字段 | 说明 |
| --- | --- |
| 需要人工校验 | 选「是」→ 第一次取列表时自动弹校验页,用户点完「我已完成」才继续 |
| 校验页地址 | 要打开的那个站。iplayr/插件类源的 `url` 是**配置地址**,推不出站点域名,必须填;采集站留空则按 `url` 的 origin 推断 |

打开之后,适配器**不需要改**:宿主在跑钩子前拿到会话,并把会话 id 塞进这次调用,
沙箱里所有 `ctx.http` 自动带上它。同一个源并发问两次(list 和分类)只会开一页。

用户也可以在 **设置 → 校验** 里自己开一个会话先试通(不写代码也能验证站点能不能过),
会话列表里能看状态、把窗口叫回来、或者撤销。

## 直播源(和点播同一套契约)

直播和点播用的是**同一套钩子**,区别只在播放器:

```js
reelbox.define({
  id: "mychannels",
  kind: "reelbox",
  list: async () => ({ items: [{ id: "cctv1", title: "CCTV-1", poster: "" }], next: "" }),
  play: async (ctx, { id }) => ({
    url: "https://example.com/cctv1.m3u8",
    mime: "application/x-mpegURL",
  }),
});
```

- `detail` **不会被调用**:直播没有详情页,点频道直接播。
- 源的 `type` 写 `live`,播放器会自动进直播模式:不显示进度条、不显示上下集、
  显示「直播中」、不续播不连播、断流每 3 秒重连(最多 5 次)。
- `list` 的 `filters.classify` 仍然是分类入口(比如按 `group-title` 分组)。

大部分 IPTV 源不用写代码:直接粘一个 `.m3u` / `.m3u8` 地址,导入时认出
`m3u` 适配器(内置),分组来自 `group-title`,点频道直接播。
短链(如 `bit.ly/xxx`)也行:地址看不出后缀时,探测会把 `m3u` 也试一遍,
取到频道就建直播源。

## 引擎插件:一份代码 + 一份站点配置

把「怎么爬」和「爬哪个站」拆开的插件写法(`kind: "engine"`,站点配置放源里的
`options.config`),见 [ENGINE-PLUGINS.md](ENGINE-PLUGINS.md)。

## 兼容模式:`.webox.js`

`kind: "webox"` 的源由适配层执行,把 WeBox 的钩子映射到本契约:
`list({page, classify})` → `list({page})`,`play` 返回单个 `{url}` → 单元素数组。
现有 WeBox 插件无需改动。

## 未支持

- `compute` / WebAssembly
- 插件间相互依赖
