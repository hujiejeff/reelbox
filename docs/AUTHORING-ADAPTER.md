# 写一个适配器

> 适配器 = 把**某种固定的数据格式**翻译成 Reelbox 的 `list / detail / play`。
> 它是一个 `.adapter.js` 文件,和具体站点无关:一份适配器能配无数个站点。

## 先确认:你该写的是适配器,不是插件

| 你想做的事 | 写什么 |
| --- | --- |
| 一堆站用同一套接口(苹果 CMS、m3u 频道表、某个开源爬虫的 JSON) | **适配器** |
| 就一个站点,页面结构自己一套,还要签名/加密/多步跳转 | [源插件](AUTHORING-PLUGIN.md) |
| 站点用的是 iplayr 那种「XPath 规则 JSON」 | 不用写,内置引擎 + 一份配置,见 [iplayr 配置](AUTHORING-IPLAYR.md) |

判断标准很简单:**换一个站点,这个文件还改不改?** 不改就是适配器。

## 最小的适配器

```js
reelbox.define({
  id: "demo",
  name: "演示适配器",
  version: "1",
  api: 1,
  kind: "adapter",
  caps: ["http"],

  // 这个适配器认什么样的源(导入时用来判型)
  accepts: { kind: "json", has: ["items"] },

  // 分类。可以没有 —— 没有就是「全部」
  async filters(ctx, { options }) {
    return [{ key: "classify", label: "分类", options: [{ label: "全部", value: "" }] }];
  },

  async list(ctx, { page, filters, options }) {
    const res = await ctx.http.get(options.config + "?page=" + page);
    const data = JSON.parse(String(res));
    return {
      items: data.items.map((it) => ({
        id: String(it.id),
        title: it.name,
        poster: it.pic || "",
      })),
      next: data.hasMore ? String(page + 1) : "",
    };
  },

  async detail(ctx, { id, options }) {
    const res = await ctx.http.get(options.config + "/detail?id=" + encodeURIComponent(id));
    const d = JSON.parse(String(res));
    return {
      title: d.name,
      poster: d.pic || "",
      summary: d.desc || "",
      groups: [
        {
          name: "线路 1",
          episodes: d.episodes.map((e, i) => ({ id: e.url, name: "第 " + (i + 1) + " 集" })),
        },
      ],
    };
  },

  async play(ctx, { id }) {
    return { url: id, mime: "application/x-mpegURL" };
  },
});
```

装进应用: **设置 → 源 → 适配器 → 导入**,选这个文件。装好后它只出现在「适配器」清单里,
还不会变成源 —— 要去**导入源**,把一份配置地址交进去,适配器才拿到 `options.config`。

## 契约

### 入口

```js
reelbox.define({ id, name, version, api, kind: "adapter", caps, accepts, ... })
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 适配器标识,不要和内置的 `vod` / `iplayr` / `m3u` 撞 |
| `name` | ✅ | 界面上显示的名字 |
| `kind` | ✅ | 适配器固定写 `"adapter"` |
| `accepts` | | 判型用:`{kind: "json"|"xml"|"live"|"text", has: [...], ext: [...]}` |
| `caps` | | 目前是声明性的,写 `["http"]` 或 `["http","html"]` |
| `api` | | 契约版本,现在写 `1` |

### 钩子

四个都是可选,但**只会被调用到 `list` / `detail` / `play`**,`filters` 决定分类栏。

| 钩子 | 入参 | 返回 |
| --- | --- | --- |
| `filters` | `{ options }` | `[{key, label, options: [{label, value}]}]`(只取第一个) |
| `list` | `{ page, cursor, filters: {classify}, options }` | `{ items: [...], next: "游标或空串" }` |
| `detail` | `{ id, options }` | `{ title, poster, summary, groups: [{name, episodes: [{id, name}]}] }` |
| `play` | `{ id, contentId, groupId, episodeId, options }` | `{url, mime, headers?}` **或** `[{url, quality}]` |

`items` 里每条:

```js
{ id: "详情页地址或内部 id", title: "标题", poster: "封面地址", subtitle: "角标(可选)" }
```

几条硬规则:

- **`id` 必须是你能用 `detail` 还原出详情的东西**。最省事的是直接放详情页绝对地址,`detail` 里原样用。
- **`next` 是游标不是页码**:有下一页就给任意非空字符串,没有了给 `""`。
- **`play` 可以返回数组**:多档清晰度会进播放器的清晰度菜单;直播多线路会进「线路 n/m」。
- `mime` 拿不准就写 `application/x-mpegURL`(m3u8)或 `video/mp4`;不写也能跑,播放器会探测。

## ctx 能力

| 能力 | 说明 |
| --- | --- |
| `ctx.http.get(url, opts)` | 发请求,返回 `String` 体,`.status` / `.url` / `.headers` 挂在上面。`opts` 支持 `headers`、`query`、`responseType: "base64"`、`session` |
| `ctx.http.post(url, opts)` | 同上(目前和 get 同一个实现) |
| `ctx.html.load(html)` | 吃一段 HTML,返回可查询的 `page` |
| `ctx.html.load(url)` | 取页面并返回 `page`(`await`) |
| `page.$(sel)` | CSS 选择器;返回节点集,方法有 `length` / `each(fn)` / `map(fn)` / `get()` / `eq(i)` / `first()` / `last()` / `find(sel)` / `text()` / `attr(name)` / `html()` / `val()` / `xpath(expr)` |
| `page.xpath(expr)` | XPath:`//li` 节点集、`//a/@href` 字符串集 |
| `page(node)` | 把一个 DOM 节点包成同样的节点集,便于在循环里继续查 |
| `page.xpath(expr)` | 在节点（或节点集）上做相对求值 |
| `ctx.human.verify({url, reason})` | 让用户过一次人机校验,返回 `{id, host, origin}`;之后 `ctx.http.get(url, {session: s.id})` 带会话取数 |
| `ctx.compute.run({...})` | 跑一段 wasm 做签名/解密 |
| `ctx.url.resolve(raw, base)` | 相对地址补全 |
| `ctx.utils.sleep(ms)` / `ctx.settings` | 小工具 / 插件自己的设置 |
| `ctx.fail(code, msg)` | 抛分类错误,`code` ∈ `network` / `parse` / `auth` / `unsupported` |
| `ctx.log(...)` | 写进调试日志 |

