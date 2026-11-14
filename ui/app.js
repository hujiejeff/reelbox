import { initTheme } from "./theme.js";

// Reelbox 前端:所有数据都从 Tauri 命令拿。
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

async function init() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
      e.preventDefault();
      toggleDebug();
    }
  });
  log("init start");
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
  if (!$("player").hidden) closePlayer();
  showView("home");
  await Promise.all([loadFilters(), loadItems()]);
}

async function loadFilters() {
  let fs = [];
  try {
    fs = await invoke("filters", { source: S.source });
  } catch (_) {}
  const opts = (fs[0] && fs[0].options) || [];
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
    const page = await invoke("list_items", {
      source: S.source,
      page: 1,
      classify: S.child,
    });
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
    const page = await invoke("list_items", {
      source: S.source,
      page: Number(S.next),
      classify: S.child,
    });
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
    const page = await invoke("search", { source: S.source, keyword: q, page: 1 });
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
    const d = await invoke("detail", { source: S.source, id: item.id });
    renderDetail(d);
  } catch (e) {
    $("v-detail").innerHTML = '<div class="placeholder"><b>详情失败</b><span>' + esc(String(e)) + "</span></div>";
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
        '<span class="m3e-filter-chip__leading"><span class="m3e-icon m3e-filter-chip__check">check</span></span>' +
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
  d.groups.forEach((g) => g.episodes.forEach((e) => S.detailEps.push({ id: e.id, name: e.name })));
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
          .map((e) => '<button class="chip-ep" data-id="' + esc(e.id) + '">' + esc(e.name) + "</button>")
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
      if (r && r.id) playEpisode(r.id, r.name);
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
    b.onclick = () => playEpisode(b.getAttribute("data-id"), b.textContent);
  });
}

let hls = null;
let playCtx = null;
let idleTimer = 0;
let tickTimer = 0;
let dragging = false;

/* ---------- 播放进度 ---------- */
/* ---------- 日志:内存环形缓冲 + 落盘 ---------- */
const LOG_MAX = 300;
const LOG_BUF = [];
const NL = String.fromCharCode(10);

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
  playEpisode(ep.id, ep.name);
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
  btn.onclick = () => playEpisode(rec.id, rec.name);
}

function saveProgress(force) {
  if (!playCtx || !playCtx.id) return;
  const v = $("video");
  const t = v.currentTime;
  if (!isFinite(t) || t < 3) return;
  const now = Date.now();
  if (!force && now - (playCtx.saved || 0) < 5000) return;
  playCtx.saved = now;
  progSet(playCtx.key, { id: playCtx.id, name: playCtx.name, t: t, at: now });
}

function openPlayer(url, name) {
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
    if (next) playEpisode(next.id, next.name);
    else pStatus("已经是最后一集");
  };

  const isHls = url.indexOf(".m3u8") >= 0 || url.indexOf("mpegurl") >= 0;
  if (window.Hls && Hls.isSupported() && isHls) {
    hls = new Hls({ maxBufferLength: 30, enableWorker: true });
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      pStatus("");
      renderLevels();
      v.volume = loadVolume();
      v.play().then(() => tryUnmute(v)).catch(() => {});
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, renderLevels);
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (d && d.fatal) {
        log("HLS FATAL", d.details);
        pStatus("播放失败:" + d.details);
        window.__err && window.__err("hls: " + d.details);
      }
    });
  } else {
    $("pQuality").hidden = true;
    v.src = url;
    v.volume = loadVolume();
    v.play().then(() => tryUnmute(v)).catch(() => {});
  }
}

async function playEpisode(id, name) {
  log("playEpisode", name);
  const key = detailKey();
  const rec = progGet(key);
  const list = S.detailEps || [];
  const idx = list.findIndex((e) => e.id === id);
  playCtx = {
    key: key,
    id: id,
    name: name,
    list: list,
    index: idx,
    resume: rec && rec.id === id ? rec.t || 0 : 0,
  };
  openPlayer("", name);
  try {
    const st = await invoke("play", { source: S.source, episodeId: id });
    const local = await invoke("player_url", { stream: st });
    log("stream", st.mime, String(local).slice(0, 60));
    openPlayer(local, name);
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
