import { initTheme, state as themeState, SEEDS, isDark } from "./theme.js";
import { initPluginHost, callPlugin, isPluginSource } from "./plugin-host.js";
import { buildSrcPanel } from "./src-panel.js";
import { openSheet } from "./sheet.js";
import { closeMenu, menuOpen, openMenu } from "./menu.js";
import {
  alertDialog,
  confirmDialog,
  formDialog,
  promptDialog,
  toast,
} from "./ui-dialog.js";

// Reelbox 前端:所有数据都从 Tauri 命令拿。
// 插件源例外:钩子在 ui/plugin-host.js 的 sandbox iframe 里跑,这里只做数据搬运。
const { invoke } = window.__TAURI__.core;

const S = {
  sources: [],
  source: null,
  parents: [],          // [{label, value}]
  children: {},         // parentValue -> [{label, value}]
  parent: "",
  child: "",
  items: [],
  page: 1,
  next: "",
  loading: false,
  query: "",
  blobs: new Map(),     // 封面地址 → objectURL(避免重复加载)
  listError: null,      // 上一页/当前列表的失败信息(三态用:加载中 / 空 / 错误)
  detailItem: null,     // 最近打开的条目,详情失败时重试用
  detailGroups: [],     // 详情里的线路,播放失败"换线路"用
  favs: {},             // 收藏:localStorage["reelbox.favs"],键 = 源id|片名
  srcFilter: "all",     // 源管理页分段:all | vod | plugin | live
};

const $ = (id) => document.getElementById(id);

// ---------- 数据 ----------

function bindWheelScroll() {
  // 非触摸屏:鼠标滚轮在横向 chip 行里改成左右滚动
  const row = document.getElementById("childchips");
  if (!row || row.dataset.wheel) return;
  row.dataset.wheel = "1";
  row.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    row.scrollLeft += e.deltaY;
  }, { passive: false });
}

async function init() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
      e.preventDefault();
      toggleDebug();
    }
  });
  bindDebugToggle();
  bindWheelScroll();
  S.srcFilter = prefGet("reelbox.srcFilter", "all");
  log("init start");
  initPluginHost({ invoke: invoke, log: log });
  {
    const d = document.getElementById("dbg");
    if (d) d.hidden = true;
  }
  syncDebugButtons();
  syncPlaySettings();
  loadAppInfo();
  bindPlayer();
  document.addEventListener("keydown", (e) => {
    const box = $("player");
    if (box.hidden) return;
    const v = $("video");
    if (e.key === "Escape") {
      if ($("pLevels").hidden) return closePlayer();
      $("pLevels").hidden = true;
      return;
    }
    if (e.key === " " || e.code === "Space") { e.preventDefault(); return pTogglePlay(); }
    if (e.key === "ArrowRight") { v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10); return; }
    if (e.key === "ArrowLeft") { v.currentTime = Math.max(0, v.currentTime - 10); return; }
    if (e.key === "f" || e.key === "F") {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (box.requestFullscreen) box.requestFullscreen();
    }
  });

  try {
    S.sources = await invoke("list_sources");
  } catch (e) {
    return showListError(errorInfo("source", e), () => init());
  }
  if (!S.sources.length) {
    showListEmpty(
      "还没有配置源",
      "加一个点播接口地址(苹果 CMS 的 /api.php/provide/vod 那种),或者从网络索引批量导入。",
      "去添加源",
      openSourceManager
    );
    bindNav();
    bindSourceMenu();
    return;
  }
  S.source = startSource(S.sources);
  renderSources();
  bindNav();
  bindSourceMenu();
  await switchSource(S.source);

  // reelbox.exe --selftest:无人值守跑一遍 列表 → 详情 → 播放,结果写日志
  try {
    if (await invoke("selftest_mode")) await runSelfTest();
  } catch (e) {
    log("SELFTEST CRASH", String(e));
  }
}

/* ---------- 自检:reelbox.exe --selftest ---------- */

function waitFor(check, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = !!check(); } catch (_) {}
      if (ok) return resolve(true);
      if (Date.now() - started > ms) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

const PLAY_TIMEOUT_MS = 25000; // 单集最多等这么久出画面
const PLAY_TRIES = 3;          // 最多试几集
const PLAY_NEED = 2;           // 至少几集真的播起来才算 PASS

/** 播放判定:有画面尺寸 + 缓冲够 + currentTime 真的往前走 */
function playingNow(v, from) {
  return v.readyState >= 3 && v.videoWidth > 0 && Number(v.currentTime || 0) > from + 0.5;
}

/** 失败时把 <video> 和 hls.js 的现场抄下来 */
function videoFailReason(v) {
  const parts = [
    "readyState=" + v.readyState,
    "networkState=" + v.networkState,
    "size=" + v.videoWidth + "x" + v.videoHeight,
    "t=" + Number(v.currentTime || 0).toFixed(2),
    "paused=" + v.paused,
  ];
  if (v.error) parts.push("mediaErr=" + v.error.code + "(" + (v.error.message || "") + ")");
  if (v.currentSrc) parts.push("src=" + shortUrl(v.currentSrc, 90));
  return parts.join(" ");
}

/** 自检失败时,直接再拉一次 m3u8,拿到 HTTP 码/字节数/是否真是清单 */
async function probePlaylist(localUrl) {
  if (!localUrl) return null;
  try {
    const r = await fetch(localUrl, { cache: "no-store" });
    const text = await r.text();
    const ext = text.startsWith("#EXTM3U");
    log(
      "M3U8 probe", "code=" + r.status, "bytes=" + text.length,
      "extm3u=" + (ext ? "yes" : "NO"),
      ext ? "" : "head=" + text.replace(/\s+/g, " ").slice(0, 160)
    );
    return { code: r.status, bytes: text.length, extm3u: ext };
  } catch (e) {
    log("M3U8 probe fail", String(e));
    return { error: String(e && e.message ? e.message : e) };
  }
}

/** 一次播放尝试:返回可写进报告的结构 */
async function playAttempt(ep) {
  const v = $("video");
  const t0 = Date.now();
  const res = { name: ep.name, id: ep.id, ok: false, ms: 0 };
  try {
    await playEpisode(ep.id, ep.name, ep.group || "");
  } catch (e) {
    res.ms = Date.now() - t0;
    res.reason = "playEpisode: " + (e && e.message ? e.message : e);
    return res;
  }
  // 自检不需要声音:静音播放在任何策略下都能起来
  try { v.muted = true; v.play().catch(() => {}); } catch (_) {}
  // 每次从当前位置往前推 0.5 秒才算"真的在走"
  const startAt = Number(v.currentTime || 0);
  res.from = Number(startAt.toFixed(2));
  const ok = await waitFor(() => playingNow(v, startAt), PLAY_TIMEOUT_MS);
  res.ms = Date.now() - t0;
  res.ok = !!ok;
  res.readyState = v.readyState;
  res.videoWidth = v.videoWidth;
  res.videoHeight = v.videoHeight;
  res.to = Number(Number(v.currentTime || 0).toFixed(2));
  if (!ok) {
    res.reason = videoFailReason(v);
    res.m3u8 = await probePlaylist(lastLocalUrl);
  }
  return res;
}

/** 把日志里和播放相关的行挑出来,失败时一起打出去 */
function diagLines(lines, keep) {
  const re = /HLS ERR|HLS FATAL|VIDEO ERR|M3U8 probe|STREAM FAIL|stream |PROXY /;
  return lines.filter((l) => re.test(l)).slice(-(keep || 14));
}

let lastLocalUrl = "";

/** 全流程验收:插件源 列表 → 详情 → 播放(多集,视频真的在走) */
async function runSelfTest() {
  const say = (m) => log("SELFTEST " + m);
  const startedAt = new Date();
  const report = {
    at: startedAt.toISOString(),
    exe: "reelbox --selftest",
    source: null,
    list: null,
    detail: null,
    play: null,
    cms: null,
    result: "FAIL",
    reason: "",
  };

  // 先写一版占位报告:进程被杀也不会一份都没有
  async function flushReport() {
    report.durationMs = Date.now() - startedAt.getTime();
    try {
      const p = await invoke("selftest_report", { json: JSON.stringify(report, null, 2) });
      say("report " + p);
    } catch (e) {
      say("report fail " + (e && e.message ? e.message : e));
    }
  }

  const stop = async (m) => {
    report.result = "FAIL";
    report.reason = String(m);
    say("FAIL " + m);
    const diag = diagLines(LOG_BUF, 20);
    diag.forEach((l) => say("diag| " + l));
    say("DONE");
    await flushReport();
  };

  try {
    await flushReport();
    const src =
      S.sources.find((s) => isPluginSource(s) && /4k/i.test(String(s.name) + String(s.url))) ||
      S.sources.find((s) => isPluginSource(s));
    if (!src) return await stop("没有插件源");
    report.source = { name: src.name, url: src.url };
    say("source " + src.name);

    /* ---- 列表 ---- */
    const t0 = Date.now();
    await switchSource(src);
    const items = S.items || [];
    const first = items[0] || {};
    report.list = {
      ms: Date.now() - t0,
      items: items.length,
      first: first.title || "",
      poster: !!first.poster,
      ok: items.length > 0 && /[\u4e00-\u9fa5]/.test(first.title || ""),
    };
    say(
      "list ms=" + report.list.ms + " n=" + items.length +
      " first=" + JSON.stringify(first.title || "") + " poster=" + (first.poster ? "yes" : "no")
    );
    if (!items.length) {
      return await stop("列表为空" + (S.listError ? " | " + S.listError.title + " | " + S.listError.raw : ""));
    }
    if (!report.list.ok) return await stop("首个条目没有中文片名");

    /* ---- 指定片名(复现某个播不了的片):--selftest-title=xxx ---- */
    const want = await invoke("selftest_title").catch(() => "");
    let pick = first;
    if (want) {
      const match = (list) => (list || []).find((it) => String(it.title || "").indexOf(want) >= 0);
      let hit = match(items);
      if (!hit) {
        // 列表里没有就用插件自己的 search 钩子捞
        try {
          const page = await fetchSearch(want, 1);
          const found = page.items || [];
          say("search " + JSON.stringify(want) + " n=" + found.length);
          hit = match(found) || found[0];
        } catch (e) {
          say("search fail " + (e && e.message ? e.message : e));
        }
      }
      if (hit) {
        pick = hit;
        report.list.picked = pick.title || "";
        say("picked " + JSON.stringify(pick.title || "") + " id=" + pick.id);
      } else {
        say("picked none,回退列表第一条");
      }
    }

    /* ---- 详情 ---- */
    const t1 = Date.now();
    const d = await openDetail(pick);
    const eps = (S.detailEps || []).slice();
    report.detail = {
      ms: Date.now() - t1,
      title: d.title || "",
      summary: (d.summary || "").length,
      groups: d.groups.length,
      episodes: eps.length,
      ok: !!d.title && eps.length > 0,
    };
    say(
      "detail ms=" + report.detail.ms + " title=" + JSON.stringify(d.title || "") +
      " summary=" + report.detail.summary + " groups=" + d.groups.length + " eps=" + eps.length
    );
    if (!d.title) return await stop("详情没有标题");
    if (!eps.length) return await stop("详情没有分集");

    /* ---- 播放:最多试 3 集,至少 2 集真的播起来 ---- */
    const picks = [];
    for (const e of eps) {
      if (picks.length >= PLAY_TRIES) break;
      if (picks.some((p) => p.id === e.id)) continue;
      picks.push(e);
    }
    const need = Math.min(PLAY_NEED, picks.length);
    const t2 = Date.now();
    const attempts = [];
    for (let i = 0; i < picks.length; i++) {
      const mark = LOG_BUF.length;
      const r = await playAttempt(picks[i]);
      r.index = i + 1;
      attempts.push(r);
      say(
        "play " + r.index + "/" + picks.length + " ep=" + JSON.stringify(r.name) +
        " ok=" + (r.ok ? "yes" : "no") + " ms=" + r.ms +
        " readyState=" + r.readyState + " size=" + r.videoWidth + "x" + r.videoHeight +
        " t=" + r.from + "→" + r.to
      );
      if (!r.ok) {
        say("play " + r.index + " reason " + r.reason);
        diagLines(LOG_BUF.slice(mark), 10).forEach((l) => say("diag| " + l));
      }
      if (attempts.filter((a) => a.ok).length >= need) break; // 够了就别再耗时间
    }
    const passed = attempts.filter((a) => a.ok).length;
    report.play = {
      ms: Date.now() - t2,
      tries: attempts.length,
      passed: passed,
      needed: need,
      attempts: attempts,
      ok: passed >= need,
    };
    say("play summary ok=" + passed + "/" + need + " tries=" + attempts.length + " ms=" + report.play.ms);
    if (!report.play.ok) {
      return await stop(
        "视频没有真正播起来(" + passed + "/" + need + "):" +
        attempts.filter((a) => !a.ok).map((a) => a.name + " " + (a.reason || "")).join(" | ")
      );
    }

    /* ---- 内置 CMS 源回归:插件化改动别把共享的 player_url / HLS 弄坏 ---- */
    const cms = S.sources.find((s) => !isPluginSource(s) && /dytt|ffzy|lzzy/.test(String(s.url)));
    if (cms) {
      const t3 = Date.now();
      try {
        await switchSource(cms);
        const one = (S.items || [])[0];
        if (!one) throw new Error("列表为空");
        await openDetail(one);
        const ep = (S.detailEps || [])[0];
        if (!ep) throw new Error("没有分集");
        await playEpisode(ep.id, ep.name, ep.group || "");
        const cv = $("video");
        try { cv.muted = true; cv.play().catch(() => {}); } catch (_) {}
        const okCms = await waitFor(() => cv.currentTime > 0.05 && !cv.paused, 20000);
        report.cms = {
          name: cms.name,
          ms: Date.now() - t3,
          ok: !!okCms,
          reason: okCms ? "" : videoFailReason(cv),
        };
        say("cms " + (okCms ? "ok" : "warn 没播起来 " + report.cms.reason) + " source=" + cms.name);
      } catch (e) {
        report.cms = { name: cms.name, ms: Date.now() - t3, ok: false, reason: String(e && e.message ? e.message : e) };
        say("cms warn " + report.cms.reason);
      }
    }

    report.result = "PASS";
    report.reason = "";
    say("PASS play=" + passed + "/" + need);
    say("DONE");
    await flushReport();
  } catch (e) {
    await stop(e && e.message ? e.message : String(e));
  }
}

