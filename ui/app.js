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
  blobs: [],            // 回收用的 object URL
};

const $ = (id) => document.getElementById(id);

// ---------- 数据 ----------

async function init() {
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
    renderGrid();
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
    S.items = S.items.concat(page.items || []);
    S.next = page.nextCursor || "";
    renderGrid();
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
    renderGrid();
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
        '<button class="m3e-filter-chip" type="button" data-child="' + esc(c.value) + '"' +
        (S.child === c.value ? ' aria-selected="true"' : "") + ">" + esc(c.label) + "</button>"
    )
    .join("");
}

function renderGrid() {
  revokeBlobs();
  const grid = $("grid");
  $("empty").style.display = S.items.length ? "none" : "";
  if (!S.items.length) {
    $("empty").textContent = S.loading ? "" : "这个分类没有内容";
  }
  grid.innerHTML = S.items
    .map(
      (it, i) =>
        '<article class="card" data-i="' + i + '"><div class="poster"><img alt="" loading="lazy"></div>' +
        '<div class="meta"><b>' + esc(it.title) + "</b><span>" + esc(it.subtitle || "") + "</span></div></article>"
    )
    .join("");

  const imgs = grid.querySelectorAll("img");
  S.items.forEach((it, i) => {
    if (!it.poster || !imgs[i]) return;
    invoke("poster", { url: it.poster })
      .then((buf) => {
        const url = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: "image/jpeg" }));
        S.blobs.push(url);
        imgs[i].src = url;
      })
      .catch(() => {});
  });
}

function renderDetail(d) {
  const eps = [];
  d.groups.forEach((g) => {
    eps.push('<div class="catgroup">' + esc(g.name) + "</div>");
    g.episodes.forEach((e) => {
      eps.push('<button class="chip-ep" data-id="' + esc(e.id) + '">' + esc(e.name) + "</button>");
    });
  });
  $("v-detail").innerHTML =
    '<div class="detail-head"><button class="m3e-button m3e-button--text m3e-button--size-s" id="btnBack">返回</button></div>' +
    '<div class="detail-top"><div class="hero"><img alt=""></div>' +
    "<div><h2>" + esc(d.title) + "</h2><p>" + esc(d.summary || "") + "</p></div></div>" +
    '<div class="eps">' + eps.join("") + "</div>";

  $("btnBack").onclick = () => showView("home");
  if (d.poster) {
    invoke("poster", { url: d.poster })
      .then((buf) => {
        const url = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: "image/jpeg" }));
        S.blobs.push(url);
        const img = $("v-detail").querySelector(".hero img");
        if (img) img.src = url;
      })
      .catch(() => {});
  }
  $("v-detail").querySelectorAll(".chip-ep").forEach((b) => {
    b.onclick = () => playEpisode(b.getAttribute("data-id"), b.textContent);
  });
}

async function playEpisode(id, name) {
  try {
    const st = await invoke("play", { source: S.source, episode_id: id });
    $("v-detail").querySelector(".eps").innerHTML =
      '<div class="placeholder"><b>' + esc(name) + "</b><span>" + esc(st.mime) + "</span><span class=\"mono\">" +
      esc(st.url) + "</span></div>";
  } catch (e) {
    alert("取流失败:" + e);
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
    S.child = chip.getAttribute("data-child");
    renderChildren();
    return loadItems();
  }
  const card = e.target.closest(".card");
  if (card) {
    const it = S.items[Number(card.getAttribute("data-i"))];
    if (it) return openDetail(it);
  }
});

function setStatus() {
  const el = $("empty");
  if (S.loading) {
    el.style.display = "";
    el.textContent = "加载中…";
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

$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});
$("scroll").addEventListener("scroll", () => {
  const el = $("scroll");
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) loadMore();
});

init();
