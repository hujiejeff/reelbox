// 适配器:苹果 CMS v10 的两种采集接口 —— JSON(`api.php/provide/vod`)与
// XML(`/at/xml`)。
//
// 这一个文件就是原来 Rust 侧 `core/src/source/cms.rs` 的 JS 版:同一个接口、
// 同一套字段、同样的 id 编码规则。所以同一批 CMS 源走哪边都必须出一模一样的结果
// (验收口径见 `docs/ARCHITECTURE.md` P3:逐字段一致)。
//
// 一条源 = 内置这个适配器 + 源地址(`options.config`):
//
//   { adapter: "vod", url: "https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8" }
//
// 格式不用用户填:地址里带 `/at/xml`、`ac=xml`,或以 `.xml` 收尾就是 XML,否则 JSON。
// `options.format` 留作以后手动覆盖("auto" / "json" / "xml")。
//
// 剧集 id 的编码和 Rust 那份相同(前端/续播/回滚到 `vod-rs` 都靠它):
//   线路 id = `line:{线路序号}:{线路名}`
//   剧集 id = `{线路序号}:{集序号}:{地址}`   ← 只切前两个冒号,地址里的冒号不动
//
// 四类错误码:network / parse / auth / unsupported。

/** 采集接口普遍接受的桌面 UA(和前端沙箱的默认 UA 一致) */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * 简介的保险丝。cms.rs 不截断,真实站点也远到不了这个长度 ——
 * 这里只是为了不让一份畸形响应把整篇正文塞进播放页。
 */
const SUMMARY_MAX = 2000;

function trim(s) {
  return String(s == null ? "" : s).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, "");
}

/** JSON 里的 id / 分页可能是数字也可能是字符串(cms.rs 的 raw_string 同口径) */
function rawString(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" && isFinite(v)) return String(v);
  return "";
}

function str(v) {
  return typeof v === "string" ? v : "";
}

/** 一句地上的错误信息:带上前缀和截断,别把整页正文塞进日志 */
function head60(s) {
  return trim(String(s == null ? "" : s)).slice(0, 60);
}

function errText(e) {
  if (!e) return "未知错误";
  if (e.message) return String(e.message);
  return String(e);
}

/**
 * 百分号编码:和 cms.rs 的 urlencode 同一个口径 —— 只放过 `A-Za-z0-9-_.~`,
 * 其余(含中文)按 UTF-8 一个字节一个 `%XX`。
 * `encodeURIComponent` 只额外放过 `!'()*`,补掉这几个就完全一致了。
 */