/* ---------- 记忆:上次用的源与分类 ---------- */
// 只记四个键(点播/直播各记一个源;分类记上次停在哪一级)。
// 存的源被删掉、存的分类在新源里不存在,都回退到第一个可用值,不报错。

const LS = {
  currentSource: "reelbox.currentSource",
  currentLiveSource: "reelbox.currentLiveSource", // 直播 tab(v0.3)用,现在只写不读
  lastClass: "reelbox.lastClass",
  lastChild: "reelbox.lastChild",
};

/** 启动时用哪个源:上次用的那个,找不到就第一个 */
function startSource(list) {
  const want = prefGet(LS.currentSource, "");
  return (want && (list || []).find((s) => s.id === want)) || (list || [])[0];
}

/** 把上次的分类先摆上;返回"有没有存过分类"(没存过就不用串行等 filters) */
function seedCategory() {
  const cls = prefGet(LS.lastClass, "");
  const kid = prefGet(LS.lastChild, "");
  S.parent = cls || "";
  S.child = cls && kid ? kid : "";
  return !!(S.parent || S.child);
}

function rememberSource(src) {
  if (!src || !src.id) return;
  prefSet(LS.currentSource, src.id);
  // 直播源单独记一份,将来直播 tab 直接用它
  if (sourceType(src) === "live") prefSet(LS.currentLiveSource, src.id);
}

function rememberCategory() {
  prefSet(LS.lastClass, S.parent || "");
  prefSet(LS.lastChild, S.child || "");
}

async function switchSource(src) {
  log("switchSource", src && src.id);
  S.source = src;
  // 最近使用靠这里喂:不接上「最近使用」永远是空的
  pushRecent(src && src.id);
  rememberSource(src);
  S.parent = "";
  S.child = "";
  S.items = [];
  S.blobs.forEach((u) => URL.revokeObjectURL(u));
  S.blobs.clear();
  $("srcName").textContent = src.name;
  // 切源等于换了片库:详情页上的剧集已失效,先回首页
  S.detailTitle = "";
  S.detailEps = [];
  S.detailGroups = [];
  S.detailId = "";
  S.listError = null;
  if (!$("player").hidden) closePlayer();
  showView("home");
  const seeded = seedCategory();
  if (seeded) {
    // 存的分类要先让 loadFilters 校验一遍(新源里可能没有这个分类),再取列表,
    // 否则会拿一个不存在的分类去请求。没存过分类时保持并行,不多等一个来回。
    await loadFilters();
    await loadItems();
  } else {
    await Promise.all([loadFilters(), loadItems()]);
  }
  // 当前源变了:源管理页的选中态与设置首页摘要都要跟着走
  renderSourceManager();
  syncSetSummaries();
}

/* ---------- 插件源:钩子在 sandbox iframe 里跑 ---------- */

function pluginMode() {
  return isPluginSource(S.source);
}

/** 列表:插件源走沙箱(ui/plugin-host.js),内置源走 Rust */
async function fetchPage(page, classify) {
  if (!pluginMode()) return invoke("list_items", { source: S.source, page, classify });
  const res = await callPlugin(S.source.url, "list", {
    page: page,
    cursor: page > 1 ? String(page) : null,
    filters: { classify: classify || "" },
  });
  return {
    items: (res && (res.items || res.list)) || [],
    nextCursor: (res && (res.nextCursor || res.next)) || "",
  };
}

async function fetchSearch(keyword, page) {
  if (!pluginMode()) return invoke("search", { source: S.source, keyword, page });
  const res = await callPlugin(S.source.url, "search", {
    query: keyword,
    cursor: page > 1 ? String(page) : null,
  });
  return {
    items: (res && (res.items || res.list)) || [],
    nextCursor: (res && (res.nextCursor || res.next)) || "",
  };
}

async function fetchFilters() {
  if (!pluginMode()) return invoke("filters", { source: S.source });
  return callPlugin(S.source.url, "filters", {});
}

async function fetchDetail(id) {
  if (!pluginMode()) return invoke("detail", { source: S.source, id });
  const d = (await callPlugin(S.source.url, "detail", { id })) || {};
  const groups = Array.isArray(d.groups) ? d.groups : [];
  return {
    id: d.id || id,
    title: d.title || "",
    poster: d.poster || "",
    summary: d.summary || "",
    groups: groups
      .map((g, i) => {
        const gid = g.id || "g" + i;
        const eps = (Array.isArray(g.episodes) ? g.episodes : [])
          .filter((e) => e && e.id)
          .map((e, k) => ({ id: String(e.id), name: e.name || "第 " + (k + 1) + " 集", group: gid }));
        return { id: gid, name: g.name || "线路 " + (i + 1), episodes: eps };
      })
      .filter((g) => g.episodes.length),
  };
}

async function loadFilters() {
  let fs = [];
  try {
    fs = await fetchFilters();
  } catch (e) {
    log("filters fail", e);
  }
  const opts = (fs && fs[0] && fs[0].options) || [];
  S.parents = opts.filter((o) => !o.parent && o.value);
  S.children = {};
  for (const o of opts) {
    if (!o.parent) continue;
    (S.children[o.parent] = S.children[o.parent] || []).push(o);
  }
  // 记忆下来的分类可能在换源后不存在了:清掉,退回「全部」。
  // 分类接口本身失败( opts 为空)时不动记忆,免得网络抖一下就把它抹掉。
  if (opts.length) {
    if (S.parent && !S.parents.some((p) => p.value === S.parent)) {
      S.parent = "";
      S.child = "";
      rememberCategory();
    } else if (S.child && !(S.children[S.parent] || []).some((c) => c.value === S.child)) {
      S.child = "";
      rememberCategory();
    }
  }
  renderParents();
  renderChildren();
}

async function loadItems() {
  if (!S.source) return;
  S.loading = true;
  S.listError = null;
  showListLoading();
  try {
    const page = await fetchPage(1, S.child);
    S.items = page.items || [];
    S.page = 1;
    S.next = page.nextCursor || "";
    resetGrid();
    appendCards(0);
  } catch (e) {
    log("LIST FAIL", errText(e));
    S.items = [];
    S.next = "";
    resetGrid();
    S.listError = errorInfo("list", e);
    showListError(S.listError, () => loadItems());
  } finally {
    S.loading = false;
    setStatus();
  }
}

async function loadMore() {
  if (S.loading || !S.next) return;
  const more = Number(S.next);
  S.loading = true;
  try {
    const page = await fetchPage(more, S.child);
    const before = S.items.length;
    S.items = S.items.concat(page.items || []);
    S.next = page.nextCursor || "";
    appendCards(before);
  } catch (e) {
    // 翻页失败不该把已经看到的内容清掉:停掉自动翻页,给一个可点的提示
    log("LIST MORE FAIL", errText(e));
    S.next = "";
    showLoadMoreError(errorInfo("list", e), () => {
      S.next = String(more);
      loadMore();
    });
  } finally {
    S.loading = false;
  }
}

async function doSearch() {
  const q = ($("q").value || "").trim();
  if (!q) return loadItems();
  S.loading = true;
  S.listError = null;
  showListLoading();
  try {
    const page = await fetchSearch(q, 1);
    S.items = page.items || [];
    S.next = "";
    resetGrid();
    appendCards(0);
  } catch (e) {
    log("SEARCH FAIL", errText(e));
    S.items = [];
    S.next = "";
    resetGrid();
    S.listError = errorInfo("search", e);
    showListError(S.listError, () => doSearch());
  } finally {
    S.loading = false;
    setStatus();
  }
}

async function openDetail(item) {
  log("openDetail", item && item.title);
  if (item) S.detailItem = item;
  showView("detail");
  $("v-detail").innerHTML = DETAIL_SKELETON;
  try {
    const d = await fetchDetail(item.id);
    S.detailId = d.id || item.id;
    renderDetail(d);
    return d;
  } catch (e) {
    log("DETAIL FAIL", errText(e));
    showDetailError(errorInfo("detail", e), item);
    throw e;
  }
}

// ---------- 三态:加载(骨架屏)/ 空 / 错误 ----------
// 空屏是最糟的状态:用户既不知道发生了什么,也没法重试。这里把"哪一步失败"
// "网络还是源不支持""原始错误"都摆出来,并给出对应的下一步操作。

const STEP_LABEL = {
  source: "读源列表",
  list: "取列表",
  search: "搜索",
  detail: "取详情",
  stream: "取流",
};

function errText(e) {
  if (!e) return "未知错误";
  if (typeof e === "string") return e;
  if (e.message) return String(e.message);
  return String(e);
}

