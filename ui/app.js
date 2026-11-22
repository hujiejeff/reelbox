import { initTheme, state as themeState, SEEDS, isDark } from "./theme.js";
import {
  initPluginHost,
  callPlugin,
  isPluginSource,
  isPluginKind,
  looksLikePluginSource,
  looksLikeAdapterSource,
  looksLikeRemovedParser,
  isRemovedParserPath,
  PARSER_REMOVED_HINT,
  ADAPTER_KIND,
  ENGINE_KIND,
  PLUGIN_KIND,
} from "./plugin-host.js";
import { splitCollection } from "./import-shape.js";
import { buildSrcPanel } from "./src-panel.js";
import { openSheet } from "./sheet.js";
import { closeMenu, menuOpen, openMenu } from "./menu.js";
// 平台判断只有 platform.js 一处;桌面走的就是原有分支
import { platform } from "./platform.js";
import {
  alertDialog,
  confirmDialog,
  dialog,
  formDialog,
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
  detailFrom: "home",   // 详情页是从哪个视图点进来的:返回要回原处(首页 / 喜欢)
  favs: {},             // 收藏:localStorage["reelbox.favs"],键 = 源id|片名
  srcFilter: "all",     // 源管理页分段:all | vod | plugin | live
  reqSeq: 0,            // 请求代际:切源/换分类时 +1,回来的迟到的响应一律丢掉
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

/**
 * 右键菜单:桌面壳里右键会弹出 WebView2 的默认菜单(返回 / 刷新 / 另存为…),
 * 对这个应用纯属噪声,全局关掉。
 *
 * 例外:输入框(input / textarea / [contenteditable])里保留 —— 那里右键是
 * 复制粘贴的唯一入口,关掉就没法用了。
 * 只拦 contextmenu,不碰 pointerdown / touchstart,所以移动端的长按行为不变;
 * 顺带记一下"最近一次是触摸",长按触发的那次 contextmenu 也一并放行。
 */
function bindNoContextMenu() {
  if (document.__reelboxNoContextMenu) return;
  document.__reelboxNoContextMenu = true;

  let lastTouch = false;
  document.addEventListener(
    "pointerdown",
    (e) => { lastTouch = e.pointerType !== "mouse"; },
    true
  );

  // 捕获阶段:元素自己 stopPropagation 也拦不住这条
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (lastTouch) return; // 长按不是鼠标右键,交给系统和系统输入法
      const t = e.target;
      const field = t && t.closest ? t.closest("input, textarea, [contenteditable]") : null;
      // contenteditable="false" 不是可编辑区,别误放行
      const ce = field && field.hasAttribute("contenteditable")
        ? String(field.getAttribute("contenteditable")).toLowerCase()
        : null;
      const editable = !!field && ce !== "false";
      if (editable) return;
      e.preventDefault();
    },
    true
  );
}

