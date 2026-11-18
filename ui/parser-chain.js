// 解析器链路:分享页 → 可播地址。
//
// 有的源只给网页地址(cms.rs 里抽不到 m3u8 就把 Stream.page 置 true)。这时按顺序
// 问「设置 → 源 → 解析器」里的插件:第一个认出页面、又给出地址的就算数。
//   * 串行,不并行:并行会把站点打爆,也看不出是哪个解析器解的;
//   * 整条链最多 20 秒,单个解析器最多 10 秒;
//   * 切集/关播放器把 playSeq 换代,链上每个 await 之后都会立刻退出。
// 契约见 docs/PARSERS.md。
//
// 这个文件是纯逻辑:不碰 DOM、不 import tauri —— 插件调用、白名单登记、状态栏、
// 日志、代际全从 runParserChain 的参数进来,这样 node --test 能直接跑。

export const PARSER_TOTAL_MS = 20000; // 整条解析链的预算
export const PARSER_ONE_MS = 10000; // 单个解析器(match + parse)的预算

/** 签名地址动辄几百字符,日志里只留开头 */
function shortUrl(u, n) {
  const s = String(u == null ? "" : u);
  const max = n || 120;
  return s.length > max ? s.slice(0, max) + "…(" + s.length + ")" : s;
}

/** 插件抛出来的可能是字符串 / Error / 别的东西,日志里只要一句话 */
function errText(e) {
  if (!e) return "未知错误";
  if (typeof e === "string") return e;
  if (e.message) return String(e.message);
  return String(e);
}

/** 给任意 Promise 加一个截止时间:插件卡住不能把播放一直吊着 */
export function withTimeout(promise, ms, tag) {
  if (!(ms > 0)) return Promise.reject(new Error((tag || "解析") + " 没有时间预算了"));
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error((tag || "解析") + " 超时(" + ms + "ms)"));
    }, ms);
    Promise.resolve(promise).then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
    );
  });
}

/**
 * 解析器的返回值三种形态都收(别让插件作者猜):
 *   {quality, url} / {streams:[{quality,url}]} / [{quality,url}]
 */
export function parserStreamsOf(res) {
  const out = [];
  const push = (o) => {
    if (!o || typeof o !== "object") return;
    const url = String(o.url == null ? "" : o.url).trim();
    if (!/^https?:\/\//i.test(url)) return;
    out.push({ quality: String(o.quality || o.name || "档 " + (out.length + 1)), url: url });
  };
  if (Array.isArray(res)) res.forEach(push);
  else if (res && Array.isArray(res.streams)) res.streams.forEach(push);
  else if (res && Array.isArray(res.sources)) res.sources.forEach(push); // 顺手兼容 play 的形状
  else push(res);
  return out;
}

/** 解析出来的地址是 mp4 还是清单:后缀能看出来就先猜,真正的类型由 stream_kind 探 */
export function parserMime(url) {
  return /\.mp4(\?|#|$)/i.test(String(url || ""))
    ? "video/mp4"
    : "application/vnd.apple.mpegurl";
}

/**
 * 依序问所有解析器,第一个成功就用它。返回内部 Stream 形状,全失败返回 null。
 *
 * 依赖全部注入(这样本文件不碰 DOM / tauri):
 *   parsers    [{ name, url }]            解析器列表,按导入顺序
 *   pageUrl    页面地址
 *   headers    播放链路带过来的请求头
 *   call       (path, hook, arg) → Promise  跑插件钩子(match / parse)
 *   allow      (urls) → Promise            登记播放白名单
 *   isAlive    () → boolean                代际还对不对(切集/关播放器就假了)
 *   status     (msg) → void                状态栏「解析中:xxx」
 *   log        (...args) → void            日志
 *   budget     整条链预算,默认 20s
 *   oneBudget  单个解析器预算,默认 10s
 *   now        时钟,默认 Date.now
 */
export async function runParserChain(opts) {
  const o = opts || {};
  const parsers = Array.isArray(o.parsers) ? o.parsers : [];
  const pageUrl = String(o.pageUrl || "");
  const srcHeaders = o.headers && typeof o.headers === "object" ? o.headers : {};
  const call = o.call;
  const allow = o.allow;
  const isAlive = typeof o.isAlive === "function" ? o.isAlive : () => true;
  const status = typeof o.status === "function" ? o.status : () => {};
  const log = typeof o.log === "function" ? o.log : () => {};
  const budget = o.budget > 0 ? o.budget : PARSER_TOTAL_MS;
  const oneBudget = o.oneBudget > 0 ? o.oneBudget : PARSER_ONE_MS;
  const now = typeof o.now === "function" ? o.now : Date.now;

  if (!parsers.length) {
    log("parser: 没有解析器,page =", shortUrl(pageUrl));
    return null;
  }
  const deadline = now() + budget;
  for (const src of parsers) {
    if (!isAlive()) return null;
    const name = String((src && src.name) || "解析器");
    const t0 = now();
    // 单个解析器的剩余预算:自己的 10 秒,整条链的 20 秒,取更紧的那个
    const left = () => Math.max(0, Math.min(oneBudget - (now() - t0), deadline - now()));
    if (left() <= 0) break;
    try {
      status("解析中:" + name);
      const hit = await withTimeout(call(src.url, "match", pageUrl), left(), "match");
      if (!isAlive()) return null;
      if (!hit) {
        log("parser skip", name, "(match=false)");
        continue;
      }
      const res = await withTimeout(
        call(src.url, "parse", { url: pageUrl, headers: srcHeaders }),
        left(),
        "parse"
      );
      if (!isAlive()) return null;
      const streams = parserStreamsOf(res);
      if (!streams.length) {
        log("parser skip", name, "(没有给出可播地址)");
        continue;
      }
      // 登记进服务端白名单:player_url 只认本次会话里给出的地址
      await allow(streams.map((s) => s.url));
      if (!isAlive()) return null;
      log("parser hit", name, "→", shortUrl(streams[0].url, 160), "档=" + streams.length);
      const headers = Object.assign({}, srcHeaders);
      // 解析出来的地址大多要 Referer = 原页面,没有就补上(大小写不敏感)
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "referer") && /^https?:/i.test(pageUrl)) {
        headers.Referer = pageUrl;
      }
      return {
        url: streams[0].url,
        mime: parserMime(streams[0].url),
        headers: headers,
        options: streams.map((s, i) => ({ quality: s.quality || "档 " + (i + 1), url: s.url })),
        page: false,
      };
    } catch (e) {
      // 一个解析器失败不该拖死整条链:记下来,问下一个
      log("parser fail", name, errText(e));
    }
  }
  log("parser: 全部失败,page =", shortUrl(pageUrl), "n=" + parsers.length);
  return null;
}
