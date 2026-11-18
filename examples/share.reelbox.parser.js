// 示例解析器:把"分享页"解成可播地址。
//
// 怎么用:设置 → 源 → 导入解析器 → 选这个文件。导入后它只对 match() 认得的页面生效,
// 别的页面一律跳过(所以多装几个解析器也不会互相拖累)。
// 契约见 docs/PARSERS.md;它和源插件(reelbox.define)是两件事。
//
// 什么时候会用到它:某些源给的剧集地址是一张网页(比如站点的分享页 / 播放页),
// 真正的 m3u8 藏在页面 HTML 里。这时播放链路会把页面地址交给解析器。
reelbox.parser({
  id: "share-page",
  name: "分享页 m3u8",
  version: "1",

  // 只认自己认识的页面:返回 false 就跳过,不拖慢别的源。
  // 没有这个钩子视为"都匹配"(所以别给万能解析器省掉它)。
  match(url) {
    return /dytt|share|vodplay|play\/\d/i.test(String(url || ""));
  },

  // ctx 与源插件的 ctx 是同一个(http / html / url / fail / log);
  // 第二个参数是 {url, headers},headers 是播放链路带过来的(UA / Referer)。
  async parse(ctx, { url, headers }) {
    const res = await ctx.http.get(url, { headers: headers || {} });
    const html = String((res && res.data) || res || "");
    if (!html) ctx.fail("network", "分享页取回来是空的");

    // 页面里的地址有两种写法:整条 https://…/index.m3u8?sign=… ,或者 /2026/…/index.m3u8
    const abs = html.match(/(?:https?:)?\/\/[^"'\s]+?\.m3u8[^"'\s]*/i);
    const rel = html.match(/["'](\/[^"'\s]+?\.m3u8[^"'\s]*)["']/i);
    const raw = abs ? abs[0] : rel ? rel[1] : "";
    if (!raw) ctx.fail("parse", "页面上没找到 m3u8");

    // 相对地址用页面自己的地址补全(重定向过的用 res.url)
    return { quality: "自动", url: ctx.url.resolve(raw, (res && res.url) || url) };
  },
});
