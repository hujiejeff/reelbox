import { initTheme } from "./theme.js";
import { initPluginHost, callPlugin, isPluginSource } from "./plugin-host.js";

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
      if (debugOn()) toggleDebug();
    }
  });
  bindDebugToggle();
  bindWheelScroll();
  log("init start");
  initPluginHost({ invoke: invoke, log: log });
  {
    const d = document.getElementById("dbg");
    const fab = document.getElementById("dbgFab");
    if (fab) fab.hidden = !debugOn();
    if (!debugOn() && d) d.hidden = true;
  }
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
    return showEmpty("读不到源列表:" + e);
  }
  if (!S.sources.length) return showEmpty("还没有配置源");
  S.source = S.sources[0];
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
    if (!items.length) return await stop("列表为空");
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

async function switchSource(src) {
  log("switchSource", src && src.id);
  S.source = src;
  S.parent = "";
  S.child = "";
  S.items = [];
  S.blobs.forEach((u) => URL.revokeObjectURL(u));
  S.blobs.clear();
  $("srcName").textContent = src.name;
  // 切源等于换了片库:详情页上的剧集已失效,先回首页
  S.detailTitle = "";
  S.detailEps = [];
  S.detailId = "";
  if (!$("player").hidden) closePlayer();
  showView("home");
  await Promise.all([loadFilters(), loadItems()]);
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
  renderParents();
  renderChildren();
}

async function loadItems() {
  if (!S.source) return;
  S.loading = true;
  setStatus();
  try {
    const page = await fetchPage(1, S.child);
    S.items = page.items || [];
    S.page = 1;
    S.next = page.nextCursor || "";
    resetGrid();
    appendCards(0);
  } catch (e) {
    showEmpty(String(e));
  } finally {
    S.loading = false;
    setStatus();
  }
}

async function loadMore() {
  if (S.loading || !S.next) return;
  S.loading = true;
  try {
    const page = await fetchPage(Number(S.next), S.child);
    const before = S.items.length;
    S.items = S.items.concat(page.items || []);
    S.next = page.nextCursor || "";
    appendCards(before);
  } catch (_) {
  } finally {
    S.loading = false;
  }
}

async function doSearch() {
  const q = ($("q").value || "").trim();
  if (!q) return loadItems();
  S.loading = true;
  setStatus();
  try {
    const page = await fetchSearch(q, 1);
    S.items = page.items || [];
    S.next = "";
    resetGrid();
    appendCards(0);
  } catch (e) {
    showEmpty(String(e));
  } finally {
    S.loading = false;
    setStatus();
  }
}

async function openDetail(item) {
  log("openDetail", item && item.title);
  showView("detail");
  $("v-detail").innerHTML =
    '<div class="detail-wrap">' +
      '<div class="skel-hero"><div class="sk"></div>' +
        '<div class="sk-lines"><i></i><i></i><i></i><i></i></div></div>' +
      '<div class="skel-chips">' + "<i></i>".repeat(14) + "</div>" +
    "</div>";
  try {
    const d = await fetchDetail(item.id);
    S.detailId = d.id || item.id;
    renderDetail(d);
    return d;
  } catch (e) {
    $("v-detail").innerHTML = '<div class="placeholder"><b>详情失败</b><span>' + esc(String(e)) + "</span></div>";
    throw e;
  }
}

// ---------- 渲染 ----------