/** 导入进来的 iplayr HTML 爬取配置:地址不是接口,天然取不到数据 */
function isCrawlSource(src) {
  if (!src) return false;
  if (isPluginSource(src)) return false;
  const kind = srcKind(src);
  if (kind === "xml" || kind === "webox") return false;
  const url = String(src.url || "").toLowerCase();
  if (!/^https?:/.test(url)) return false;
  const host = url.split("://")[1].split(/[/?#]/)[0];
  if (host.indexOf("raw.githubusercontent.com") >= 0) return true;
  return url.split(/[?#]/)[0].endsWith(".json");
}

/**
 * 一次失败 → 给用户看的三句话:哪一步失败、是网络还是源不支持、原始错误。
 * 网络类错误给重试,源不支持类错误提示换源。
 */
function errorInfo(step, e) {
  const raw = errText(e);
  let kind = "unknown";
  if ((step === "list" || step === "search" || step === "detail") && isCrawlSource(S.source)) {
    kind = "unsupported";
  }
  if (kind !== "unsupported") {
    if (/^\s*network\b|请求失败|超时|timed out|timeout|dns|connect|unreachable|reset|eof|读响应失败|failed to fetch|networkerror/i.test(raw)) {
      kind = "network";
    } else if (/^\s*(invalid_response|not_found)|解析失败|不是合法|返回的是网页|不支持|白名单|看起来是 xml|no_boa|manifestparsing|unknown/i.test(raw)) {
      kind = "unsupported";
    }
  }
  const label = STEP_LABEL[step] || "请求";
  let title;
  let hint;
  if (kind === "unsupported") {
    title = label + "失败:这个源给不出可用的数据";
    hint =
      step === "detail" || step === "list" || step === "search"
        ? "看起来它不是点播接口(可能是 HTML 爬取配置,或者站点改版了)。去「设置 → 源」换一个源,或修正它的地址。"
        : "这个源没给出可播放的流。换一条线路,或者换源试试。";
  } else if (kind === "network") {
    title = label + "失败:网络没通";
    hint = "源站连不上或超时了。检查网络后重试;一直不行就换个源。";
  } else {
    title = label + "失败";
    hint = "可以先重试一次;反复失败就换个源。";
  }
  return { step, kind, raw, title, hint };
}

/** 空/错误共用的状态卡片;按钮通过 data-act 交给调用方绑定 */
function stateCard(o) {
  const acts = (o.actions || [])
    .map(
      (a) =>
        '<button class="btn-soft" data-act="' + esc(a.id) + '"' +
        (a.primary ? ' data-primary="1"' : "") + ">" + esc(a.label) + "</button>"
    )
    .join("");
  return (
    '<div class="m3e-card m3e-card--outlined state' + (o.error ? " state--error" : "") + '">' +
      '<span class="m3e-icon state__icon">' + esc(o.icon || "inbox") + "</span>" +
      '<div class="state__title">' + esc(o.title) + "</div>" +
      (o.msg ? '<div class="state__msg">' + esc(o.msg) + "</div>" : "") +
      (acts ? '<div class="state__acts">' + acts + "</div>" : "") +
      (o.raw
        ? '<details class="state__raw"><summary>原始错误</summary><pre>' + esc(o.raw) + "</pre></details>"
        : "") +
    "</div>"
  );
}

/** 出错时的"去换源":切到设置页,并推入「源」二级页 */
function openSourceManager() {
  showView("settings");
  openSetPage("src");
}

// ---------- 渲染 ----------

/* ---------- 顶栏切源:按类型分组 + 最近使用 + 搜索 ---------- */
// <840 用 m3e bottom sheet(见 ui/sheet.js),≥840 挂进侧栏的弹出层(ui/src-panel.js
// 是同一份内容)。当前源置顶到所属分组第一行;「最近使用」最多 3 个(LRU),
// 允许与下方分组重复 —— 重复是有意的,为了缩短拇指行程。

const RECENT_KEY = "reelbox.recentSources";
const RECENT_MAX = 3;
let srcMenuCloser = null; // 关掉当前这层容器(sheet.close / 去掉 data-open)

function recentIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch (_) {
    return [];
  }
}

function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch (_) {}
}

function pushRecent(id) {
  if (!id) return;
  saveRecent([id].concat(recentIds().filter((x) => x !== id)));
}

function dropRecent(id) {
  saveRecent(recentIds().filter((x) => x !== id));
}

/** 健康状态 → 四态 + 文案(判定口径见 docs/DESIGN-SPEC-UI.md §2.5) */
function fmtMs(ms) {
  const n = Number(ms || 0);
  return n >= 1000 ? (n / 1000).toFixed(1) + "s" : Math.round(n) + "ms";
}

function healthOf(src) {
  if (src && src._testing) return { state: "testing", label: "测速中…" };
  const h = src && src.health;
  if (!h) return { state: "untested", label: "未测速" };
  if (!h.ok) return { state: "fail", label: "连接失败" + (h.error ? " · " + h.error : "") };
  const ms = Number(h.ms || 0);
  if (ms < 800) return { state: "ok", label: "正常 · " + fmtMs(ms) };
  if (ms <= 2000) return { state: "slow", label: "偏慢 · " + fmtMs(ms) };
  return { state: "slow", label: "偏慢 · " + fmtMs(ms) };
}

function srcTypeIcon(s) {
  const t = sourceType(s);
  if (t === "plugin") return "extension";
  if (t === "live") return "live_tv";
  return "ondemand_video";
}

/** 组好切源面板需要的数据(分组、当前源置顶、最近使用、搜索过滤) */
function srcPanelModel(query) {
  const q = String(query || "").trim().toLowerCase();
  const all = S.sources || [];
  const hit = (s) => !q || (String(s.name) + " " + String(s.url)).toLowerCase().indexOf(q) >= 0;
  const toRow = (s) => {
    const h = healthOf(s);
    return {
      id: s.id,
      name: s.name,
      icon: srcTypeIcon(s),
      current: !!(S.source && S.source.id === s.id),
      state: h.state,
      stateLabel: h.label,
    };
  };
  const groups = [
    ["vod", "点播"],
    ["plugin", "插件"],
    ["live", "直播"],
  ].map(([key, label]) => {
    const rows = all.filter((s) => sourceType(s) === key && hit(s)).map(toRow);
    // 当前源置顶到所属分组第一行
    rows.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
    return { key, label, rows };
  });
  const recent = recentIds()
    .map((id) => all.find((s) => s.id === id))
    .filter((s) => s && hit(s))
    .slice(0, RECENT_MAX)
    .map(toRow);
  return { groups, recent, total: all.length, query: query || "", empty: !all.length };
}

/** 渲染 + 事件;host 可以是 sheet 内容容器,也可以是桌面弹出层 */
function mountSrcPanel(host, query) {
  const el = buildSrcPanel(srcPanelModel(query));
  host.innerHTML = "";
  host.appendChild(el);

  el.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="manage"]')) {
      closeSrcMenu();
      openSourceManager();
      return;
    }
    if (e.target.closest('[data-act="add"]')) {
      closeSrcMenu();
      editSource(null);
      return;
    }
    const row = e.target.closest("[data-src]");
    if (!row) return;
    const src = (S.sources || []).find((s) => s.id === row.getAttribute("data-src"));
    if (!src) return;
    // 选中后立刻走关闭动效(149ms),不等它结束就开始切源
    closeSrcMenu();
    if (!S.source || src.id !== S.source.id) switchSource(src);
  });

  const input = el.querySelector('[data-act="query"]');
  if (input) {
    input.addEventListener("input", () => {
      const v = input.value;
      mountSrcPanel(host, v);
      const again = host.querySelector('[data-act="query"]');
      if (again) {
        again.focus();
        again.setSelectionRange(v.length, v.length);
      }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") return;
      if (e.key === "Enter") {
        const first = el.querySelector("[data-src]");
        if (first) first.click();
      }
    });
  }
}

function closeSrcMenu() {
  if (srcMenuCloser) {
    const fn = srcMenuCloser;
    srcMenuCloser = null;
    fn();
  }
  const menu = $("srcMenu");
  if (menu) menu.removeAttribute("data-open");
}

function srcMenuOpen() {
  const menu = $("srcMenu");
  return !!(menu && menu.hasAttribute("data-open")) || !!srcMenuCloser;
}

/** 切源面板重画:只在它正开着的时候做事 */
function renderSources() {
  const menu = $("srcMenu");
  if (!menu) return;
  if (menu.hasAttribute("data-open")) mountSrcPanel(menu, "");
  else if (srcMenuCloser) {
    // sheet 开着:重新挂一份内容进同一个容器
    const host = document.querySelector("#appSheet .m3e-bottom-sheet__content");
    if (host) mountSrcPanel(host, "");
  }
}

function openSrcMenu() {
  const wide = window.matchMedia("(min-width: 840px)").matches;
  const menu = $("srcMenu");
  if (wide) {
    mountSrcPanel(menu, "");
    const r = $("srcBtn").getBoundingClientRect();
    menu.style.left = Math.max(8, Math.round(r.left)) + "px";
    menu.style.top = Math.round(r.bottom + 6) + "px";
    menu.setAttribute("data-open", "");
    srcMenuCloser = () => menu.removeAttribute("data-open");
    return;
  }
  const panel = document.createElement("div");
  mountSrcPanel(panel, "");
  const sheet = openSheet({ content: panel, label: "切换源" });
  srcMenuCloser = () => sheet.close();
}
function renderParents() {
  const side = $("catlist");
  side.innerHTML =
    '<button class="cat" data-parent="" aria-selected="' + (S.parent === "" ? "true" : "false") + '">全部</button>' +
    S.parents
      .map(
        (p) =>
          '<button class="cat" data-parent="' + esc(p.value) + '" data-label="' + esc(p.label) +
          '" aria-selected="' + (S.parent === p.value ? "true" : "false") + '">' + esc(p.label) + "</button>"
      )
      .join("");

  const tabs = $("cattabs");
  tabs.innerHTML =
    '<button class="cattab" data-parent="" aria-selected="' + (S.parent === "" ? "true" : "false") + '">全部</button>' +
    S.parents
      .map(
        (p) =>
          '<button class="cattab" data-parent="' + esc(p.value) + '" aria-selected="' +
          (S.parent === p.value ? "true" : "false") + '">' + esc(p.label) + "</button>"
      )
      .join("");
}

function renderChildren() {
  const box = $("childchips");
  const kids = S.children[S.parent] || [];
  if (!S.parent || !kids.length) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  box.style.display = "";
  box.innerHTML = kids
    .map(
      (c) =>
        '<label class="m3e-filter-chip" data-child="' + esc(c.value) + '">' +
        '<input class="m3e-filter-chip__input" type="checkbox"' + (S.child === c.value ? " checked" : "") + ">" +
        '<span class="m3e-filter-chip__leading"><span class="m3e-filter-chip__check"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9.6 17.3 4.8 12.5l1.4-1.4 3.4 3.4 8.2-8.2 1.4 1.4z" fill="currentColor"/></svg></span></span>' +
        '<span class="m3e-filter-chip__label">' + esc(c.label) + "</span></label>"
    )
    .join("");
}

function posterFor(url) {
  const cached = S.blobs.get(url);
  if (cached) return Promise.resolve(cached);
  return invoke("poster", { url }).then((buf) => {
    const u = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: "image/jpeg" }));
    S.blobs.set(url, u);
    return u;
  });
}

// 从 from 开始把 items 追加到网格;已存在的卡片不动,所以滚动不会重载图片。
function appendCards(from) {
  const grid = $("grid");
  const el = $("empty");
  el.style.display = "none";
  el.innerHTML = "";
  if (!S.items.length) {
    if (!S.loading) showListEmpty();
    return;
  }
  const frag = document.createElement("div");
  frag.innerHTML = S.items
    .slice(from)
    .map(
      (it, k) =>
        '<article class="card" data-i="' + (from + k) + '"><div class="poster">' +
        (it.subtitle ? '<span class="badge">' + esc(it.subtitle) + "</span>" : "") +
        '</div><div class="meta"><b>' + esc(it.title) + "</b></div></article>"
    )
    .join("");
  const added = Array.from(frag.children);
  added.forEach((el) => grid.appendChild(el));

  added.forEach((el, k) => {
    const it = S.items[from + k];
    if (!it || !it.poster) return;
    const box = el.querySelector(".poster");
    posterFor(it.poster)
      .then((u) => {
        const img = document.createElement("img");
        img.alt = "";
        img.src = u;
        box.classList.add("has-img");
        box.prepend(img);
      })
      .catch(() => {});
  });
}

function resetGrid() {
  clearSkeleton();
  $("grid").innerHTML = "";
}

function renderDetail(d) {
  const summary = (d.summary || "").replace(/[\s\u3000]+/g, " ").trim();
  S.detailTitle = d.title;
  S.detailId = d.id || S.detailId || "";
  S.detailGroups = d.groups || []; // 播放失败时"换线路"要用
  S.detailEps = [];
  d.groups.forEach((g) =>
    g.episodes.forEach((e) => S.detailEps.push({ id: e.id, name: e.name, group: e.group || g.id }))
  );
  const rec = progGet(detailKey());
  const resumeBtn =
    resumeOn() && rec && rec.id
      ? '<button class="resume" id="btnResume">继续观看 · ' + esc(rec.name || "") + " · " + fmtTime(rec.t) + "</button>"
      : "";
  const groups = d.groups
    .map(
      (g, gi) =>
        '<section class="epgroup"><h4>' +
        esc(/[\u4e00-\u9fa5]/.test(g.name) ? g.name : "线路 " + (gi + 1)) +
        '</h4><div class="epgrid">' +
        g.episodes
          .map(
            (e) =>
              '<button class="chip-ep" data-id="' + esc(e.id) + '" data-group="' +
              esc(e.group || g.id) + '">' + esc(e.name) + "</button>"
          )
          .join("") +
        "</div></section>"
    )
    .join("");

  $("v-detail").innerHTML =
    '<div class="detail-wrap">' +
      '<button class="back" id="btnBack" aria-label="返回">' +
        '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z" fill="currentColor"/></svg>' +
      "</button>" +
      '<div class="detail-top">' +
        '<div class="hero"><img alt=""></div>' +
        '<div class="hero-meta">' +
          "<h2>" + esc(d.title) + "</h2>" +
          (summary ? '<p id="sum">' + esc(summary) + "</p>" : "") +
          (summary.length > 90 ? '<button class="more" id="btnMore">展开</button>' : "") +
        "</div>" +
      "</div>" +
      resumeBtn +
      (groups || '<p class="noep">这个源没给剧集列表</p>') +
    "</div>";

  $("btnBack").onclick = () => showView("home");

  const btnResume = $("btnResume");
  if (btnResume)
    btnResume.onclick = () => {
      const r = progGet(detailKey());
      if (r && r.id) playEpisode(r.id, r.name, r.group || "");
    };

  const more = $("btnMore");
  if (more)
    more.onclick = () => {
      const p = $("sum");
      const open = p.classList.toggle("open");
      more.textContent = open ? "收起" : "展开";
    };

  if (d.poster) {
    posterFor(d.poster)
      .then((u) => {
        const img = $("v-detail").querySelector(".hero img");
        if (!img) return;
        img.src = u;
        img.parentElement.classList.add("has-img");
      })
      .catch(() => {});
  }

  $("v-detail").querySelectorAll(".chip-ep").forEach((b) => {
    b.onclick = () =>
      playEpisode(b.getAttribute("data-id"), b.textContent, b.getAttribute("data-group") || "");
  });
}

