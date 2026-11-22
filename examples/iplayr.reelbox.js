// @builtin-version 1   (随包升级时会按这个数字覆盖旧文件)
// 引擎插件:iplayr 那类「声明式爬虫规则」(XPath + 正则 + URL 模板)的通用执行器。
//
// 一个引擎插件 = 「怎么爬」;一份站点配置 = 「爬哪个站」。
// 所以同一个文件可以配不同地址、变成多条源。
//
// 怎么用:
//   1. 设置 → 源 →「导入源」,选这个 js 文件(kind 是 "engine");
//   2. 导入后会弹「站点配置地址」,填那份 iplayr 配置的地址,例如
//      https://raw.githubusercontent.com/m3u8playlist/dp/master/iplayr/dbk.json
//      (留空 = 只装插件、不建源;以后想补,再导入一次这个文件填上即可);
//   3. 源列表里多出来的那条就是它,切过去就能看。
//
// 字段对照表、ctx.html.load().xpath() 的用法:docs/ENGINE-PLUGINS.md。

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// 同一份配置在插件实例里只取一次:翻页要连着取十几页,每页都重取配置
// 既慢又容易把 raw.githubusercontent 拖黑。键是配置地址。
const CONFIG_CACHE = new Map();

function trim(s) {
  return String(s == null ? "" : s).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, "");
}

function originOf(url) {
  const m = /^https?:\/\/[^/?#]+/i.exec(String(url == null ? "" : url));
  return m ? m[0] : "";
}

/** 相对地址补成绝对:配置里有的站点给 //host/x 或 /upload/x */
function absolute(raw, base) {
  const v = trim(raw);
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (v.indexOf("//") === 0) return "https:" + v;
  const origin = originOf(base);
  if (!origin) return v;
  return v.charAt(0) === "/" ? origin + v : origin + "/" + v;
}

/**
 * URL 模板替换。配置里的 vod_link_url 是 "https://www.dbku.tv{id}" 这种;
 * 模板里没有 {id} 就直接用取到的值(有的配置本来就给绝对地址)。
 */
function fillTemplate(tpl, value) {
  const t = trim(tpl);
  const v = trim(value);
  if (!t || t.indexOf("{id}") < 0) return v;
  return t.split("{id}").join(v);
}

function looksBase64(s) {
  const t = String(s == null ? "" : s);
  return t.length > 32 && /^[A-Za-z0-9+/=]+$/.test(t);
}

function base64Decode(s) {
  try {
    return atob(String(s));
  } catch (e) {
    return "";
  }
}

/** 站点有 Cloudflare 校验:iplayr 用 cf_flag 标出来,直接说不支持,别静默失败 */
function hasCloudflare(cfg) {
  const v = cfg && cfg.cf_flag;
  if (v === true || v === 1) return true;
  return String(v == null ? "" : v).toLowerCase() === "true";
}

/** 请求头:桌面 UA + Referer(配置里的 referer 优先,没有就用站点 origin) */
function headersFor(cfg, base) {
  const headers = { "User-Agent": UA };
  const referer = trim(cfg && cfg.referer) || originOf(base);
  if (referer) headers.Referer = referer.charAt(referer.length - 1) === "/" ? referer : referer + "/";
  return headers;
}

/** 取一页正文:状态码和空页面都要报出来,不然只会看到"列表是空的" */
async function getText(ctx, url, cfg) {
  const res = await ctx.http.get(url, { headers: headersFor(cfg, url) });
  const status = Number(res && res.status) || 0;
  if (status >= 400) ctx.fail("network", "站点返回 " + status + ":" + url);
  const body = String((res && res.data) || "");
  if (!body) ctx.fail("network", "页面是空的:" + url);
  return body;
}

/** 站点配置:取一次、缓存、顺手做几项检查 */
async function loadConfig(ctx, options) {
  const url = trim(options && options.config);
  if (!url) {
    ctx.fail("unsupported", "这个源还没填站点配置地址(设置 → 源 → 编辑源)");
  }
  const hit = CONFIG_CACHE.get(url);
  if (hit) return hit;
  const res = await ctx.http.get(url, { headers: { "User-Agent": UA } });
  const body = String((res && res.data) || "");
  if (!body) ctx.fail("network", "站点配置是空的:" + url);
  let cfg;
  try {
    cfg = JSON.parse(body);
  } catch (e) {
    ctx.fail("parse", "站点配置不是 JSON:" + url);
  }
  if (!cfg || !Array.isArray(cfg.category) || !cfg.category.length) {
    ctx.fail("parse", "站点配置里没有 category:" + url);
  }
  if (hasCloudflare(cfg)) {
    ctx.fail("unsupported", "这个站点有 Cloudflare 校验,当前跑不了");
  }
  CONFIG_CACHE.set(url, cfg);
  return cfg;
}

/** 配置里的 category → 内部统一形状(value 用序号,和筛选的取值一致) */
function categoriesOf(cfg) {
  const out = [];
  const list = (cfg && cfg.category) || [];
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i] || {};
    const url0 = trim(c.url0 || c.url);
    const url1 = trim(c.url1 || c.url_page);
    if (!url0 && !url1) continue;
    out.push({ index: i, title: trim(c.title || c.name), url0: url0, url1: url1 });
  }
  return out;
}