async function init() {
  bindNoContextMenu();
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
      e.preventDefault();
      toggleDebug();
    }
  });
  bindDebugToggle();
  bindWheelScroll();
  S.srcFilter = prefGet("reelbox.srcFilter", "all");
  S.favs = favAll();
  renderFavs();
  log("init start");
  initPluginHost({ invoke: invoke, log: log });
  initVerifyPage();
  {
    const d = document.getElementById("dbg");
    if (d) d.hidden = true;
  }
  syncDebugButtons();
  syncPlaySettings();
  loadAppInfo();
  bindPlayer();
  bindLifecycle();
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
    // 音量:上下键 ±5。滑块自己聚焦时交给原生处理,别一次跳两格
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && document.activeElement !== $("vol")) {
      e.preventDefault();
      setVolume(v.volume + (e.key === "ArrowUp" ? 0.05 : -0.05));
      keepVolumeOpen();
      return;
    }
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
  // 老配置里有名字塌成 "-" 的 id(见 docs/REVIEW-2026-11-14.md A1):
  // 先修 id 再往下走,收藏与进度里「源id|片名」的键会同步搬过去。
  if (migrateSourceIds()) renderFavs();
  // 默认没有源(见 src-tauri 的 load_sources):先给首页空态,不自动切任何源。
  if (!listableSources().length) {
    bindNav();
    bindSourceMenu();
    renderSources();
    showNoSources();
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
    const cms = S.sources.find((s) => sourceType(s) === "vod" && /dytt|ffzy|lzzy/.test(String(s.url)));
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
  const pool = list || [];
  return (want && pool.find((s) => s.id === want)) || pool[0];
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

/**
 * 取列表时带给源的分类值。
 * 一级分类下面**没有**二级分类时(引擎插件那种平铺分类就是这样),S.child 是空,
 * 只传 S.child 会让"选了分类"等于没选 —— 这时退回一级分类自己的值。
 */
function categoryValue() {
  return S.child || S.parent || "";
}

async function switchSource(src, opts) {
  if (!src) return;
  const o = opts || {};
  log("switchSource", src && src.id);
  // 换代:上一个源发出去的请求从这里开始全部作废(I2)
  const seq = ++S.reqSeq;
  S.source = src;
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
  // 顶栏已经是新源了,网格不能还留着上个源的片:立刻清空 + 上骨架屏
  resetGrid();
  showListLoading();
  const scroller = $("scroll");
  if (scroller) scroller.scrollTop = 0; // 新源可能只有几条,别落在半空
  if (!o.stay) showView("home");
  const seeded = seedCategory();
  if (seeded) {
    // 存的分类要先让 loadFilters 校验一遍(新源里可能没有这个分类),再取列表,
    // 否则会拿一个不存在的分类去请求。没存过分类时保持并行,不多等一个来回。
    await loadFilters();
    if (seq !== S.reqSeq) return; // 期间又切源了:这轮结果作废
    await loadItems();
  } else {
    await Promise.all([loadFilters(), loadItems()]);
  }
  if (seq !== S.reqSeq) return;
  // 当前源变了:源管理页的选中态与设置首页摘要都要跟着走
  renderSourceManager();
  syncSetSummaries();
}

/* ---------- 适配器:导入时判定,运行时只读 ---------- */
// 一条源走哪条路只看 `adapter`(见 docs/ARCHITECTURE.md 第 2 节):
//   vod            → 沙箱,插件是**随包安装的内置适配器**,源的 url 是接口地址
//   vod-rs         → Rust 的 CMS 客户端(苹果 CMS 的 JSON / XML),回滚开关
//   reelbox/webox  → 沙箱,源的 url 就是插件文件
//   iplayr         → 沙箱,但插件是**随包安装的内置引擎**,源的 url 是站点配置
// 判定只做一次(导入时写进 adapter + probe),运行时不再重新猜格式。

/** 钩子跑在沙箱里的适配器(其余的交给 Rust:现在只剩 `vod-rs` 那条回滚路径) */
const SANDBOX_ADAPTERS = ["reelbox", "webox", "iplayr", "vod", "m3u"];

/** 插件文件随包安装的适配器(名字 → `builtin_adapters()` 里的键) */
const BUILTIN_ADAPTERS = ["iplayr", "vod", "m3u"];

/**
 * 这条源用哪个适配器。
 * 后端 `load_sources` 一定会把 `adapter` 补齐,这里只兜住极老的内存数据。
 */
function sourceAdapter(src) {
  const a = String((src && src.adapter) || "").trim().toLowerCase();
  if (a) return a;
  if (sourceType(src) === "plugin") return "reelbox";
  return "vod";
}

/** 钩子跑在沙箱 iframe 里吗(`vod` 是,`vod-rs` 不是) */
function pluginMode(src) {
  return SANDBOX_ADAPTERS.indexOf(sourceAdapter(src || S.source)) >= 0;
}

/**
 * 内置适配器的路径(`builtin_adapters()` 返回的那张表,见 src-tauri/src/builtin.rs)。
 * 拿一次记一辈子:文件是启动时装的,应用跑起来之后不会变。
 */
let builtinTable = null;

function builtinAdapter(name) {
  if (!builtinTable) {
    builtinTable = Promise.resolve(invoke("builtin_adapters")).catch((e) => {
      log("BUILTIN ADAPTERS FAIL", errText(e));
      builtinTable = null; // 下次再问一遍,别把一次失败记成永久没有
      return {};
    });
  }
  return builtinTable.then((t) => String((t && t[name]) || ""));
}

/**
 * 这个源的插件文件在哪儿。
 * reelbox / webox 的地址就是插件文件;iplayr / vod 的地址是站点配置 / 接口地址,
 * 插件是随包安装的内置适配器。
 */
async function adapterPath(src) {
  const name = sourceAdapter(src);
  if (BUILTIN_ADAPTERS.indexOf(name) >= 0) {
    const path = await builtinAdapter(name);
    if (!path) {
      throw new Error("内置 " + name + " 适配器没装上(插件目录里找不到 builtin/" + name + ".adapter.js)");
    }
    return path;
  }
  return String((src && src.url) || "");
}

/**
 * 交给插件的 options。内置适配器从 `url` 里拿站点配置 / 接口地址(它不知道别的);
 * 其余源用自己存的 options —— 普通插件不会因为多了个字段而变。
 *
 * `format: "auto"` 是给 vod 的口径:JSON / XML 由适配器按地址自己判,
 * 和 Rust 那份 `Source::format()` 同一个规则。
 */
function adapterOptions(src) {
  if (!src) return {};
  const name = sourceAdapter(src);
  if (name === "iplayr") return { config: String(src.url || "") };
  if (name === "vod") return { config: String(src.url || ""), format: "auto" };
  if (name === "m3u") return { config: String(src.url || "") };
  return src.options || {};
}

/**
 * 源的「需要人工校验」开关打开时:先拿到一个可用的会话。
 * 有现成的就复用,没有就开一页校验并等用户点完(页面由内核弹出)。
 */
async function ensureVerify(src) {
  if (!src || !src.verify) return "";
  const origin = originOfUrl(src.verifyUrl || src.url);
  if (!origin) return "";
  try {
    const rows = await invoke("session_list", {});
    const hit = (rows || []).find((s) => s.done && s.origin === origin);
    if (hit) return hit.id;
  } catch (e) {
    log("SESSION LIST FAIL", errText(e));
  }
  const s = await invoke("verify_ensure", {
    source: String(src.id || ""),
    url: origin + "/",
    reason: String(src.name || "站点校验"),
  });
  return s && s.id ? s.id : "";
}

function originOfUrl(url) {
  const u = String(url || "").trim();
  const i = u.indexOf("//");
  if (i < 0) return "";
  const j = u.indexOf("/", i + 2);
  const base = j < 0 ? u : u.slice(0, j);
  const k = base.indexOf(":");
  if (k < 0) return "";
  const scheme = base.slice(0, k).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return "";
  return scheme + ":" + base.slice(k + 1);
}

/** 在这个源的适配器里跑一个钩子(沙箱侧入口只有这一个) */
async function callAdapter(src, hook, arg) {
  const args = Object.assign({}, arg || {});
  args.options = adapterOptions(src);
  const session = await ensureVerify(src);
  return callPlugin(await adapterPath(src), hook, args, session);
}

/** 列表:沙箱类适配器走 ui/plugin-host.js,`vod-rs` 走 Rust */
async function fetchPage(page, classify) {
  if (!pluginMode()) return invoke("list_items", { source: S.source, page, classify });
  const res = await callAdapter(S.source, "list", {
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
  const res = await callAdapter(S.source, "search", {
    query: keyword,
    keyword: keyword,
    cursor: page > 1 ? String(page) : null,
  });
  return {
    items: (res && (res.items || res.list)) || [],
    nextCursor: (res && (res.nextCursor || res.next)) || "",
  };
}

async function fetchFilters() {
  // 沙箱类适配器的分类由插件自己说(iplayr 从站点配置的 category 算)
  if (!pluginMode()) return invoke("filters", { source: S.source });
  return callAdapter(S.source, "filters", {});
}

async function fetchDetail(id) {
  if (!pluginMode()) return invoke("detail", { source: S.source, id });
  const d = (await callAdapter(S.source, "detail", { id })) || {};
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
  // 分类属于某个源:回来的晚于切源就丢掉,别把上个源的分类摆在顶栏上(I2)
  const forSource = S.source;
  let fs = [];
  try {
    fs = await fetchFilters();
  } catch (e) {
    log("filters fail", e);
  }
  if (forSource !== S.source) {
    log("filters dropped", "source changed");
    return;
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
  const seq = ++S.reqSeq; // 每次取列表都换代:先回来的旧响应会被丢掉
  S.loading = true;
  S.listError = null;
  showListLoading();
  try {
    const page = await fetchPage(1, categoryValue());
    if (seq !== S.reqSeq) {
      log("list dropped", "seq=" + seq + " now=" + S.reqSeq);
      return;
    }
    S.items = page.items || [];
    S.page = 1;
    S.next = page.nextCursor || "";
    resetGrid();
    appendCards(0);
  } catch (e) {
    if (seq !== S.reqSeq) return;
    log("LIST FAIL", errText(e));
    S.items = [];
    S.next = "";
    resetGrid();
    S.listError = errorInfo("list", e);
    showListError(S.listError, () => loadItems());
  } finally {
    if (seq === S.reqSeq) {
      S.loading = false;
      setStatus();
    }
  }
}

async function loadMore() {
  if (S.loading || !S.next) return;
  const more = Number(S.next);
  const seq = S.reqSeq;
  S.loading = true;
  try {
    const page = await fetchPage(more, categoryValue());
    if (seq !== S.reqSeq) return; // 翻页途中切了源/分类:这页不要了
    const before = S.items.length;
    S.items = S.items.concat(page.items || []);
    S.next = page.nextCursor || "";
    appendCards(before);
  } catch (e) {
    if (seq !== S.reqSeq) return;
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
  const seq = ++S.reqSeq;
  S.loading = true;
  S.listError = null;
  showListLoading();
  try {
    const page = await fetchSearch(q, 1);
    if (seq !== S.reqSeq) return;
    S.items = page.items || [];
    S.next = "";
    resetGrid();
    appendCards(0);
  } catch (e) {
    if (seq !== S.reqSeq) return;
    log("SEARCH FAIL", errText(e));
    S.items = [];
    S.next = "";
    resetGrid();
    S.listError = errorInfo("search", e);
    showListError(S.listError, () => doSearch());
  } finally {
    if (seq === S.reqSeq) {
      S.loading = false;
      setStatus();
    }
  }
}

async function openDetail(item) {
  log("openDetail", item && item.title);
  if (item) S.detailItem = item;
  // 记下来源视图:从「喜欢」进来的详情,返回该回「喜欢」,不是永远甩回首页(第 6 组)
  if (currentView !== "detail") S.detailFrom = currentView;
  showView("detail");
  renderDetailSkeleton();
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

/** 详情页返回:回到点进来的那个视图(收藏 → 喜欢,首页 → 首页) */
function closeDetail() {
  const back = S.detailFrom && S.detailFrom !== "detail" ? S.detailFrom : "home";
  showView(back);
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

/** 当作接口导入的 HTML 爬取配置:地址不是接口,拿它取列表只会把配置本身当响应体 */
function isCrawlSource(src) {
  if (!src) return false;
  // iplayr 的地址**就是**站点配置(.json):它有内置引擎解释,不是"取不到数据"
  if (sourceAdapter(src) === "iplayr") return false;
  if (isPluginSource(src)) return false;
  if (srcKind(src) === "xml") return false;
  const url = String(src.url || "").toLowerCase();
  if (!/^https?:/.test(url)) return false;
  const host = url.split("://")[1].split(/[/?#]/)[0];
  if (host.indexOf("raw.githubusercontent.com") >= 0) return true;
  return url.split(/[?#]/)[0].endsWith(".json");
}

/**
 * 这个源「可用于当前功能」吗?—— 顶栏切源面板只列可用的源(判定只在这里一处,
 * 别处不要再各写一套)。
 *
 * 两条判据:
 *   1) 类型必须是已支持的三类:点播(JSON)/ 点播(XML)/ 插件(JS)。
 *      直播源现在只能登记、没有列表接口(v0.3 才有),算不可用。
 *   2) 配置本身就不成立的排除:HTML 爬取配置(iplayr 那类 .json,里面是爬虫规则
 *      而不是接口地址)拿它取列表只会把配置本身当响应体 → 空屏,见 isCrawlSource。
 *
 * 健康检查失败(health.ok === false)**不**隐藏:那是「现在坏了」而不是「不可用」,
 * 用户需要知道它坏了 —— 行尾照常给失败状态点(见 healthOf / src-panel 的 trail)。
 * 从没测过(health 为空)同理,留着。
 *
 * 只管顶栏面板:源管理页要管理全部源,不经过这里。
 */
function isUsableSource(src) {
  if (!src) return false;
  const t = sourceType(src);
  if (t !== "vod" && t !== "plugin" && t !== "live") return false;
  return !isCrawlSource(src);
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

/* ---------- 顶栏切源:按类型分组 + 搜索 ---------- */
// <840 用 m3e bottom sheet(见 ui/sheet.js),≥840 挂进侧栏的弹出层(ui/src-panel.js
// 是同一份内容)。当前源置顶到所属分组第一行;分组只有类型这一种口径
// (点播 / 插件 / 直播),不记任何「最近使用」历史。

let srcMenuCloser = null; // 关掉当前这层容器(sheet.close / 去掉 data-open)

/** 健康状态 → 四态 + 文案(判定口径见 docs/DESIGN-SPEC-UI.md §2.5) */
function fmtMs(ms) {
  const n = Number(ms || 0);
  return n >= 1000 ? (n / 1000).toFixed(1) + "s" : Math.round(n) + "ms";
}

function healthOf(src) {
  if (src && src._testing) return { state: "testing", label: "测速中…" };
  const h = src && src.health;
  if (!h) return { state: "untested", label: "未测速" };
  // 后端 Health 的备注字段叫 note;老数据/老前端写过 error,两个都认
  const note = h.note || h.error || "";
  if (!h.ok) return { state: "fail", label: "连接失败" + (note ? " · " + note : "") };
  const ms = Number(h.ms || 0);
  if (ms < 800) return { state: "ok", label: "正常 · " + fmtMs(ms) };
  return { state: "slow", label: "偏慢 · " + fmtMs(ms) };
}

/** UTC ISO8601 秒精度,和 Rust 的 now_iso() 同一个形状(health.checked_at) */
function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** 失败原因留前 40 字:状态点的 tooltip 放不下整段 blame */
function shortNote(text) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}

function srcTypeIcon(s) {
  const t = sourceType(s);
  if (t === "plugin") return "extension";
  if (t === "live") return "live_tv";
  return "ondemand_video";
}

/** 组好切源面板需要的数据(只列可用的源、按类型分组、当前源置顶、搜索过滤) */
function srcPanelModel(query) {
  const q = String(query || "").trim().toLowerCase();
  const all = S.sources || [];
  // 只画「可用于当前功能」的源:坏掉的配置不进列表,健康检查失败的源照常进
  const usable = all.filter(isUsableSource);
  const hit = (s) => !q || (String(s.name) + " " + String(s.url)).toLowerCase().indexOf(q) >= 0;
  const toRow = (s) => {
    const h = healthOf(s);
    return {
      // 下标仍按整份 S.sources 算:行按它派发,面板里筛掉的源不影响别人
      idx: all.indexOf(s),
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
    ["live", "直播"], // 直播源现在不可用(isUsableSource 不放行),这一组自然空着
  ].map(([key, label]) => {
    const rows = usable.filter((s) => sourceType(s) === key && hit(s)).map(toRow);
    // 当前源置顶到所属分组第一行
    rows.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
    return { key, label, rows };
  });
  return {
    groups,
    total: usable.length, // 搜索框的出现看可用源的数量
    query: query || "",
    empty: all.length ? (usable.length ? "" : "unusable") : "none",
  };
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
    if (e.target.closest('[data-act="import"]')) {
      closeSrcMenu();
      runSingleImport(); // 面板里只给「导入源」:批量导入在源页底栏
      return;
    }
    const row = e.target.closest("[data-idx]");
    if (!row) return;
    const src = (S.sources || [])[Number(row.getAttribute("data-idx"))];
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
  // 拖拽 / 点遮罩 / Esc 关掉 sheet 时要顺手清掉 closer,否则 srcMenuOpen() 一直是 true,
  // 下一次点源按钮的第一下会被当成"关闭"(I3 的另一半)
  let closer = null;
  const sheet = openSheet({
    content: panel,
    label: "切换源",
    onClose: () => { if (srcMenuCloser === closer) srcMenuCloser = null; },
  });
  closer = () => sheet.close();
  srcMenuCloser = closer;
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
  // 直播:名字直接写进磁贴(台标来源太杂,有的方有的宽还有一半是坏的);
  // 点播仍是 2:3 海报
  const live = sourceType(S.source) === "live";
  if (grid) grid.classList.toggle("grid--live", live);
  applyPosterRatio(grid);
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
        live
          ? '<article class="card" data-i="' + (from + k) + '">' +
            '<div class="poster poster--text">' +
            '<span class="poster__name">' + esc(it.title) + "</span>" +
            (it.subtitle ? '<span class="badge">' + esc(it.subtitle) + "</span>" : "") +
            "</div></article>"
          : '<article class="card" data-i="' + (from + k) + '"><div class="poster">' +
            (it.subtitle ? '<span class="badge">' + esc(it.subtitle) + "</span>" : "") +
            '</div><div class="meta"><b>' + esc(it.title) + "</b></div></article>"
    )
    .join("");
  const added = Array.from(frag.children);
  added.forEach((el) => grid.appendChild(el));

  added.forEach((el, k) => {
    if (live) return; // 直播卡不加载图片
    const it = S.items[from + k];
    if (!it || !it.poster) return;
    const box = el.querySelector(".poster");
    posterFor(it.poster)
      .then((u) => {
        const img = document.createElement("img");
        img.alt = "";
        img.src = u;
        box.classList.add("has-img");
        // 台标是方的就 contain(裁了会掉字),本身够宽就 cover 铺满
        img.addEventListener("load", () => {
          const r = img.naturalWidth / (img.naturalHeight || 1);
          if (r >= 1.3) img.classList.add("is-wide");
        });
        box.prepend(img);
      })
      .catch(() => {
        // 台标没下下来(常见于 gitee 图床被墙):退成图标,别留空白
        if (!box.querySelector(".poster__icon")) {
          box.insertAdjacentHTML(
            "afterbegin",
            '<span class="m3e-icon poster__icon" aria-hidden="true">live_tv</span>'
          );
        }
      });
  });
}

/** 封面比例:源上存的是 "16:9" 这种,转成 CSS 认的 "16 / 9" */
function applyPosterRatio(grid) {
  if (!grid) return;
  const raw = String((S.source && S.source.posterRatio) || "").trim();
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(raw);
  if (m) grid.style.setProperty("--poster-ratio", m[1] + " / " + m[2]);
  else grid.style.removeProperty("--poster-ratio");
}

function resetGrid() {
  const g0 = $("grid");
  if (g0) g0.classList.toggle("grid--live", sourceType(S.source) === "live");
  applyPosterRatio(g0);
  clearSkeleton();
  $("grid").innerHTML = "";
}

/* ---------- 收藏(喜欢) ---------- */
// localStorage["reelbox.favs"]:键 = 源id|片名,值 = {sourceId,id,title,poster,addedAt}。
// 键里带源 id,同名片在不同源里是两条;源被删掉时条目留着(不可播,点了会说清楚)。

const FAV_KEY = "reelbox.favs";

function favAll() {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

function favSave(map) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(map)); } catch (_) {}
  S.favs = map;
}

function favKey(sourceId, title) {
  return String(sourceId || "") + "|" + String(title || "");
}

function favGet(sourceId, title) {
  return favAll()[favKey(sourceId, title)] || null;
}

/** 新的在前 */
function favList() {
  const all = favAll();
  return Object.keys(all)
    .map((k) => all[k])
    .filter((f) => f && f.title)
    .sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));
}

/** 收藏/取消收藏;返回 true 表示现在是收藏状态 */
function favToggle(fav) {
  const all = favAll();
  const k = favKey(fav.sourceId, fav.title);
  let on;
  if (all[k]) {
    delete all[k];
    on = false;
  } else {
    all[k] = {
      sourceId: String(fav.sourceId || ""),
      id: String(fav.id || ""),
      title: String(fav.title || ""),
      poster: String(fav.poster || ""),
      addedAt: new Date().toISOString(),
    };
    on = true;
  }
  favSave(all);
  renderFavs();
  return on;
}

/** 删掉一条收藏(按「源id|片名」的键,顺带清掉 sourceId 对不上的老键) */
function favRemove(fav) {
  const all = favAll();
  let hit = false;
  for (const k of Object.keys(all)) {
    const v = all[k] || {};
    const same = k === favKey(fav.sourceId, fav.title);
    const loose = v.title === fav.title && String(v.sourceId || "") === String(fav.sourceId || "");
    if (same || loose) {
      delete all[k];
      hit = true;
    }
  }
  if (hit) {
    favSave(all);
    renderFavs();
  }
  return hit;
}

/** 清掉指向某个源的全部收藏;返回清掉的条数 */
function favRemoveBySource(sourceId) {
  const all = favAll();
  let n = 0;
  for (const k of Object.keys(all)) {
    const v = all[k] || {};
    if (String(v.sourceId || "") === String(sourceId || "") || String(k).split("|")[0] === String(sourceId || "")) {
      delete all[k];
      n++;
    }
  }
  if (n) {
    favSave(all);
    renderFavs();
  }
  return n;
}

/** 有多少条收藏指着这个源 */
function favCountForSource(sourceId) {
  return favList().filter((f) => String(f.sourceId || "") === String(sourceId || "")).length;
}

/**
 * 重新定位源:把一条收藏改挂到另一个源上(源 id 变了、或者当初挂错了源)。
 * 键是「源id|片名」,所以这里要换键,不能原地改值。
 */
async function favRelink(fav) {
  const list = S.sources || [];
  if (!list.length) {
    alertDialog("没有可用的源", "先去「设置 → 源」加一个源,再回来重新定位。");
    return;
  }
  const cur = list.findIndex((s) => s.id === fav.sourceId);
  const res = await formDialog({
    icon: "link",
    headline: "重新定位源",
    okText: "保存",
    fields: [
      {
        id: "src",
        label: "这条收藏挂到哪个源",
        type: "select",
        // 用下标当值:id 重复时也不会指错(见 A1)
        value: String(cur < 0 ? 0 : cur),
        options: list.map((s, i) => ({ value: String(i), label: s.name + (s.id === fav.sourceId ? "(当前)" : "") })),
      },
    ],
    note: "只改这条收藏指向的源;片名不变,点进去用新源同名条目播放。",
  });
  if (!res) return;
  const src = list[Number(res.src)];
  if (!src) return;
  const all = favAll();
  delete all[favKey(fav.sourceId, fav.title)];
  all[favKey(src.id, fav.title)] = Object.assign({}, fav, { sourceId: src.id });
  favSave(all);
  renderFavs();
  toast("已挂到「" + src.name + "」");
}

/** 收藏卡右上角的 ⋮ 菜单:移除 / 重新定位源 */
function openFavMenu(fav, anchor) {
  const dead = !(S.sources || []).some((s) => s.id === fav.sourceId);
  return openMenu(
    anchor,
    [
      { type: "label", label: dead ? "源已删除" : "收藏" },
      { id: "remove", label: "移除收藏", icon: "delete", danger: true },
      { id: "relink", label: "重新定位源", icon: "link" },
    ],
    (id) => {
      if (id === "remove") {
        if (favRemove(fav)) toast("已移除「" + fav.title + "」");
        return;
      }
      if (id === "relink") favRelink(fav);
    }
  );
}

function syncFavBtn(btn, on) {
  if (!btn) return;
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  const label = on ? "取消收藏" : "收藏";
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

/** 详情页标题旁的 ♡:实心 = 已收藏(aria-pressed 同时给读屏和样式用) */
function favBtnHtml(d) {
  const on = !!favGet(S.source && S.source.id, d.title);
  return (
    '<button type="button" class="m3e-icon-button m3e-icon-button--standard fav-btn" id="btnFav"' +
    ' aria-pressed="' + (on ? "true" : "false") + '"' +
    ' aria-label="' + (on ? "取消收藏" : "收藏") + '" title="' + (on ? "取消收藏" : "收藏") + '">' +
    '<span class="m3e-icon" aria-hidden="true">favorite</span></button>'
  );
}

/** 喜欢页:复用首页卡片(同一套 .card / .poster),点进去走 openFav */
function renderFavs() {
  const grid = $("favGrid");
  const empty = $("favEmpty");
  if (!grid || !empty) return;
  const list = favList();
  // 源被删掉的条目留着但灰化(A1/源删除之后卡片不该永久装死也删不掉,见 I4)
  grid.innerHTML = list
    .map((f, i) => {
      const src = (S.sources || []).find((s) => s.id === f.sourceId);
      return (
        '<article class="card' + (src ? "" : " card--dead") + '" data-fav="' + i + '">' +
        '<div class="poster">' +
        (src
          ? '<span class="badge">' + esc(src.name) + "</span>"
          : '<span class="badge badge--dead">源已删除</span>') +
        '<button type="button" class="card__more" data-favmenu="' + i +
          '" aria-haspopup="menu" aria-label="收藏操作 · ' + esc(f.title) + '">' +
          '<span class="m3e-icon" aria-hidden="true">more_vert</span></button>' +
        '</div><div class="meta"><b>' + esc(f.title) + "</b></div></article>"
      );
    })
    .join("");

  const cards = Array.from(grid.children);
  list.forEach((f, i) => {
    const el = cards[i];
    if (!el) return;
    const more = el.querySelector("[data-favmenu]");
    if (more) {
      more.onclick = (e) => {
        e.stopPropagation(); // 别让卡片的点击把详情打开
        openFavMenu(f, more);
      };
    }
    if (!f.poster) return;
    const box = el.querySelector(".poster");
    posterFor(f.poster)
      .then((u) => {
        const img = document.createElement("img");
        img.alt = "";
        img.src = u;
        box.classList.add("has-img");
        box.prepend(img);
      })
      .catch(() => {});
  });

  empty.style.display = list.length ? "none" : "";
  if (list.length) {
    empty.innerHTML = "";
    return;
  }
  empty.innerHTML = stateCard({
    icon: "favorite",
    title: "还没有收藏",
    msg: "在剧集详情页点一下标题旁的 ♡,就会收到这里。",
    actions: [{ id: "home", label: "去首页看看" }],
  });
  const b = empty.querySelector('[data-act="home"]');
  if (b) b.onclick = () => showView("home");
}

/** 收藏项 → 详情:先切回收藏时的那个源,再打开 */
async function openFav(f) {
  const src = (S.sources || []).find((s) => s.id === f.sourceId);
  if (!src) {
    // 僵尸收藏:能给的两条出路是"重新定位源"和"删掉",别只弹一句话就完事(I4)
    const pick = await dialog({
      icon: "link_off",
      headline: "这条收藏的源已经删了",
      content:
        '<p class="dlg-text">「' + esc(f.title) + "」当初是用一个已经不存在的源收藏的。" +
        "重新定位到一个源,或者把这条收藏清掉。</p>",
      actions: [
        { label: "关闭", value: null },
        { label: "移除收藏", value: "remove", danger: true },
        { label: "重新定位源", value: "relink", primary: true },
      ],
    });
    if (pick === "remove") {
      if (favRemove(f)) toast("已移除「" + f.title + "」");
    } else if (pick === "relink") {
      await favRelink(f);
    }
    return;
  }
  if (!S.source || S.source.id !== src.id) {
    await switchSource(src);
    // 静默换源会让人以为列表自己变了:说一句
    toast("已切到「" + src.name + "」以匹配这条收藏");
  }
  await openDetail({ id: f.id, title: f.title, poster: f.poster || "" });
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

  const body = detailBody();
  body.parentElement.removeAttribute("data-skel");
  body.innerHTML =
    '<button class="back" id="btnBack" aria-label="返回">' +
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z" fill="currentColor"/></svg>' +
    "</button>" +
    '<div class="detail-top">' +
      '<div class="hero"><img alt=""></div>' +
      '<div class="hero-meta">' +
        '<div class="detail-title"><h2>' + esc(d.title) + "</h2>" + favBtnHtml(d) + "</div>" +
        (summary ? '<p id="sum">' + esc(summary) + "</p>" : "") +
        (summary.length > 90 ? '<button class="more" id="btnMore">展开</button>' : "") +
      "</div>" +
    "</div>" +
    resumeBtn +
    (groups || '<p class="noep">这个源没给剧集列表</p>');

  $("btnBack").onclick = () => closeDetail();

  const btnFav = $("btnFav");
  if (btnFav) {
    btnFav.onclick = () => {
      const on = favToggle({
        sourceId: S.source && S.source.id,
        id: S.detailId || d.id,
        title: d.title,
        poster: d.poster || "",
      });
      syncFavBtn(btnFav, on);
      toast(on ? "已加入「喜欢」" : "已取消收藏", on ? { actionLabel: "去看看", onAction: () => showView("fav") } : undefined);
    };
  }

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

/** 类型下拉的四个取值;title 是给人看的说法 */
const KIND_OPTIONS = [
  { value: "vod", label: "点播(JSON)", title: "苹果 CMS 的 /api.php/provide/vod" },
  { value: "xml", label: "点播(XML)", title: "…/at/xml 或 .xml" },
  { value: "live", label: "直播(m3u/m3u8)", title: "频道列表,v0.3 才播放" },
  { value: PLUGIN_KIND, label: "插件(JS)", title: "本地插件文件" },
];

function kindTitle(kind) {
  const hit = KIND_OPTIONS.find((o) => o.value === kind);
  return hit ? hit.label : kind;
}

/**
 * 地址 → 类型。认不出来的返回 ""(只有这时才让用户手选)。
 *   .m3u8 / .m3u                            → live
 *   .js(插件就是 js 文件)                → 插件
 *   provide/vod、api.php、ac=list/detail   → vod
 *   /at/xml、ac=xml、.xml                  → xml
 */
function guessSourceKind(url) {
  const raw = String(url || "").trim().toLowerCase();
  if (!raw) return "";
  const path = raw.split(/[?#]/)[0];
  if (/\.m3u8?$/.test(path)) return "live";
  if (path.endsWith(".js")) return PLUGIN_KIND;
  if (/\/at\/xml$/.test(path) || /[?&]ac=xml\b/.test(raw) || path.endsWith(".xml")) return "xml";
  if (/provide\/vod/.test(path) || /\/api\.php/.test(path) || /[?&]ac=(list|detail)\b/.test(raw)) {
    return "vod";
  }
  return "";
}

/** 把各种历史写法归一到 vod / xml / live / 插件 */
function normKind(kindRaw, url) {
  const k = String(kindRaw == null ? "" : kindRaw).toLowerCase();
  if (k === "1" || k === "xml") return "xml";
  if (k === "json" || k === "vod") return "vod";
  if (k === "live" || k === "m3u" || k === "m3u8") return "live";
  if (isPluginKind(k)) return PLUGIN_KIND;
  return guessSourceKind(url) || "vod";
}

function normSource(raw) {
  const url = (raw.url || raw.api || "").trim();
  const name = (raw.name || raw.key || "").trim();
  if (!url || !name) return null;
  const kind = normKind(raw.kind || raw.type, url);
  // id 不再由名字生成(见 normalizeSourceIds):这里只负责搬过来,
  // 缺了或者靠不住的时候由 normalizeSourceIds 按地址补。
  const id = String(raw.id == null ? "" : raw.id).trim();
  // 后端把 kind 序列化成 type,这里跟着用 type,免得存回去时丢类型
  const src = { id: id, name: name, type: kind, url: url };
  // 适配器与探测证据(P1/P2):导入时判定一次就落盘,之后一条源"走哪条路"
  // 只看 adapter —— 存回去时不能弄丢(见 docs/ARCHITECTURE.md 第 2 节)
  const adapter = String(raw.adapter == null ? "" : raw.adapter).trim();
  if (adapter) src.adapter = adapter;
  // 需要人工校验的源:这个开关要跟着源一起存(运行时靠它决定弹不弹校验页)
  if (raw.verify) src.verify = true;
  const vurl = String(raw.verifyUrl == null ? "" : raw.verifyUrl).trim();
  if (vurl) src.verifyUrl = vurl;
  const ratio = String(raw.posterRatio == null ? "" : raw.posterRatio).trim();
  if (ratio) src.posterRatio = ratio;
  const probe = raw.probe;
  if (probe && typeof probe === "object" && !Array.isArray(probe)) {
    const one = {
      at: String(probe.at || ""),
      ok: !!probe.ok,
      items: Number(probe.items) || 0,
      sample: String(probe.sample || ""),
    };
    // 失败的那次带一句原因(四类码 + 一句话),成功的不用
    if (probe.error) one.error = String(probe.error);
    src.probe = one;
  }
  // 版本:插件自己声明的版本号;空的时候不占字段
  const version = String(raw.version == null ? "" : raw.version).trim();
  if (version) src.version = version;
  // 引擎插件的站点配置(见 docs/ENGINE-PLUGINS.md):原样搬过来,
  // 缺了就当作没有 —— 不写空对象,免得给旧数据添一个没用的字段
  const options = raw.options;
  if (options && typeof options === "object" && !Array.isArray(options) && Object.keys(options).length) {
    src.options = options;
  }
  return src;
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
  return normalizeSourceIds(out).list;
}

/* ---------- 源 id:与名字解耦 ---------- */
// 老实现拿名字生成 id(name → slug),中文名整段被替换,最后只剩一串横线:
//   -3 = 独播库、-5 = 厂长资源、-7 = 欧乐影视、-8 = 无水印资源
// 两个中文源撞同一个 id 时,点 A 行会切到 B 源、删一个会删两个。
// 现在 id 只跟地址有关(url 的 32 位短哈希):名字随便改都不影响 id,重复扫描也幂等。
// 收藏与进度的键是「源id|片名」,所以换 id 时必须同步改写那些键 —— 见 rewriteIdKeys()。

/** FNV-1a 32 位 → 8 位十六进制。同一地址永远得到同一个 id,迁移可以反复跑 */
function shortHash(text) {
  const s = String(text == null ? "" : text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function randId() {
  try {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    }
  } catch (_) {
    /* 没有 crypto:退到 Math.random */
  }
  return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}

/** 取一个新 id:优先地址短哈希(幂等);撞车了加 -2 / -3 */
function freshSourceId(seed, taken) {
  const base = String(seed || "").trim() ? shortHash(seed) : randId();
  let id = base;
  let n = 2;
  while (taken.has(id)) {
    id = base + "-" + n;
    n++;
  }
  taken.add(id);
  return id;
}

/** 老算法:名字 → slug;只用来认出"名字塌掉了"的 id */
function legacySlug(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/gi, "-").slice(0, 24);
}

/**
 * 这个 id 靠不住吗?
 *   空的 / 和前一个重复 / 名字塌成一串横线(-3、-、--)/
 *   中文名派生出来的(老算法把汉字全换成 -,id 名字已经无关了)
 */
function weakSourceId(id, name, seen) {
  const s = String(id || "").trim();
  if (!s) return true;
  if (seen && seen.has(s)) return true;
  // 能用的 id:ASCII 字母数字开头,后面只跟字母数字 / - / _(老配置里的 dytt、user-4kvm 都在此列)。
  // "-3" / "-" / "--" / 中文 一概算坏 id —— 它们都是"名字塌成一串横线"的产物。
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(s)) return true;
  if (!/[\u0080-\uffff]/.test(String(name || ""))) return false;
  const base = legacySlug(name).replace(/-+$/, "");
  const tail = s.replace(/-\d+$/, "").replace(/-+$/, "");
  return !!base && base === tail;
}

/**
 * 扫一遍源列表:靠不住的 id 换成地址短哈希,靠得住的保持原样(收藏和进度都指着它)。
 * 返回 { list, remap } —— remap 只收「老 id 现在已经没有主人」的那些,
 * 重复 id 时第一个占住原 id,后面的换新,键跟着留在原主身上(不然分不清是谁的)。
 */
function normalizeSourceIds(list) {
  const src = Array.isArray(list) ? list : [];
  const seen = new Set();
  const taken = new Set();
  const keeps = [];
  src.forEach((s, i) => {
    const id = String((s && s.id) || "").trim();
    const ok = !weakSourceId(id, s && s.name, seen);
    if (id) seen.add(id);
    keeps[i] = ok;
    if (ok) taken.add(id);
  });
  const out = src.map((s, i) => {
    const id = String((s && s.id) || "").trim();
    if (keeps[i]) return id === (s.id || "") ? s : Object.assign({}, s, { id: id });
    return Object.assign({}, s, { id: freshSourceId(s && s.url, taken) });
  });
  const alive = new Set(out.map((s) => s.id));
  const remap = new Map();
  src.forEach((s, i) => {
    const old = String((s && s.id) || "").trim();
    const next = out[i].id;
    if (old && old !== next && !alive.has(old) && !remap.has(old)) remap.set(old, next);
  });
  return { list: out, remap };
}

/**
 * 换 id 的连带修改:收藏 / 进度 / 当前源 全都拿源 id 当键。
 * 不跟着改的话,用户点过的收藏与看到一半的进度会全部失联。
 */
function rewriteIdKeys(remap) {
  if (!remap || !remap.size) return;
  const pick = (id) => {
    let cur = String(id || "");
    for (let i = 0; i < 8 && remap.has(cur); i++) cur = remap.get(cur);
    return cur;
  };
  const splitKey = (k) => {
    const s = String(k || "");
    const at = s.indexOf("|");
    return at < 0 ? [s, ""] : [s.slice(0, at), s.slice(at + 1)];
  };
  const mkKey = (sid, rest) => sid + "|" + rest;

  // 收藏:键与条目里的 sourceId 都要改
  const favs = favAll();
  let favHit = 0;
  const nextFavs = {};
  for (const k of Object.keys(favs)) {
    const [sid, rest] = splitKey(k);
    const sid2 = remap.has(sid) ? pick(sid) : sid;
    const k2 = mkKey(sid2, rest);
    if (k2 !== k) favHit++;
    nextFavs[k2] = Object.assign({}, favs[k], { sourceId: sid2 });
  }
  if (favHit) favSave(nextFavs);

  // 进度:键是「源id|片名」
  const prog = progAll();
  let progHit = 0;
  const nextProg = {};
  for (const k of Object.keys(prog)) {
    const [sid, rest] = splitKey(k);
    const sid2 = remap.has(sid) ? pick(sid) : sid;
    const k2 = mkKey(sid2, rest);
    if (k2 !== k) progHit++;
    nextProg[k2] = prog[k];
  }
  if (progHit) progWrite(nextProg);

  // 当前源 / 直播源:值是 id
  [LS.currentSource, LS.currentLiveSource].forEach((key) => {
    const v = prefGet(key, "");
    if (v && remap.has(v)) prefSet(key, pick(v));
  });
  log("id remap", "fav=" + favHit, "prog=" + progHit, "n=" + remap.size);
}

/** 启动/导入时跑一遍:换掉靠不住的 id,并把收藏与进度的键搬过去 */
function migrateSourceIds() {
  const { list, remap } = normalizeSourceIds(S.sources || []);
  const changed =
    remap.size > 0 ||
    list.some((s, i) => s.id !== ((S.sources[i] || {}).id || ""));
  if (!changed) return false;
  const before = (S.sources || []).map((s) => s.id).join(",");
  S.sources = list;
  rewriteIdKeys(remap);
  persistSources();
  log(
    "source ids migrated",
    before + " → " + list.map((s) => s.id).join(","),
    "remap=" + remap.size
  );
  return true;
}

/** 源的 kind:后端序列化叫 type,早期前端写的是 kind,两个都认 */
function srcKind(s) {
  return String((s && (s.type || s.kind)) || "").toLowerCase();
}

/** 源的类别:vod / plugin / live */
function sourceType(s) {
  if (!s) return "vod";
  const kind = srcKind(s);
  const url = String(s.url || "");
  // kind=live 优先:直播源也可以是插件形态,不能因为"它是插件"就归成点播
  if (kind === "live") return "live";
  if (isPluginSource(s)) return "plugin";
  if (/\.m3u8?$/i.test(url.split(/[?#]/)[0])) return "live";
  return "vod";
}

/** 源列表用的那份清单(切源面板、源页、测速都按它算) */
function listableSources() {
  return S.sources || [];
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
  // iplayr:地址是站点配置,不是接口也不是插件文件
  if (sourceAdapter(s) === "iplayr") return "站点配置";
  const path = String((s && s.url) || "").split(/[?#]/)[0].toLowerCase();
  if (t === "plugin") return path.endsWith(".reelbox.js") ? ".reelbox.js" : "JS 文件";
  if (t === "live") return path.endsWith(".m3u") ? "m3u" : "m3u8";
  return srcKind(s) === "xml" ? "XML" : "JSON";
}

/**
 * 行副标题:插件的地址是磁盘路径,老文件的后缀里还带着旧名字 ——
 * 界面上只说「本地插件 · 文件名」,不把那个名字露给用户。
 */
function srcSubtitle(s) {
  if (!s) return "";
  if (sourceType(s) !== "plugin") return String(s.url || "");
  const base = String(s.url || "").split(/[\\/]/).pop() || "";
  const stem = base.replace(/(\.[^.]+)+$/, "") || base;
  return stem ? "本地插件 · " + stem : "本地插件";
}

/** 状态点:形状 + 颜色双通道(样式见 index.html 的 .status-dot 四态) */
function statusDotHtml(src) {
  const h = healthOf(src);
  // 状态点是 health 数据的可视化,不是行的装饰:没测过就什么都不显示(评审 1)
  if (h.state === "untested") return "";
  return (
    '<span class="status-dot" data-state="' + esc(h.state) + '" role="img" aria-label="' +
      esc(h.label) + '" title="' + esc(h.label) + '"></span>'
  );
}

/** 源管理页:当前过滤段没有源时的空态,带下一步 */
function showSrcEmpty(box) {
  const label = { all: "还没有任何源", vod: "没有点播源", plugin: "没有插件源", live: "还没有直播源" }[S.srcFilter] || "这里还没有源";
  const tip =
    S.srcFilter === "live"
      ? "直播源要等 v0.3 才支持播放,现在导入只会登记。"
      : S.srcFilter === "all"
      ? "点「导入源」,填链接或挑个文件:源和插件都认,类型自动判断。"
      : "切到「全部」看看,或者用「导入源」加一个。";
  box.innerHTML = stateCard({
    icon: S.srcFilter === "live" ? "live_tv" : "dns",
    title: label,
    msg: tip,
    actions:
      S.srcFilter === "all"
        ? [
            { id: "import", label: "导入源" },
            { id: "batch", label: "批量导入", soft: true },
          ]
        : [],
  });
  const imp = box.querySelector('[data-act="import"]');
  if (imp) imp.onclick = () => runSingleImport();
  const bt = box.querySelector('[data-act="batch"]');
  if (bt) bt.onclick = () => runBatchImport();
}

/* ---------- 设置 → 源 → 适配器块 ---------- */
// 适配器 = 「某种源格式怎么翻译成 list/detail/play」的那部分 js
// (契约见 docs/ARCHITECTURE.md 第 4 节)。内置四个随包安装,用户也能自己写一个导入
// (`plugins/*.adapter.js`)。**适配器不是源**:装好之后还得有一条配置地址。
// 清单由后端给(list_adapters):内置的写在 Rust 里,导入的是扫插件目录扫出来的。

/** list_adapters() 的结果:内置在前,导入的在后。进来一次就够,删/导入之后再取 */
let adapterList = [];

/** 重新问一遍适配器清单并重画这一块。失败时保留上一次的清单,只报日志 */
async function loadAdapters() {
  try {
    const list = await invoke("list_adapters");
    adapterList = Array.isArray(list) ? list : [];
  } catch (e) {
    log("LIST ADAPTERS FAIL", errText(e));
  }
  renderAdapterManager();
  return adapterList;
}

/**
 * 适配器块:每行 = 名字 + 「内置 / 导入」徽标 + 一行说明。
 * 内置的说明是 hint(config 该填什么),导入的说明是 adapter id;导入的右边带删除。
 * 只有内置时没有提示文案,直接列出来 —— 这一块本身就是"这里有什么适配器"的答案。
 */
function renderAdapterManager() {
  const box = $("adaptermgr");
  if (!box) return;
  // 原生插件直接实现接口,没有翻译层 —— 列在这里只会让人以为"插件也是一种适配器"
  box.innerHTML = (adapterList || [])
    .filter((a) => String(a.id) !== "reelbox")
    .map((a) => {
      const builtin = !!a.builtin;
      const path = String(a.path || "");
      const note = builtin ? String(a.hint || "") : String(a.id || "");
      return (
        '<div class="m3e-list-item" data-type="adapter" data-builtin="' + (builtin ? "1" : "0") + '"' +
          (builtin ? "" : ' data-path="' + esc(path) + '"') + ">" +
          '<span class="m3e-list-item__leading">' +
            '<span class="m3e-icon" aria-hidden="true">extension</span></span>' +
          '<span class="m3e-list-item__content">' +
            '<span class="m3e-list-item__headline">' +
              '<span class="src-row__name">' + esc(a.name) + "</span>" +
              '<span class="src-badge"' + (builtin ? "" : ' data-type="plugin"') + ">" +
                (builtin ? "内置" : "导入") + "</span>" +
            "</span>" +
            '<span class="m3e-list-item__supporting">' + esc(note) + "</span>" +
          "</span>" +
          '<span class="m3e-list-item__trailing">' +
            (builtin
              ? ""
              : '<button type="button" class="m3e-icon-button m3e-icon-button--standard" data-act="adapter-del" data-path="' +
                esc(path) + '" aria-label="删除适配器 · ' + esc(a.name) + '">' +
                '<span class="m3e-icon" aria-hidden="true">delete</span></button>') +
          "</span>" +
        "</div>"
      );
    })
    .join("");
}

/** 删掉一个导入的适配器:删文件 + 重取清单。内置的那几个没有删除按钮 */
async function removeAdapter(entry) {
  if (!entry || entry.builtin || !entry.path) return;
  const ok = await confirmDialog(
    "删除适配器「" + entry.name + "」?",
    "删掉之后,靠它解析的源会报「适配器没装上」。可以再导入一次。",
    "删除",
    true
  );
  if (!ok) return;
  try {
    await invoke("delete_adapter", { path: entry.path });
  } catch (e) {
    log("ADAPTER DELETE FAIL", errText(e));
    alertDialog("删除失败", errText(e));
    return;
  }
  log("adapter removed", String(entry.id));
  await loadAdapters();
  toast("已删除适配器「" + entry.name + "」");
}

/** 适配器块的交互:导入(复用导入对话框)+ 删除导入的 */
function bindAdapterManager() {
  const box = $("adaptermgr");
  if (box && !box.dataset.bound) {
    box.dataset.bound = "1";
    box.onclick = (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b || b.getAttribute("data-act") !== "adapter-del") return;
      const path = String(b.getAttribute("data-path") || "");
      const entry = (adapterList || []).find((x) => !x.builtin && String(x.path || "") === path);
      removeAdapter(entry);
    };
  }
  const imp = $("adapterImport");
  if (imp && !imp.dataset.bound) {
    imp.dataset.bound = "1";
    imp.onclick = () => runSingleImport(undefined, { adapter: true });
  }
  loadAdapters();
}

/**
 * 源列表:m3e list item,每项 = 图标容器 / 名称 + 类型徽标 / 地址 + 右侧「进去看」「更多」。
 * 容器颜色按类型(点播 secondary / 插件 tertiary / 直播 error 族);当前源只把
 * 图标容器换成 primary、名称加粗,不再整行铺色(评审 §0-3、§2.4)。
 */
function renderSourceManager() {
  const box = $("srcmgr");
  // 分段计数与列表永远同源同刷:导入/新增/删除之后不会再出现 11 vs 12(I7)
  renderSrcSeg();
  // 适配器块用自己那份清单(list_adapters):源列表怎么变都不影响它,重画一次只为跟上
  renderAdapterManager();
  if (!box) return;
  const all = S.sources || [];
  const sources = listableSources();
  const list = S.srcFilter === "all" ? sources : sources.filter((s) => sourceType(s) === S.srcFilter);
  if (!list.length) {
    // 过滤后 0 条必须给空态(带下一步),不能只剩一句灰字(A-8)
    showSrcEmpty(box);
    return;
  }
  // 行上用「列表下标」而不是 id:同 id 的两条源不会互相误伤(A1)
  box.innerHTML = list
    .map((s) => {
      const active = !!(S.source && S.source.id === s.id);
      const crawl = isCrawlSource(s);
      const idx = all.indexOf(s);
      const type = sourceType(s);
      return (
        '<div class="m3e-list-item" data-idx="' + idx + '" data-type="' + esc(type) + '"' +
          (active ? ' aria-current="true"' : "") + ">" +
          '<span class="m3e-list-item__leading">' +
            '<span class="m3e-icon" aria-hidden="true">' + esc(srcTypeIcon(s)) + "</span></span>" +
          '<span class="m3e-list-item__content">' +
            // 状态点放在标题行里:它要跟名称那一行对齐,而不是跟 72 高的整行中心对齐
            '<span class="m3e-list-item__headline">' +
              '<span class="src-row__name">' + esc(s.name) + "</span>" +
              '<span class="src-badge" data-type="' + esc(type) + '">' + sourceKindLabel(s) + "</span>" +
              (crawl
                ? '<span class="src-badge src-badge--warn" title="地址是 HTML 爬取配置,不是点播接口">取不到数据</span>'
                : "") +
              statusDotHtml(s) +
            "</span>" +
            '<span class="m3e-list-item__supporting">' + esc(srcSubtitle(s)) + "</span>" +
          "</span>" +
          '<span class="m3e-list-item__trailing">' +
            // 行尾只留一个「更多」:状态点是状态、容器+名称 600 是当前源,
            // 再加箭头/勾就是第三种标记了(评审 1;§2.3 行尾 = 状态点 + 更多)
            '<button type="button" class="m3e-icon-button m3e-icon-button--standard" data-act="more" data-idx="' +
              idx + '" aria-haspopup="menu" aria-label="更多 · ' + esc(s.name) + '">' +
              '<span class="m3e-icon" aria-hidden="true">more_vert</span></button>' +
          "</span>" +
        "</div>"
      );
    })
    .join("");
}

/** 行「更多」菜单:进去看 / 编辑 / 测试连接 / 设为当前 / 置顶 / 复制地址 / 删除 */
function openSourceRowMenu(src, anchor) {
  const active = !!(S.source && S.source.id === src.id);
  const firstInList = (S.sources || []).indexOf(src) === 0;
  return openMenu(
    anchor,
    [
      { type: "label", label: sourceKindLabel(src) + " · " + sourceTechLabel(src) },
      // 「进去看」= 真的进这个源的首页;点行只切源、留在源页,两件事分开(I5)。
      // 行尾不再放箭头按钮(评审 1),这个动作收进菜单第一项。
      { id: "home", label: "进去看", icon: "arrow_forward" },
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
  if (id === "home") return showView("home");
  if (id === "edit") return editSource(src);
  if (id === "current") return setCurrentSource(src);
  if (id === "pin") return pinSource(src);
  if (id === "copy") return copySourceUrl(src);
  if (id === "del") return removeSource(src);
}

/** 当前是不是正站在设置页上(决定切源之后要不要留在这一页) */
function onSettingsView() {
  const v = $("v-settings");
  return !!(v && v.hasAttribute("data-on"));
}

/**
 * 设为当前:走统一的 switchSource(会写 currentSource)。
 * opts.stay = 留在源管理页(点行就是这条路,见 I5);3 秒内可撤销。
 */
async function setCurrentSource(src, opts) {
  if (!src) return;
  const stay = !!(opts && opts.stay);
  if (S.source && S.source.id === src.id) {
    if (stay) toast("「" + src.name + "」已经是当前源");
    return;
  }
  const prev = S.source;
  const done = await switchSource(src, { stay: stay });
  if (done === false) return; // 播放中确认框被取消:什么都没变
  renderSourceManager();
  toast("已切到「" + src.name + "」", prev ? {
    actionLabel: "撤销",
    timeout: 3000, // 3 秒内可撤销
    onAction: () => undoSwitchSource(prev, stay),
  } : undefined);
}

/** 撤销切源:切回上一个源,人在源页就继续留在源页 */
async function undoSwitchSource(prev, stay) {
  if (!prev) return;
  if (!(S.sources || []).some((s) => s.id === prev.id)) return;
  const done = await switchSource(prev, { stay: stay || onSettingsView() });
  if (done === false) return;
  renderSourceManager();
  toast("已切回「" + prev.name + "」");
}

/** 置顶 = 把它挪到列表第一个,顺序本身要落盘 */
async function pinSource(src) {
  const list = (S.sources || []).filter((s) => s !== src);
  if (list.length === (S.sources || []).length) return;
  await applySources([src].concat(list));
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

/**
 * 源列表变了(加/改/删/导入/置顶)统一走这里:补 id(与名字解耦)、
 * 换 id 时把收藏与进度的键搬过去、落盘、重画所有相关视图。
 */
async function applySources(list) {
  const { list: fixed, remap } = normalizeSourceIds(list || []);
  S.sources = fixed;
  if (remap.size) {
    rewriteIdKeys(remap);
    renderFavs();
  }
  await persistSources();
  renderSourceManager();
  renderSources();
  syncSetSummaries();
  syncSearchBox(); // 有源/没源决定搜索框能不能用
}

/* ---------- 全部测速(I6) ---------- */
// 对每个源跑一次列表首页,把耗时写回 Source.health 并落盘,状态点立刻变。
// 「首字节」在 invoke 这一层拿不到:这里量的是「发出请求 → 列表解析完」的往返,
// 口径比首字节略大,但同口径可比(四态阈值见 docs/DESIGN-SPEC-UI.md §2.5)。

let testingAll = false;

function syncTestAllBtn() {
  const b = $("btnTestAll");
  if (!b) return;
  b.disabled = testingAll;
  b.setAttribute("aria-busy", testingAll ? "true" : "false");
  b.textContent = testingAll ? "测速中…" : "全部测速";
}

/** 单源测速:适配器走沙箱(和首页同一个请求),`vod-rs` 走 Rust 的 list_items */
async function checkSourceHealth(src) {
  const t0 = performance.now();
  const spent = () => Math.round(performance.now() - t0);
  try {
    if (pluginMode(src)) {
      await callAdapter(src, "list", {
        page: 1,
        cursor: null,
        filters: { classify: "" },
      });
    } else {
      await invoke("list_items", { source: src, page: 1, classify: "" });
    }
    return { ok: true, ms: spent(), checked_at: nowIso(), note: "" };
  } catch (e) {
    log("PROBE FAIL", src && src.name, errText(e));
    return { ok: false, ms: spent(), checked_at: nowIso(), note: shortNote(errText(e)) };
  }
}

/**
 * 全部测速:串行跑(并发会把首字节时间搅成一团),每测完一个就重画一次,
 * 用户能看着状态点一个个亮起来。结束后汇总「n/m 可用」。
 */
async function testAllSources() {
  if (testingAll) return;
  const all = (S.sources || []).slice();
  if (!all.length) {
    toast("还没有源可测");
    return;
  }
  // 直播源没有列表接口(要等直播播放做出来),不谎报"连接失败",
  // 跳过并在汇总里说清楚
  const targets = all.filter((s) => sourceType(s) !== "live");
  const skipped = all.length - targets.length;
  if (!targets.length) {
    toast("没有可测的源(直播源没列表接口)");
    return;
  }

  testingAll = true;
  syncTestAllBtn();
  targets.forEach((s) => { s._testing = true; });
  renderSourceManager();
  renderSources();

  let okCount = 0;
  for (const src of targets) {
    const health = await checkSourceHealth(src);
    if (health.ok) okCount++;
    delete src._testing;
    src.health = health;
    renderSourceManager();
    renderSources(); // 切源面板里的状态点也一起变
  }

  testingAll = false;
  syncTestAllBtn();
  await persistSources();
  renderSourceManager();
  renderSources();
  const msg =
    "测速完成:" + okCount + "/" + targets.length + " 可用" +
    (skipped ? "(未测 " + skipped + " 个直播源)" : "");
  log("test all", "ok=" + okCount, "n=" + targets.length, "skip_live=" + skipped);
  toast(msg);
}

/** 类型下拉跟着地址走:认出来了就锁死并说明,认不出来才放开手选 */
function wireKindGuess(d) {
  const url = d.querySelector("#dlg-url");
  const sel = d.querySelector("#dlg-kind");
  if (!url || !sel) return;
  const field = sel.closest(".dlg-field");
  const hint = field ? field.querySelector(".dlg-field__hint") : null;
  const apply = () => {
    const k = guessSourceKind(url.value);
    if (k) {
      sel.value = k;
      sel.disabled = true;
      if (hint) hint.textContent = "已按地址识别为「" + kindTitle(k) + "」。";
    } else {
      sel.disabled = false;
      if (hint) hint.textContent = "地址认不出类型,手动选一个。";
    }
  };
  url.addEventListener("input", apply);
  url.addEventListener("change", apply);
  apply();
}

/**
 * 编辑已有源:一个 m3e 对话框,三个字段。
 * 新增不走这里 —— 新增就是「导入源」:地址或文件进去,由内容判型(见 runSingleImport)。
 */
/** 编辑源时的「适配器」下拉:自动 + 当前可用适配器(内置清单没加载时给一份兜底) */
const ADAPTER_FALLBACK = [
  { value: "", label: "自动(按地址判断)" },
  { value: "vod", label: "苹果 CMS" },
  { value: "iplayr", label: "iplayr 配置" },
  { value: "webox", label: "WeBox 插件" },
  { value: "reelbox", label: "原生插件(无需适配)" },
];

function adapterChoices() {
  const opts = [{ value: "", label: "自动(按地址判断)" }];
  const seen = { "": 1 };
  for (const a of adapterList || []) {
    const id = String(a.id || "");
    if (!id || seen[id]) continue;
    seen[id] = 1;
    opts.push({ value: id, label: id === "reelbox" ? "原生插件(无需适配)" : String(a.name || id) });
  }
  return opts.length > 1 ? opts : ADAPTER_FALLBACK;
}

async function editSource(src) {
  if (!src) return;
  const res = await formDialog({
    icon: "dns",
    headline: "编辑源",
    okText: "保存",
    fields: [
      { id: "name", label: "名称", value: src.name, placeholder: "例如 我的源" },
      {
        id: "url",
        label: "地址",
        value: src.url,
        placeholder: "https://xxx/api.php/provide/vod 或 https://…/iplayr/dbk.json",
      },
      {
        id: "kind",
        label: "类型",
        type: "select",
        value: normKind(srcKind(src), src.url),
        hint: "地址能看出类型时会自动选好。",
        options: KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      },
      {
        id: "verify",
        label: "需要人工校验",
        type: "select",
        value: src.verify ? "1" : "0",
        hint: "Cloudflare 那类站点选「是」:第一次取数据会弹校验页,过完自动继续。",
        options: [
          { value: "0", label: "否" },
          { value: "1", label: "是" },
        ],
      },
      {
        id: "posterRatio",
        label: "封面比例",
        type: "select",
        value: String(src.posterRatio || ""),
        hint: "列表卡片的宽高比。站点海报不统一时按它调,默认 2:3。",
        options: [
          { value: "", label: "默认(2:3)" },
          { value: "3:4", label: "3:4" },
          { value: "4:3", label: "4:3(横向)" },
          { value: "16:9", label: "16:9(截图)" },
          { value: "1:1", label: "1:1(方形)" },
        ],
      },
      {
        id: "verifyUrl",
        label: "校验页地址",
        value: String(src.verifyUrl || ""),
        placeholder: "https://站点域名/",
        hint: "适配器/配置类源的地址不是站点本身,这里填要打开的那个站;留空按地址推断。",
      },
      {
        id: "adapter",
        label: "适配器",
        type: "select",
        value: String(src.adapter || ""),
        hint: "自动 = 按地址判断;只有想强制指定时才改。",
        options: adapterChoices(),
      },
    ],
    note: "地址能看出类型就自动选好;认不出来时才需要手动选。",
    onOpen: (d) => wireKindGuess(d),
  });
  if (!res) return;
  // options / adapter / probe 都不在编辑表单里,但要跟着搬:
  // adapter 是导入时判定的(运行时只看它),编辑一下名字不能把它弄丢
  const src2 = normSource({
    name: res.name,
    url: res.url,
    kind: res.kind,
    options: src.options,
    adapter: res.adapter, // 表单里选的;「自动」是空串,运行时再按地址推断
    verify: res.verify === "1",
    verifyUrl: res.verifyUrl,
    posterRatio: res.posterRatio,
    probe: src.probe,
  });
  if (!src2) return;
  const list = S.sources.slice();
  // 按对象找位置(不是按 id):同 id 的两条源不会互相误伤
  const i = list.indexOf(src);
  if (i >= 0) list[i] = Object.assign({}, src2, { id: src.id });
  else list.push(src2);
  await applySources(list);
  toast("已保存「" + src2.name + "」");
}

/**
 * 从剪贴板导入:剪贴板里是地址就直接预填进「导入源」框,否则照常打开让用户自己粘。
 * Tauri 侧没有装剪贴板插件(离线环境引新依赖有风险),所以先走 WebView 的
 * navigator.clipboard.readText();读不到就退化成"打开导入对话框"。
 */
async function addFromClipboard() {
  let text = "";
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      text = String((await navigator.clipboard.readText()) || "").trim();
    }
  } catch (_) {
    text = "";
  }
  const isAddr = /^(https?:\/\/|[a-z]:[\\/]|[\\/])/i.test(text);
  await runSingleImport(text && isAddr ? { path: text } : undefined);
}

async function removeSource(src) {
  // 按对象删:同 id 的两条源只删点中的那条
  if (!src || !(S.sources || []).includes(src)) return;
  const refs = favCountForSource(src.id);
  let dropFavs = false;
  if (refs) {
    // 先让用户决定收藏怎么办:删源之后那些卡片会变成播不了的"僵尸"(I4)
    const pick = await dialog({
      icon: "warning",
      headline: "删除源「" + src.name + "」?",
      content:
        '<p class="dlg-text">有 ' + refs + " 条收藏引用了它。删掉源之后这些收藏还在," +
        "但点进去播不了 —— 要一并清掉吗?</p>",
      actions: [
        { label: "取消", value: null },
        { label: "只删源", value: "keep" },
        { label: "一并清掉收藏", value: "drop", primary: true, danger: true },
      ],
    });
    if (!pick) return;
    dropFavs = pick === "drop";
  } else {
    const ok = await confirmDialog(
      "删除源「" + src.name + "」?",
      "删掉之后可以在「添加源」里重新加回来。",
      "删除",
      true
    );
    if (!ok) return;
  }
  const list = S.sources.filter((x) => x !== src);
  await applySources(list);
  const dropped = dropFavs ? favRemoveBySource(src.id) : 0;
  toast(dropped ? "已删除「" + src.name + "」,顺带清掉 " + dropped + " 条收藏" : "已删除「" + src.name + "」");
  if (!list.length) {
    // 默认就是没有源的状态,删空之后直接进空态,不要拦
    showNoSources();
  } else if (S.source === src) {
    await switchSource(list[0]);
  }
}

/* ---------- 导入:两个入口,共用一套表单与判型 ---------- */
// 用户的心智模型:一次加一条,和一次加一包,是两件事。
//   「导入源」  单条源:接口地址 / 站点配置 / 插件文件。判型后**先探测**,能用才建源。
//   「批量导入」集合/索引:JSON 里带 sources / sites 数组的那种,一次加入多条。
// 两条路读内容、判型、落地都走同一批函数(analyzeImport / collectionOf /
// singleSourceOf / applyImport),区别只在标题、允许的类型和落地行为。

/** 单源 JSON 里可能装着接口地址的字段 */
const SINGLE_SOURCE_KEYS = ["api", "url", "apiurl", "api_url", "interface", "baseurl", "base_url"];

/** 「选择文件」刚选中的 File:名字和输入框里的值一致时优先用它 */
let importPicked = null;

function looksLikeUrl(s) {
  return /^https?:\/\//i.test(String(s == null ? "" : s).trim());
}

/** 当 JSON 解析;不是 JSON(或空)返回 undefined —— 和「解析出 null」区分开 */
function tryJson(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return undefined;
  try {
    return JSON.parse(t);
  } catch (_) {
    return undefined;
  }
}

/** 集合源:顶层数组,或 {sources:[...]} / {sites:[...]}(老索引格式) */
function collectionOf(data) {
  if (Array.isArray(data)) return data.length ? data : null;
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.sources)) return data.sources.length ? data.sources : null;
  if (Array.isArray(data.sites)) return data.sites.length ? data.sites : null;
  return null;
}

/** 字段值可能是字符串,也可能是 {url} / {api} 这种小对象 */
function urlField(v) {
  if (typeof v === "string") return v.trim();
  if (!v || typeof v !== "object") return "";
  for (const k of ["url", "api", "src", "base"]) {
    if (typeof v[k] === "string" && v[k].trim()) return v[k].trim();
  }
  return "";
}

/** 认单源配置:有 api / url / provide.vod 这类字段就算 */
function singleSourceOf(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  let url = "";
  for (const k of SINGLE_SOURCE_KEYS) {
    url = urlField(data[k]);
    if (url) break;
  }
  if (!url && data.provide) {
    url = typeof data.provide === "object"
      ? urlField(data.provide.vod) || urlField(data.provide)
      : urlField(data.provide);
  }
  if (!url) return null;
  return { name: String(data.name || data.title || "").trim(), url: url };
}

/**
 * 判型表(内容优先,后缀兜底):
 *   源码里调了 define( / adapter(      → 插件(前缀的兼容见 plugin-host.js;
 *                                        adapter 由后端判成 kind=adapter,只装文件不建源)
 *   以 <?xml 或 <rss 开头               → 源(XML)
 *   JSON 顶层有 sources 数组             → 集合源(批量导入)
 *   JSON 里有 api/url/provide.vod 等字段 → 源(JSON)
 *   .js / .json / .xml 后缀              → 上面几种的辅助判断
 * 认不出来返回 "" —— 只有这时才让用户手选类型。
 */
function analyzeImport(text, hint) {
  const body = String(text == null ? "" : text).replace(/^\uFEFF/, "").trim();
  const path = String(hint == null ? "" : hint).trim().toLowerCase().split(/[?#]/)[0];
  // 1) 插件:源码里调了 define()
  if (looksLikePluginSource(body)) return { type: "plugin" };
  // 2) XML 源
  if (/^<\?xml/i.test(body) || /^<rss/i.test(body)) return { type: "xml" };
  // 3) JSON:先看是不是集合源,再看单源
  const data = tryJson(body);
  if (data !== undefined) {
    const list = collectionOf(data);
    if (list) return { type: "collection", list: list };
    const one = singleSourceOf(data);
    if (one) return { type: "json", source: one };
  }
  // 4) 后缀兜底:内容看不出门道时按扩展名猜
  if (path.endsWith(".js")) return { type: "plugin" };
  if (path.endsWith(".xml")) return { type: "xml" };
  if (path.endsWith(".json")) return { type: "json" };
  return { type: "" };
}

/** 名字兜底:域名,或文件名(后缀全去掉) */
function nameFromTarget(target) {
  const t = String(target == null ? "" : target).trim();
  if (looksLikeUrl(t)) return t.split("://")[1].split(/[/?#]/)[0].replace(/^www\./i, "");
  const base = t.split(/[\\/]/).pop() || "";
  return base.replace(/(\.[^.]+)+$/, "") || base || "新源";
}

/* ---------- 导入即探测(docs/ARCHITECTURE.md 第 3 节) ---------- */
// 用户粘一个地址 → ①静态特征缩小候选(不发网络)→ ②依次试跑 list(page=1),
// 每个限时 8 秒 → ③第一个出条目的定案,写进 adapter + probe。
// 判定只做一次:之后运行时只看 adapter,不会"昨天能看、今天变成另一个适配器"。
// 失败分三态(第 3 节):格式不对 → 不建源;网络没通 → **照样建源**;一个候选都没有 → unknown。

/** 每个候选的试跑上限。三个候选都试完 ≈ 24 秒封顶,比"导进来才发现不能用"划算 */
const PROBE_TIMEOUT_MS = 8000;

/** 进度提示里的叫法:用户不需要认识 vod / iplayr 这些词 */
const PROBE_LABEL = { vod: "接口", iplayr: "站点配置", reelbox: "插件", webox: "插件", m3u: "频道表" };

/** 认不出来时依次试这三个(顺序即优先级) */
// 短链(.m3u 地址被 bit.ly 之类包了一层)看不出后缀,只能靠试跑回答 ——
// 所以 m3u 也在候选里,排在最后:它不是频道表时会立刻报「不像 m3u」
const PROBE_FALLBACK = ["vod", "iplayr", "reelbox", "m3u"];

/**
 * 静态特征表(不发网络):返回候选适配器,最可能的排在最前。
 * 一条都认不出来时退回 [`PROBE_FALLBACK`] —— 那时只能靠试跑回答。
 */
function probeCandidates(target, text) {
  const body = String(text == null ? "" : text);
  const addr = String(target == null ? "" : target).trim().toLowerCase();
  const bare = addr.split(/[?#]/)[0];
  const out = [];
  const add = (a) => {
    if (out.indexOf(a) < 0) out.push(a);
  };
  if (/reelbox\s*\.\s*define\s*\(/.test(body)) add("reelbox");
  if (/WeBox\s*\.\s*define\s*\(/.test(body)) add("webox");
  // iplayr 的站点配置是一份 JSON:同时有 category 与 vod_node 就是它
  const data = tryJson(body);
  if (data && typeof data === "object" && !Array.isArray(data) && data.category && data.vod_node) {
    add("iplayr");
  }
  // 直播频道表:内置 m3u 适配器,粘地址就能建源
  if (bare.endsWith(".m3u") || bare.endsWith(".m3u8")) add("m3u");
  // 苹果 CMS:接口关键字 / XML 变体
  if (/api\.php|ac=list|ac=detail/i.test(addr)) add("vod");
  if (bare.endsWith(".xml") || /ac=xml/i.test(addr)) add("vod");
  return out.length ? out : PROBE_FALLBACK.slice();
}

/** 配置自称的名字(iplayr 的配置有 title):比"从域名猜"准得多 */
function probeNameOf(text) {
  const data = tryJson(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  for (const k of ["title", "name"]) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** 首条标题:给用户一眼看出"抓的是不是这个站"(probe.sample,最长 60 字) */
function probeSampleOf(items) {
  for (const it of items || []) {
    const t = String((it && it.title) || "").trim();
    if (t) return t.length > 60 ? t.slice(0, 60) + "…" : t;
  }
  return "";
}

/** 返回前 100 字(格式不对时给用户看:一眼就知道地址粘错了) */
function probeHeadOf(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, 100);
}

/**
 * 超时。插件沙箱自己有 30 秒的超时,导入这边等不了那么久 —— 8 秒还没回,
 * 就当"网络没通"(判不了),而不是格式错。
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("network: " + label + "超时(" + Math.round(ms / 1000) + " 秒没回应)"));
    }, ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * 错误文案 → 两种判定(对应架构文档第 4 节的四类码)。
 * 网络问题绝不能当成"格式不对":那会让用户去改一个本来没错的地址。
 */
function probeErrorKind(raw) {
  const s = String(raw == null ? "" : raw);
  if (/network|超时|timed? ?out|请求失败|连不上|connect|dns|unreachable|reset|eof|读响应失败|failed to fetch|networkerror/i.test(s)) {
    return "network";
  }
  return "format"; // parse / auth / unsupported 以及认不出来的,都算"这个地址不是源"
}

/** 试跑一次 list(page=1),出条目就算过 */
async function probeRunList(adapter, target, name) {
  if (adapter === "vod-rs") {
    // 苹果 CMS 的 Rust 实现(回滚路径):和正常取列表同一条路
    const page = await invoke("list_items", {
      source: {
        id: shortHash(target),
        name: name || nameFromTarget(target),
        type: /\bac=xml\b|\.xml$/i.test(String(target).split(/[?#]/)[0]) ? "xml" : "vod",
        url: target,
        adapter: "vod-rs",
      },
      page: 1,
      classify: "",
    });
    return (page && page.items) || [];
  }
  // reelbox / webox:地址就是插件文件;iplayr / vod:内置适配器 + 地址当站点配置
  const path = BUILTIN_ADAPTERS.indexOf(adapter) >= 0 ? await builtinAdapter(adapter) : target;
  if (!path) throw new Error("unsupported: 内置 " + adapter + " 引擎没装上");
  // options 和运行时同口径:iplayr/vod 的站点地址就是 `url`(见 adapterOptions)
  const res = await callPlugin(path, "list", {
    page: 1,
    cursor: null,
    filters: { classify: "" },
    options: adapterOptions({ url: target, adapter: adapter }),
  });
  return (res && (res.items || res.list)) || [];
}

/**
 * 探测一个地址用哪个适配器。入参 `{ target, text, fileName }`。
 *
 * 返回 `{ adapter, ok, items, sample, name, error, head, tried, kind, at }`:
 *   kind = "ok"       出条目了,定案
 *        = "network"  网络没通 / 超时 → **判不了**,调用方仍然建源
 *        = "format"   试过的都答"不是这种格式" → 不建源
 *        = "unknown"  一个候选都没有(理论上到不了)
 * onProgress(第几个, 共几个, 适配器) 给界面报进度。
 */
async function probeSource(input, onProgress) {
  const o = input || {};
  const target = String(o.target == null ? "" : o.target).trim();
  const text = String(o.text == null ? "" : o.text);
  const at = nowIso();
  const name = probeNameOf(text) || nameFromTarget(target);
  const head = probeHeadOf(text);
  const tried = probeCandidates(target, text);
  if (!tried.length) {
    return {
      adapter: "", ok: false, items: 0, sample: "", name: name, head: head, tried: [],
      error: "没有可试的适配器", kind: "unknown", at: at,
    };
  }
  let netFail = null; // 第一个"网络没通"的候选:它决定了失败时用哪个 adapter
  let lastError = "";
  for (let i = 0; i < tried.length; i += 1) {
    const adapter = tried[i];
    if (onProgress) onProgress(i + 1, tried.length, adapter);
    try {
      const items = await withTimeout(
        probeRunList(adapter, target, name),
        PROBE_TIMEOUT_MS,
        PROBE_LABEL[adapter] || adapter
      );
      if (items && items.length) {
        log("PROBE ok", adapter, "items=" + items.length, shortUrl(target, 90));
        return {
          adapter: adapter, ok: true, items: items.length, sample: probeSampleOf(items),
          name: name, head: head, tried: tried.slice(0, i + 1), error: "", kind: "ok", at: at,
        };
      }
      // 没报错但一条都没有:和"格式不对"同类,接着试下一个候选
      lastError = "parse: 这个适配器一条也没取到";
    } catch (e) {
      const raw = errText(e);
      lastError = raw;
      if (!netFail && probeErrorKind(raw) === "network") netFail = { adapter: adapter, raw: raw };
      log("PROBE trial fail", adapter, shortNote(raw));
    }
  }
  if (netFail) {
    return {
      adapter: netFail.adapter, ok: false, items: 0, sample: "", name: name, head: head,
      tried: tried, error: netFail.raw, kind: "network", at: at,
    };
  }
  return {
    adapter: tried[0], ok: false, items: 0, sample: "", name: name, head: head,
    tried: tried, error: lastError, kind: "format", at: at,
  };
}

/**
 * 两个导入对话框共用的表单:地址/路径 + 可选名称 + 「选择文件」。
 * cfg = { headline, okText, icon, note, placeholder, namePlaceholder, preset }
 * —— 只有标题、提示文案和落地逻辑不同,输入这一套完全一样。
 */
function importForm(cfg) {
  const c = cfg || {};
  const p = c.preset || {};
  importPicked = p.file || null;
  return formDialog({
    icon: c.icon || "file_upload",
    headline: c.headline,
    okText: c.okText,
    fields: [
      {
        id: "path",
        label: "地址或文件路径",
        value: p.path || "",
        placeholder: c.placeholder || "https://…/api.php/provide/vod 或 D:\\…\\source.json",
      },
      {
        id: "name",
        label: "名称(可选)",
        value: p.name || "",
        placeholder: c.namePlaceholder || "留空用文件名或域名",
        required: false,
      },
    ],
    note: c.note,
    onOpen: (d) => wireImportFile(d),
  });
}

/** 对话框里的「选择文件」:本地优先走系统选择器,选完把文件名填进地址框 */
function wireImportFile(d) {
  const input = d.querySelector("#dlg-path");
  const field = input ? input.closest(".dlg-field") : null;
  const picker = $("importFile");
  if (!input || !field || !picker) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "m3e-button m3e-button--outlined dlg-file";
  btn.innerHTML = '<span class="m3e-icon" aria-hidden="true">folder_open</span>选择文件';
  btn.onclick = () => picker.click();
  field.appendChild(btn);
  picker.onchange = () => {
    const f = picker.files && picker.files[0];
    if (!f) return;
    importPicked = f;
    input.value = f.name; // 只填文件名:内容已经由 File 拿着,不用再读一次盘
    input.dispatchEvent(new Event("input"));
  };
}

/**
 * 把「地址或文件」读成文本:本地文件直接读,链接先抓
 * (plugin_fetch,和插件走同一个带 SSRF 兜底的出口)。
 * 两个入口共用。
 */
async function readImportText(target) {
  if (importPicked && importPicked.name === target) {
    return { text: await importPicked.text(), fileName: importPicked.name };
  }
  if (looksLikeUrl(target)) {
    const r = await invoke("plugin_fetch", { url: target, headers: null });
    if (r && r.status >= 400) throw new Error("服务器返回 " + r.status);
    return { text: String((r && r.body) || ""), fileName: "" };
  }
  const text = await invoke("read_text_file", { path: target });
  return { text: text, fileName: target.split(/[\\/]/).pop() || "" };
}

/** 对话框 → 读内容 → 判型;两个入口共用的前半段。读失败/取消返回 null */
async function pickImportTarget(cfg) {
  const res = await importForm(cfg);
  if (!res) return null;
  const target = String(res.path || "").trim();
  if (!target) return null;
  let got;
  try {
    got = await readImportText(target);
  } catch (e) {
    log("IMPORT READ FAIL", errText(e));
    alertDialog("读取失败", "没读到内容:" + errText(e));
    return null;
  }
  return {
    target: target,
    text: got.text,
    fileName: got.fileName,
    name: String(res.name || "").trim(),
    hit: analyzeImport(got.text, got.fileName || target),
  };
}

/**
 * 「导入源」:单个源(接口地址 / 站点配置 / 插件)。加一条并设为当前。
 *
 * 三条路:
 *   插件(js)      → 存进插件目录就是一条源,不发网络:规则文件不用试跑
 *   适配器(js)    → 只装文件(不是源:加源还得用它的配置地址)
 *   其余(地址 / 配置) → **先探测**(probeSource),判出适配器再建源 —— P2 的主路径
 *
 * opts.adapter = true 是「导入适配器」:同一套表单与判型,只是文案和
 * "只收哪种插件"不同;它只装文件,不设当前源。
 */
async function runSingleImport(preset, opts) {
  const asAdapter = !!(opts && opts.adapter);
  const ctx = await pickImportTarget({
    preset: preset,
    headline: asAdapter ? "导入适配器" : "导入源",
    okText: "导入",
    icon: asAdapter ? "extension" : "file_upload",
    placeholder: asAdapter
      ? "D:\\…\\my.adapter.js"
      : "https://…/api.php/provide/vod 或 D:\\…\\source.json",
    note: asAdapter
      ? "适配器是一个 js 文件,入口是 reelbox.adapter({...})。装好之后,用它的配置地址「导入源」才会建出源。"
      : "一个源:接口地址、站点配置或插件文件;链接和本地文件都行。加进去之前会先试一下能不能取到片单,能用才建源。",
  });
  if (!ctx) return;
  // 解析器这个概念已经移除:老文件(入口 `.parser.js`)不再当源收,
  // 给它一句明确的话,指到现在的两条路上去
  if (looksLikeRemovedParser(ctx.text) || isRemovedParserPath(ctx.fileName || ctx.target)) {
    log("import:解析器已移除");
    alertDialog(
      "解析器已移除",
      PARSER_REMOVED_HINT +
        ":从网页里取流的逻辑现在写在源自己的适配器(list / detail / play)里," +
        "直接实现接口的写成插件(reelbox.define)。"
    );
    return;
  }
  // 集合源里有几条说不清,不该悄悄只加第一条 —— 指到「批量导入」去
  if (ctx.hit.type === "collection") {
    alertDialog(
      "这是集合源",
      "这份内容里有 " + ctx.hit.list.length + " 条源,用「批量导入」一次加进去。"
    );
    return;
  }
  // 「导入适配器」同理:只吃适配器(reelbox.adapter 入口,或 `.adapter.js` 文件)
  if (asAdapter && !looksLikeAdapterSource(ctx.text) && !/\.adapter\.js$/i.test(ctx.fileName || "")) {
    alertDialog(
      "这不是适配器",
      "适配器文件的入口是 reelbox.adapter({...}),文件名一般以 .adapter.js 收尾。" +
        "源配置(接口地址 / 站点配置)请用「导入源」。"
    );
    return;
  }
  if (!asAdapter && looksLikeAdapterSource(ctx.text)) {
    // 从「导入源」里进来了一个适配器:一样只装文件,提示它"这不是源"
    log("import:识别为适配器");
  }
  // 插件 / 适配器都是 js 文件:文件本身就是规则,存下来即可,不需要发网络试跑
  if (asAdapter || looksLikePluginSource(ctx.text) || ctx.hit.type === "plugin") {
    await applyImport("plugin", ctx.hit, Object.assign({}, ctx, { viaAdapter: asAdapter }));
    importPicked = null;
    return;
  }
  // 其余一律先探测:地址是接口、是站点配置、还是一个包装过的源配置(api 字段指向真地址)
  const one = ctx.hit.source || null;
  const target = String((one && one.url) || ctx.target || "").trim();
  // 进度复用底部 snackbar(不新造组件):三个候选最多转 24 秒,不提示会像卡死
  const closeTip = toast("正在验证 1/1 …", { timeout: 60000, dismissible: true });
  let probe;
  try {
    probe = await probeSource(
      { target: target, text: ctx.text, fileName: ctx.fileName },
      (i, n, adapter) => {
        toast(
          "正在验证 " + i + "/" + n + "(" + (PROBE_LABEL[adapter] || adapter) + ")…",
          { timeout: 60000, dismissible: true }
        );
      }
    );
  } catch (e) {
    closeTip();
    log("IMPORT PROBE FAIL", errText(e));
    alertDialog("验证失败", errText(e));
    return;
  }
  closeTip();
  await applyImport("source", ctx.hit, Object.assign({}, ctx, { probe: probe, probeTarget: target }));
  importPicked = null;
}

/** 「批量导入」:只吃集合/索引(JSON 里有 sources / sites 数组),一次加入多条 */
async function runBatchImport(preset) {
  const ctx = await pickImportTarget({
    preset: preset,
    headline: "批量导入",
    okText: "导入",
    icon: "playlist_add",
    placeholder: "https://…/sources.json 或 D:\\…\\sources.json",
    note: "只吃集合/索引:一份 JSON,里面有 sources 或 sites 数组。单条源(一个接口地址)用「导入源」。",
  });
  if (!ctx) return;
  const list = ctx.hit.type === "collection" ? ctx.hit.list : null;
  if (!list) {
    alertDialog(
      "这不是集合源",
      "「批量导入」只吃集合/索引格式(一份 JSON,里面有 sources 或 sites 数组)。这一个用「导入源」试试。"
    );
    return;
  }
  await applyImport("collection", ctx.hit, ctx);
  importPicked = null;
}

/**
 * 按判型结果落地:插件 / 适配器存进插件目录,集合源逐个加入,
 * 单源(探测过)加进列表并设为当前。
 * ctx = { target, text, fileName, name, probe, probeTarget, viaAdapter }
 * —— `viaAdapter` 只影响适配器那句提示:从「导入适配器」进来和从「导入源」进来的说法不一样。
 */
async function applyImport(type, hit, ctx) {
  const given = String(ctx.name || "").trim();

  if (type === "plugin") {
    try {
      const res = await invoke("save_plugin", { fileName: ctx.fileName || "plugin.js", text: ctx.text });
      const path = String((res && res.path) || "");
      // 后端按源码/suffix 判出来的类型:adapter 的插件不是源,
      // engine 还差一份站点配置
      const pluginKind = String((res && res.kind) || "");
      const isEngine = pluginKind === ENGINE_KIND;
      const isAdapter = pluginKind === ADAPTER_KIND;
      const name = given || String((res && res.name) || "");
      const known = (S.sources || []).find((x) => x.url === path || x.id === (res && res.id));

      // 适配器也不是源:装的是文件(`plugins/*.adapter.js`),不建源、不设当前源。
      // 要加源还得有它的配置地址,那一步走「导入源」的探测(见 docs/ARCHITECTURE.md 第 4 节)。
      if (isAdapter) {
        log("adapter imported", String(res && res.id), path);
        await loadAdapters(); // 适配器清单立刻多一条
        toast(
          ctx.viaAdapter
            ? "已导入适配器:" + name
            : "这是适配器,已安装;要加源请用它的配置地址"
        );
        return;
      }

      // 引擎插件:从 P2 起引擎随包安装(见 src-tauri/src/builtin.rs),人不用再导它。
      // 它本身不是源 —— 一份引擎 + 一份站点配置才是一条源,而那一步由探测接管:
      // 直接粘站点配置地址,自动判出 iplayr 并建源。
      if (isEngine) {
        log("engine plugin not needed", path);
        toast("引擎已经内置了:不用导入它,直接粘站点配置地址即可");
        return;
      }

      if (!known) {
        // adapter 顺手写死:插件文件的格式是确定的(它自己就是适配器),不用探测
        await applySources(
          (S.sources || []).concat([
            { id: res.id, name: name, type: PLUGIN_KIND, url: path, adapter: "reelbox" },
          ])
        );
      }
      const src = (S.sources || []).find((x) => x.url === path) || known;
      log("plugin imported", String(res && res.id));
      if (src) await setCurrentSource(src, { stay: true });
      else toast("已导入插件:" + name);
    } catch (e) {
      log("PLUGIN IMPORT FAIL", errText(e));
      alertDialog("导入失败", errText(e));
    }
    return;
  }

  if (type === "collection") {
    const raw = hit.list || collectionOf(tryJson(ctx.text));
    // TVBox 的索引里混着 jar 爬虫(type:3,`api` 是类名):那种跑不了,
    // 在这里筛掉,别让它变成一条点开就报错的源。
    const split = splitCollection(raw || []);
    const items = split.sources.map(normSource).filter(Boolean);
    if (!items.length) {
      alertDialog("导入失败", "这份集合里没有认出可用的源(每条要有名字和地址)。");
      return;
    }
    const before = (S.sources || []).length;
    const merged = uniqSources((S.sources || []).concat(items));
    await applySources(merged);
    // 集合里已有的(同地址)算跳过:用户要的是"这份里加进来几条、跳了几条"
    const added = Math.max(0, merged.length - before);
    const skipped = Math.max(0, items.length - added);
    log("sources imported", "new=" + added, "skip=" + skipped, "n=" + merged.length);
    const unfit = split.skipped.length;
    log("tvbox skipped", unfit, split.skipped.slice(0, 3).map((x) => x.name + ":" + x.reason).join(","));
    toast(
      "新增 " + added + " 个,跳过 " + skipped + " 个" +
        (unfit ? "(其中 " + unfit + " 条不是接口)" : "") +
        ",当前共 " + merged.length + " 个源"
    );
    return;
  }

  // 单源:ctx.probe 是 probeSource 的结论(见架构文档第 3 节的三态)
  await applyProbedSource(hit, ctx);
}

/**
 * 探测之后落地一条源(P2 的主路径):适配器已经判好,这里只做三态分流。
 *
 * 成功          → 建源(带 `probe` 证据)并设为当前
 * 网络没通      → **仍然建源**:地址本身没被否定,adapter 用第一个候选,
 *                 probe.ok=false 记下原因,网络好了直接就能看
 * 格式不对      → 不建源:把试过的适配器和返回前 100 字摆出来
 *
 * `type` 继续按老规则写一份(vod / xml / live):界面还在用它(徽标、分块)。
 */
async function applyProbedSource(hit, ctx) {
  const given = String(ctx.name || "").trim();
  const probe = ctx.probe || { adapter: "", ok: false, items: 0, sample: "", error: "", kind: "unknown" };
  const target = String(ctx.probeTarget || (hit.source && hit.source.url) || ctx.target || "").trim();
  const tried = (probe.tried || [probe.adapter]).filter(Boolean).join(" / ");

  if (probe.kind === "format" || probe.kind === "unknown") {
    log("IMPORT probe rejected", probe.kind, shortNote(probe.error));
    await alertDialog(
      "这个地址不是能识别的源格式",
      "试过:" + (tried || "无") + "。" +
        (probe.error ? "错误:" + probe.error : "") +
        (probe.head ? " 返回前 100 字:「" + probe.head + "」" : "")
    );
    return;
  }
  if (!target) {
    alertDialog("导入失败", "没拿到可用的地址。");
    return;
  }
  // 名字:用户填的 > 配置自称的(iplayr 配置里的 title)> 配置里的名字 > 从地址猜
  const name = given || probe.name || (hit.source && hit.source.name) || nameFromTarget(ctx.target);
  // 适配器说了算:m3u 判成功就是直播源,哪怕地址没后缀(短链)
  const kind =
    probe.adapter === "m3u"
      ? "live"
      : hit.type === "xml"
        ? "xml"
        : hit.type === "live"
          ? "live"
          : "vod";
  const src = normSource({
    name: name,
    url: target,
    kind: kind,
    adapter: probe.adapter || "vod",
    probe: {
      at: probe.at || nowIso(),
      ok: !!probe.ok,
      items: Number(probe.items) || 0,
      sample: String(probe.sample || ""),
      error: probe.ok ? "" : String(probe.error || ""),
    },
  });
  if (!src) {
    alertDialog("导入失败", "没拿到可用的地址。");
    return;
  }
  // 同一个地址已经在列表里:切过去就行,不用再加一条
  const dup = (S.sources || []).find((x) => x.url === src.url);
  if (dup) {
    await setCurrentSource(dup, { stay: true });
    return;
  }
  await applySources((S.sources || []).concat([src]));
  const added = (S.sources || []).find((x) => x.url === src.url);
  log(
    "source imported",
    "adapter=" + src.adapter,
    "items=" + Number(probe.items || 0),
    "ok=" + (probe.ok ? "yes" : "no"),
    shortUrl(src.url, 100)
  );
  if (added) await setCurrentSource(added, { stay: true });
  // 网络没通也要说清楚:源已经存下了,等网络好了再点它
  toast(
    probe.kind === "network"
      ? "网络没通,源已保存,可稍后重试"
      : "已导入「" + name + "」" + (Number(probe.items) ? "· " + probe.items + " 条" : "")
  );
}

let srcRowMenuAnchor = null; // 当前打开「更多」的按钮(再点同一个算收起)

function bindSourceManager() {
  const box = $("srcmgr");
  if (box && !box.dataset.bound) {
    box.dataset.bound = "1";
    // 行按「列表下标」解析成源对象:同 id 的两条源不会误伤(A1)
    const srcAt = (el) => (S.sources || [])[Number(el && el.getAttribute("data-idx"))];
    box.onclick = (e) => {
      const b = e.target.closest("button[data-act]");
      if (b) {
        const act = b.getAttribute("data-act");
        const src = srcAt(b);
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
        return;
      }
      // 点整行 = 设为当前源,但留在源页 + toast + 3s 撤销(I5)
      const row = e.target.closest(".m3e-list-item[data-idx]");
      if (!row) return;
      const src = srcAt(row);
      if (src) setCurrentSource(src, { stay: true });
    };
  }
  if ($("srcImport") && !$("srcImport").dataset.bound) {
    $("srcImport").dataset.bound = "1";
    // 底栏两个键:导入源(单条,判型后设为当前)+ 批量导入(集合,一次多条)
    $("srcImport").onclick = () => runSingleImport();
    if ($("srcImportBatch")) $("srcImportBatch").onclick = () => runBatchImport();
    if ($("srcClip")) $("srcClip").onclick = () => addFromClipboard();
    // 全部测速:之前 onclick 是空的,点了一点反应都没有(I6)
    if ($("btnTestAll")) $("btnTestAll").onclick = () => testAllSources();
    syncTestAllBtn();
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
  syncSetSummaries();
  log("debug", on ? "on" : "off");
}

/**
 * 调试浮标:右下角那颗随时弹日志面板的按钮。
 * 它跟着「记录日志」走 —— 日志没记录时没有现场可看,浮标也就不该常驻(评审 2);
 * 另外只有 dev 构建才有它(发布版不给调试界面)。
 */
function fabOn() {
  return isDevBuild() && debugOn();
}

function syncDebugButtons() {
  const sw = document.getElementById("swLog");
  if (sw) sw.checked = debugOn();
  const fab = document.getElementById("dbgFab");
  if (fab) fab.hidden = !fabOn();
}

function bindDebugToggle() {
  const fab = document.getElementById("dbgFab");
  if (fab && !fab.dataset.bound) {
    fab.dataset.bound = "1";
    fab.onclick = () => toggleDebug();
  }
  const sw = document.getElementById("swLog");
  if (sw && !sw.dataset.bound) {
    sw.dataset.bound = "1";
    sw.onchange = () => setDebug(sw.checked);
  }
  syncDebugButtons();
}

// 站点校验:app 里的一层页面(顶栏/底栏是我们画的,中间是原生子 WebView)。
// cookie 留在宿主,插件只拿会话 id。桌面和以后移动端共用这一套壳。
let verifySession = null;
let verifyPageId = null;

/** 会话列表:给设置页用,其他地方改完也调一下 */
async function refreshVerifySessions() {
  const box = $("verifySessions");
  if (!box) return;
  let rows = [];
  try {
    rows = await invoke("session_list", {});
  } catch (e) {
    box.textContent = "读取失败:" + errText(e);
    return;
  }
  if (!rows || !rows.length) {
    box.textContent = "还没有会话";
    return;
  }
  box.textContent = "";
  rows.forEach((s) => {
    const line = document.createElement("div");
    line.style.cssText = "display:flex;align-items:center;gap:10px;padding:5px 0;flex-wrap:wrap";
    const label = document.createElement("span");
    const when = new Date(s.opened_at * 1000).toLocaleTimeString();
    label.textContent =
      s.host + " · " + (s.done ? "已通过" : s.cancelled ? "已取消" : "进行中") +
      " · " + s.cookies + " cookie · " + when;
    label.style.flex = "1 1 auto";
    const kill = document.createElement("button");
    kill.type = "button";
    kill.className = "m3e-button m3e-button--text";
    kill.textContent = "撤销";
    kill.onclick = async () => {
      try {
        await invoke("session_close", { id: s.id });
        if (verifySession && verifySession.id === s.id) verifySession = null;
      } catch (e) {
        log("SESSION CLOSE FAIL", errText(e));
      }
      refreshVerifySessions();
    };
    line.append(label, kill);
    box.appendChild(line);
  });
}

/** 校验页:顶栏/底栏归我们,中间那块让宿主的子 WebView 摆进来 */
function initVerifyPage() {
  const page = $("verifyPage");
  const body = $("verifyBody");
  if (!page || !body) return;
  const hostEl = $("verifyHost");
  const reasonEl = $("verifyReason");

  const sync = () => {
    if (!verifyPageId) return;
    const r = body.getBoundingClientRect();
    // 传物理像素:子 WebView 在 Windows 上是独立 HWND,按物理像素摆最稳
    const dpr = window.devicePixelRatio || 1;
    invoke("verify_bounds", {
      id: verifyPageId,
      rect: [r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr],
    }).catch(() => {});
  };

  const show = (d) => {
    verifyPageId = d.id;
    if (hostEl) hostEl.textContent = d.host || "站点校验";
    if (reasonEl) reasonEl.textContent = d.reason || "完成校验后点「我已完成」";
    page.hidden = false;
    const load = $("verifyLoading");
    if (load) load.hidden = true;
    // 等一帧再量,否则拿到的是隐藏时的矩形
    requestAnimationFrame(() => {
      sync();
      setTimeout(sync, 120);
    });
  };

  const hide = () => {
    page.hidden = true;
    verifyPageId = null;
  };

  const back = async () => {
    if (!verifyPageId) {
      hide();
      return;
    }
    const id = verifyPageId;
    try {
      await invoke("verify_cancel", { id });
    } catch (e) {
      log("VERIFY CANCEL FAIL", errText(e));
    }
    hide();
    refreshVerifySessions();
  };

  window.__TAURI__.event.listen("verify:open", (e) => show(e.payload || {}));
  window.__TAURI__.event.listen("verify:close", () => hide());

  new ResizeObserver(() => sync()).observe(body);
  window.addEventListener("resize", sync);

  const btnBack = $("verifyBack");
  const btnCancel = $("verifyCancel");
  const btnDone = $("verifyDone");
  if (btnBack) btnBack.onclick = back;
  if (btnCancel) btnCancel.onclick = back;
  if (btnDone) {
    btnDone.onclick = async () => {
      if (!verifyPageId) return;
      const id = verifyPageId;
      btnDone.disabled = true;
      try {
        const s = await invoke("verify_finish", { id });
        verifySession = s;
        const say = $("verifyOut");
        if (say) {
          say.textContent =
            "会话 " + s.id + " · " + s.host + NL + "✅ 已通过(" + s.cookies + " 个 cookie),可以取数据了";
        }
        toast("校验完成:" + s.host);
      } catch (e) {
        alertDialog("校验失败", errText(e));
      } finally {
        btnDone.disabled = false;
      }
      hide();
      refreshVerifySessions();
    };
  }
}

/** 设置 → 校验:手动开一个会话 */
function bindVerifyPanel() {
  const input = $("verifyUrl");
  const out = $("verifyOut");
  const btnOpen = $("btnVerifyOpen");
  const btnFetch = $("btnVerifyFetch");
  if (!input || !btnOpen || !btnFetch) return;

  const say = (t) => {
    if (out) out.textContent = t;
  };
  const target = () => input.value.trim();

  refreshVerifySessions();

  btnOpen.onclick = async () => {
    const url = target();
    if (!/^https?:/i.test(url)) {
      say("地址要以 http(s):// 开头");
      return;
    }
    btnOpen.disabled = true;
    say("正在打开…");
    try {
      const s = await invoke("verify_start", { url: url, reason: "手动校验" });
      verifySession = null;
      say("会话 " + s.id + " · " + s.host + NL + "页面已打开:完成后点底部「我已完成」");
    } catch (e) {
      say("打开失败:" + errText(e));
    } finally {
      btnOpen.disabled = false;
    }
  };

  btnFetch.onclick = async () => {
    if (!verifySession) {
      say("先完成一次校验");
      return;
    }
    btnFetch.disabled = true;
    try {
      const res = await invoke("session_fetch", {
        id: verifySession.id,
        url: target(),
        headers: null,
      });
      const body = String(res && res.body ? res.body : "");
      const challenge = /just a moment|_cf_chl_opt|cf-challenge|challenge-platform/i.test(body);
      say(
        "会话 " + verifySession.id + " · HTTP " + res.status + " · " + body.length + " 字" + NL +
          (challenge ? "⚠️ 还是挑战页" : "✅ 不是挑战页") + NL + NL +
          body.slice(0, 160).replace(/s+/g, " ")
      );
      refreshVerifySessions();
    } catch (e) {
      say("取数据失败:" + errText(e));
    } finally {
      btnFetch.disabled = false;
    }
  };
}

function showDebugPanel(on) {
  if (!isDevBuild()) return; // 发布版不暴露实时日志(日志照旧写文件)
  const box = document.getElementById("dbg");
  if (!box) return;
  box.hidden = !on;
  if (on) {
    box.textContent = LOG_BUF.join(NL);
    box.scrollTop = box.scrollHeight;
  }
}

function toggleDebug() {
  if (!isDevBuild()) return;
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
  // 适配器单独一页:它既不是源,也不该埋在源的页面里(见 docs/ARCHITECTURE.md 第 4 节)
  { key: "adapters", icon: "extension", title: "适配器", group: 0 },
  { key: "play", icon: "play_circle", title: "播放", group: 0 },
  // 没有「网络」页:代理不开放给用户选,出口一律跟着系统走(见 docs/NETWORK.md)
  { key: "look", icon: "palette", title: "外观", group: 0 },
  // 站点校验:Cloudflare / 登录这类必须人工过的站点,用户自己也能用(不是调试工具)
  { key: "sites", icon: "verified_user", title: "校验", group: 0 },
  { key: "debug", icon: "terminal", title: "调试", group: 1 },
  { key: "about", icon: "info", title: "关于", group: 1 },
];

const VARIANT_LABEL = {
  tonal: "标准", vibrant: "鲜明", expressive: "表现型", neutral: "柔和", mono: "单色",
};

let APP_INFO = null;
let setPage = "";

/**
 * 构建 profile:只有 debug 构建(不带 --release)才暴露调试能力。
 * 判断集中在这一个函数里 —— app_info 的 build 形如 "debug · windows x86_64",
 * 首段就是 profile。还没拿到 app_info 时按发布版处理(先藏),
 * dev 构建在 loadAppInfo 之后由 applyBuildGates() 补回来。
 */
function isDevBuild() {
  if (!APP_INFO || !APP_INFO.build) return false;
  return /^\s*debug\b/i.test(String(APP_INFO.build));
}

/** 设置里能看到的入口:发布版没有「调试」 */
function setPages() {
  return SET_PAGES.filter((p) => p.key !== "debug" || isDevBuild());
}

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
  if (key === "sites") {
    return "人机验证 · 登录页";
  }
  if (key === "debug") {
    return "日志" + (debugOn() ? "开" : "关");
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
  const pages = setPages();
  if (main) main.innerHTML = pages.filter((p) => p.group === 0).map(setEntryHtml).join("");
  if (low) low.innerHTML = pages.filter((p) => p.group === 1).map(setEntryHtml).join("");

  const master = $("setMaster");
  if (master) {
    master.innerHTML = pages.map(
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
  // 发布版没有「调试」:手滑/旧状态指过来也落回「源」
  const page = setPages().some((p) => p.key === key) ? key : "src";
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
  if (page === "adapters") loadAdapters();

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
  if (!el) return;
  const p = (APP_INFO && APP_INFO.log_path) || "";
  el.textContent = p || "读取中…";
  // 两行 clamp 之后必然有截断,title 兜住完整路径
  if (p) el.title = p;
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
  applyBuildGates();
}

/**
 * 按构建 profile 摆正调试界面(在 app_info 到位后跑一次)。
 * 发布版:调试二级页、浮标、日志面板、Ctrl+Shift+D 全部撤掉 ——
 * 日志本身照旧落盘(log() 写文件与界面无关),只是没有开关和实时面板。
 */
function applyBuildGates() {
  if (!isDevBuild()) {
    ["dbgFab", "dbg"].forEach((id) => {
      const el = $(id);
      if (el) el.remove();
    });
    const page = document.querySelector('#setDetail .set-page[data-page="debug"]');
    if (page) page.remove();
    if (setPage === "debug") {
      setPage = "";
      const shell = $("setShell");
      if (shell) shell.removeAttribute("data-page");
      document.body.removeAttribute("data-setpage");
    }
  }
  renderSetHome();
  syncSetSummaries();
  syncDebugButtons();
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
  const list = listableSources();
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
  bindAdapterManager();

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

  // 调试:一个开关(记录日志)+ 一个文本按钮(打开日志目录)(评审 2)
  bindDebugToggle();
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

  // 人工校验会话:开窗口 → 用户点「我已完成」→ 用会话取一次
  bindVerifyPanel();

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
  progWrite(all);
}
/** 整表写回(换源 id 时要搬键,见 rewriteIdKeys) */
function progWrite(all) {
  try { localStorage.setItem(PROG_KEY, JSON.stringify(all || {})); } catch (_) {}
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

/**
 * 播放器状态文字。默认是「加载态」:转圈 + 一句话,同时打上 .player.loading
 * —— 取流/缓冲期间画面中央只该有这一颗转圈,中央播放/暂停按钮的底圆由 CSS 收起,
 * 否则转圈外面会套一圈「暂停」的描边,像两个控件叠在一起。
 * spinner=false 用于「放完了 / 最后一集」这类纯提示:不是加载,中央该留播放按钮。
 */
function pStatus(msg, spinner) {
  const el = $("pState");
  const box = $("player");
  const spin = !!msg && spinner !== false;
  if (box) box.classList.toggle("loading", spin);
  if (!msg) { el.innerHTML = ""; return; }
  el.innerHTML = (spin ? '<span class="spin"></span>' : "") + "<span>" + esc(msg) + "</span>";
}

/**
 * 起播的统一入口:先摆加载态,再去取流。
 * 正式播放、续播与预览(「继续观看」/ resume / 选集)、换线路重试、上一集下一集、
 * 自动连播,以及「先探一小段再起播」的 peek 阶段(play 钩子 → player_url →
 * stream_kind)全都走这里:点下去立刻有转圈 + 状态文案,复用播放器自己那套
 * loading(.p-state 里的转圈),没有第二套加载样式。
 * 顺手把上一集的画面停住 —— peek 期间不该还在放旧的那一集。
 */
function pStartLoading(msg) {
  const box = $("player");
  if (!box) return;
  const v = $("video");
  if (v && !v.paused) {
    try { v.pause(); } catch (_) {}
  }
  box.hidden = false;
  box.classList.remove("idle");
  hidePlayerFail();
  pStatus(msg || "取流中…");
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

// 直播:没有进度、不续播、不连播,断了自动重连
let liveMode = false;
let liveRetryTimer = 0;
let liveRetryCount = 0;
let liveLast = { url: "", name: "", mime: "" };
// 同一个台的多条线路:由用户在右上角手动切换(不自动跳)
let liveLines = [];
let liveIdx = 0;
let liveMime = "application/x-mpegURL";
let liveHeaders = {};
let liveTitle = "";
// 只出声不出画:这条流的画面编码(MPEG-2 / HEVC)WebView 解不了,只提示一次
let liveNoVideo = false;

function liveOff() {
  liveMode = false;
  clearTimeout(liveRetryTimer);
  liveRetryCount = 0;
  liveNoVideo = false;
  liveLast = { url: "", name: "", mime: "" };
  liveLines = [];
  liveIdx = 0;
  liveTitle = "";
  const seek = $("seek");
  if (seek) seek.style.display = "";
  const prev = $("pPrev");
  const next = $("pNext");
  if (prev) prev.style.display = "";
  if (next) next.style.display = "";
  const player = $("player");
  if (player) player.classList.remove("is-live");
}

/** 直播断流:隔 3 秒重新起一次,最多 5 次 */
function liveRetry(reason) {
  if (!liveMode) return;
  // 不自动换线路(用户自己用右上角那个按钮换),这里只重连当前这条
  if (!liveLast.url) return;
  if (liveRetryCount >= 3) {
    playerFail({
      step: "stream",
      kind: "network",
      title: "这条线路播不了",
      hint:
        liveLines.length > 1
          ? "右上角可以换一条线路(" + liveLines.length + " 条),或者点重试。"
          : "重连 3 次都没成。可能是源暂时挂了,换一个频道或稍后再试。",
      raw: String(reason || ""),
    });
    renderLevels();
    return;
  }
  liveRetryCount++;
  pStatus("直播断流,正在重连(" + liveRetryCount + "/3)…", false);
  clearTimeout(liveRetryTimer);
  liveRetryTimer = setTimeout(() => {
    if (!liveMode) return;
    openPlayer(liveLast.url, liveLast.name, liveLast.mime, "hls");
  }, 3000);
}

function pSync() {
  const v = $("video");
  if (liveMode) {
    // 有声音没画面:说明音频轨能解、视频轨不能。常见于 MPEG-2 / HEVC 的老 IPTV 源
    if (!liveNoVideo && v.readyState >= 2 && v.videoWidth === 0) {
      liveNoVideo = true;
      pStatus("只有声音:这条流的画面编码不受支持(常见于 MPEG-2 / HEVC 频道)", false);
      log("LIVE no video", "audio=" + v.readyState + " vw=0");
    }
    $("pTime").textContent = "直播中";
    const playing0 = !v.paused && !v.ended;
    $("pPlayIcon").textContent = playing0 ? "pause" : "play_arrow";
    $("pBigPath").setAttribute("d", playing0 ? PAUSE_PATH : PLAY_PATH);
    $("player").classList.toggle("playing", playing0);
    if (!playing0) $("player").classList.remove("idle");
    const vol0 = v.muted ? 0 : v.volume;
    paintVol(vol0 * 100);
    $("pMuteIcon").textContent = vol0 === 0 ? "volume_off" : vol0 < 0.5 ? "volume_down" : "volume_up";
    $("pPrev").setAttribute("aria-disabled", "true");
    $("pNext").setAttribute("aria-disabled", "true");
    return;
  }
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
  // 自绘滑块没有"输入中"的中间态:画一次就是最终位置,不用再避让 activeElement
  paintVol(vol * 100);
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
  // 直播:这里放「线路」,不是清晰度
  if (playCtx && playCtx.lines && playCtx.lines.length > 1) {
    const n = playCtx.lines.length;
    const cur = playCtx.lineIdx || 0;
    btn.hidden = false;
    btn.textContent = "线路 " + (cur + 1) + "/" + n;
    menu0.innerHTML = playCtx.lines
      .map((_, i) => '<button data-line="' + i + '">线路 ' + (i + 1) + "</button>")
      .join("");
    menu0.querySelectorAll("button").forEach((b) => {
      const i = Number(b.getAttribute("data-line"));
      if (i === cur) b.setAttribute("aria-current", "true");
      b.onclick = () => {
        menu0.hidden = true;
        switchLiveLine(i);
      };
    });
    return;
  }
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

/**
 * 移动端生命周期:切后台暂停播放 + 把进度落盘,回前台不自动播。
 *
 * 只在移动端挂(`platform.pauseOnHidden`)。桌面最小化窗口同样会触发
 * visibilitychange,那属于原有行为,不在这里动。
 */
function bindLifecycle() {
  if (!platform.pauseOnHidden || document.__reelboxLifecycle) return;
  document.__reelboxLifecycle = true;

  const flush = () => {
    const v = $("video");
    if (!v) return;
    // 切后台先停,别在后台继续拉分片(移动端会掉电、也会被系统限流)
    if (!v.paused) {
      try { v.pause(); } catch (_) {}
    }
    // 一定要落盘:应用随时可能被系统直接杀掉
    saveProgress(true);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flush();
  });
  // 兜底:iOS 进后台不保证每次都发 visibilitychange
  window.addEventListener("pagehide", flush);
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
    // 取消静音:0 的时候回到 0.8,剩下多少就回多少
    setVolume(wasSilent ? (v.volume < 0.05 ? 0.8 : v.volume) : 0);
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
    // 浮层接住点击:否则点到滑块等于点到播放器(切播放/暂停)
    volBox.addEventListener("click", (e) => e.stopPropagation());
  }

  paintVol(loadVolume() * 100);
  v.volume = loadVolume();
  bindVolumeSlider();

  $("pRetry").onclick = () => {
    const c = playCtx;
    hidePlayerFail();
    if (!c || !c.id) return;
    // 直播没有剧集:重试 = 把这条线路再起一次
    if (c.live) return playLive({ id: c.id, title: c.name });
    playEpisode(c.id, c.name, c.group || "");
  };

  $("pPrev").onclick = () => jumpEpisode(-1);
  $("pNext").onclick = () => jumpEpisode(1);
  $("pFull").onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (box.requestFullscreen) box.requestFullscreen();
    // iOS 没有元素级全屏,只能让系统播放器接管(桌面/Android 走不到这条)
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
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
  setVolume(v.volume || 0.8);
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

/**
 * 音量滑块只有两个量:--vol(已播放段高度 + 拇指 bottom,同一个百分比)和
 * aria-valuenow。少写后者轨道就是一根灰条,看不出音量到哪了。
 * --vol 挂在浮层上往下继承,轨道里的 fill / thumb 一起动,不会各走各的。
 */
function paintVol(pct) {
  const el = $("vol");
  if (!el) return;
  const p = Math.min(100, Math.max(0, Number(pct) || 0));
  el.style.setProperty("--vol", p + "%");
  el.setAttribute("aria-valuenow", String(Math.round(p)));
  el.setAttribute("aria-valuetext", Math.round(p) + "%");
}

/**
 * 音量滑块(自绘,不用原生 range)。
 *
 * 原生 range 走 writing-mode: vertical-lr 时,拇指的横向位置由浏览器按 input
 * 盒宽算,和背景画的轨道对不齐 —— 表现就是"轨道在中间、拇指偏左半个拇指宽"。
 * 自绘后中心线只有一处定义:轨道的 left:50% + translateX(-50%),
 * 拇指用 left:50% + translate(-50%, 50%) 落在同一条线上,
 * 所以 thumb 与轨道的水平中心恒等。
 *
 * 交互:按下即定位(按 Y 算比例)→ setPointerCapture 拖动实时改 → 抬起结束;
 * 键盘上下 ±5、Home/End 到 0/100;统一的入口是 setVolume()。
 */
function bindVolumeSlider() {
  const box = $("vol");
  if (!box || box.dataset.bound) return;
  box.dataset.bound = "1";
  const track = box.querySelector(".p-vol__track");
  if (!track) return;

  // 客户端 Y → 0~100:轨道下沿是 0,上沿是 100
  const pctAt = (clientY) => {
    const r = track.getBoundingClientRect();
    if (!r.height) return 0;
    return Math.min(100, Math.max(0, ((r.bottom - clientY) / r.height) * 100));
  };
  const move = (clientY) => {
    keepVolumeOpen(); // 拖着的时候浮层不收起:3s 空闲才收
    setVolume(pctAt(clientY) / 100);
  };

  let dragging = false;
  box.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return; // 只认左键
    e.preventDefault();
    e.stopPropagation(); // 别让播放器把这下当"切播放/暂停"
    dragging = true;
    try { box.setPointerCapture(e.pointerId); } catch (_) {}
    try { box.focus({ preventScroll: true }); } catch (_) {}
    move(e.clientY); // 按下即定位,不用先对准拇指
  });
  box.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    e.stopPropagation();
    move(e.clientY);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { box.releasePointerCapture(e.pointerId); } catch (_) {}
    keepVolumeOpen();
  };
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);

  // 键盘:浮层可聚焦(tabindex="0"),上下 ±5,Home/End 到 0/100
  box.addEventListener("keydown", (e) => {
    const v = $("video");
    const cur = (v.muted ? 0 : v.volume) * 100;
    let next = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") next = cur + 5;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = cur - 5;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 100;
    if (next === null) return;
    e.preventDefault(); // 别让页面跟着滚
    e.stopPropagation(); // 也别让播放器的全局上下键再动一次(那会一次跳两格)
    keepVolumeOpen();
    setVolume(next / 100);
  });
}

/**
 * 音量落到 <video> 上并同步滑块:垂直滑块、静音键、上下方向键都走这里,
 * 免得三处各写一份「0 算静音」的规则。
 */
function setVolume(val) {
  const v = $("video");
  const vol = Math.min(1, Math.max(0, Number(val) || 0));
  v.volume = vol;
  v.muted = vol === 0;
  paintVol(vol * 100);
  saveVolume();
  pSync();
}

let volIdleTimer = 0;

/** 音量浮层亮出来,3s 没动作再收(悬停那条 250ms 宽限在 bindPlayer 里) */
function keepVolumeOpen() {
  const wrap = document.querySelector(".p-volwrap");
  if (!wrap) return;
  wrap.classList.add("open");
  clearTimeout(volIdleTimer);
  volIdleTimer = setTimeout(() => wrap.classList.remove("open"), 3000);
}

function closePlayer() {
  liveOff();
  const box = $("player");
  const v = $("video");
  playSeq++; // 关播放器 = 放弃正在解析 / 取流的那条链路
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
  // 内容都在 .detail-body 里(外壳固定,见 detailBody),插入点也要在这一层
  const body = $("v-detail").querySelector(".detail-body");
  if (!body) return;
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
    const anchor = body.querySelector(".epgroup") || body.querySelector(".noep");
    body.insertBefore(btn, anchor || null);
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
  const v = $("video");
  if (liveMode) {
    liveLast = { url: url || liveLast.url, name: name || liveLast.name, mime: mime || liveLast.mime };
    $("player").classList.add("is-live");
    const seek = $("seek");
    if (seek) seek.style.display = "none";
    const prev = $("pPrev");
    const next = $("pNext");
    // .p-icon 有自己的 display("grid"),单靠 hidden 属性盖不住
    if (prev) prev.style.display = "none";
    if (next) next.style.display = "none";
  } else {
    liveOff();
  }
  const full = S.detailTitle && name && name !== S.detailTitle
    ? S.detailTitle + " · " + name
    : name || S.detailTitle || "";
  $("pTitle").textContent = full;
  pStartLoading(url ? "加载中…" : "取流中…");
  if (hls) { hls.destroy(); hls = null; }
  if (!url) return;

  clearInterval(tickTimer);
  tickTimer = setInterval(pSync, 250);

  v.onloadedmetadata = () => {
    if (!liveMode && playCtx && playCtx.resume > 5) {
      try { v.currentTime = playCtx.resume; } catch (_) {}
    }
    pSync();
  };
  v.ontimeupdate = () => saveProgress(false);
  v.onplaying = () => {
    pStatus("");
    hidePlayerFail();
    liveRetryCount = 0;
    pSync();
  };
  v.onpause = pSync;
  v.onended = () => {
    const ctx = playCtx;
    if (liveMode) return;
    pSync();
    if (!ctx || !ctx.list || !ctx.list.length) return;
    if (!autoplayOn()) {
      pStatus("这一集放完了(自动连播已关闭)", false);
      return;
    }
    const next = ctx.list[ctx.index + 1];
    if (next) playEpisode(next.id, next.name, next.group || "");
    else pStatus("已经是最后一集", false);
  };

  // 出错先记现场:<video> 自己的错误码往往比 hls.js 的 details 更直接
  v.onerror = () => {
    const e = v.error || {};
    if (liveMode) {
      log("LIVE ERR", "code=" + (e.code || 0), "net=" + v.networkState);
      liveRetry("video code=" + (e.code || 0));
      return;
    }
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
  // iOS 的 WKWebView 没有 MSE:hls.js 用不了,直接把反代地址交给 <video>,由 AVPlayer 播 HLS
  const useHlsJs = isHls && !platform.nativeHlsOnly;
  logv(
    "play mode " + (useHlsJs ? "hls" : "native") +
    (platform.nativeHlsOnly ? "(ios/AVPlayer)" : "") +
    " kind=" + (kind || "?") + " hint=" + hint
  );
  // 探测失败(手机网络/超时)不等于"这不是流":只记一笔,继续按 mime 与后缀尝试
  if (kind === "unknown") {
    const probe = (playCtx && playCtx.probe) || {};
    log("probe unknown, fallback to hint head=" + (probe.head || "") + " status=" + (probe.status || 0));
    kind = "";
  }

  if (useHlsJs && window.Hls && Hls.isSupported()) {
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
      // 直播:先别报死,换线路去(还有线就换,全试完才失败)
      if (liveMode) {
        liveRetry("hls:" + d.details);
        return;
      }
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

/**
 * 源只给了一张网页(解析页),现在没有谁能接着把它变成可播地址:
 * 明确报错,不拿 HTML 去喂 hls.js(那只会得到 manifestParsingError)。
 * 页面地址放进 raw 里,方便判断到底是哪一步丢了。
 */
function pageWithoutStream(st) {
  pStatus("这个源只给了解析页");
  playerFail({
    step: "page",
    kind: "unsupported",
    title: "这个源只给了解析页,当前没有可用的取流方式",
    hint: "换一条线路试试;都不行就换一个源。",
    raw: "page=" + shortUrl(String((st && st.url) || ""), 200),
  });
}

/** 插件源的 play 钩子:返回 {sources:[{id,name,url,mime,headers}]},换成内部 Stream 形状 */
/**
 * 直播起播:分类 → 列表 → play,没有详情、没有进度。
 * 复用点播那条取流链路(player_url / 白名单 / hls.js),只是把播放器切进直播模式。
 */
async function playLive(item) {
  if (!item) return;
  const gen = ++playSeq;
  liveMode = true;
  liveRetryCount = 0;
  pStartLoading();
  const title = item.title || "直播";
  playCtx = { live: true, key: "", id: item.id, name: title, group: "", mime: "", list: [], index: -1, resume: 0 };
  openPlayer("", title);
  try {
    const st = pluginMode()
      ? await pluginStream("", item.id)
      : await invoke("play", { source: S.source, episodeId: item.id });
    if (gen !== playSeq) return;
    if (!st || !st.url) throw new Error("源没有给出播放地址");
    liveTitle = title;
    liveMime = st.mime || "application/x-mpegURL";
    liveHeaders = st.headers || {};
    // 适配器返回数组 = 同一个台的多条线路(见 examples/m3u.reelbox.js)
    const urls = [st.url].concat((st.options || []).map((o) => o && o.url)).filter(Boolean);
    liveLines = urls.filter((u, i) => urls.indexOf(u) === i);
    liveIdx = 0;
    await startLiveLine(gen);
  } catch (e) {
    log("LIVE FAIL", e);
    liveMode = false;
    pStatus("取流失败");
    playerFail(errorInfo("stream", e));
  }
}

/** 换线路:用户在右上角点的,失败不自动跳,只有这里会换 */
function switchLiveLine(i) {
  if (!liveMode || !liveLines.length) return;
  if (i < 0 || i >= liveLines.length) return;
  liveIdx = i;
  if (playCtx) playCtx.lineIdx = i;
  liveRetryCount = 0;
  pStartLoading("切换线路…");
  startLiveLine(playSeq).catch((e) => {
    log("LIVE switch fail", String(e && e.message ? e.message : e));
    liveRetry("manual switch");
  });
}

/** 起一条线路;标题里带「线路 n/m」,多条线时用户能看出来 */
async function startLiveLine(gen) {
  const url = liveLines[liveIdx];
  if (!url) throw new Error("没有可用的线路");
  // 解析地址可能要点时间,先摆加载态(有时候看着"没 loading"就是这段空的)
  pStartLoading("加载中…");
  const local = await invoke("player_url", {
    stream: { url: url, mime: liveMime, headers: liveHeaders },
  });
  if (gen !== playSeq) return;
  lastLocalUrl = local;
  liveLast = { url: local, name: liveTitle, mime: liveMime };
  const name =
    liveLines.length > 1
      ? liveTitle + " · 线路 " + (liveIdx + 1) + "/" + liveLines.length
      : liveTitle;
  log("LIVE play line", liveIdx + 1 + "/" + liveLines.length, shortUrl(url, 90));
  if (playCtx) {
    playCtx.lines = liveLines;
    playCtx.lineIdx = liveIdx;
  }
  openPlayer(local, name, liveMime, "hls");
  renderLevels();
}

async function pluginStream(groupId, episodeId) {
  const res = await callAdapter(S.source, "play", {
    contentId: S.detailId || "",
    groupId: groupId || "",
    episodeId: episodeId,
    // 契约里的名字是 id(见 docs/PLUGIN.md):两个都喂,插件写哪个都能拿到
    id: episodeId,
    purpose: "playback",
  });
  // play 允许直接返回数组(多档清晰度),别只认 {sources}/{streams}/单对象
  const list = Array.isArray(res)
    ? res
    : (res && (res.sources || res.streams)) || (res && res.url ? [res] : []);
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

/** 这条流是不是"一张网页":CMS 抽不到 m3u8 会标 page,插件也可以直接给 text/html */
function isPageStream(st) {
  if (!st) return false;
  if (st.page === true) return true;
  return String(st.mime || "").toLowerCase().indexOf("text/html") === 0;
}

/** 播放代际:切集 / 关播放器都 +1,让上一条(可能还在解析的)链路立刻作废 */
let playSeq = 0;

async function playEpisode(id, name, groupId) {
  log("playEpisode", name);
  const gen = ++playSeq;
  // 续播/预览和正式播放是同一条起播路:点下去先摆加载态,后面
  // play 钩子 → player_url → stream_kind 这段 peek 也就一直有转圈陪着
  pStartLoading();
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
    let st = pluginMode()
      ? await pluginStream(groupId, id)
      : await invoke("play", { source: S.source, episodeId: id });
    if (gen !== playSeq) return; // 期间切集 / 关了播放器:这条链路作废
    // 这个源只给了一张网页(解析页):没有取流方式就明确报错。
    // 适配器也可能给 page(它自己标了 text/html),这种情况一样 ——
    // 否则 hls.js 只会拿着 HTML 报 manifestParsingError。
    if (st && isPageStream(st)) {
      pageWithoutStream(st);
      return;
    }
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
  if (key === "fav") renderFavs();
  if (key === "settings") {
    bindSettings();
    // 源编辑里的「适配器」下拉要有数据,进设置时拉一次
    loadAdapters();
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
  // 桌面弹出层:点外面关掉(sheet 有自己的 scrim)。
  // 必须走 closeSrcMenu():直接摘 data-open 会留下 srcMenuCloser,
  // 于是 srcMenuOpen() 仍是 true,下一次点源按钮会被当成"关闭"(I3)
  document.addEventListener("click", (e) => {
    const menu = $("srcMenu");
    if (!menu || !menu.hasAttribute("data-open")) return;
    if (e.target.closest("#srcMenu") || e.target.closest("#srcBtn")) return;
    closeSrcMenu();
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
  const favCard = e.target.closest("[data-fav]");
  if (favCard) {
    const f = favList()[Number(favCard.getAttribute("data-fav"))];
    if (f) return openFav(f);
  }
  const card = e.target.closest(".card");
  if (card) {
    const it = S.items[Number(card.getAttribute("data-i"))];
    if (!it) return;
    // 直播源点了就播:频道没有详情页、没有剧集
    if (sourceType(S.source) === "live") return playLive(it);
    return openDetail(it);
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
  clearSkelTimer();
  $("grid").querySelectorAll(".skel").forEach((n) => n.remove());
}

/**
 * 骨架屏兜底:接口迟迟不回来,就一直转下去没人知道发生了什么。
 * 超时后直接给错误三态里的「重试」,用户至少能自己再来一次。
 *
 * 22 秒 = 后端一次请求整体 20 秒 + 一次 800ms 重试(core/src/net/http.rs 的
 * REQUEST_TIMEOUT / RETRY_DELAY)。比以前在这里的 10 秒长:按域名选路之后,
 * 一个 host 第一次可能要走两条路线(先代理再直连,或被反代/被墙那次要等超时),
 * 10 秒会在后端还在试的时候先把界面判死。等真的通了,记忆会把这十几秒只付一次。
 */
const SKEL_TIMEOUT_MS = 22000;
let skelTimer = 0;

function clearSkelTimer() {
  if (skelTimer) clearTimeout(skelTimer);
  skelTimer = 0;
}

function armListTimeout() {
  clearSkelTimer();
  skelTimer = setTimeout(() => {
    skelTimer = 0;
    if (!S.loading || (S.items || []).length) return;
    log("LIST TIMEOUT", SKEL_TIMEOUT_MS + "ms");
    S.loading = false;
    showListError(errorInfo("list", "超时:" + SKEL_TIMEOUT_MS / 1000 + " 秒没有回应"), () => loadItems());
  }, SKEL_TIMEOUT_MS);
}

const DETAIL_SKELETON =
  '<div class="skel-hero"><div class="sk"></div>' +
    '<div class="sk-lines">' + "<i></i>".repeat(6) + "</div></div>" +
  '<div class="skel-chips"><i></i><i></i></div>' +
  '<div class="skel-epgrid">' + "<i></i>".repeat(12) + "</div>";

/**
 * 详情页外壳:结构固定成 `#v-detail > .detail-wrap > .detail-body`。
 * 骨架、真实内容、错误态都只替换 `.detail-body` 的子节点,容器本身不重建 ——
 * 以前整体重写 #v-detail,一次切换就是一次全页重新布局,首屏会闪一下。
 */
function detailBody() {
  const box = $("v-detail");
  let body = box.querySelector(".detail-body");
  if (!body) {
    box.innerHTML = '<div class="detail-wrap"><div class="detail-body"></div></div>';
    body = box.querySelector(".detail-body");
  }
  return body;
}

/** 详情骨架屏:结构与真实布局同构,首屏高度也贴着真实页(样式见 index.html .skel-*) */
function renderDetailSkeleton() {
  const body = detailBody();
  body.parentElement.setAttribute("data-skel", "");
  body.innerHTML = DETAIL_SKELETON;
  $("v-detail").scrollTop = 0;
}

/** 列表:加载中(骨架屏 + 22s 超时兜底,见 SKEL_TIMEOUT_MS) */
function showListLoading() {
  const el = $("empty");
  el.style.display = "none";
  el.innerHTML = "";
  renderSkeleton();
  armListTimeout();
}

/** 列表:空(没有内容;icon 可换,「还没有源」用的是 playlist_add) */
function showListEmpty(title, msg, actionLabel, onAction, icon) {
  clearSkeleton();
  $("grid").innerHTML = "";
  const el = $("empty");
  el.style.display = "";
  el.innerHTML = stateCard({
    icon: icon || "movie",
    title: title || "这个分类没有内容",
    msg: msg || "换一个分类,或者用别的片名搜一下。",
    actions: actionLabel ? [{ id: "more", label: actionLabel }] : [],
  });
  const b = el.querySelector('[data-act="more"]');
  if (b && onAction) b.onclick = onAction;
}

/**
 * 一个源都没有时首页的样子(init 与「删掉最后一个源」都走这里):
 * 卡片式空态 + 「导入源」,搜索框禁用并提示先加源,顶栏源按钮写「还没有源」。
 * 还有源时不要调它 —— 那是 loadItems 的地盘。
 */
function showNoSources() {
  S.source = null;
  S.items = [];
  S.next = "";
  S.parents = [];
  S.children = {};
  S.parent = "";
  S.child = "";
  S.reqSeq++; // 在途的列表/详情请求全部作废
  renderParents();
  renderChildren();
  showListEmpty(
    "还没有源",
    "点「导入源」加一个接口地址;也可以批量导入集合。",
    "导入源",
    () => runSingleImport(),
    "playlist_add"
  );
  if ($("srcName")) $("srcName").textContent = "还没有源";
  syncSearchBox();
  renderSources(); // 顶栏面板:没有源时给空态,不是空白列表
  renderSourceManager(); // 源管理页:空态 + 两个入口
  syncSetSummaries();
}

/**
 * 搜索属于「某个源」:一个源都没有时把输入框与服务按钮一起禁用,占位改成一句提示。
 * 有源之后恢复。源列表每次变化(applySources / 启动)都会走到这里。
 */
function syncSearchBox() {
  const q = $("q");
  const go = $("btnSearch");
  const on = !!(S.sources || []).length;
  if (q) {
    q.disabled = !on;
    q.placeholder = on ? "搜索影片" : "先加一个源再搜索";
    if (!on) q.value = "";
  }
  if (go) go.disabled = !on;
  const box = q ? q.closest(".searchbox") : null;
  if (box) {
    if (on) box.removeAttribute("data-off");
    else box.setAttribute("data-off", "");
  }
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
  const body = detailBody();
  const unsupported = info.kind === "unsupported";
  body.parentElement.removeAttribute("data-skel");
  body.innerHTML =
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
    });
  $("btnBack").onclick = () => closeDetail();
  const retryBtn = body.querySelector('[data-act="retry"]');
  if (retryBtn) retryBtn.onclick = () => openDetail(item || S.detailItem).catch(() => {});
  const sw = body.querySelector('[data-act="switch"]');
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
  // 840–1119 时左侧栏换成了 84 的 rail(没有 sideControls 这一格),
  // 切源按钮与搜索框跟着回到首页顶栏,1120 起才回到侧栏
  const wide = window.matchMedia("(min-width: 1120px)").matches;
  const target = wide ? $("sideControls") : $("topbar");
  if (controls.parentElement !== target) target.appendChild(controls);
  // 源切换 + 搜索框是首页(一级页)的控件。设置二级页只能有 app bar + 内容 + 吸底操作区,
  // 所以只在首页出现:窄屏收起 #topbar,宽屏收起侧栏那一格(以前 ≥1120 会漏进设置页)
  const onHome = currentView === "home";
  controls.style.display = onHome ? "" : "none";
  $("topbar").style.display = !wide && onHome ? "" : "none";
  $("sideControls").style.display = wide && onHome ? "" : "none";
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