let hls = null;
let playCtx = null;
let idleTimer = 0;
let tickTimer = 0;
let dragging = false;

/* ---------- 播放进度 ---------- */

/* ---------- 设置 → 源 ---------- */
const INDEX_URL = "https://ddgksf2013.top/webox/index.json";

function normSource(raw) {
  const url = (raw.url || raw.api || "").trim();
  const name = (raw.name || raw.key || "").trim();
  if (!url || !name) return null;
  const kindRaw = raw.kind || raw.type;
  const kind = kindRaw === "xml" || kindRaw === 1 ? "xml" : "vod";
  const id = (raw.id || name).toString().toLowerCase().replace(/[^a-z0-9_-]+/gi, "-").slice(0, 24) || "src";
  return { id: id, name: name, kind: kind, url: url };
}

function uniqSources(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const src = normSource(item);
    if (!src) continue;
    const key = src.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(src);
  }
  return out;
}

/** 源的 kind:后端序列化叫 type,早期前端写的是 kind,两个都认 */
function srcKind(s) {
  return String((s && (s.type || s.kind)) || "").toLowerCase();
}

/** 三类源:v0.2 只跑得动点播(插件另走沙箱),直播只保存不播放 */
function sourceType(s) {
  if (!s) return "vod";
  const kind = srcKind(s);
  const url = String(s.url || "");
  if (isPluginSource(s)) return "plugin";
  if (kind === "live" || /\.m3u8?$/i.test(url.split(/[?#]/)[0])) return "live";
  return "vod";
}

/** 徽标文案只说"这源怎么播":点播 / 插件 / 直播 */
function sourceKindLabel(s) {
  const t = sourceType(s);
  if (t === "plugin") return "插件";
  if (t === "live") return "直播";
  return "点播";
}

/** 技术子类型不进徽标,只出现在「更多」菜单首行与编辑对话框 */
function sourceTechLabel(s) {
  const t = sourceType(s);
  const path = String((s && s.url) || "").split(/[?#]/)[0].toLowerCase();
  if (t === "plugin") return path.endsWith(".reelbox.js") ? ".reelbox.js" : ".webox.js";
  if (t === "live") return path.endsWith(".m3u") ? "m3u" : "m3u8";
  return srcKind(s) === "xml" ? "XML" : "JSON";
}

/** 状态点:形状 + 颜色双通道(样式见 index.html 的 .status-dot 四态) */
function statusDotHtml(src) {
  const h = healthOf(src);
  return (
    '<span class="status-dot" data-state="' + esc(h.state) + '" role="img" aria-label="' +
      esc(h.label) + '" title="' + esc(h.label) + '"></span>'
  );
}

/** 源列表:m3e list item,每项 = 名称 / 类型 / 地址 + 右侧状态点与「更多」 */
function renderSourceManager() {
  const box = $("srcmgr");
  if (!box) return;
  const all = S.sources || [];
  const list = S.srcFilter === "all" ? all : all.filter((s) => sourceType(s) === S.srcFilter);
  if (!all.length) {
    box.innerHTML = '<p class="hint">还没有源。下面「添加源」或「网络导入」都行。</p>';
    return;
  }
  if (!list.length) {
    box.innerHTML =
      '<p class="hint">这个类型下还没有源。点下面的「添加源」加一个,或者切回「全部」。</p>';
    return;
  }
  box.innerHTML = list
    .map((s) => {
      const active = !!(S.source && S.source.id === s.id);
      const crawl = isCrawlSource(s);
      return (
        '<div class="m3e-list-item" data-id="' + esc(s.id) + '"' + (active ? ' data-active="1"' : "") + ">" +
          '<span class="m3e-list-item__leading"><span class="m3e-icon" aria-hidden="true">' +
            (isPluginSource(s) ? "extension" : "dns") + "</span></span>" +
          '<span class="m3e-list-item__content">' +
            '<span class="m3e-list-item__headline">' + esc(s.name) +
              '<span class="src-badge">' + sourceKindLabel(s) + "</span>" +
              (crawl
                ? '<span class="src-badge src-badge--warn" title="地址是 HTML 爬取配置,不是点播接口">取不到数据</span>'
                : "") +
            "</span>" +
            '<span class="m3e-list-item__supporting">' + esc(s.url) + "</span>" +
          "</span>" +
          '<span class="m3e-list-item__trailing">' +
            statusDotHtml(s) +
            '<button type="button" class="m3e-icon-button m3e-icon-button--standard" data-act="more" data-id="' +
              esc(s.id) + '" aria-haspopup="menu" aria-label="更多 · ' + esc(s.name) + '">' +
              '<span class="m3e-icon" aria-hidden="true">more_vert</span></button>' +
          "</span>" +
        "</div>"
      );
    })
    .join("");
}

/** 行「更多」菜单:编辑 / 测试连接 / 设为当前 / 置顶 / 复制地址 / 删除 */
function openSourceRowMenu(src, anchor) {
  const active = !!(S.source && S.source.id === src.id);
  const firstInList = (S.sources || []).findIndex((s) => s.id === src.id) === 0;
  return openMenu(
    anchor,
    [
      { type: "label", label: sourceKindLabel(src) + " · " + sourceTechLabel(src) },
      { id: "edit", label: "编辑", icon: "edit" },
      {
        id: "current",
        label: active ? "已设为当前源" : "设为当前",
        icon: "check",
        checked: active,
        disabled: active,
      },
      { id: "pin", label: "置顶", icon: "vertical_align_top", disabled: firstInList },
      { id: "copy", label: "复制地址", icon: "content_copy" },
      { divider: true },
      { id: "del", label: "删除", icon: "delete", danger: true },
    ],
    (id) => onSourceRowAction(id, src)
  );
}

async function onSourceRowAction(id, src) {
  if (id === "edit") return editSource(src);
  if (id === "current") return setCurrentSource(src);
  if (id === "pin") return pinSource(src);
  if (id === "copy") return copySourceUrl(src);
  if (id === "del") return removeSource(src.id);
}

/** 设为当前:走统一的 switchSource(会写 recent 与 currentSource) */
async function setCurrentSource(src) {
  if (S.source && S.source.id === src.id) return;
  await switchSource(src);
  renderSourceManager();
  toast("已切换到「" + src.name + "」");
}

/** 置顶 = 把它挪到列表第一个,顺序本身要落盘 */
async function pinSource(src) {
  const list = (S.sources || []).filter((s) => s.id !== src.id);
  if (list.length === (S.sources || []).length) return;
  S.sources = [src].concat(list);
  await persistSources();
  renderSourceManager();
  renderSources();
  toast("已置顶「" + src.name + "」");
}

async function copySourceUrl(src) {
  const ok = await copyText(src.url);
  if (ok) toast("地址已复制");
  else alertDialog("复制失败", "这个环境的剪贴板不可用。地址是:" + src.url);
}

/** 复制到剪贴板:先试 navigator.clipboard,失败退回 textarea + execCommand */
async function copyText(text) {
  const s = String(text == null ? "" : text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (_) {
    /* 没权限:走下面的退路 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch (_) {
    return false;
  }
}

async function persistSources() {
  try {
    await invoke("save_sources", { list: S.sources });
    log("sources saved", String(S.sources.length));
  } catch (e) {
    log("SOURCES SAVE FAIL", errText(e));
    toast("保存源列表失败:" + errText(e), { dismissible: true });
  }
}

/** 新增 / 编辑源:一个 m3e 对话框,三个字段 */
async function editSource(src) {
  const res = await formDialog({
    icon: "dns",
    headline: src ? "编辑源" : "添加源",
    okText: "保存",
    fields: [
      { id: "name", label: "名称", value: src ? src.name : "", placeholder: "例如 我的源" },
      {
        id: "url",
        label: "接口地址",
        value: src ? src.url : "",
        placeholder: "https://xxx/api.php/provide/vod",
      },
      {
        id: "kind",
        label: "类型",
        type: "select",
        value: src && String(src.kind) === "xml" ? "xml" : "vod",
        options: [
          { value: "vod", label: "JSON(vod)" },
          { value: "xml", label: "XML" },
        ],
      },
    ],
    note: "地址以 .json 结尾的多半是 HTML 爬取配置,不是点播接口,取不到数据。",
  });
  if (!res) return;
  const src2 = normSource({ name: res.name, url: res.url, kind: res.kind });
  if (!src2) return;
  const list = S.sources.slice();
  if (src) {
    const i = list.findIndex((x) => x.id === src.id);
    if (i >= 0) list[i] = Object.assign({}, src2, { id: src.id });
    else list.push(src2);
  } else {
    if (list.some((x) => x.url === src2.url)) {
      toast("这个地址已经加过了");
      return;
    }
    list.push(src2);
  }
  S.sources = list;
  await persistSources();
  renderSourceManager();
  renderSources();
  toast(src ? "已保存「" + src2.name + "」" : "已添加「" + src2.name + "」");
}

async function removeSource(id) {
  const src = (S.sources || []).find((x) => x.id === id);
  if (!src) return;
  const ok = await confirmDialog(
    "删除源「" + src.name + "」?",
    "删掉之后可以在「添加源」里重新加回来。",
    "删除",
    true
  );
  if (!ok) return;
  const list = S.sources.filter((x) => x.id !== id);
  if (!list.length) {
    toast("至少得留一个源");
    return;
  }
  S.sources = list;
  dropRecent(id); // 删掉的源不该再出现在「最近使用」里
  await persistSources();
  renderSourceManager();
  renderSources();
  toast("已删除「" + src.name + "」");
  if (S.source && S.source.id === id) await switchSource(list[0]);
}

/** 网络导入:跳过的 iplayr 爬取配置要明说,不能静默丢 */
async function importFromIndex() {
  const url = await promptDialog("网络导入源", "索引地址", INDEX_URL, "https://.../index.json", "导入");
  if (!url) return;
  try {
    const res = await invoke("import_index", { url });
    // 兼容旧返回(纯数组)
    const list = (res && res.sources) || (Array.isArray(res) ? res : []);
    const skipped = (res && res.skipped) || 0;
    const skippedNames = (res && res.skipped_names) || [];
    if (!list.length && !skipped) {
      toast("索引里没有可用的源");
      return;
    }
    const have = new Set(S.sources.map((x) => x.url));
    const fresh = list.filter((x) => !have.has(x.url));
    const dup = list.length - fresh.length;
    S.sources = S.sources.concat(fresh);
    await persistSources();
    renderSourceManager();
    renderSources();
    log(
      "index imported",
      "new=" + fresh.length,
      "dup=" + dup,
      "skipped=" + skipped,
      skippedNames.join(",")
    );
    let msg = "新增 " + fresh.length + " 个,跳过 " + skipped + " 个不支持的源";
    if (dup) msg += "(重复 " + dup + " 个)";
    toast(msg, {
      actionLabel: skipped ? "看详情" : "",
      onAction: () =>
        alertDialog(
          "跳过了 " + skipped + " 个源",
          (skippedNames.length ? skippedNames.join("、") : "这些源") +
            " 指向的是 HTML 爬取配置(iplayr 那种),不是点播接口地址,导进来也取不到数据,所以没有导入。",
          "知道了"
        ),
    });
  } catch (e) {
    log("INDEX IMPORT FAIL", errText(e));
    alertDialog("导入失败", errText(e));
  }
}

async function importPluginFile(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const res = await invoke("save_plugin", { fileName: f.name, text: text });
    const exists = S.sources.some((x) => x.id === res.id);
    if (!exists) {
      S.sources = S.sources.concat([{ id: res.id, name: res.name, kind: "webox", url: res.path }]);
      await persistSources();
    }
    renderSourceManager();
    renderSources();
    log("plugin imported", res.id);
    toast("已导入插件:" + res.name);
  } catch (err) {
    log("PLUGIN IMPORT FAIL", errText(err));
    alertDialog("导入插件失败", errText(err));
  } finally {
    e.target.value = "";
  }
}

async function importJsonFile(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const data = JSON.parse(text);
    const raw = Array.isArray(data) ? data : data.sites || data.sources || [];
    const merged = uniqSources(S.sources.concat(raw.map(normSource).filter(Boolean)));
    if (!merged.length) throw new Error("没有识别到可用的源");
    const added = merged.length - S.sources.length;
    S.sources = merged;
    await persistSources();
    renderSourceManager();
    renderSources();
    log("sources imported", String(merged.length));
    toast("已导入,新增 " + Math.max(0, added) + " 个,当前共 " + merged.length + " 个源");
  } catch (err) {
    log("IMPORT FAIL", errText(err));
    alertDialog("导入失败", errText(err));
  } finally {
    e.target.value = "";
  }
}

let srcRowMenuAnchor = null; // 当前打开「更多」的按钮(再点同一个算收起)

function bindSourceManager() {
  const box = $("srcmgr");
  if (box && !box.dataset.bound) {
    box.dataset.bound = "1";
    box.onclick = (e) => {
      const b = e.target.closest("button[data-act]");
      if (b) {
        const act = b.getAttribute("data-act");
        const id = b.getAttribute("data-id");
        const src = (S.sources || []).find((x) => x.id === id);
        if (!src) return;
        // 再点同一个「更多」= 收起来
        if (act === "more") {
          if (menuOpen() && srcRowMenuAnchor === b) {
            closeMenu();
            return;
          }
          srcRowMenuAnchor = b;
          openSourceRowMenu(src, b);
          return;
        }
        if (act === "edit") return editSource(src);
        if (act === "del") return removeSource(id);
        return;
      }
      // 点整行 = 切到那个源
      const row = e.target.closest(".m3e-list-item[data-id]");
      if (!row) return;
      const src = S.sources.find((x) => x.id === row.getAttribute("data-id"));
      if (src && (!S.source || src.id !== S.source.id)) {
        renderSources();
        switchSource(src);
      }
    };
  }
  if ($("srcAdd") && !$("srcAdd").dataset.bound) {
    $("srcAdd").dataset.bound = "1";
    $("srcAdd").onclick = () => editSource(null);
    $("srcIndex").onclick = importFromIndex;
    $("srcImport").onclick = () => $("srcFile").click();
    $("srcPlugin").onclick = () => $("pluginFile").click();
    $("pluginFile").onchange = importPluginFile;
    $("srcFile").onchange = importJsonFile;
  }
}

/* ---------- 日志:内存环形缓冲 + 落盘 ---------- */
const LOG_MAX = 300;
const LOG_BUF = [];
const NL = String.fromCharCode(10);

/** 签名地址动辄几百字符,日志里只留开头 */
function shortUrl(u, n) {
  const s = String(u == null ? "" : u);
  const max = n || 120;
  return s.length > max ? s.slice(0, max) + "…(" + s.length + ")" : s;
}

function log() {
  const t = new Date().toISOString().slice(11, 19);
  const line = t + " " + Array.prototype.map.call(arguments, String).join(" ");
  LOG_BUF.push(line);
  if (LOG_BUF.length > LOG_MAX) LOG_BUF.shift();
  try {
    invoke("append_log", { line: line }).catch((e) => { LOG_BUF.push("LOGFAIL " + e); });
  } catch (e) { LOG_BUF.push("LOGFAIL " + e); }
  const box = document.getElementById("dbg");
  if (box && !box.hidden) { box.textContent = LOG_BUF.join(NL); box.scrollTop = box.scrollHeight; }
}

/** 噪音行(播放/探测细节):只有开了「详细日志」才记 */
function logv() {
  if (!debugOn()) return;
  log.apply(null, arguments);
}

const DEBUG_KEY = "reelbox.debug";

function debugOn() {
  try { return localStorage.getItem(DEBUG_KEY) === "1"; } catch (_) { return false; }
}

function setDebug(on) {
  try { localStorage.setItem(DEBUG_KEY, on ? "1" : "0"); } catch (_) {}
  const box = document.getElementById("dbg");
  if (box && !on) box.hidden = true;
  syncDebugButtons();
  log("debug", on ? "on" : "off");
}

/** 调试浮标:右下角那颗按钮(和「详细日志」是两件事) */
function fabOn() {
  try { return localStorage.getItem("reelbox.debugFab") !== "0"; } catch (_) { return true; }
}

function setFab(on) {
  try { localStorage.setItem("reelbox.debugFab", on ? "1" : "0"); } catch (_) {}
  syncDebugButtons();
}

function syncDebugButtons() {
  const seg = document.getElementById("segDebug");
  if (seg) {
    const on = debugOn() ? "1" : "0";
    seg.querySelectorAll("button").forEach((b) => {
      b.setAttribute("aria-selected", b.getAttribute("data-debug") === on ? "true" : "false");
    });
  }
  const fab = document.getElementById("dbgFab");
  if (fab) fab.hidden = !fabOn();
  const sw = document.getElementById("swFab");
  if (sw) sw.checked = fabOn();
}

function bindDebugToggle() {
  const fab = document.getElementById("dbgFab");
  if (fab && !fab.dataset.bound) {
    fab.dataset.bound = "1";
    fab.onclick = () => toggleDebug();
  }
  const seg = document.getElementById("segDebug");
  if (seg && !seg.dataset.bound) {
    seg.dataset.bound = "1";
    seg.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      setDebug(b.getAttribute("data-debug") === "1");
    };
  }
  syncDebugButtons();
}

function showDebugPanel(on) {
  const box = document.getElementById("dbg");
  if (!box) return;
  box.hidden = !on;
  if (on) {
    box.textContent = LOG_BUF.join(NL);
    box.scrollTop = box.scrollHeight;
  }
}

function toggleDebug() {
  const box = document.getElementById("dbg");
  if (!box) return;
  showDebugPanel(box.hidden);
}

/* ---------- 播放偏好(设置 → 播放) ---------- */
// 三个开关都真的作用到播放器上:清晰度 → hls/插件档位,自动连播 → onended,
// 进度记忆 → saveProgress / resume。

function prefGet(key, dflt) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v;
  } catch (_) {
    return dflt;
  }
}

function prefSet(key, val) {
  try { localStorage.setItem(key, val); } catch (_) {}
}

function qualityPref() { return prefGet("reelbox.quality", "auto"); }   // auto | high
function autoplayOn() { return prefGet("reelbox.autoplay", "1") === "1"; }
function resumeOn() { return prefGet("reelbox.resume", "1") === "1"; }

function syncPlaySettings() {
  const seg = $("segQuality");
  if (seg) {
    seg.querySelectorAll("button").forEach((b) => {
      b.setAttribute("aria-selected", b.getAttribute("data-q") === qualityPref() ? "true" : "false");
    });
  }
  const a = $("swAutoplay");
  if (a) a.checked = autoplayOn();
  const r = $("swResume");
  if (r) r.checked = resumeOn();
}

/* ---------- 设置:入口列表 + 二级页 ---------- */
// 设置首页是入口列表(每行写"当前值"),点进去是整屏二级页。
// ≥840 走 master-detail(左列 336 固定),<840 走 push(整屏 + 返回箭头)。
// 二级页位置不记忆:每次进设置都回到入口列表(expanded 下默认落在「源」)。

const SET_PAGES = [
  { key: "src", icon: "dns", title: "源", group: 0 },
  { key: "play", icon: "play_circle", title: "播放", group: 0 },
  { key: "look", icon: "palette", title: "外观", group: 0 },
  { key: "debug", icon: "terminal", title: "调试", group: 1 },
  { key: "about", icon: "info", title: "关于", group: 1 },
];

const VARIANT_LABEL = {
  tonal: "标准", vibrant: "鲜明", expressive: "表现型", neutral: "柔和", mono: "单色",
};

let APP_INFO = null;
let setPage = "";

function themeSeedLabel() {
  const hit = SEEDS.find((s) => s.id === themeState.seed);
  return hit ? hit.label : "自定义";
}

/** 设置首页每行的"当前值":写值,不写功能名 */
function setSummary(key) {
  if (key === "src") {
    const list = S.sources || [];
    if (!list.length) return "未添加,点进去加一个";
    const live = list.filter((s) => sourceType(s) === "live").length;
    const name = S.source ? S.source.name : "未选源";
    return name + " · " + list.length + " 源" + (live ? " · 直播 " + live : "");
  }
  if (key === "play") {
    return (qualityPref() === "high" ? "最高" : "自动") + " · 连播" + (autoplayOn() ? "开" : "关");
  }
  if (key === "look") {
    const dark = isDark();
    const mode = dark ? (themeState.pureBlack ? "纯黑" : "深色") : "浅色";
    return mode + " · " + themeSeedLabel() + " · " + (VARIANT_LABEL[themeState.variant] || "标准");
  }
  if (key === "debug") {
    return "日志" + (debugOn() ? "开" : "关") + " · 浮标" + (fabOn() ? "开" : "关");
  }
  if (key === "about") {
    return APP_INFO ? "v" + APP_INFO.version + " · 契约 v1" : "读取中…";
  }
  return "";
}

function setEntryHtml(p) {
  return (
    '<button type="button" class="set-entry" data-page="' + p.key + '" data-sum="' + p.key + '">' +
      '<span class="set-entry__icon"><span class="m3e-icon" aria-hidden="true">' + p.icon + "</span></span>" +
      '<span class="set-entry__text">' +
        '<span class="set-entry__title">' + esc(p.title) + "</span>" +
        '<span class="set-entry__summary">' + esc(setSummary(p.key)) + "</span>" +
      "</span>" +
      '<span class="m3e-icon set-entry__chevron" aria-hidden="true">chevron_right</span>' +
    "</button>"
  );
}

/** 设置首页(compact / medium)+ 左列(expanded) */
function renderSetHome() {
  const main = $("setGroupMain");
  const low = $("setGroupLow");
  if (main) main.innerHTML = SET_PAGES.filter((p) => p.group === 0).map(setEntryHtml).join("");
  if (low) low.innerHTML = SET_PAGES.filter((p) => p.group === 1).map(setEntryHtml).join("");

  const master = $("setMaster");
  if (master) {
    master.innerHTML = SET_PAGES.map(
      (p) =>
        '<button type="button" class="set-navrow" role="tab" data-page="' + p.key +
        '" aria-selected="' + (setPage === p.key ? "true" : "false") + '">' +
          '<span class="m3e-icon" aria-hidden="true">' + p.icon + "</span>" +
          '<span class="set-navrow__label">' + esc(p.title) + "</span>" +
        "</button>"
    ).join("");
  }
}

/** 只刷新摘要行,不重建 DOM(避免点完一行丢焦点) */
function syncSetSummaries() {
  document.querySelectorAll("[data-sum]").forEach((el) => {
    const key = el.getAttribute("data-sum");
    const box = el.querySelector(".set-entry__summary");
    if (box) box.textContent = setSummary(key);
  });
}

function wideSettings() {
  return window.matchMedia("(min-width: 840px)").matches;
}

/** 打开二级页;key 为空 = 回到入口列表(<840 才有入口列表) */
function openSetPage(key) {
  const page = SET_PAGES.find((p) => p.key === key) ? key : "src";
  setPage = page;
  const shell = $("setShell");
  if (shell) shell.setAttribute("data-page", page);
  // <600 时二级页盖住 floating toolbar(既是 push 语义,也避免压住底栏)
  if (!wideSettings()) document.body.setAttribute("data-setpage", "");
  else document.body.removeAttribute("data-setpage");
  document.querySelectorAll("#setDetail .set-page").forEach((el) => {
    const on = el.getAttribute("data-page") === page;
    if (on) {
      el.setAttribute("data-on", "");
      // push 进入的转场(宽屏并排时不做位移动画)
      if (!wideSettings()) {
        el.setAttribute("data-enter", "");
        setTimeout(() => el.removeAttribute("data-enter"), 400);
      }
    } else {
      el.removeAttribute("data-on");
    }
  });
  document.querySelectorAll("#setMaster [data-page]").forEach((b) => {
    b.setAttribute("aria-selected", b.getAttribute("data-page") === page ? "true" : "false");
  });
  if (page === "src") {
    renderSrcSeg();
    renderSourceManager();
  }
  if (page === "about") fillAbout();
  if (page === "debug") fillLogPath();
  const scroll = document.querySelector('.set-page[data-page="' + page + '"] .set-page__scroll');
  if (scroll) scroll.scrollTop = 0;
}

/** 二级页 → 设置首页;expanded 下入口列表被左列替代,返回等同于落回「源」 */
function closeSetPage() {
  if (wideSettings()) return openSetPage("src");
  setPage = "";
  const shell = $("setShell");
  if (shell) shell.removeAttribute("data-page");
  document.body.removeAttribute("data-setpage");
  document.querySelectorAll("#setDetail .set-page").forEach((el) => el.removeAttribute("data-on"));
  renderSetHome();
}

function fillAbout() {
  if (!APP_INFO) return;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v || "—"; };
  set("aboutVersion", "v" + APP_INFO.version);
  set("aboutBuild", APP_INFO.build);
  set("aboutEngine", APP_INFO.plugin_engine);
  set("aboutSources", APP_INFO.sources_path);
  syncSetSummaries();
}

function fillLogPath() {
  const el = $("logPath");
  if (el) el.textContent = (APP_INFO && APP_INFO.log_path) || "读取中…";
}

async function loadAppInfo() {
  try {
    APP_INFO = await invoke("app_info");
    fillAbout();
    fillLogPath();
    log("app_info", APP_INFO.version + " " + APP_INFO.build);
  } catch (e) {
    log("app_info fail", errText(e));
    const el = $("logPath");
    if (el) el.textContent = "%APPDATA%\\reelbox\\reelbox.log";
  }
}

/** 二级页 app bar:滚动超过 8dp 才加下边线 */
function bindSetScrollLines() {
  document.querySelectorAll(".set-page__scroll").forEach((scroll) => {
    if (scroll.dataset.bound) return;
    scroll.dataset.bound = "1";
    scroll.addEventListener("scroll", () => {
      const bar = scroll.parentElement.querySelector(".set-page__bar");
      if (!bar) return;
      if (scroll.scrollTop > 8) bar.setAttribute("data-scrolled", "");
      else bar.removeAttribute("data-scrolled");
    }, { passive: true });
  });
}

/** 源管理页的分段:全部 / 点播 / 插件 / 直播;选择持久化到 localStorage */
const SRC_FILTERS = [
  { key: "all", label: "全部" },
  { key: "vod", label: "点播" },
  { key: "plugin", label: "插件" },
  { key: "live", label: "直播" },
];

function srcCountByType(key) {
  const list = S.sources || [];
  return key === "all" ? list.length : list.filter((s) => sourceType(s) === key).length;
}

function renderSrcSeg() {
  const box = $("srcSeg");
  if (!box) return;
  box.innerHTML = SRC_FILTERS.map(
    (f) =>
      '<button type="button" role="tab" data-filter="' + f.key + '" aria-selected="' +
      (S.srcFilter === f.key ? "true" : "false") + '">' +
        '<span class="m3e-icon seg__check" aria-hidden="true">check</span>' +
        '<span class="seg__label">' + f.label + "</span>" +
        '<span class="seg__count">' + srcCountByType(f.key) + "</span>" +
      "</button>"
  ).join("");
}

function bindSrcSeg() {
  const box = $("srcSeg");
  if (!box || box.dataset.bound) return;
  box.dataset.bound = "1";
  box.onclick = (e) => {
    const b = e.target.closest("button[data-filter]");
    if (!b) return;
    setSrcFilter(b.getAttribute("data-filter"));
  };
  box.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = SRC_FILTERS.findIndex((f) => f.key === S.srcFilter);
    const next = SRC_FILTERS[(i + (e.key === "ArrowRight" ? 1 : SRC_FILTERS.length - 1)) % SRC_FILTERS.length];
    setSrcFilter(next.key);
    const b = box.querySelector('button[data-filter="' + next.key + '"]');
    if (b) b.focus();
  });
}

function setSrcFilter(key) {
  if (!SRC_FILTERS.some((f) => f.key === key)) return;
  S.srcFilter = key;
  prefSet("reelbox.srcFilter", key);
  renderSrcSeg();
  renderSourceManager();
}

let settingsBound = false;

function bindSettings() {
  if (settingsBound) return;
  settingsBound = true;

  const shell = $("setShell");
  if (shell) {
    shell.onclick = (e) => {
      const nav = e.target.closest(".set-entry[data-page], .set-navrow[data-page]");
      if (nav) return openSetPage(nav.getAttribute("data-page"));
      if (e.target.closest("[data-back]")) return closeSetPage();
    };
  }
  window.addEventListener("resize", () => {
    // 断点切换时把形态摆正:expanded 一定有打开的页,compact 一定回到列表
    if (wideSettings()) {
      if (!setPage) openSetPage("src");
    } else if (setPage && !document.querySelector('#setShell[data-page]')) {
      closeSetPage();
    }
  });

  // Esc:二级页 → 设置首页 → 首页 tab(和返回箭头同一套语义)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("player") && !$("player").hidden) return;
    if (document.querySelector("dialog[open]")) return;
    if (setPage) {
      e.preventDefault();
      closeSetPage();
    } else if ($("v-settings").hasAttribute("data-on")) {
      e.preventDefault();
      showView("home");
    }
  });

  bindSrcSeg();
  bindSetScrollLines();
  bindSourceManager();

  // 播放
  const segQ = $("segQuality");
  if (segQ) {
    segQ.onclick = (e) => {
      const b = e.target.closest("button[data-q]");
      if (!b) return;
      prefSet("reelbox.quality", b.getAttribute("data-q"));
      syncPlaySettings();
      syncSetSummaries();
      toast(qualityPref() === "high" ? "清晰度:固定最高档" : "清晰度:自动");
    };
  }
  const swA = $("swAutoplay");
  if (swA) {
    swA.onchange = () => {
      prefSet("reelbox.autoplay", swA.checked ? "1" : "0");
      syncSetSummaries();
      log("pref autoplay", swA.checked);
    };
  }
  const swR = $("swResume");
  if (swR) {
    swR.onchange = () => {
      prefSet("reelbox.resume", swR.checked ? "1" : "0");
      log("pref resume", swR.checked);
      if (!swR.checked) refreshResume();
    };
  }

  // 调试
  bindDebugToggle();
  const swF = $("swFab");
  if (swF) swF.onchange = () => { setFab(swF.checked); syncSetSummaries(); };
  const live = $("btnLiveLog");
  if (live) live.onclick = () => showDebugPanel(true);
  const open = $("btnOpenLog");
  if (open) {
    open.onclick = async () => {
      try {
        const p = await invoke("open_log");
        log("open log", p);
        toast("已在文件管理器里定位到日志");
      } catch (e) {
        log("OPEN LOG FAIL", errText(e));
        alertDialog("打开日志失败", errText(e));
      }
    };
  }

  // 外观改了(主题/种子色/风格)之后摘要要跟着变
  ["segMode", "segBlack", "segVariant", "swatches"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", () => setTimeout(syncSetSummaries, 0));
    el.addEventListener("input", () => setTimeout(syncSetSummaries, 0));
  });

  syncPlaySettings();
  syncDebugButtons();
  renderSetHome();
  syncSetSummaries();
}
const PROG_KEY = "reelbox.progress";

