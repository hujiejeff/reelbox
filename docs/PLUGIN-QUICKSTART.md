# 三分钟写一个源

给不想读契约全文的人。

## 1. 建文件

`%APPDATA%\reelbox\plugins\mysource.reelbox.js`

## 2. 抄这个骨架

```js
reelbox.define({
  id: "me.mysite",        // 随便起,别和别的源撞
  name: "我的源",
  version: "1.0.0",
  api: 1,
  caps: ["http", "html"],

  async list(ctx, { page }) {
    const p = await ctx.html.load("https://site.com/list?p=" + page);
    const items = [];
    p.$("div.item a").each(function (i, el) {
      const a = p.$(el);
      items.push({ id: a.attr("href"), title: a.text() });
    });
    return { items, next: items.length ? String(page + 1) : "" };
  },

  async detail(ctx, { id }) {
    const p = await ctx.html.load(id);
    return {
      title: p.$("h1").text(),
      poster: p.$("img.pic").attr("src"),
      groups: [{ name: "线路 1", episodes: [{ id: id, name: "第 1 集" }] }],
    };
  },

  async play(ctx, { id }) {
    const p = await ctx.html.load(id);
    const src = p.$("source").attr("src");
    if (!src) ctx.fail("parse", "没找到播放地址");
    return { url: src };
  },
});
```

## 3. 调试

运行应用 → 设置 → 源管理 → 导入 `.js` → 切到这个源。

出问题就打开右下角调试浮标看日志。三条最常见：

| 现象 | 原因 |
| --- | --- |
| 列表空了 | 选择器没匹配上,把 `div.item a` 换成页面上真实的标签 |
| 点进去报 parse | `detail` 里的字段名和页面结构变了 |
| 播放黑屏 | `play` 返回的不是 m3u8/mp4,或者该地址要 Referer |

## 4. 拿到多档清晰度

`play` 返回数组,画质菜单会自动出现：

```js
return [
  { quality: "1080P", url: high },
  { quality: "720P", url: low },
];
```

少于两档就别返回数组,画质按钮不会出现。

## 5. 选择器能用的东西

`tag`、`.class`、`#id`、`tag[attr]`、`a.b`、`div a`(后代)。

方法：`each`、`text()`、`attr(name)`、`html()`、`eq(i)`、`length`。

**不支持** jQuery 的 `find` / `closest` / 选择器里的伪类。