function urlencode(s) {
  return encodeURIComponent(String(s == null ? "" : s)).replace(/[!'()*]/g, function (c) {
    return "%" + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

/**
 * 接口地址 + 查询串。空值不发(和 cms.rs 一样):
 * 分类没选时 `t=` 整个不出现在地址里。
 */
function endpoint(config, query) {
  const base = String(config == null ? "" : config);
  if (!base) return "";
  const parts = [];
  const keys = Object.keys(query || {});
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    const v = query[k];
    if (v === undefined || v === null || v === "") continue;
    parts.push(k + "=" + urlencode(String(v)));
  }
  if (!parts.length) return base;
  return base + (base.indexOf("?") >= 0 ? "&" : "?") + parts.join("&");
}

/** 站点地址:引擎类适配器都从 `options.config` 拿(插件契约见 docs/ENGINE-PLUGINS.md) */
function configOf(args) {
  const a = args || {};
  const o = (a.options && a.options.config) || a.config || "";
  return trim(o);
}

/**
 * 这个地址是哪个变体:XML 还是 JSON。
 *
 * 判据和 `Source::format()` 相同 —— 带 `/at/xml`、`ac=xml`,或以 `.xml` 收尾。
 * `options.format` 写死 "json" / "xml" 时听它的("auto" / 空 = 自己判)。
 */
function formatOf(config, args) {
  const forced = trim((args && args.options && args.options.format) || "").toLowerCase();
  if (forced === "xml" || forced === "json") return forced;
  const u = String(config == null ? "" : config).toLowerCase();
  if (u.indexOf("/at/xml") >= 0 || u.indexOf("ac=xml") >= 0) return "xml";
  // 查询串里的 `.xml` 不算后缀,`feed.xml#top` / `feed.xml?raw=1` 仍然按地址判
  if (u.endsWith(".xml") || u.split(/[?#]/)[0].endsWith(".xml")) return "xml";
  return "json";
}

function isXml(config, args) {
  return formatOf(config, args) === "xml";
}

/** 从响应里取正文:沙箱给的是 String 对象(带 status/mime),boa 回退也是同一形状 */
function resBody(res) {
  if (res === null || res === undefined) return "";
  const d = res.data;
  if (d !== undefined && d !== null) return String(d);
  return String(res);
}

function resMime(res) {
  if (!res) return "";
  if (res.mime) return String(res.mime);
  const h = res.headers || {};
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === "content-type") return String(h[k]);
  }
  return "";
}

/** 发一个请求。网络那一层的问题一律归 `network`,别谎称"格式不对" */
async function fetchText(ctx, url) {
  let res;
  try {
    res = await ctx.http.get(url, { headers: { "User-Agent": UA } });
  } catch (e) {
    ctx.fail("network", "请求失败:" + url + "(" + errText(e) + ")");
  }
  const status = Number(res && res.status) || 0;
  if (status >= 400) {
    ctx.fail("network", "站点返回 " + status + ":" + url);
  }
  return { body: resBody(res), mime: resMime(res), status: status };
}

function errhead(body) {
  const head = head60(body);
  return head ? "(返回前 60 字:" + head + ")" : "";
}

/* ---------- 列表:JSON ---------- */

/** 分类名 → kind(cms.rs 的 kind_of 同口径:先看"剧/动漫/综艺",再看"电影/片") */
function kindOf(typeName) {
  const t = String(typeName == null ? "" : typeName);
  if (t.indexOf("剧") >= 0 || t.indexOf("动漫") >= 0 || t.indexOf("综艺") >= 0) {
    return "series";
  }
  if (t.indexOf("电影") >= 0 || t.indexOf("片") >= 0) return "movie";
  return "unknown";
}

/** 分页游标:总数大于当前页才给下一页(没有总数就停) */
function nextOf(total, page) {
  return total > page ? String(page + 1) : "";
}

function pageFromJson(ctx, body, page) {
  let doc;
  try {
    doc = JSON.parse(body);
  } catch (e) {
    ctx.fail("parse", "不是合法 JSON" + errhead(body));
  }
  const items = [];
  const list = doc && Array.isArray(doc.list) ? doc.list : [];
  for (let i = 0; i < list.length; i += 1) {
    const v = list[i] || {};
    items.push({
      id: rawString(v.vod_id),
      title: str(v.vod_name),
      kind: kindOf(str(v.type_name)),
      poster: str(v.vod_pic),
      subtitle: str(v.vod_remarks),
    });
  }
  const total = parseInt(rawString(doc && doc.pagecount), 10) || 0;
  return { items: items, next: nextOf(total, page) };
}

/* ---------- 列表:XML ---------- */

/**
 * 取所有 `<tag ...>…</tag>` 的内容(不含外层标签本身)。
 *
 * 为什么不用 DOMParser:沙箱(浏览器)里有,boa 回退引擎和 node 里没有。
 * 采集接口的 XML 形状是固定的(只有 rss > list > video 一层),手写扫描器
 * 就够了,而且三条路径(WebView / boa / node 比对脚本)跑的是同一份代码。
 * CDATA 里的 `</video>` 不会提前结束 —— 那是唯一必须小心的地方。
 */
function blocksOf(xml, tag) {
  const src = String(xml == null ? "" : xml);
  const lower = src.toLowerCase();
  const open = "<" + tag.toLowerCase();
  const close = "</" + tag.toLowerCase() + ">";
  const out = [];
  let i = 0;
  while (i < src.length) {
    const at = lower.indexOf(open, i);
    if (at < 0) break;
    const after = src.charAt(at + open.length);
    if (after !== ">" && after !== " " && after !== "\n" && after !== "\r" && after !== "\t") {
      i = at + open.length; // `<videoid>` 这种不是它
      continue;
    }
    const gt = src.indexOf(">", at);
    if (gt < 0) break;
    const head = src.slice(at + 1, gt);
    if (head.charAt(head.length - 1) === "/") {
      out.push({ head: head, body: "" }); // 自闭合:`<video/>`
      i = gt + 1;
      continue;
    }
    const end = closeFrom(src, lower, close, gt + 1);
    if (end < 0) break;
    out.push({ head: head, body: src.slice(gt + 1, end) });
    i = end + close.length;
  }
  return out;
}

/** 找结束标签,跳过 CDATA 段(否则 CDATA 里的 `</name>` 会提前收尾) */
function closeFrom(src, lower, close, from) {
  let i = from;
  while (i < src.length) {
    const hit = lower.indexOf(close, i);
    if (hit < 0) return -1;
    const cdata = src.indexOf("<![CDATA[", i);
    if (cdata < 0 || cdata > hit) return hit;
    const end = src.indexOf("]]>", cdata + 9);
    if (end < 0) return hit;
    i = end + 3;
  }
  return -1;
}

/** 开标签里的属性值:`<list pagecount="8240">` → "8240" */
function attrOf(head, name) {
  const re = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i");
  const m = re.exec(String(head == null ? "" : head));
  if (!m) return "";
  return m[1] !== undefined ? m[1] : m[2];
}

/**
 * 一个字段的文本:CDATA 取出里面的正文,其余原样(采集接口的字段不会再套标签)。
 */
function xmlText(raw) {
  const s = String(raw == null ? "" : raw);
  let out = "";
  let i = 0;
  for (;;) {
    const start = s.indexOf("<![CDATA[", i);
    if (start < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, start);
    const end = s.indexOf("]]>", start + 9);
    if (end < 0) {
      out += s.slice(start + 9);
      break;
    }
    out += s.slice(start + 9, end);
    i = end + 3;
  }
  return trim(out);
}

/** 某个标签的第一个文本(cdata 也算) */
function innerOf(xml, tag) {
  const hits = blocksOf(xml, tag);
  return hits.length ? xmlText(hits[0].body) : "";
}

function pageFromXml(ctx, body, page) {
  const lists = blocksOf(body, "list");
  if (!lists.length) {
    // 合法 XML 但没有 list:当空页;连尖括号都没有(比如拿 JSON 当 XML 取):报格式
    if (String(body).indexOf("<") < 0) {
      ctx.fail("parse", "不是合法 XML" + errhead(body));
    }
    return { items: [], next: "" };
  }
  const list = lists[0];
  const items = [];
  const videos = blocksOf(list.body, "video");
  for (let i = 0; i < videos.length; i += 1) {
    const v = videos[i].body;
    items.push({
      id: innerOf(v, "id"),
      title: innerOf(v, "name"),
      kind: kindOf(innerOf(v, "type")),
      poster: innerOf(v, "pic"),
      subtitle: innerOf(v, "note"),
    });
  }
  const total = parseInt(attrOf(list.head, "pagecount"), 10) || 0;
  return { items: items, next: nextOf(total, page) };
}

/* ---------- 详情 ---------- */

/** 去 HTML 标签:cms.rs 的 strip_tags 同口径(逐字符数深度,`&nbsp;` 换空格) */
function stripTags(s) {
  const text = String(s == null ? "" : s);
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "<") {
      depth += 1;
    } else if (ch === ">") {
      if (depth > 0) depth -= 1;
    } else if (depth === 0) {
      out += ch;
    }
  }
  out = trim(out.split("&nbsp;").join(" "));
  return out.length > SUMMARY_MAX ? out.slice(0, SUMMARY_MAX) : out;
}

/** 详情页的原始字段(JSON 与 XML 各解析出一份同样的形状) */
function rawDetailFromJson(ctx, body) {
  let doc;
  try {
    doc = JSON.parse(body);
  } catch (e) {
    ctx.fail("parse", "不是合法 JSON" + errhead(body));
  }
  const list = doc && Array.isArray(doc.list) ? doc.list : [];
  const first = list[0];
  if (!first) ctx.fail("parse", "没有这个内容");
  return {
    title: str(first.vod_name),
    poster: str(first.vod_pic),
    summary: str(first.vod_content),
    from: str(first.vod_play_from),
    playUrl: str(first.vod_play_url),
  };
}

function rawDetailFromXml(ctx, body) {
  const lists = blocksOf(body, "list");
  const videos = lists.length ? blocksOf(lists[0].body, "video") : [];
  if (!videos.length) ctx.fail("parse", "没有这个内容");
  const v = videos[0].body;
  const dls = blocksOf(v, "dl");
  const dds = dls.length ? blocksOf(dls[0].body, "dd") : [];
  const from = [];
  const urls = [];
  for (let i = 0; i < dds.length; i += 1) {
    from.push(attrOf(dds[i].head, "flag"));
    urls.push(xmlText(dds[i].body));
  }
  return {
    title: innerOf(v, "name"),
    poster: innerOf(v, "pic"),
    summary: innerOf(v, "des"),
    from: from.join("$$$"),
    playUrl: urls.join("$$$"),
  };
}

/**
 * 线路 / 剧集拆分:规则照抄 cms.rs 的 `detail()` ——
 * `$$$` 分线路、`#` 分集、`名称$地址` 拆开;没有 `名称$` 的整段当地址。
 * 线路名取 `vod_play_from` 的同序号那一项,没有就叫"线路 N";
 * 一集都没有的线路不出现,一集都没有就报错。
 */
function detailOf(ctx, id, raw) {
  const names = String(raw.from == null ? "" : raw.from).split("$$$");
  const lines = String(raw.playUrl == null ? "" : raw.playUrl).split("$$$");
  const groups = [];
  for (let i = 0; i < lines.length; i += 1) {
    const name = trim(names[i] === undefined ? "" : names[i]) || "线路 " + (i + 1);
    const episodes = [];
    const eps = lines[i].split("#");
    for (let j = 0; j < eps.length; j += 1) {
      const ep = trim(eps[j]);
      if (!ep) continue;
      const dollar = ep.indexOf("$");
      const epName = dollar < 0 ? ep : ep.slice(0, dollar);
      const epUrl = dollar < 0 ? ep : ep.slice(dollar + 1);
      if (epUrl.indexOf("http") !== 0) continue;
      episodes.push({ id: String(i) + ":" + String(j) + ":" + epUrl, name: epName });
    }
    if (!episodes.length) continue;
    groups.push({ id: "line:" + String(i) + ":" + name, name: name, episodes: episodes });
  }
  if (!groups.length) a.fail("parse", "没有可播放的剧集");
  return {
    id: id,
    title: raw.title,
    poster: raw.poster,
    summary: stripTags(raw.summary),
    groups: groups,
  };
}

/* ---------- 播放 ---------- */

/** 地址本身看着就是媒体文件(`.m3u8` / `.mp4`)吗? */
function isMediaUrl(url) {
  const u = String(url == null ? "" : url).toLowerCase();
  return u.indexOf(".m3u8") >= 0 || u.indexOf(".mp4") >= 0;
}

function isBoundary(ch) {
  return "'\"<>(),;".indexOf(ch) >= 0 || /\s/.test(ch);
}

/** 相对地址补成绝对(cms.rs 的 absolute 同口径) */
function absolute(u, base) {
  const raw = String(u == null ? "" : u);
  if (raw.indexOf("http") === 0) return raw;
  if (raw.indexOf("//") === 0) return "https:" + raw;
  const b = String(base == null ? "" : base);
  const p = b.indexOf("://");
  if (p < 0) return raw;
  const rest = b.slice(p + 3);
  const slash = rest.indexOf("/");
  const hostEnd = slash < 0 ? b.length : p + 3 + slash;
  const origin = b.slice(0, hostEnd);
  if (raw.charAt(0) === "/") return origin + raw;
  const lastSlash = b.lastIndexOf("/");
  if (lastSlash <= hostEnd) return origin + "/" + raw;
  return b.slice(0, lastSlash + 1) + raw;
}

/** 页面里第一个 `.m3u8` 地址(前后都是"边界",别把 CSS 类名截进来) */
function extractM3u8(body, base) {
  const text = String(body == null ? "" : body).split("\\/").join("/");
  const lower = text.toLowerCase();
  const idx = lower.indexOf(".m3u8");
  if (idx < 0) return "";
  let l = idx;
  while (l > 0 && !isBoundary(text.charAt(l - 1))) l -= 1;
  let r = idx + 5;
  while (r < text.length && !isBoundary(text.charAt(r))) r += 1;
  return absolute(text.slice(l, r), base);
}

/** 响应像不像一张网页:content-type 说了算,没说就看正文开头 */
function looksLikeHtml(contentType, body) {
  if (String(contentType).toLowerCase().indexOf("html") >= 0) return true;
  const head = String(body == null ? "" : body).slice(0, 400).toLowerCase();
  return head.indexOf("<html") >= 0 || head.indexOf("<!doctype") >= 0;
}

/**
 * 剧集地址是不是真的能播(cms.rs 的 resolve_media 同口径):
 *   1. 地址本身就是 `.m3u8` / `.mp4` → 直接播;
 *   2. 取一次,响应是媒体类型 → 直接播;
 *   3. 页面里能抽出 `.m3u8` → 用它,页面地址留作 Referer;
 *   4. 抽不到、但响应确实是 HTML → 这是个分享页,`page = true` 交给播放链路报错;
 *   5. 其余(404、二进制、连不上)原样交出去,让播放阶段报出真实的失败。
 */
async function resolveMedia(ctx, url) {
  const played = { url: url, referer: "", page: false };
  if (isMediaUrl(url)) return played;
  let res;
  try {
    res = await ctx.http.get(url, { headers: { "User-Agent": UA, Referer: url } });
  } catch (e) {
    // 连不上就照旧把地址交出去:让播放阶段说"网络没通",别谎称"只给了解析页"
    return played;
  }
  const status = Number(res && res.status) || 0;
  const mime = resMime(res);
  const lower = mime.toLowerCase();
  if (lower.indexOf("mpegurl") >= 0 || lower.indexOf("video/") >= 0) return played;
  const body = resBody(res);
  if (status >= 400) return played;
  const media = extractM3u8(body, url);
  if (media) return { url: media, referer: url, page: false };
  if (looksLikeHtml(mime, body)) return { url: url, referer: "", page: true };
  return played;
}

/* ---------- 入口 ---------- */

reelbox.define({
  id: "vod",
  name: "苹果 CMS 接口",
  version: "1",
  api: 1,
  caps: ["http"],
  // 这是适配器不是源:它的"站点"在 options.config 里(见 docs/ARCHITECTURE.md)
  kind: "adapter",
  accepts: { kind: "json", has: ["list", "pagecount"] },

  /** 分类:`ac=list` 里的 `class` 数组。XML 变体没有分类(cms.rs 同口径) */
  async filters(ctx, args) {
    const a = args || {};
    const config = configOf(a);
    if (!config) ctx.fail("unsupported", "这个源还没填接口地址(设置 → 源 → 编辑源)");
    if (isXml(config, a)) return [];
    let body = "";
    try {
      body = (await fetchText(ctx, endpoint(config, { ac: "list" }))).body;
    } catch (e) {
      // 分类取不到不该拦住整个列表:列表那边会给出真正的错误
      return [];
    }
    let doc;
    try {
      doc = JSON.parse(body);
    } catch (e) {
      return [];
    }
    const opts = [{ label: "全部", value: "", parent: "" }];
    const list = doc && Array.isArray(doc.class) ? doc.class : [];
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i] || {};
      const value = rawString(c.type_id);
      const label = str(c.type_name);
      if (!value || !label) continue;
      let parent = rawString(c.type_pid);
      if (parent === "0") parent = "";
      opts.push({ label: label, value: value, parent: parent });
    }
    if (opts.length < 2) return [];
    return [{ key: "classify", label: "分类", options: opts }];
  },

  /** 列表:`?ac=detail&pg={page}`(选了分类再带 `t=`) */
  async list(ctx, args) {
    const a = args || {};
    const config = configOf(a);
    if (!config) ctx.fail("unsupported", "这个源还没填接口地址(设置 → 源 → 编辑源)");
    const page = Number(a.page) > 0 ? Math.floor(Number(a.page)) : 1;
    const classify = trim((a.filters && a.filters.classify) || a.classify || "");
    const url = endpoint(config, { ac: "detail", pg: String(page), t: classify });
    const got = await fetchText(ctx, url);
    return isXml(config, a) ? pageFromXml(ctx, got.body, page) : pageFromJson(ctx, got.body, page);
  },

  /** 搜索:`?ac=detail&wd={keyword}&pg={page}` */
  async search(ctx, args) {
    const a = args || {};
    const config = configOf(a);
    if (!config) ctx.fail("unsupported", "这个源还没填接口地址(设置 → 源 → 编辑源)");
    const keyword = trim(a.keyword || a.query || a.wd || "");
    if (!keyword) return { items: [], next: "" };
    const raw = Number(a.page) > 0 ? Number(a.page) : Number(a.cursor) > 0 ? Number(a.cursor) : 1;
    const page = Math.floor(raw);
    const url = endpoint(config, { ac: "detail", wd: keyword, pg: String(page) });
    const got = await fetchText(ctx, url);
    return isXml(config, a) ? pageFromXml(ctx, got.body, page) : pageFromJson(ctx, got.body, page);
  },

  /** 详情:`?ac=detail&ids={id}`,线路 / 剧集的拆法见 detailOf */
  async detail(ctx, args) {
    const a = args || {};
    const config = configOf(a);
    if (!config) ctx.fail("unsupported", "这个源还没填接口地址(设置 → 源 → 编辑源)");
    const id = trim(a.id || a.contentId || "");
    if (!id) ctx.fail("parse", "缺少内容标识");
    const got = await fetchText(ctx, endpoint(config, { ac: "detail", ids: id }));
    const raw = isXml(config, a) ? rawDetailFromXml(ctx, got.body) : rawDetailFromJson(ctx, got.body);
    return detailOf(ctx, id, raw);
  },

  /** 播放:从剧集 id 里取出地址,必要时去分享页里抽 `.m3u8` */
  async play(ctx, args) {
    const a = args || {};
    const id = trim(a.id || a.episodeId || "");
    const first = id.indexOf(":");
    const second = first < 0 ? -1 : id.indexOf(":", first + 1);
    if (first < 0 || second < 0) ctx.fail("parse", "剧集标识无效:" + head60(id));
    const target = id.slice(second + 1);
    if (target.indexOf("http") !== 0) {
      ctx.fail("parse", "剧集标识里没有播放地址:" + head60(target));
    }
    const media = await resolveMedia(ctx, target);
    const mime =
      media.url.toLowerCase().indexOf(".mp4") >= 0
        ? "video/mp4"
        : "application/vnd.apple.mpegurl";
    const headers = { "User-Agent": UA };
    if (media.referer) headers.Referer = media.referer;
    return {
      url: media.url,
      mime: mime,
      headers: headers,
      options: [],
      // 只拿到一张分享页:标成解析页(和 cms.rs 的 page 标记同一个含义)。
      // 这里没有取流方式,播放链路会明确报「只给了解析页」。
      page: media.page,
    };
  },
});
