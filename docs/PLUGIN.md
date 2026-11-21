# 插件契约(v1)

Reelbox 自己的插件格式。与 `.webox.js` 不冲突:那种文件走兼容模式,见文末。

> 若你的目标是「把网页地址变成播放地址」(分享页 / 需要从 HTML 里捞流),那是另一类插件:见 [PARSERS.md](PARSERS.md)。

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
| `ctx.fail(code, msg)` | 抛出分类错误,code ∈ `network` / `parse` / `auth` / `unsupported` |
| `ctx.log(...)` | 写进调试日志 |

选择器对象的方法:`length`、`each(i, el)`、`text()`、`attr(name)`、`html()`、`eq(i)`、
`xpath(expr)`(相对**该批节点**求值,`p(node).xpath(".//a/@href")`)。

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
