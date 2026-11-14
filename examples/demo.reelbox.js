// 示例:符合 reelbox 原生契约的最小插件
reelbox.define({
  id: "example.demo",
  name: "示例源",
  version: "1.0.0",
  api: 1,
  caps: ["http", "html"],

  async filters(ctx) {
    return [{ key: "classify", label: "分类", options: [
      { label: "全部", value: "" },
      { label: "电影", value: "movie" },
    ] }];
  },

  async list(ctx, { page = 1, filters = {} }) {
    const url = "https://example.com/list?p=" + page + "&c=" + (filters.classify || "");
    const page1 = await ctx.html.load(url);
    const items = [];
    page1.$("li.item a").each(function (i, el) {
      const a = page1.$(el);
      items.push({
        id: a.attr("href"),
        title: a.text(),
        poster: a.attr("data-pic"),
      });
    });
    return { items: items, next: items.length ? String(page + 1) : "" };
  },

  async detail(ctx, { id }) {
    const p = await ctx.html.load(id);
    const groups = [{ name: "线路 1", episodes: [] }];
    p.$(".episode a").each(function (i, el) {
      const a = p.$(el);
      groups[0].episodes.push({ id: a.attr("href"), name: a.text() });
    });
    return { title: p.$("h1").text(), poster: p.$("img.cover").attr("src"), groups: groups };
  },

  async play(ctx, { id }) {
    const p = await ctx.html.load(id);
    const src = p.$("video source").attr("src");
    if (!src) ctx.fail("parse", "页面里没找到播放地址");
    return [{ quality: "1080P", url: src }];
  },
});