function progAll() {
  try { return JSON.parse(localStorage.getItem(PROG_KEY) || "{}"); } catch (_) { return {}; }
}
function progGet(key) { return key ? progAll()[key] : null; }
function progSet(key, val) {
  if (!key) return;
  const all = progAll();
  all[key] = val;
  try { localStorage.setItem(PROG_KEY, JSON.stringify(all)); } catch (_) {}
}
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? h + ":" : "") + mm + ":" + String(secs).padStart(2, "0");
}
function detailKey() { return S.source && S.detailTitle ? S.source.id + "|" + S.detailTitle : ""; }

/* ---------- 播放器界面 ---------- */
function pStatus(msg) {
  const el = $("pState");
  if (!msg) { el.innerHTML = ""; return; }
  el.innerHTML = '<span class="spin"></span><span>' + esc(msg) + "</span>";
}

/** 另一条线路的第一集;没有别的线路就返回 null(那就只能换源) */
function otherLine() {
  const groups = S.detailGroups || [];
  const cur = (playCtx && playCtx.group) || "";
  const start = groups.findIndex((g) => g.id === cur);
  for (let k = 1; k <= groups.length; k++) {
    const g = groups[(start + k + groups.length) % groups.length];
    if (!g || g.id === cur) continue;
    const eps = g.episodes || [];
    const pick = eps.find((e) => !playCtx || e.id !== playCtx.id) || eps[0];
    if (pick) return { id: pick.id, name: pick.name, group: g.id, line: g.name };
  }
  return null;
}

