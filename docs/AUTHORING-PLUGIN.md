# 写一个源插件

> 源插件 = 直接实现 `list / detail / play` 的一份 JS,**它自己就是一个源**。
> 和适配器的区别:适配器翻译"某种格式",插件解决"某个站点"。

## 什么时候写插件

- 站点页面结构是自己一套,没有通用格式
- 取流要签名、要解密、要多步跳转(先拿 token 再换地址)
- 详情页和播放页是两张不同的页面,字段关系只能靠代码表达
- 站点要**人机校验**(Cloudflare 之类)

反过来,如果换一个站你的代码只改几个字符串 —— 那应该写[适配器](AUTHORING-ADAPTER.md)。

## 最小骨架

```js
// my-site.reelbox.js
reelbox.define({
  id: "mysite",
  name: "我的站点",
  version: "1.0.0",
  api: 1,
  kind: "reelbox",     // 原生插件
  caps: ["http", "html"],

  async list(ctx, { page, filters }) {
    const res = await ctx.http.get("https://example.com/list?page=" + page);
    const page1 = ctx.html.load(String(res));
    // 回调里是原生节点:要 page1(el) 包一层才能继续查;map() 之后 .get() 才是数组
    const items = page1.$(".item").map((i, el) => {
      const card = page1(el);
      return {
        id: card.$("a").attr("href"),
        title: card.$("a").text(),
        poster: card.$("img").attr("data-original") || card.$("img").attr("src"),
      };
    }).get();
    return { items: items, next: items.length ? String(page + 1) : "" };
  },

  async detail(ctx, { id }) {
    const res = await ctx.http.get(id);
    const doc = ctx.html.load(String(res));
    const eps = doc.$(".playlist a").map((i, a) => {
      const one = doc(a);
      return { id: one.attr("href"), name: one.text() || "第 " + (i + 1) + " 集" };
    }).get();
    return {
      title: doc.$("h1").text(),
      poster: doc.$(".pic img").attr("src") || "",
      summary: doc.$(".desc").text(),
      groups: [{ name: "线路 1", episodes: eps }],
    };
  },

  async play(ctx, { id }) {
    const res = await ctx.http.get(id, { headers: { Referer: "https://example.com/" } });
    const m = /var url = "([^"]+\.m3u8)"/.exec(String(res));
    if (!m) ctx.fail("parse", "播放页里没找到 m3u8");
    return { url: m[1], mime: "application/x-mpegURL" };
  },
});
```

装: **导入源 → 选这个文件**。装好会自动建一条源并切过去。

## 契约

完整字段见 [PLUGIN.md](PLUGIN.md),这里只列最容易踩的几条:

| 钩子 | 返回 |
| --- | --- |
| `list` | `{items, next}`;`next` 是**游标**,有下一页给任意非空串 |
| `detail` | `{title, poster, summary, groups: [{name, episodes: [{id, name}]}]}` |
| `play` | `{url, mime?, headers?}` 或 `[{quality, url}]` |
| `filters` | `[{key, label, options: [{label, value}]}]`,只取第一个 |
| `search` | 和 `list` 同形状 |

`items` 每条至少要有 `id` 和 `title`,没有 `title` 的会被丢掉。

## ctx 能干什么

| | |
| --- | --- |
| `ctx.http.get(url, {headers, query, responseType, session})` | 所有网络请求都从这里走(带系统代理、拦内网) |
| `ctx.html.load(htmlOrUrl)` | 拿到可查询的 `page` |
| `page.$(sel)` | CSS;节点集方法有 `each` / `map` / `get` / `eq` / `text` / `attr` / `html` / `val` / `xpath` |
| `page(node)` | 把原生节点包成节点集(循环里用) |
| `ctx.human.verify({url, reason})` | 站点要人机校验时,让用户过一次;之后用 `{session}` 发请求 |
| `ctx.fail(code, msg)` | `network` / `parse` / `auth` / `unsupported` |
| `ctx.log(...)` | 进调试日志 |

**沙箱边界**:拿不到 `window`、`document`、`localStorage`,也没有宿主 IPC。这不是 bug,
是设计 —— 插件只允许通过 `ctx` 与外界交互。

## 实战顺序

1. **先手动把链路走通**:浏览器里打开列表页 → 详情页 → 播放页,把三个 URL 和要抓的字段记下来
2. **只写 `list`**,导入看能不能出条目(探测就是把 `list` 跑一遍)
3. 加上 `detail`,点进一部片子看剧集出来没有
4. 最后写 `play`,点一集看能不能播
5. 全程看 **设置 → 调试 → 日志文件**,每步的原始错误都在里面

## 常见坑

| 现象 | 原因 / 解法 |
| --- | --- |
| 标题里出现 `&amp;` `&#39;` | 站点把实体写进了属性。用 `ctx.html.load` 的 `.text()` 一般会还原;自己拼字符串时要手动反转义 |
| 列表有了,详情点不开 | `id` 存的是相对地址,`detail` 里要先补成绝对 |
| 播放报 `manifestParsingError` | 给的是网页不是流。要么继续往下解析,要么标 `page: true`(界面会明确说"只给了解析页") |
| 站点 403 | 补 `Referer`(通常就是站点首页)和桌面 UA |
| 拿到的 m3u8 里分片地址是相对路径 | 不用管,本地反代会按清单地址补全 |
| 详情页要 POST / 要带 token | 先在一个钩子里取 token 存到模块级变量,后续请求带上 |
| 站点要过人机校验 | 见下 |

### 需要人机校验的站点

```js
async list(ctx, { page }) {
  const s = await ctx.human.verify({ url: "https://example.com/", reason: "站点要求人机验证" });
  const res = await ctx.http.get("https://example.com/list?page=" + page, { session: s.id });
  // …
}
```

也可以在**源编辑里勾「需要人工校验」**,那样宿主在跑任何钩子之前就会先准备好会话,
插件代码里不用写 `verify`,`ctx.http` 会自动带上会话。

## 调试

- 每次运行的错误都写进日志文件(`PLUGIN` / `PROBE` 行),包含原始错误码
- 探测结果(`probe.items` / `probe.sample`)会存在源里,界面上能看到"这个源当初凭什么算能用"
- 改插件文件后重新导入一次即可,不用重启应用

## 发布前自查

- [ ] `list` 第 1 页能出 ≥ 10 条,`next` 翻页正常
- [ ] `detail` 的剧集数量和网页上一致
- [ ] `play` 至少一集能播,且拖动能用(说明是 m3u8/常规 mp4,不是网页)
- [ ] 没有把 cookie / token 硬编码进文件
- [ ] 站点改版时,错误信息能说清是哪一步(用了 `ctx.fail` 而不是静默返回空)
