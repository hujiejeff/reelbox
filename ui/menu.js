// 弹出菜单(m3e-menu 的容器 + 定位 + 收事件)。
//
// m3e 只给了 .m3e-menu / .m3e-menu__item 的样式,没有开合与定位;这里补齐。
// 结构取最简形态(菜单里不放 .m3e-menu__group):此时 .m3e-menu:not(:has(>__group))
// 自己就是容器(圆角、底色、阴影都由它给),外层只负责贴在锚点旁边。
//
// 用法:
//   const close = openMenu(anchorEl, [
//     { type: "label", label: "点播 · JSON" },
//     { id: "edit", label: "编辑", icon: "edit" },
//     { id: "cur", label: "已设为当前源", icon: "check", checked: true, disabled: true },
//     { divider: true },
//     { id: "del", label: "删除", icon: "delete", danger: true },
//   ], (id) => { ... });
//   close();   // 也可以外部关掉(点外面 / Esc / 滚动都会自己关)

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

const GAP = 4;      // 菜单与锚点的间距
const EDGE = 8;     // 与视口边缘的最小距离

let closeCurrent = null;

function itemHtml(it) {
  if (it.divider) return '<hr class="m3e-menu__divider">';
  if (it.type === "label") {
    return '<div class="m3e-menu__label"><span class="m3e-menu__item-text">' + esc(it.label) + "</span></div>";
  }
  return (
    '<button type="button" class="m3e-menu__item" role="menuitem" data-id="' + esc(it.id) + '"' +
      (it.disabled ? ' aria-disabled="true" disabled' : "") +
      (it.checked ? ' aria-checked="true"' : "") +
      (it.danger ? ' data-danger="1"' : "") +
      (it.hint ? ' title="' + esc(it.hint) + '"' : "") + ">" +
      '<span class="m3e-menu__item-leading">' +
        '<span class="m3e-icon" aria-hidden="true">' + esc(it.icon || "chevron_right") + "</span>" +
      "</span>" +
      '<span class="m3e-menu__item-text">' + esc(it.label) + "</span>" +
    "</button>"
  );
}

/** 把菜单摆在锚点旁边:优先右下,放不下就翻到上方,左右夹在视口里 */
function place(menu, anchor) {
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  let left = a.right - m.width;
  left = Math.max(EDGE, Math.min(left, vw - m.width - EDGE));
  let top = a.bottom + GAP;
  if (top + m.height > vh - EDGE) {
    const up = a.top - m.height - GAP;
    top = up >= EDGE ? up : Math.max(EDGE, vh - m.height - EDGE);
  }
  menu.style.left = Math.round(left) + "px";
  menu.style.top = Math.round(top) + "px";
}

/** 打开菜单;返回关闭函数。同一时刻只留一个。 */
export function openMenu(anchor, items, onSelect) {
  closeMenu();
  if (!anchor || !items || !items.length) return () => {};

  const menu = document.createElement("div");
  menu.className = "m3e-menu popmenu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = items.map(itemHtml).join("");
  document.body.appendChild(menu);
  place(menu, anchor);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("scroll", close, true);
    menu.remove();
    if (closeCurrent === close) closeCurrent = null;
  };

  function onDown(e) {
    if (menu.contains(e.target) || anchor.contains(e.target)) return;
    close();
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = Array.from(menu.querySelectorAll(".m3e-menu__item:not([disabled])"));
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement);
    const next = e.key === "ArrowDown"
      ? list[(i + 1) % list.length]
      : list[(i <= 0 ? list.length : i) - 1];
    next.focus();
  }

  menu.addEventListener("click", (e) => {
    const b = e.target.closest(".m3e-menu__item[data-id]");
    if (!b || b.hasAttribute("disabled")) return;
    const id = b.getAttribute("data-id");
    close();
    if (onSelect) onSelect(id);
  });

  // 捕获阶段:先于页面的其它点击处理关掉,免得点到别处还残留一层
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", close);
  window.addEventListener("scroll", close, true);

  closeCurrent = close;
  const first = menu.querySelector(".m3e-menu__item:not([disabled])");
  if (first) setTimeout(() => { try { first.focus(); } catch (_) {} }, 20);
  return close;
}

export function closeMenu() {
  if (closeCurrent) closeCurrent();
}

export function menuOpen() {
  return !!closeCurrent;
}