function renderSources() {
  const menu = $("srcMenu");
  menu.innerHTML = S.sources
    .map(
      (s) =>
        '<button role="menuitemradio" data-src="' + esc(s.id) + '" aria-checked="' +
        (S.source && s.id === S.source.id ? "true" : "false") + '">' +
        esc(s.name) + '<span class="m3e-icon">' +
        (S.source && s.id === S.source.id ? "check" : "") + "</span></button>"
    )
    .join("");
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
  $("empty").style.display = S.items.length ? "none" : "";
  if (!S.items.length) {
    $("empty").textContent = S.loading ? "" : "这个分类没有内容";
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
  S.detailEps = [];
  d.groups.forEach((g) =>
    g.episodes.forEach((e) => S.detailEps.push({ id: e.id, name: e.name, group: e.group || g.id }))
  );
  const rec = progGet(detailKey());
  const resumeBtn =
    rec && rec.id
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

/* ---------- 源管理 ---------- */
let editingId = "";

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

function renderSourceManager() {
  const box = $("srcmgr");
  if (!box) return;
  box.innerHTML = (S.sources || [])
    .map(
      (s) =>
        '<div class="srcrow" data-id="' + esc(s.id) + '">' +
        '<span class="nm">' + esc(s.name) + "</span>" +
        '<span class="kd">' + (s.kind === "xml" ? "XML" : "JSON") + "</span>" +
        '<span class="ul">' + esc(s.url) + "</span>" +
        '<button data-act="edit" data-id="' + esc(s.id) + '">编辑</button>' +
        '<button data-act="del" data-id="' + esc(s.id) + '">删除</button>' +
        "</div>"
    )
    .join("") || '<p class="hint">还没有源</p>';
}

function openSrcForm(src) {
  const form = $("srcForm");
  if (!form) return;
  editingId = src ? src.id : "";
  $("sfName").value = src ? src.name : "";
  $("sfUrl").value = src ? src.url : "";
  $("sfKind").value = src && src.kind === "xml" ? "xml" : "vod";
  form.hidden = false;
  $("sfName").focus();
}

function closeSrcForm() {
  const form = $("srcForm");
  if (form) form.hidden = true;
  editingId = "";
}

async function persistSources() {
  try {
    await invoke("save_sources", { list: S.sources });
    log("sources saved", String(S.sources.length));
  } catch (e) {
    log("SOURCES SAVE FAIL", e);
  }
}

async function saveSrcForm() {
  const name = $("sfName").value.trim();
  const url = $("sfUrl").value.trim();
  const kind = $("sfKind").value;
  if (!name || !url) return;
  const src = normSource({ name: name, url: url, kind: kind });
  if (!src) return;
  const list = S.sources.slice();
  if (editingId) {
    const i = list.findIndex((x) => x.id === editingId);
    if (i >= 0) list[i] = Object.assign({}, src, { id: editingId });
    else list.push(src);
  } else {
    if (list.some((x) => x.url === src.url)) return;
    list.push(src);
  }
  S.sources = list;
  await persistSources();
  renderSourceManager();
  renderSources();
  closeSrcForm();
}

async function removeSource(id) {
  const list = S.sources.filter((x) => x.id !== id);
  if (!list.length) return;
  S.sources = list;
  await persistSources();
  renderSourceManager();
  renderSources();
  if (S.source && S.source.id === id) await switchSource(list[0]);
}

function bindSourceManager() {
  const box = $("srcmgr");
  if (box && !box.dataset.bound) {
    box.dataset.bound = "1";
    box.onclick = (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const id = b.getAttribute("data-id");
      if (b.getAttribute("data-act") === "edit") {
        const src = S.sources.find((x) => x.id === id);
        if (src) openSrcForm(src);
      } else if (confirm("删除这个源?")) {
        removeSource(id);
      }
    };
  }
  if ($("srcAdd") && !$("srcAdd").dataset.bound) {
    $("srcAdd").dataset.bound = "1";
    $("srcAdd").onclick = () => openSrcForm(null);
    $("sfSave").onclick = saveSrcForm;
    $("sfCancel").onclick = closeSrcForm;
    $("srcImport").onclick = () => $("srcFile").click();
    $("srcPlugin").onclick = () => $("pluginFile").click();
    $("pluginFile").onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const res = await invoke("save_plugin", { fileName: f.name, text: text });
        const exists = S.sources.some((x) => x.id === res.id);
        if (!exists) {
          S.sources = S.sources.concat([
            { id: res.id, name: res.name, type: "webox", url: res.path },
          ]);
          await persistSources();
        }
        renderSourceManager();
        renderSources();
        log("plugin imported", res.id);
        alert("已导入插件:" + res.name);
      } catch (err) {
        log("PLUGIN IMPORT FAIL", err);
        alert("导入失败:" + err);
      } finally {
        e.target.value = "";
      }
    };
    $("srcFile").onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const data = JSON.parse(text);
        const raw = Array.isArray(data) ? data : data.sites || data.sources || [];
        const merged = uniqSources(S.sources.concat(raw.map(normSource).filter(Boolean)));
        if (!merged.length) throw new Error("没有识别到可用的源");
        S.sources = merged;
        await persistSources();
        renderSourceManager();
        renderSources();
        log("sources imported", String(merged.length));
        alert("已导入,当前共 " + merged.length + " 个源");
      } catch (err) {
        log("IMPORT FAIL", err && err.message);
        alert("导入失败:" + (err && err.message ? err.message : err));
      } finally {
        e.target.value = "";
      }
    };
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

const DEBUG_KEY = "reelbox.debug";

function debugOn() {
  try { return localStorage.getItem(DEBUG_KEY) === "1"; } catch (_) { return false; }
}

function setDebug(on) {
  try { localStorage.setItem(DEBUG_KEY, on ? "1" : "0"); } catch (_) {}
  const box = document.getElementById("dbg");
  const fab = document.getElementById("dbgFab");
  if (fab) fab.hidden = !on;
  if (box && !on) box.hidden = true;
  syncDebugButtons();
  log("debug", on ? "on" : "off");
}

function syncDebugButtons() {
  const seg = document.getElementById("segDebug");
  if (!seg) return;
  const on = debugOn() ? "1" : "0";
  seg.querySelectorAll("button").forEach((b) => {
    b.setAttribute("aria-selected", b.getAttribute("data-debug") === on ? "true" : "false");
  });
}

function bindDebugToggle() {
  const fab = document.getElementById("dbgFab");
  if (fab) {
    fab.hidden = !debugOn();
    fab.onclick = () => toggleDebug();
  }
  const seg = document.getElementById("segDebug");
  if (!seg || seg.dataset.bound) return;
  seg.dataset.bound = "1";
  seg.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    setDebug(b.getAttribute("data-debug") === "1");
  };
  syncDebugButtons();
}