function hidePlayerFail() {
  const box = $("pFail");
  if (box) box.hidden = true;
  const p = $("player");
  if (p) p.classList.remove("failed");
}

/**
 * 播放失败:状态文字之外给「重试」和「换线路」,原始错误收进小字。
 * 换线路 = 换到详情页里另一条线路的第一集;只有一条线路时退化成"换源"。
 */
function playerFail(info) {
  const box = $("pFail");
  if (!box) return;
  const alt = otherLine();
  $("pFailIcon").textContent = info.kind === "unsupported" ? "link_off" : "error";
  $("pFailMsg").textContent = info.title;
  $("pFailHint").textContent =
    (info.hint || "") + (alt ? "" : " 这个标题下没有别的线路了,可以换个源。");
  $("pFailRaw").textContent = info.raw || "";
  const sw = $("pSwitch");
  sw.textContent = alt ? "换线路" : "换源";
  sw.onclick = alt
    ? () => playEpisode(alt.id, alt.name, alt.group)
    : () => { closePlayer(); openSourceManager(); };
  box.hidden = false;
  $("player").classList.add("failed");
  log("PLAY FAIL", info.step, info.kind, info.raw);
}

// 用路径画图标:字体字形带侧边距,画不准中心
const PLAY_PATH = "M9.2 5.6v12.8L19 12z";
const PAUSE_PATH = "M8.6 5.8h2.9v12.4H8.6z M12.5 5.8h2.9v12.4h-2.9z";

function pSync() {
  const v = $("video");
  const dur = isFinite(v.duration) ? v.duration : 0;
  $("pTime").textContent = fmtTime(v.currentTime) + " / " + fmtTime(dur);
  const pct = dur ? (v.currentTime / dur) * 100 : 0;
  $("played").style.width = pct + "%";
  if (!dragging) $("knob").style.left = pct + "%";
  let buffered = 0;
  try {
    if (v.buffered.length && dur) buffered = (v.buffered.end(v.buffered.length - 1) / dur) * 100;
  } catch (_) {}
  $("buf").style.width = Math.min(100, buffered) + "%";
  const playing = !v.paused && !v.ended;
  $("pPlayIcon").textContent = playing ? "pause" : "play_arrow";
  $("pBigPath").setAttribute("d", playing ? PAUSE_PATH : PLAY_PATH);
  $("player").classList.toggle("playing", playing);
  if (!playing) $("player").classList.remove("idle");
  const vol = v.muted ? 0 : v.volume;
  const volEl2 = $("vol");
  if (volEl2 && document.activeElement !== volEl2) volEl2.value = String(Math.round(vol * 100));
  $("pMuteIcon").textContent = vol === 0 ? "volume_off" : vol < 0.5 ? "volume_down" : "volume_up";
  const pv = $("pPrev"), nx = $("pNext");
  const list = (playCtx && playCtx.list) || [];
  const idx = playCtx ? playCtx.index : -1;
  pv.setAttribute("aria-disabled", idx <= 0 ? "true" : "false");
  nx.setAttribute("aria-disabled", !list.length || idx < 0 || idx >= list.length - 1 ? "true" : "false");
}

function pSeekTo(clientX) {
  const v = $("video");
  const r = $("seek").getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  $("played").style.width = ratio * 100 + "%";
  $("knob").style.left = ratio * 100 + "%";
  if (isFinite(v.duration)) v.currentTime = ratio * v.duration;
}

function pTogglePlay() {
  const v = $("video");
  if (v.paused) v.play().catch(() => {});
  else v.pause();
}

