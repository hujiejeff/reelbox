// 切源面板的内容(容器无关):同一份 DOM 既挂进 bottom sheet(<840),也挂进
// 桌面侧栏的弹出层(≥840)。行样式与数值来自 docs/DESIGN-SPEC-UI.md §4。
//
// 结构:
//   header(切换源 + 管理)
//   search?(源总数 > 8 才出现)
//   分组 × n(最近使用 / 点播 / 插件 / 直播)
//
// 行:56 高、r28、leading 18 图标、名称 16/24、trailing 状态点 + check。

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

/**
 * opts = {
 *   groups: [{ key, label, rows: [row] }],   // 已排好序、当前源已置顶
 *   recent: [row],                            // 最近使用(可以为空)
 *   total,                                    // 源总数(决定搜索框出现与否)
 *   query,                                    // 当前搜索词
 *   empty: false                              // 一个源都没有
 * }
 * row = { idx, id, name, type: "vod"|"plugin"|"live", icon, current, state, stateLabel }
 * idx = 该源在 sources 数组里的下标(行按它派发,同 id 的两条源不会误伤)
 */
export function buildSrcPanel(opts) {
  const box = document.createElement("div");
  box.className = "src-panel";

  const groups = (opts.groups || []).filter((g) => g.rows && g.rows.length);
  const showSearch = opts.total > 8;
  const nothing = !groups.length && !(opts.recent || []).length;

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
    (nothing && opts.empty
      ? '<div class="src-panel__empty">' +
          '<span class="m3e-icon" aria-hidden="true">playlist_add</span>' +
          '<b>还没有源</b>' +
          '<button type="button" class="m3e-button m3e-button--filled" data-act="add">添加源</button>' +
        "</div>"
      : "") +
    (nothing && !opts.empty
      ? '<div class="src-panel__empty"><b>没找到 「' + esc(opts.query || "") + '」</b>' +
          '<span>换个词试试</span></div>'
      : "") +
    ((opts.recent || []).length
      ? groupHtml({ key: "recent", label: "最近使用" }, opts.recent, true)
      : "") +
    groups.map((g) => groupHtml(g, g.rows, false)).join("");

  return box;
}

function groupHtml(group, rows, isRecent) {
  return (
    '<section class="src-panel__group" data-group="' + esc(group.key) + '">' +
      '<h4 class="src-panel__gh">' + esc(group.label) + "</h4>" +
      '<div class="src-panel__rows">' +
        rows.map((r) => rowHtml(r, isRecent)).join("") +
      "</div>" +
    "</section>"
  );
}

function rowHtml(r, isRecent) {
  return (
    '<button type="button" class="src-panel__row" data-idx="' + esc(r.idx) + '" data-src="' + esc(r.id) + '"' +
    (r.current ? ' aria-current="true"' : "") + ">" +
      '<span class="src-panel__lead" aria-hidden="true">' +
        '<span class="m3e-icon">' + (isRecent ? "history" : esc(r.icon || "dns")) + "</span>" +
      "</span>" +
      '<span class="src-panel__name">' + esc(r.name) + "</span>" +
      (isRecent && r.icon
        ? '<span class="m3e-icon src-panel__type" aria-hidden="true">' + esc(r.icon) + "</span>"
        : "") +
      '<span class="src-panel__trail">' +
        // health = 8dp 圆/方块/空心环;check = 18dp 对勾。两者不要混成一个点
        '<span class="status-dot" data-state="' + esc(r.state || "untested") + '" role="img" aria-label="' +
          esc(r.stateLabel || "未测速") + '"' + (r.stateLabel ? ' title="' + esc(r.stateLabel) + '"' : "") +
        "></span>" +
        (r.current ? '<span class="m3e-icon src-panel__check" aria-hidden="true">check</span>' : "") +
      "</span>" +
    "</button>"
  );
}