/** 站点的 origin:补相对地址时当基准(配置地址本身在 github,不能当基准) */
function siteOrigin(cfg) {
  const cats = categoriesOf(cfg);
  const first = cats[0] || {};
  return originOf(first.url0 || first.url1) || originOf(cfg && cfg.referer);
}

/** 选中哪个分类:分类序号 → 分类;没选/认不出来 → 第一个(总得有个地址) */
function pickCategory(cats, classify) {
  const v = trim(classify);
  if (v) {
    if (/^\d+$/.test(v) && cats[Number(v)]) return cats[Number(v)];
    for (let i = 0; i < cats.length; i += 1) {
      if (cats[i].title && cats[i].title === v) return cats[i];
    }
  }
  return cats[0] || null;
}

/** 第 1 页用 url0,后面用 url1(把 {pg} 换成页码);没有 url1 就只能停在第 1 页 */
function pageUrl(cat, page) {
  const p = Number(page) > 0 ? Math.floor(Number(page)) : 1;
  if (!cat) return "";
  const tpl = p <= 1 ? cat.url0 || cat.url1 : cat.url1 || "";
  if (!tpl) return "";
  return tpl.indexOf("{pg}") >= 0 ? tpl.split("{pg}").join(String(p)) : tpl;
}

/**
 * iplayr 的 XPath 都是「从文档根开始」的写法(//h4//a)。按节点求值时要把
 * 开头的 // 换成 .//,否则会跳到整篇文档里去找 —— 每张卡片都会抓到同一批节点。
 */
function relativeXPath(expr) {
  const e = trim(expr);
  if (!e) return "";
  return e.indexOf("//") === 0 ? "." + e : e;
}

/**
 * 在某个节点上求一条 XPath(不给节点就整篇文档)。
 * 单个字段取不到不该让整页失败:坏表达式在这里吞掉,返回空数组。
 */
function xpathOf(page, node, expr) {
  const e = trim(expr);
  if (!e) return [];
  try {
    return (node ? page(node).xpath(relativeXPath(e)) : page.xpath(e)) || [];
  } catch (err) {
    return [];
  }
}

/** 取第一个非空文本(节点集 → textContent,字符串 → 原样) */
function textOf(hits) {
  for (let i = 0; i < hits.length; i += 1) {
    const h = hits[i];
    const t = typeof h === "string" ? trim(h) : trim(h && h.textContent);
    if (t) return t;
  }
  return "";
}

/** 取第一个非空「值」(属性 / 字符串 / 节点都收) */
function valueOf(hits) {
  for (let i = 0; i < hits.length; i += 1) {
    const h = hits[i];
    let t = "";
    if (typeof h === "string") t = trim(h);
    else if (h && h.nodeValue != null) t = trim(h.nodeValue);
    else if (h) t = trim(h.textContent);
    if (t) return t;
  }
  return "";
}

/**
 * 列表 / 搜索共用的字段组:配置里搜索那一套是 search_ 前缀的同名字段
 * (search_vod_node / search_vod_title …),所以前缀一拼就行。
 */
