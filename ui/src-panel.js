// 切源面板的内容(容器无关):同一份 DOM 既挂进 bottom sheet(<840),也挂进
// 桌面侧栏的弹出层(≥840)。行样式与数值来自 docs/DESIGN-SPEC-UI.md §4。
//
// 结构:
//   header(切换源 + 管理)
//   search?(源总数 > 8 才出现)
//   空态(没有可用的源)/ 分组 × n(点播 / 插件 / 直播)
//
// 只列「可用于当前功能」的源(判定在 app.js 的 isUsableSource 一处);
// 面板本身不再维护任何历史/LRU 分组 —— 分组只按类型。
//
// 行:56 高、r28、leading 18 图标、名称 16/24、trailing 只有状态点(有 health 数据才显示)。
// 当前源只靠 secondary-container 底 + 名称 600 表示,不加 check(评审 1)。

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

/**
 * opts = {
 *   groups: [{ key, label, rows: [row] }],   // 已排好序、当前源已置顶
 *   total,                                    // 源总数(决定搜索框出现与否)
 *   query,                                    // 当前搜索词
 *   empty: "none" | "unusable" | ""           // 没有源 / 有源但都不可用 / 有可用的行
 * }
 * row = { idx, id, name, type: "vod"|"plugin"|"live", icon, current, state, stateLabel }
 * idx = 该源在 sources 数组里的下标(行按它派发,同 id 的两条源不会误伤)
 */
export function buildSrcPanel(opts) {
  const box = document.createElement("div");
  box.className = "src-panel";

  const groups = (opts.groups || []).filter((g) => g.rows && g.rows.length);
  const showSearch = opts.total > 8;
  const nothing = !groups.length;

  box.innerHTML =
    '<div class="src-panel__head">' +
      '<h3 class="src-panel__title">切换源</h3>' +
      '<button type="button" class="m3e-button m3e-button--text" data-act="manage">管理</button>' +
    "</div>" +
    (showSearch
      ? '<label class="src-panel__search">' +
          '<span class="m3e-icon" aria-hidden="true">search</span>' +
          '<input type="search" data-act="query" value="' + esc(opts.query || "") +
          '" placeholder="搜索源名称或地址" aria-label="搜索源">' +
        "</label>"
      : "") +
    (nothing ? emptyHtml(opts) : "") +
    groups.map((g) => groupHtml(g, g.rows)).join("");

  return box;
}

/**
 * 面板空态:一个能列的行都没有时才出现。
 *   empty = "none"     一个源都还没有 → 「还没有源」+ 导入源
 *   empty = "unusable" 有源,但没有一个能用于当前功能 → 说清楚为什么,同样给导入源
 *   有搜索词但没命中            → 「没找到 xxx」
 */
function emptyHtml(opts) {
  const q = String(opts.query || "").trim();
  if (opts.empty === "none") {
    return (
      '<div class="src-panel__empty">' +
        '<span class="m3e-icon" aria-hidden="true">playlist_add</span>' +
        "<b>还没有源</b>" +
        "<span>点「导入源」加一个接口地址,也可以批量导入集合。</span>" +
        '<button type="button" class="m3e-button m3e-button--filled" data-act="import">导入源</button>' +
      "</div>"
    );
  }
  if (q) {
    return (
      '<div class="src-panel__empty">' +
        "<b>没找到「" + esc(q) + "」</b>" +
        "<span>换个词试试</span>" +
      "</div>"
    );
  }
  return (
    '<div class="src-panel__empty">' +
      '<span class="m3e-icon" aria-hidden="true">link_off</span>' +
      "<b>没有可用的源</b>" +
      "<span>直播源要等 v0.3;取不到数据的源点「管理」换掉,或者再导入一个。</span>" +
      '<button type="button" class="m3e-button m3e-button--filled" data-act="import">导入源</button>' +
    "</div>"
  );
}

function groupHtml(group, rows) {
  return (
    '<section class="src-panel__group" data-group="' + esc(group.key) + '">' +
      '<h4 class="src-panel__gh">' + esc(group.label) + "</h4>" +
      '<div class="src-panel__rows">' +
        rows.map(rowHtml).join("") +
      "</div>" +
    "</section>"
  );
}

/** 状态点只在有 health 数据时出现:未测速不画空心环(评审 1) */
function trailHtml(r) {
  if (!r.state || r.state === "untested") return "";
  return (
    '<span class="src-panel__trail">' +
      '<span class="status-dot" data-state="' + esc(r.state) + '" role="img" aria-label="' +
        esc(r.stateLabel || "未测速") + '"' + (r.stateLabel ? ' title="' + esc(r.stateLabel) + '"' : "") +
      "></span>" +
    "</span>"
  );
}

function rowHtml(r) {
  return (
    '<button type="button" class="src-panel__row" data-idx="' + esc(r.idx) + '" data-src="' + esc(r.id) + '"' +
    (r.current ? ' aria-current="true"' : "") + ">" +
      '<span class="src-panel__lead" aria-hidden="true">' +
        '<span class="m3e-icon">' + esc(r.icon || "dns") + "</span>" +
      "</span>" +
      '<span class="src-panel__name">' + esc(r.name) + "</span>" +
      trailHtml(r) +
    "</button>"
  );
}
