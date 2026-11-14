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
  $("pBack").onclick = closePlayer;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("player").hidden) closePlayer();
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
  S.source = src;
  S.parent = "";
  S.child = "";
  S.items = [];
  S.blobs.forEach((u) => URL.revokeObjectURL(u));
  S.blobs.clear();
  $("srcName").textContent = src.name;
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
  showView("detail");
  $("v-detail").innerHTML = '<div class="placeholder"><b>加载中…</b></div>';
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
      (groups || '<p class="noep">这个源没给剧集列表</p>') +
    "</div>";

  $("btnBack").onclick = () => showView("home");

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

function closePlayer() {
  const box = $("player");
  const v = $("video");
  if (hls) { hls.destroy(); hls = null; }
  try { v.pause(); } catch (_) {}
  v.removeAttribute("src");
  v.load();
  box.hidden = true;
  box.classList.remove("dim");
}

function openPlayer(url, name) {
  const box = $("player");
  const v = $("video");
  box.hidden = false;
  $("pTitle").textContent = name || "";
  $("pState").textContent = "加载中…";
  if (hls) { hls.destroy(); hls = null; }

  const isHls = url.indexOf(".m3u8") >= 0 || url.indexOf("mpegurl") >= 0;
  if (window.Hls && Hls.isSupported() && isHls) {
    hls = new Hls({ maxBufferLength: 30, enableWorker: true });
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      $("pState").textContent = "";
      v.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (d && d.fatal) { $("pState").textContent = "播放失败:" + d.details; window.__err && window.__err("hls: " + d.details); }
    });
  } else {
    v.src = url;
    v.play().catch(() => {});
  }
  v.onplaying = () => { $("pState").textContent = ""; };
}

async function playEpisode(id, name) {
  openPlayer("", name);
  try {
    const st = await invoke("play", { source: S.source, episodeId: id });
    const local = await invoke("player_url", { stream: st });
    openPlayer(local, name);
  } catch (e) {
    $("pState").textContent = "取流失败:" + e;
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