function fieldsOf(cfg, prefix) {
  const p = prefix || "";
  return {
    node: cfg[p + "vod_node"],
    title: cfg[p + "vod_title"],
    linkId: cfg[p + "vod_link_id"],
    linkUrl: cfg[p + "vod_link_url"],
    imageId: cfg[p + "vod_image_id"],
    imageUrl: cfg[p + "vod_image_url"],
  };
}

/** 一张列表卡片 → {id, title, poster};id 是详情页的绝对地址 */
function rowOf(page, node, field, base) {
  const link = valueOf(xpathOf(page, node, field.linkId));
  const title = textOf(xpathOf(page, node, field.title));
  const poster = valueOf(xpathOf(page, node, field.imageId));
  return {
    id: absolute(fillTemplate(field.linkUrl, link), base),
    title: title,
    poster: absolute(fillTemplate(field.imageUrl, poster), base),
  };
}

function parseRows(ctx, page, field, base) {
  let nodes = [];
  try {
    nodes = page.xpath(trim(field.node));
  } catch (e) {
    ctx.fail(
      "parse",
      "列表 XPath 求值失败(" + trim(field.node) + "):" + ((e && e.message) || e)
    );
  }
  const items = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const row = rowOf(page, nodes[i], field, base);
    if (!row.id || !row.title) continue;
    items.push(row);
  }
  return items;
}

/**
 * play_regex:iplayr 的正则字段是 base64(解出来才是正则源码),也兼容直接写正则。
 * base64 解出来的东西得像个正则(带括号/转义)才用,免得把普通字符串当正则。
 */
function regexOf(ctx, raw) {
  const s = trim(raw);
  if (!s) ctx.fail("parse", "站点配置里没有 play_regex");
  const tries = [];
  if (/^[A-Za-z0-9+/=\s]+$/.test(s)) {
    const decoded = base64Decode(s.replace(/\s+/g, ""));
    if (decoded && /[\\()\[\]{}|]/.test(decoded)) tries.push(decoded);
  }
  tries.push(s);
  for (let i = 0; i < tries.length; i += 1) {
    try {
      return new RegExp(tries[i]);
    } catch (e) {
      /* 换下一个写法 */
    }
  }
  ctx.fail("parse", "play_regex 不是合法正则:" + s.slice(0, 60));
}

/** 详情页标题:配置里没有专门的字段,先 h1 再 <title> */
function titleOf(page) {
  let t = textOf(xpathOf(page, null, "//h1"));
  if (t) return t;
  return textOf(xpathOf(page, null, "//title"));
}

