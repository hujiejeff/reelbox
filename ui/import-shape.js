// 集合导入的形状识别。
//
// 索引文件五花八门,但真正能变成"源"的只有一种东西:一个能取数据的地址。
// TVBox 的配置里混着两类条目——`api` 是 URL 的(CMS 接口,能用)和 `api` 是
// `csp_XXX` 类名的(jar 里的 Java 爬虫,我们跑不了)。把后者导进来只会多一堆
// 点开就报错的源,所以在这里筛掉,并把跳过的原因带出去给用户看。

/** 能不能直接当源地址用:必须是 http(s),不能是类名/本地路径 */
export function usableApi(url) {
  const s = String(url == null ? "" : url).trim();
  if (!/^https?:\/\//i.test(s)) return false;
  // `csp_Douban` 这类是 jar 里的类名,不是地址
  if (/^csp_/i.test(s)) return false;
  return true;
}

/** TVBox 的 type:0=XML 1=JSON 3=jar 爬虫 4=外部播放器;缺省按 0 处理 */
function siteKind(item) {
  const t = item && item.type;
  if (t === undefined || t === null || t === "") return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : -1;
}

/** 认一条像不像 TVBox 的 site:有 key/api,但没有 url */
export function isTvboxSite(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  if (typeof item.url === "string" && item.url.trim()) return false;
  return typeof item.api === "string" || typeof item.key === "string";
}

/**
 * 把一份集合拆成「能用的源」和「跳过的条目」。
 * 非 TVBox 的条目原样通过(交给原来的 normSource 逻辑),TVBox 条目按类型筛。
 */
export function splitCollection(list) {
  const sources = [];
  const skipped = [];
  for (const item of list || []) {
    if (!isTvboxSite(item)) {
      sources.push(item);
      continue;
    }
    const name = String(item.name || item.key || "未命名").trim();
    const api = String(item.api || "").trim();
    const kind = siteKind(item);
    if (kind !== 0 && kind !== 1) {
      skipped.push({ name, reason: kind === 3 ? "jar 爬虫,跑不了" : "不是接口类型" });
      continue;
    }
    if (!usableApi(api)) {
      skipped.push({ name, reason: "没有可用地址" });
      continue;
    }
    sources.push({ name, url: api, type: kind === 0 ? "xml" : "vod", adapter: "vod" });
  }
  return { sources, skipped };
}
