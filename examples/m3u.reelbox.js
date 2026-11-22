// m3u / m3u8 直播频道表适配器(内置)。
//
// 一份 IPTV 频道表长这样:
//   #EXTM3U
//   #EXTINF:-1 tvg-name="CCTV1" tvg-logo="http://…/cctv1.png" group-title="央视",CCTV-1 综合
//   http://…/cctv1.m3u8
//
// 这里把它翻译成「分组 + 频道」:
//   filters → 一个 group 过滤器(sidebar 的分组 chip 就是它)
//   list    → 当前分组下的频道
//   play    → 频道对应的地址
//
// 所以用户建一个直播源只要填 m3u 地址,不用写任何代码。

var CACHE = { key: "", list: [] };

/** 解析 #EXTINF 的属性:`tvg-name="…"` / `group-title="…"` */
function attrs(line) {
  var out = {};
  var re = /([A-Za-z0-9-]+)="([^"]*)"/g;
  var m;
  while ((m = re.exec(line))) out[m[1].toLowerCase()] = m[2];
  // 逗号后面是显示名
  var i = line.indexOf(",");
  if (i >= 0) out.name = line.slice(i + 1).trim();
  return out;
}

function parse(text) {
  var list = [];
  var lines = String(text).split(/\r?\n/);
  var pending = null;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (!t) continue;
    if (t.indexOf("#EXTINF") === 0) {
      pending = attrs(t);
      continue;
    }
    if (t.charAt(0) === "#") continue; // #EXTM3U / #EXTVLCOPT 之类
    if (!pending) continue;
    var name = pending["tvg-name"] || pending.name || "";
    // 名字去掉常见的 "高清"/"HD" 后缀?不动它 —— 频道表怎么写就怎么显示
    if (!name) {
      pending = null;
      continue;
    }
    list.push({
      url: t,
      name: name,
      group: pending["group-title"] || "",
      logo: pending["tvg-logo"] || "",
    });
    pending = null;
  }
  return list;
}

/** 频道表按 config(地址)缓存:切分组、点播放都要它,别每次都重下 */
async function load(ctx, options) {
  var cfg = String((options && options.config) || "").trim();
  if (!cfg) throw new Error("unsupported: 这个源没有填 m3u 地址");
  if (CACHE.key === cfg && CACHE.list.length) return CACHE.list;
  var res = await ctx.http.get(cfg);
  var list = parse(String(res));
  if (!list.length) {
    throw new Error("parse: 这个地址不像 m3u 频道表(没有 #EXTINF 或后面没跟地址)");
  }
  CACHE = { key: cfg, list: list };
  return list;
}

function groups(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var g = list[i].group;
    if (g && !seen[g]) {
      seen[g] = 1;
      out.push(g);
    }
  }
  out.sort(function (a, b) {
    return a.localeCompare(b, "zh");
  });
  return out;
}

reelbox.define({
  id: "m3u",
  name: "m3u 频道表",
  kind: "adapter",
  version: "1",

  // 判型用:地址是 .m3u / .m3u8 就当直播频道表
  accepts: { kind: "live", ext: ["m3u", "m3u8"] },

  filters: async function (ctx, arg) {
    var list = await load(ctx, arg.options);
    var opts = [{ value: "", label: "全部" }];
    var gs = groups(list);
    for (var i = 0; i < gs.length; i++) opts.push({ value: gs[i], label: gs[i] });
    return [{ key: "group", label: "分组", options: opts }];
  },

  list: async function (ctx, arg) {
    var list = await load(ctx, arg.options);
    var want = (arg.filters && arg.filters.classify) || "";
    var items = [];
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      if (want && ch.group !== want) continue;
      items.push({
        // id 用全表下标:切分组也稳定,play 时能直接取回地址
        id: "ch" + i,
        title: ch.name,
        poster: ch.logo,
        // 卡片副标题:显示分组
        remark: ch.group,
      });
    }
    return { items: items, next: "" };
  },

  detail: async function (ctx, arg) {
    // 直播不会有详情页(点频道直接播),这里只是契约要求的占位
    return { id: arg.id, title: arg.id, episodes: [], groups: [] };
  },

  play: async function (ctx, arg) {
    var list = await load(ctx, arg.options);
    var i = parseInt(String(arg.id || "").replace(/^ch/, ""), 10);
    var ch = list[i];
    if (!ch) throw new Error("parse: 找不到这个频道");
    return { url: ch.url, mime: "application/x-mpegURL" };
  },
});