### 解析 HTML 时注意两件事

```js
const page1 = ctx.html.load(String(await ctx.http.get(url)));

// 1) 回调里拿到的是原生 DOM 节点,要 page1(el) 包一层才能继续 .$()
// 2) .map() 返回的是节点集不是数组,末尾要 .get()
const items = page1.$(".card").map((i, el) => {
  const card = page1(el);
  return { id: card.$("a").attr("href"), title: card.$("a").text() };
}).get();
```

**缓存**:沙箱里的模块级变量在插件实例存活期间一直在(iplayr 就用它缓存站点配置)。
不要塞进 `ctx`,也不要往 localStorage 写(沙箱没有存储)。

## 一个真实的适配器怎么写

以内置的 [m3u 频道表](../examples/m3u.reelbox.js) 为例,思路是三步:

1. **取一次原文**,解析成中间结构(频道数组),按 `options.config` 缓存
2. `list` 从中间结构里切片(分类过滤、合并同名)
3. `play` 用 `id` 回中间结构取地址

```js
var CACHE = { key: "", list: [] };

async function load(ctx, options) {
  var cfg = String((options && options.config) || "").trim();
  if (CACHE.key === cfg && CACHE.list.length) return CACHE.list;
  var res = await ctx.http.get(cfg);
  var list = parse(String(res));           // 自己的解析
  if (!list.length) throw new Error("parse: 这个地址不像频道表");
  CACHE = { key: cfg, list: list };
  return list;
}
```

要点:

- **解析失败要 `ctx.fail("parse", ...)` 或抛 `Error("parse: ...")`**,不要静默返回空数组 ——
  否则界面只会说"没有内容",你也不知道是哪一步坏了。
- **分类值用下标**(`"0"`, `"1"`)最稳,别用中文标题当 `value`。
- **同一个源被问两次是常态**(列表 + 分类),缓存一下能省一半请求。

## 导入时会发生什么

粘一个地址进来,应用先看静态特征(`reelbox.define(`、`#EXTM3U`、`api.php` …),认不出来就**依次试跑**:

```
候选适配器(list 第 1 页,每个最多 8 秒)
   ✅ 出条目 → 定案,建源并落盘 probe 证据
   ⚠️ 网络不通 → 仍然建源,probe 记下原因(网络好了就能用)
   ❌ 格式不对 → 不建源,把试过的适配器和返回前 100 字摆给你看
```

所以你的适配器只要 `list` 能出条目,导入就能认出它。

## 调试

- 每次请求、每个错误都在**设置 → 调试 → 日志文件**里(`ROUTE` / `PROBE` / `PLUGIN` 行)
- 探测结果会写进源里(`probe.items` / `probe.sample`),界面上的源卡片能看到
- 沙箱里的 `ctx.log()` 会进日志
- 改完文件不用重装:适配器是运行时读的,**重新导入一次**(覆盖同名文件)或者改 `plugins/` 下那份都行

## 常见错误

| 现象 | 原因 |
| --- | --- |
| `unsupported: 内置 xxx 引擎没装上` | 用了内置适配器名但目录里没有那份文件 |
| 列表永远是空 | `id` 或 `title` 取空了(它们两个都必须非空,否则这条被丢掉) |
| 详情打不开 | `id` 不是 `detail` 能用的东西(常见:只存了数字 id,详情却要完整 URL) |
| 播放报 `manifestParsingError` | `mime` 给错了,或者给的是网页不是流(用 `page: true` 标记) |
| 站点说 `403` | 缺 `Referer` / `User-Agent`;用 `ctx.http.get(url, {headers: {...}})` 补 |

## 不要做的事

- 不要在适配器里读文件、开 socket、拿 `window` —— 沙箱里都没有
- 不要试图访问别的源的配置:`options` 只有当前源的那份
- 不要把密钥写进适配器再提交到仓库(适配器是明文,用户能打开看)