reelbox.define({
  id: "iplayr.engine",
  name: "iplayr 引擎",
  version: "1.0.0",
  api: 1,
  kind: "engine",
  caps: ["http", "html"],

  /** 分类:配置里 category 有几项就有几个选项,value 用序号 */
  async filters(ctx, args) {
    const options = (args && args.options) || {};
    if (!trim(options.config)) return [];
    let cfg;
    try {
      cfg = await loadConfig(ctx, options);
    } catch (e) {
      // 分类取不到不该拦住整个列表:列表那边会给出真正的错误
      return [];
    }
    const cats = categoriesOf(cfg);
    if (cats.length < 2) return [];
    return [
      {
        key: "classify",
        label: "分类",
        options: cats.map((c) => ({
          label: c.title || "分类 " + (c.index + 1),
          value: String(c.index),
        })),
      },
    ];
  },

  async list(ctx, args) {
    const a = args || {};
    const page = Number(a.page) > 0 ? Math.floor(Number(a.page)) : 1;
    const classify =
      (a.filters && a.filters.classify) || a.classify || "";
    const cfg = await loadConfig(ctx, a.options);
    const cat = pickCategory(categoriesOf(cfg), classify);
    if (!cat) ctx.fail("parse", "站点配置里没有可用的分类地址");
    const url = pageUrl(cat, page);
    if (!url) return { items: [], next: "" };
    const body = await getText(ctx, url, cfg);
    const doc = ctx.html.load(body);
    const items = parseRows(ctx, doc, fieldsOf(cfg, ""), url);
    return { items: items, next: items.length ? String(page + 1) : "" };
  },

  async search(ctx, args) {
    const a = args || {};
    const page = Number(a.page) > 0 ? Math.floor(Number(a.page)) : 1;
    const keyword = trim(a.keyword || a.query || a.wd);
    if (!keyword) return { items: [], next: "" };
    const cfg = await loadConfig(ctx, a.options);
    const first = trim(cfg.search_url_first_page);
    if (!first) ctx.fail("unsupported", "这份站点配置不支持搜索");
    const other = trim(cfg.search_url_other_page);
    if (page > 1 && !other) return { items: [], next: "" };
    const tpl = page > 1 ? other : first;
    const url = tpl
      .split("{wd}")
      .join(encodeURIComponent(keyword))
      .split("{pg}")
      .join(String(page));
    const body = await getText(ctx, url, cfg);
    const doc = ctx.html.load(body);
    const items = parseRows(ctx, doc, fieldsOf(cfg, "search_"), url);
    return { items: items, next: items.length ? String(page + 1) : "" };
  },

  /** 详情:剧集按 playlist_group_node 分组,组内取标题 / 链接 */
  async detail(ctx, args) {
    const a = args || {};
    const cfg = await loadConfig(ctx, a.options);
    // 列表给的 id 已经是绝对地址;万一配置直接给了相对路径,用站点 origin 补
    const url = absolute(a.id || "", siteOrigin(cfg));
    if (!url) ctx.fail("parse", "detail 没有拿到详情页地址");
    const body = await getText(ctx, url, cfg);
    const doc = ctx.html.load(body);

    let groupNodes = [];
    if (trim(cfg.playlist_group_node)) {
      try {
        groupNodes = doc.xpath(trim(cfg.playlist_group_node));
      } catch (e) {
        ctx.fail(
          "parse",
          "playlist_group_node 求值失败(" + trim(cfg.playlist_group_node) + "):" + ((e && e.message) || e)
        );
      }
    }
    // 没有分组写法(或不支持分组)时整页当一组
    if (!groupNodes.length) groupNodes = [doc.doc];

    const groups = [];
    for (let g = 0; g < groupNodes.length; g += 1) {
      const node = groupNodes[g];
      const names = xpathOf(doc, node, cfg.playlist_title);
      const links = xpathOf(doc, node, cfg.playlist_link_id);
      const episodes = [];
      for (let i = 0; i < names.length; i += 1) {
        const name = typeof names[i] === "string" ? trim(names[i]) : trim(names[i] && names[i].textContent);
        const raw = valueOf([links[i]]);
        const id = absolute(fillTemplate(cfg.playlist_link_url, raw), url);
        if (!name || !id) continue;
        episodes.push({ id: id, name: name });
      }
      if (!episodes.length) continue;
      groups.push({ name: "线路 " + (groups.length + 1), episodes: episodes });
    }
    if (!groups.length) ctx.fail("parse", "详情页里没有取到剧集(playlist_* 的 XPath 可能过期了)");
    return { title: titleOf(doc), groups: groups };
  },

  /**
   * 播放:剧集页里 play_regex 的第一个捕获组就是要的地址。
   * 捕获值有时是 base64(里面还套着 URL 编码),这里一并还原。
   */
  async play(ctx, args) {
    const a = args || {};
    const cfg = await loadConfig(ctx, a.options);
    const episodeUrl = absolute(trim(a.id || a.episodeId || ""), siteOrigin(cfg));
    if (!episodeUrl) ctx.fail("parse", "play 没有拿到剧集地址");
    const body = await getText(ctx, episodeUrl, cfg);
    const re = regexOf(ctx, cfg.play_regex);
    const m = re.exec(body);
    if (!m || !m[1]) ctx.fail("parse", "播放页里没有匹配 play_regex 的内容(站点可能改版了)");
    let value = trim(m[1]);
    if (looksBase64(value)) {
      const decoded = base64Decode(value);
      if (decoded) value = trim(decoded);
    }
    if (value.indexOf("%") >= 0) {
      try {
        value = decodeURIComponent(value);
      } catch (e) {
        /* 不是百分号编码,原样用 */
      }
    }
    const url = absolute(value, episodeUrl);
    if (!/^https?:\/\//i.test(url)) {
      ctx.fail("parse", "解出来的不是 http(s) 地址:" + url.slice(0, 80));
    }
    // Referer 一起带上:这类 CDN 多半查防盗链
    return { url: url, headers: headersFor(cfg, episodeUrl) };
  },
});