function renderLevels() {
  const btn = $("pQuality");
  const menu0 = $("pLevels");
  // 插件给了多档:直接用插件的档位
  const opts = (playCtx && playCtx.options) || [];
  if (opts.length > 1) {
    btn.hidden = false;
    const cur = (playCtx && playCtx.quality) || opts[0].quality;
    btn.textContent = cur;
    menu0.innerHTML = opts
      .map((o, i) => '<button data-opt="' + i + '">' + esc(o.quality) + "</button>")
      .join("");
    menu0.querySelectorAll("button").forEach((b) => {
      const i = Number(b.getAttribute("data-opt"));
      if (opts[i].quality === cur) b.setAttribute("aria-current", "true");
      b.onclick = () => {
        menu0.hidden = true;
        playCtx.quality = opts[i].quality;
        openPlayer(opts[i].url, $("pTitle").textContent);
        renderLevels();
      };
    });
    return;
  }
  const menu = $("pLevels");
  const heights = new Set((hls && hls.levels ? hls.levels : []).map((l) => l.height || 0));
  if (!hls || !hls.levels || hls.levels.length < 2 || heights.size < 2) {
    btn.hidden = true;
    menu.hidden = true;
    return;
  }
  btn.hidden = false;
  const cur = hls.currentLevel < 0 ? hls.loadLevel : hls.currentLevel;
  const lv = hls.levels[cur];
  btn.textContent = lv && lv.height ? lv.height + "P" : "自动";
  menu.innerHTML =
    hls.levels
      .map((l, i) => '<button data-lv="' + i + '">' + (l.height ? l.height + "P" : "档位 " + (i + 1)) + "</button>")
      .join("") + '<button data-lv="-1">自动</button>';
  menu.querySelectorAll("button").forEach((b) => {
    const n = Number(b.getAttribute("data-lv"));
    if ((n === -1 && hls.currentLevel === -1) || n === cur) b.setAttribute("aria-current", "true");
    b.onclick = () => {
      hls.currentLevel = n === -1 ? -1 : n;
      menu.hidden = true;
      renderLevels();
    };
  });
}

function bindPlayer() {
  const box = $("player");
  const v = $("video");

  $("pBack").onclick = closePlayer;
  $("pBig").onclick = pTogglePlay;
  $("pPlay").onclick = pTogglePlay;
  v.onclick = pTogglePlay;

  $("pMute").onclick = () => {
    const wasSilent = v.muted || v.volume < 0.05;
    v.muted = !wasSilent;
    if (!v.muted && v.volume < 0.05) v.volume = 0.8;
    if (v.muted) v.volume = 0;
    $("vol").value = String(Math.round((v.muted ? 0 : v.volume) * 100));
    saveVolume();
    pSync();
  };
  

  // 音量浮层:移开 250ms 再收起,避免从按钮移到滑块的瞬间消失
  const volWrap = document.querySelector(".p-volwrap");
  let volTimer = 0;
  if (volWrap) {
    volWrap.addEventListener("mouseenter", () => {
      clearTimeout(volTimer);
      volWrap.classList.add("open");
    });
    volWrap.addEventListener("mouseleave", () => {
      clearTimeout(volTimer);
      volTimer = setTimeout(() => volWrap.classList.remove("open"), 250);
    });
  }
  const volBox = document.querySelector(".p-vol");
  if (volBox) {
    volBox.addEventListener("pointerdown", (e) => e.stopPropagation());
    volBox.addEventListener("click", (e) => e.stopPropagation());
  }

  const volEl = $("vol");
  volEl.value = String(Math.round(loadVolume() * 100));
  v.volume = loadVolume();
  let volIdle = 0;
  const keepOpen = () => {
    if (volWrap) volWrap.classList.add("open");
    clearTimeout(volIdle);
    volIdle = setTimeout(() => volWrap && volWrap.classList.remove("open"), 3000);
  };
  volEl.addEventListener("pointerdown", keepOpen);
  volEl.oninput = () => {
    keepOpen();
    const val = Number(volEl.value) / 100;
    v.volume = val;
    v.muted = val === 0;
    saveVolume();
    pSync();
  };

  $("pRetry").onclick = () => {
    const c = playCtx;
    hidePlayerFail();
    if (c && c.id) playEpisode(c.id, c.name, c.group || "");
  };

  $("pPrev").onclick = () => jumpEpisode(-1);
  $("pNext").onclick = () => jumpEpisode(1);
  $("pFull").onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (box.requestFullscreen) box.requestFullscreen();
  };
  $("pQuality").onclick = (e) => {
    e.stopPropagation();
    $("pLevels").hidden = !$("pLevels").hidden;
  };

  const seek = $("seek");
  seek.onpointerdown = (e) => {
    dragging = true;
    seek.classList.add("drag");
    seek.setPointerCapture(e.pointerId);
    pSeekTo(e.clientX);
  };
  seek.onpointermove = (e) => { if (dragging) pSeekTo(e.clientX); };
  seek.onpointerup = (e) => {
    dragging = false;
    seek.classList.remove("drag");
    try { seek.releasePointerCapture(e.pointerId); } catch (_) {}
    pSeekTo(e.clientX);
  };

  box.onmousemove = () => {
    box.classList.remove("idle");
    clearTimeout(idleTimer);
    if (v.paused) return;
    idleTimer = setTimeout(() => box.classList.add("idle"), 2600);
  };
}

/* 浏览器自动播放策略会把视频静音,拿到播放权限后立刻恢复 */
function tryUnmute(v) {
  if (!v.muted) return;
  v.muted = false;
  if (!v.volume) v.volume = 0.8;
  const vol = $("vol");
  if (vol) vol.value = String(Math.round(v.volume * 100));
  saveVolume();
  pSync();
}

function jumpEpisode(delta) {
  const ctx = playCtx;
  if (!ctx || !ctx.list || !ctx.list.length) return;
  const i = ctx.index + delta;
  if (i < 0 || i >= ctx.list.length) return;
  const ep = ctx.list[i];
  playEpisode(ep.id, ep.name, ep.group || "");
}

function loadVolume() {
  try {
    const v = Number(localStorage.getItem("reelbox.volume"));
    // 0 视作"没设过":静音是临时状态,不该被持久成默认值
    if (!isFinite(v) || v <= 0 || v > 1) return 0.8;
    return v;
  } catch (_) { return 0.8; }
}
function saveVolume() {
  try { localStorage.setItem("reelbox.volume", String($("video").volume)); } catch (_) {}
}

function closePlayer() {
  const box = $("player");
  const v = $("video");
  saveProgress(true);
  if (hls) { hls.destroy(); hls = null; }
  clearInterval(tickTimer);
  clearTimeout(idleTimer);
  try { v.pause(); } catch (_) {}
  v.removeAttribute("src");
  v.load();
  box.hidden = true;
  box.classList.remove("idle");
  hidePlayerFail();
  pStatus("");
  $("pLevels").hidden = true;
  refreshResume();
}

function refreshResume() {
  const wrap = $("v-detail").querySelector(".detail-wrap");
  if (!wrap) return;
  const rec = progGet(detailKey());
  let btn = $("btnResume");
  if (!resumeOn() || !rec || !rec.id) {
    if (btn) btn.remove();
    return;
  }
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "resume";
    btn.id = "btnResume";
    const anchor = wrap.querySelector(".epgroup") || wrap.querySelector(".noep");
    wrap.insertBefore(btn, anchor || null);
  }
  btn.textContent = "继续观看 · " + (rec.name || "") + " · " + fmtTime(rec.t);
  btn.onclick = () => playEpisode(rec.id, rec.name, rec.group || "");
}

function saveProgress(force) {
  if (!resumeOn()) return; // 设置里关了进度记忆就不落盘
  if (!playCtx || !playCtx.id) return;
  const v = $("video");
  const t = v.currentTime;
  if (!isFinite(t) || t < 3) return;
  const now = Date.now();
  if (!force && now - (playCtx.saved || 0) < 5000) return;
  playCtx.saved = now;
  progSet(playCtx.key, { id: playCtx.id, name: playCtx.name, group: playCtx.group || "", t: t, at: now });
}

function openPlayer(url, name, mime, kind) {
  const box = $("player");
  const v = $("video");
  box.hidden = false;
  box.classList.remove("idle");
  hidePlayerFail();
  const full = S.detailTitle && name && name !== S.detailTitle
    ? S.detailTitle + " · " + name
    : name || S.detailTitle || "";
  $("pTitle").textContent = full;
  pStatus(url ? "加载中…" : "取流中…");
  if (hls) { hls.destroy(); hls = null; }
  if (!url) return;

  clearInterval(tickTimer);
  tickTimer = setInterval(pSync, 250);

  v.onloadedmetadata = () => {
    if (playCtx && playCtx.resume > 5) {
      try { v.currentTime = playCtx.resume; } catch (_) {}
    }
    pSync();
  };
  v.ontimeupdate = () => saveProgress(false);
  v.onplaying = () => { pStatus(""); hidePlayerFail(); pSync(); };
  v.onpause = pSync;
  v.onended = () => {
    const ctx = playCtx;
    pSync();
    if (!ctx || !ctx.list || !ctx.list.length) return;
    if (!autoplayOn()) {
      pStatus("这一集放完了(自动连播已关闭)");
      return;
    }
    const next = ctx.list[ctx.index + 1];
    if (next) playEpisode(next.id, next.name, next.group || "");
    else pStatus("已经是最后一集");
  };

  // 出错先记现场:<video> 自己的错误码往往比 hls.js 的 details 更直接
  v.onerror = () => {
    const e = v.error || {};
    log(
      "VIDEO ERR", "code=" + (e.code || 0), "msg=" + (e.message || ""),
      "readyState=" + v.readyState, "networkState=" + v.networkState,
      "src=" + shortUrl(v.currentSrc || v.src, 100)
    );
    pStatus("播放失败:播放器拿不到这条流");
    playerFail({
      step: "stream",
      kind: "network",
      title: "播放失败:播放器拿不到这条流",
      hint: "同一条线路重试一次,或者换一条线路。",
      raw: videoFailReason(v),
    });
  };

  // 本地反代地址把真实地址 base64 掉了,看不出扩展名,所以以 mime 为准;
  // 但插件是按地址后缀猜 mime 的(签名的 mp4 地址没有后缀,会被写成 mpegurl),
  // 所以 playEpisode 先探到的真实类型 kind 优先。
  const hint = mime || (playCtx && playCtx.mime) || "";
  const hlsByHint = /mpegurl|m3u8/i.test(hint) || url.indexOf(".m3u8") >= 0 || url.indexOf("mpegurl") >= 0;
  const isHls = kind === "file" ? false : (kind === "hls" || hlsByHint);
  logv("play mode " + (isHls ? "hls" : "native") + " kind=" + (kind || "?") + " hint=" + hint);
  // 探测说"既不是清单也不是媒体"时别硬塞给 hls.js,否则只会得到 manifestParsingError
  if (kind === "unknown") {
    const probe = (playCtx && playCtx.probe) || {};
    log("play abort kind=unknown head=" + (probe.head || ""));
    pStatus("这条线路返回的是网页,不是播放流");
    playerFail({
      step: "stream",
      kind: "unsupported",
      title: "这条线路返回的是网页,不是播放流",
      hint: "源站这一集给的不是 m3u8/mp4(可能是错误页或被拦了)。换一条线路试试。",
      raw:
        "kind=unknown status=" + (probe.status || 0) + " mime=" + (probe.mime || "") +
        (probe.head ? "\n" + probe.head : ""),
    });
    return;
  }

  if (window.Hls && Hls.isSupported() && isHls) {
    hls = new Hls({ maxBufferLength: 30, enableWorker: true });
    // 事件要先挂上再 loadSource,否则早期的清单错误会漏记
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      pStatus("");
      hidePlayerFail();
      // 设置里的清晰度偏好:自动让它自己切,「最高」钉在最高一档
      if (qualityPref() === "high" && hls.levels && hls.levels.length > 1) {
        hls.currentLevel = hls.levels.length - 1;
      }
      renderLevels();
      v.volume = loadVolume();
      v.play().then(() => tryUnmute(v)).catch(() => {});
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, renderLevels);
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d) return;
      const resp = d.response || {};
      const ctxUrl = d.url || (d.frag && d.frag.url) || (d.context && d.context.url) || "";
      const reason = resp.text ? String(resp.text).replace(/\s+/g, " ").slice(0, 160) : "";
      log(
        "HLS ERR", "type=" + d.type, "details=" + d.details, "fatal=" + !!d.fatal,
        "code=" + (resp.code || 0), "url=" + shortUrl(ctxUrl, 100),
        reason ? "resp=" + reason : ""
      );
      if (!d.fatal) return;
      log("HLS FATAL", d.details);
      pStatus("播放失败:" + d.details);
      window.__err && window.__err("hls: " + d.details);
      playerFail({
        step: "stream",
        kind: "network",
        title: "播放失败:" + d.details,
        hint: "清单或分片拿不到。重试一次,或者换一条线路。",
        raw:
          "type=" + d.type + " details=" + d.details + " code=" + (resp.code || 0) +
          (ctxUrl ? "\nurl=" + shortUrl(ctxUrl, 160) : "") + (reason ? "\nresp=" + reason : ""),
      });
    });
    hls.loadSource(url);
    hls.attachMedia(v);
  } else {
    $("pQuality").hidden = true;
    v.src = url;
    v.volume = loadVolume();
    v.play().then(() => tryUnmute(v)).catch(() => {});
  }
}