function toggleDebug() {
  const box = document.getElementById("dbg");
  if (!box) return;
  box.hidden = !box.hidden;
  box.textContent = LOG_BUF.join(NL);
  box.scrollTop = box.scrollHeight;
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
  $("pLevels").hidden = true;
  refreshResume();
}

function refreshResume() {
  const wrap = $("v-detail").querySelector(".detail-wrap");
  if (!wrap) return;
  const rec = progGet(detailKey());
  let btn = $("btnResume");
  if (!rec || !rec.id) {
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
  v.onplaying = () => { pStatus(""); pSync(); };
  v.onpause = pSync;
  v.onended = () => {
    const ctx = playCtx;
    pSync();
    if (!ctx || !ctx.list || !ctx.list.length) return;
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
  };

  // 本地反代地址把真实地址 base64 掉了,看不出扩展名,所以以 mime 为准;
  // 但插件是按地址后缀猜 mime 的(签名的 mp4 地址没有后缀,会被写成 mpegurl),
  // 所以 playEpisode 先探到的真实类型 kind 优先。
  const hint = mime || (playCtx && playCtx.mime) || "";
  const hlsByHint = /mpegurl|m3u8/i.test(hint) || url.indexOf(".m3u8") >= 0 || url.indexOf("mpegurl") >= 0;
  const isHls = kind === "file" ? false : (kind === "hls" || hlsByHint);
  log("play mode " + (isHls ? "hls" : "native") + " kind=" + (kind || "?") + " hint=" + hint);
  if (window.Hls && Hls.isSupported() && isHls) {
    hls = new Hls({ maxBufferLength: 30, enableWorker: true });
    // 事件要先挂上再 loadSource,否则早期的清单错误会漏记
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      pStatus("");
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
    resume: rec && rec.id === id ? rec.t || 0 : 0,
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
    log("play hook ms=" + hookMs + " mime=" + (st.mime || "") + " url=" + shortUrl(st.url, 160));
    if (st.headers && Object.keys(st.headers).length) {
      log("play headers " + Object.keys(st.headers).join(","));
    }
    const local = await invoke("player_url", { stream: st });
    lastLocalUrl = local;
    // 探一眼真实内容:插件会把没有后缀的 mp4 地址写成 mpegurl,
    // 丢给 hls.js 只会得到 manifestParsingError
    let kind = "";
    try {
      const probe = await invoke("stream_kind", { stream: st });
      kind = (probe && probe.kind) || "";
      log(
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
    log("stream " + st.mime + " local=" + shortUrl(local, 90) + " opts=" + opts.length);
    openPlayer(local, name, st.mime, kind);
  } catch (e) {
    log("STREAM FAIL", e);
    pStatus("取流失败:" + e);
  }
}

// ---------- 交互 ----------

function bindNav() {
  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.onclick = () => showView(el.getAttribute("data-nav"));
  });
}

function showView(key) {
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
    bindDebugToggle();
    bindSourceManager();
    renderSourceManager();
  }
}

function bindSourceMenu() {
  const btn = $("srcBtn");
  const menu = $("srcMenu");
  btn.onclick = (e) => {
    e.stopPropagation();
    if (menu.hasAttribute("data-open")) return menu.removeAttribute("data-open");
    const r = btn.getBoundingClientRect();
    menu.style.left = r.left + "px";
    menu.style.top = r.bottom + 6 + "px";
    menu.setAttribute("data-open", "");
  };
  document.addEventListener("click", () => menu.removeAttribute("data-open"));
  menu.addEventListener("click", (e) => {
    const it = e.target.closest("button[data-src]");
    if (!it) return;
    const src = S.sources.find((s) => s.id === it.getAttribute("data-src"));
    menu.removeAttribute("data-open");
    if (src && (!S.source || src.id !== S.source.id)) {
      renderSources();
      switchSource(src);
    }
  });
}

document.addEventListener("click", (e) => {
  const cat = e.target.closest("[data-parent]");
  if (cat) {
    const p = cat.getAttribute("data-parent");
    S.parent = p;
    const kids = S.children[p] || [];
    S.child = kids.length ? kids[0].value : "";
    renderParents();
    renderChildren();
    return loadItems();
  }
  const chip = e.target.closest("[data-child]");
  if (chip) {
    const next = chip.getAttribute("data-child");
    if (next === S.child) return;
    S.child = next;
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

function setStatus() {
  const el = $("empty");
  if (S.loading && !S.items.length) {
    el.style.display = "none";
    renderSkeleton();
  } else {
    clearSkeleton();
  }
}

function showEmpty(msg) {
  $("grid").innerHTML = "";
  const el = $("empty");
  el.style.display = "";
  el.textContent = msg;
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

function layoutControls() {
  const controls = $("controls");
  const wide = window.matchMedia("(min-width: 840px)").matches;
  const target = wide ? $("sideControls") : $("topbar");
  if (controls.parentElement !== target) target.appendChild(controls);
  controls.style.display = "";
  $("topbar").style.display = wide ? "none" : "";
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
