// Bottom Sheet:m3e 只给了结构和过渡令牌,拖拽手势与开合动画要自己接。
//
// 结构(照 vendor/m3e.css 的既有类):
//   <dialog class="m3e-bottom-sheet m3e-bottom-sheet--modal">
//     <div class="m3e-bottom-sheet__scrim"></div>
//     <div class="m3e-bottom-sheet__sheet">
//       <div class="m3e-bottom-sheet__handle"><div class="m3e-bottom-sheet__handle-bar"></div></div>
//       <div class="m3e-bottom-sheet__content">…</div>
//     </div>
//   </dialog>
//
// 数值来自 docs/DESIGN-SPEC-UI.md §4:把手 32×4、初始高 min(内容,60vh) 且内容多时下限 344、
// 打开 475ms / 关闭 149ms、scrim 32%、位移 > 56 或速度 > 125 视为关闭手势。

const OPEN_MS = 475;
const CLOSE_MS = 149;
const MIN_H = 344;
const CLOSE_POS = 56;
const CLOSE_VELOCITY = 125;

let sheetEl = null;
let sheetHost = null;
// 拖拽监听只绑一次(元素是复用的),当前这一次打开的关闭动作放这里
const now = { close: null };

function ensureSheet() {
  if (sheetEl) return sheetEl;
  const d = document.createElement("dialog");
  d.className = "m3e-bottom-sheet m3e-bottom-sheet--modal";
  d.id = "appSheet";
  d.innerHTML =
    '<div class="m3e-bottom-sheet__scrim"></div>' +
    '<div class="m3e-bottom-sheet__sheet">' +
      '<div class="m3e-bottom-sheet__handle" role="separator" aria-label="拖动关闭">' +
        '<div class="m3e-bottom-sheet__handle-bar"></div>' +
      "</div>" +
      '<div class="m3e-bottom-sheet__content"></div>' +
    "</div>";
  document.body.appendChild(d);
  sheetEl = d;
  sheetHost = d.querySelector(".m3e-bottom-sheet__content");
  bindDrag(d, d.querySelector(".m3e-bottom-sheet__sheet"), sheetHost);
  return d;
}

function contentHeight(host) {
  // 内容可能带 max-height 的滚动区,这里量"自然高度"
  return Math.max(host.scrollHeight, host.getBoundingClientRect().height, 0);
}

/**
 * 打开一个 bottom sheet。
 * opts: { content: HTMLElement, onClose?, label? }
 * 返回 { close(), host, el }
 */
export function openSheet(opts) {
  const d = ensureSheet();
  const sheet = d.querySelector(".m3e-bottom-sheet__sheet");
  const host = sheetHost;
  const scrim = d.querySelector(".m3e-bottom-sheet__scrim");

  host.innerHTML = "";
  if (opts.content) host.appendChild(opts.content);
  if (opts.label) d.setAttribute("aria-label", opts.label);
  d.removeAttribute("data-dragging");
  host.style.overflowY = "";

  if (typeof d.showModal === "function") {
    if (!d.open) d.showModal();
  } else {
    d.setAttribute("open", "");
  }

  // 初始高度:内容不足时就是内容高 + 16,内容多时 min(内容, 60vh)
  const vh = window.innerHeight || 800;
  const want = contentHeight(host) + 16;
  const height = want <= MIN_H ? want : Math.min(want, Math.round(vh * 0.6));
  sheet.style.height = height + "px";
  sheet.style.maxHeight = "90vh";
  host.style.overflowY = "auto";

  // 开:从屏幕外推上来(475ms)
  sheet.style.transition = "none";
  sheet.style.translate = "0 100%";
  scrim.style.opacity = "0";
  scrim.style.transition = "opacity 250ms cubic-bezier(.2,0,0,1)";
  requestAnimationFrame(() => {
    sheet.style.transition =
      "translate " + OPEN_MS + "ms cubic-bezier(.38,1.21,.22,1)";
    sheet.style.translate = "0 0";
    scrim.style.opacity = "";
  });

  let closed = false;
  function close() {
    if (closed || now.close !== close) return;
    closed = true;
    now.close = null;
    sheet.style.transition = "translate " + CLOSE_MS + "ms cubic-bezier(.31,.94,.34,1)";
    sheet.style.translate = "0 100%";
    scrim.style.opacity = "0";
    setTimeout(() => {
      if (d.open && typeof d.close === "function") d.close();
      else d.removeAttribute("open");
      sheet.style.translate = "";
      sheet.style.transition = "";
      scrim.style.opacity = "";
      host.innerHTML = "";
      d.removeAttribute("data-dragging");
      host.style.overflowY = "";
      if (opts.onClose) opts.onClose();
    }, CLOSE_MS);
  }

  // 点遮罩 / Esc 关闭
  scrim.onclick = close;
  d.oncancel = (e) => {
    e.preventDefault();
    close();
  };

  now.close = close;
  return { close, host, el: d };
}

export function isSheetOpen() {
  return !!(sheetEl && sheetEl.open);
}

function bindDrag(d, sheet, host) {
  const handle = d.querySelector(".m3e-bottom-sheet__handle");
  let startY = 0;
  let dy = 0;
  let dragging = false;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;

  const enabledAt = (target, y) => {
    if (handle.contains(target)) return true;
    // 内容顶部 8dp 内也算把手区
    const box = host.getBoundingClientRect();
    return y - box.top <= 8;
  };

  const onDown = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!enabledAt(e.target, e.clientY)) return;
    dragging = true;
    dy = 0;
    startY = lastY = e.clientY;
    lastT = performance.now();
    velocity = 0;
    d.setAttribute("data-dragging", "");
    sheet.style.transition = "none";
    handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
  };

  const onMove = (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    const now = performance.now();
    if (now - lastT > 0) velocity = (e.clientY - lastY) / (now - lastT);
    lastY = e.clientY;
    lastT = now;
    // rubber-band:超过 125px 后阻尼
    const damped = dy <= 125 ? dy : 125 + (dy - 125) * 0.35;
    sheet.style.translate = "0 " + damped + "px";
    e.preventDefault();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    d.removeAttribute("data-dragging");
    sheet.style.transition = "translate 250ms cubic-bezier(.31,.94,.34,1)";
    if (dy > CLOSE_POS || velocity > CLOSE_VELOCITY) {
      if (now.close) now.close();
      return;
    }
    sheet.style.translate = "0 0";
  };

  handle.addEventListener("pointerdown", onDown);
  host.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