/** 插件源的 play 钩子:返回 {sources:[{id,name,url,mime,headers}]},换成内部 Stream 形状 */
async function pluginStream(groupId, episodeId) {
  const res = await callPlugin(S.source.url, "play", {
    contentId: S.detailId || "",
    groupId: groupId || "",
    episodeId: episodeId,
    purpose: "playback",
  });
  const list = (res && (res.sources || res.streams)) || (res && res.url ? [res] : []);
  const usable = list.filter((s) => s && typeof s.url === "string" && /^https?:\/\//i.test(s.url));
  if (!usable.length) throw new Error(res && res.error ? String(res.error) : "插件没有给出可播放的地址");
  // 登记进服务端白名单:player_url 只认本次会话 play 出来的地址
  await invoke("plugin_stream_allow", { urls: usable.map((s) => s.url) });
  const first = usable[0];
  return {
    url: first.url,
    mime: first.mime || "application/vnd.apple.mpegurl",
    headers: first.headers || {},
    options: usable.map((s, i) => ({
      quality: s.name || s.quality || "档 " + (i + 1),
      url: s.url,
    })),
  };
}

async function playEpisode(id, name, groupId) {
  log("playEpisode", name);
  const key = detailKey();
  const rec = progGet(key);
  const list = S.detailEps || [];
  const idx = list.findIndex((e) => e.id === id);
  playCtx = {
    key: key,
    id: id,
    name: name,
    group: groupId || "",
    mime: "",
    list: list,
    index: idx,
    resume: resumeOn() && rec && rec.id === id ? rec.t || 0 : 0,
  };
  openPlayer("", name);
  try {
    const t0 = Date.now();
    const st = pluginMode()
      ? await pluginStream(groupId, id)
      : await invoke("play", { source: S.source, episodeId: id });
    const hookMs = Date.now() - t0;
    if (playCtx) playCtx.mime = st.mime || "";
    // 源头(插件 play 钩子给的)地址:签名串很长,只留开头,但要能看出主机和路径
    logv("play hook ms=" + hookMs + " mime=" + (st.mime || "") + " url=" + shortUrl(st.url, 160));
    if (st.headers && Object.keys(st.headers).length) {
      logv("play headers " + Object.keys(st.headers).join(","));
    }
    const local = await invoke("player_url", { stream: st });
    lastLocalUrl = local;
    // 探一眼真实内容:插件会把没有后缀的 mp4 地址写成 mpegurl,
    // 丢给 hls.js 只会得到 manifestParsingError
    let kind = "";
    try {
      const probe = await invoke("stream_kind", { stream: st });
      kind = (probe && probe.kind) || "";
      if (playCtx) playCtx.probe = probe || null;
      logv(
        "probe kind=" + kind + " code=" + ((probe && probe.status) || 0) +
        " ct=" + ((probe && probe.mime) || "") + " bytes=" + ((probe && probe.bytes) || 0) +
        (kind === "unknown" ? " head=" + ((probe && probe.head) || "") : "")
      );
    } catch (e) {
      log("probe fail", String(e && e.message ? e.message : e));
    }
    // 多清晰度:每档都给一个代理地址
    const opts = [];
    if (st.options && st.options.length > 1) {
      for (const o of st.options) {
        const u = await invoke("player_url", {
          stream: { url: o.url, mime: st.mime, headers: st.headers, options: [] },
        });
        opts.push({ quality: o.quality, url: u });
      }
    }
    if (playCtx) playCtx.options = opts;
    logv("stream " + st.mime + " local=" + shortUrl(local, 90) + " opts=" + opts.length);
    // 清晰度偏好「最高」:插件多档时直接起最高一档(多数插件按低→高排)
    let startUrl = local;
    if (qualityPref() === "high" && opts.length > 1) {
      const best = opts[opts.length - 1];
      startUrl = best.url;
      if (playCtx) playCtx.quality = best.quality;
      logv("quality high →", best.quality);
    }
    openPlayer(startUrl, name, st.mime, kind);
  } catch (e) {
    log("STREAM FAIL", e);
    pStatus("取流失败");
    playerFail(errorInfo("stream", e));
  }
}

// ---------- 交互 ----------

function bindNav() {
  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.onclick = () => showView(el.getAttribute("data-nav"));
  });
}

function showView(key) {
  currentView = key;
  document.querySelectorAll("[data-nav]").forEach((o) => {
    if (o.getAttribute("data-nav") === key) o.setAttribute("aria-current", "page");
    else o.removeAttribute("aria-current");
  });
  ["home", "fav", "settings", "detail"].forEach((k) => {
    const v = $("v-" + k);
    if (!v) return;
    if (k === key) v.setAttribute("data-on", "");
    else v.removeAttribute("data-on");
  });

  // 分类只在首页有意义:切走时收起,切回时按当前选中重画
  const onHome = key === "home";
  const list = $("catlist");
  const divider = document.querySelector(".side__divider");
  if (list) list.style.display = onHome ? "" : "none";
  if (divider) divider.style.display = onHome ? "" : "none";
  if (onHome) renderParents();
  if (key === "settings") {
    bindSettings();
    // 进设置 = 回到入口列表(expanded 下左列常驻,默认落在「源」)
    setPage = "";
    const shell = $("setShell");
    if (shell) shell.removeAttribute("data-page");
    document.body.removeAttribute("data-setpage");
    document.querySelectorAll("#setDetail .set-page").forEach((el) => el.removeAttribute("data-on"));
    renderSetHome();
    bindSetScrollLines();
    if (wideSettings()) openSetPage("src");
  }
  layoutControls();
}

function bindSourceMenu() {
  const btn = $("srcBtn");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.onclick = (e) => {
    e.stopPropagation();
    if (srcMenuOpen()) return closeSrcMenu();
    openSrcMenu();
  };
  // 桌面弹出层:点外面关掉(sheet 有自己的 scrim)
  document.addEventListener("click", (e) => {
    const menu = $("srcMenu");
    if (!menu || !menu.hasAttribute("data-open")) return;
    if (e.target.closest("#srcMenu") || e.target.closest("#srcBtn")) return;
    menu.removeAttribute("data-open");
  });
}

document.addEventListener("click", (e) => {
  const cat = e.target.closest("[data-parent]");
  if (cat) {
    const p = cat.getAttribute("data-parent");
    S.parent = p;
    const kids = S.children[p] || [];
    S.child = kids.length ? kids[0].value : "";
    rememberCategory();
    renderParents();
    renderChildren();
    return loadItems();
  }
  const chip = e.target.closest("[data-child]");
  if (chip) {
    const next = chip.getAttribute("data-child");
    if (next === S.child) return;
    S.child = next;
    rememberCategory();
    renderChildren();
    return loadItems();
  }
  const card = e.target.closest(".card");
  if (card) {
    const it = S.items[Number(card.getAttribute("data-i"))];
    if (it) return openDetail(it);
  }
});

let SKEL_N = 0;

function renderSkeleton() {
  const g = $("grid");
  const w = g.clientWidth || 900;
  const n = Math.max(6, Math.round(w / 170) * 3);
  if (SKEL_N === n && g.querySelector(".skel")) return;
  SKEL_N = n;
  g.innerHTML = '<article class="card skel"><div class="poster"></div><div class="meta"><i></i></div></article>'.repeat(n);
}

function clearSkeleton() {
  SKEL_N = 0;
  $("grid").querySelectorAll(".skel").forEach((n) => n.remove());
}

const DETAIL_SKELETON =
  '<div class="detail-wrap">' +
    '<div class="skel-hero"><div class="sk"></div>' +
      '<div class="sk-lines"><i></i><i></i><i></i><i></i></div></div>' +
    '<div class="skel-chips">' + "<i></i>".repeat(14) + "</div>" +
  "</div>";

/** 列表:加载中(骨架屏) */
function showListLoading() {
  const el = $("empty");
  el.style.display = "none";
  el.innerHTML = "";
  renderSkeleton();
}

/** 列表:空(没有内容) */
function showListEmpty(title, msg, actionLabel, onAction) {
  clearSkeleton();
  $("grid").innerHTML = "";
  const el = $("empty");
  el.style.display = "";
  el.innerHTML = stateCard({
    icon: "movie",
    title: title || "这个分类没有内容",
    msg: msg || "换一个分类,或者用别的片名搜一下。",
    actions: actionLabel ? [{ id: "more", label: actionLabel }] : [],
  });
  const b = el.querySelector('[data-act="more"]');
  if (b && onAction) b.onclick = onAction;
}

/** 列表:错误(原因 + 重试;源不支持时引导换源) */
function showListError(info, retry) {
  clearSkeleton();
  $("grid").innerHTML = "";
  const el = $("empty");
  el.style.display = "";
  const unsupported = info.kind === "unsupported";
  el.innerHTML = stateCard({
    error: true,
    icon: unsupported ? "link_off" : "cloud_off",
    title: info.title,
    msg: info.hint,
    actions: unsupported
      ? [{ id: "switch", label: "去换源", primary: true }, { id: "retry", label: "重试" }]
      : [{ id: "retry", label: "重试", primary: true }, { id: "switch", label: "源管理" }],
    raw: info.raw,
  });
  const retryBtn = el.querySelector('[data-act="retry"]');
  if (retryBtn) retryBtn.onclick = () => (retry ? retry() : loadItems());
  const sw = el.querySelector('[data-act="switch"]');
  if (sw) sw.onclick = openSourceManager;
}

/** 翻页失败:已经加载的内容留着,在后面补一条可点的重试 */
function showLoadMoreError(info, retry) {
  const old = $("grid").querySelector(".more-fail");
  if (old) old.remove();
  const card = document.createElement("div");
  card.className = "more-fail";
  card.style.cssText = "grid-column:1/-1";
  card.innerHTML = stateCard({
    error: true,
    icon: "cloud_off",
    title: info.title,
    msg: "已经加载的内容还留着,可以接着看,或者重试加载下一页。",
    actions: [{ id: "retry", label: "重试加载更多", primary: true }],
    raw: info.raw,
  });
  card.querySelector('[data-act="retry"]').onclick = () => {
    card.remove();
    if (retry) retry();
  };
  $("grid").appendChild(card);
}

/** 详情:错误(原因 + 重试 / 换源) */
function showDetailError(info, item) {
  const box = $("v-detail");
  const unsupported = info.kind === "unsupported";
  box.innerHTML =
    '<div class="detail-wrap">' +
      '<button class="back" id="btnBack" aria-label="返回">' +
        '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z" fill="currentColor"/></svg>' +
      "</button>" +
      stateCard({
        error: true,
        icon: unsupported ? "link_off" : "cloud_off",
        title: info.title,
        msg: info.hint,
        actions: unsupported
          ? [{ id: "switch", label: "去换源", primary: true }, { id: "retry", label: "重试" }]
          : [{ id: "retry", label: "重试", primary: true }, { id: "switch", label: "源管理" }],
        raw: info.raw,
      }) +
    "</div>";
  $("btnBack").onclick = () => showView("home");
  const retryBtn = box.querySelector('[data-act="retry"]');
  if (retryBtn) retryBtn.onclick = () => openDetail(item || S.detailItem).catch(() => {});
  const sw = box.querySelector('[data-act="switch"]');
  if (sw) sw.onclick = openSourceManager;
}

function setStatus() {
  if (S.loading && !S.items.length) renderSkeleton();
  else clearSkeleton();
}

function revokeBlobs() {
  S.blobs.forEach((u) => URL.revokeObjectURL(u));
  S.blobs = [];
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

let currentView = "home";

function layoutControls() {
  const controls = $("controls");
  const wide = window.matchMedia("(min-width: 840px)").matches;
  const target = wide ? $("sideControls") : $("topbar");
  if (controls.parentElement !== target) target.appendChild(controls);
  controls.style.display = "";
  // 窄屏只有首页需要顶栏(源按钮 + 搜索);设置/喜欢/详情各用自己的 app bar
  const showTop = wide ? false : currentView === "home";
  $("topbar").style.display = showTop ? "" : "none";
  $("sideControls").style.display = wide ? "" : "none";
}

$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});
$("btnSearch").onclick = doSearch;
window.addEventListener("resize", layoutControls);
layoutControls();
$("scroll").addEventListener("scroll", () => {
  const el = $("scroll");
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) loadMore();
});

initTheme();
init();
