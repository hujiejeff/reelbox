// 轻量对话框 + snackbar。
//
// 全部盖在 vendor/m3e.css 已有的 .m3e-dialog / .m3e-snackbar 结构上,不再用
// alert / prompt / confirm:那些原生弹窗在 WebView 里既不走主题,也没法在窄屏上用。
//
// 对外:
//   alertDialog(headline, body, okText)              → Promise<void>
//   confirmDialog(headline, body, okText, danger)    → Promise<boolean>
//   formDialog({headline, icon, fields, okText, note})→ Promise<{字段:值}|null>
//   toast(text, {actionLabel, onAction, dismissible, timeout}) → close()

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

function ensureDialog() {
  let d = document.getElementById("appDialog");
  if (d) return d;
  d = document.createElement("dialog");
  d.id = "appDialog";
  d.className = "m3e-dialog";
  document.body.appendChild(d);
  return d;
}

/**
 * 打开一个 m3e 对话框。
 * actions: [{label, value, primary, danger}] —— value 可以是函数(拿到 dialog 元素,
 * 返回 false 表示校验没过、别关)。返回值是所选 action 的 value,取消/Esc 得到 dismissValue。
 */
export function dialog(opts) {
  const d = ensureDialog();
  const acts = opts.actions || [];
  d.innerHTML =
    '<div class="m3e-dialog__scrim"></div>' +
    '<div class="m3e-dialog__container">' +
      (opts.icon ? '<span class="m3e-icon m3e-dialog__icon" aria-hidden="true">' + esc(opts.icon) + "</span>" : "") +
      (opts.headline ? '<h2 class="m3e-dialog__headline">' + esc(opts.headline) + "</h2>" : "") +
      '<div class="m3e-dialog__content">' + (opts.content || "") + "</div>" +
      '<div class="m3e-dialog__actions"></div>' +
    "</div>";

  const bar = d.querySelector(".m3e-dialog__actions");
  return new Promise((resolve) => {
    let done = false;
    let primaryBtn = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { d.close(); } catch (_) {}
      resolve(v);
    };

    acts.forEach((a) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "m3e-button m3e-button--text" + (a.danger ? " dlg-btn--danger" : "");
      b.textContent = a.label;
      if (a.primary) primaryBtn = b;
      b.onclick = () => {
        const v = typeof a.value === "function" ? a.value(d) : a.value;
        if (v === false) return; // 校验没过:留在对话框里
        finish(v === undefined ? null : v);
      };
      bar.appendChild(b);
    });

    d.oncancel = (e) => {
      e.preventDefault();
      finish(opts.dismissValue === undefined ? null : opts.dismissValue);
    };
    // 点遮罩不关:误触会丢掉刚填的内容
    if (opts.onOpen) opts.onOpen(d, finish);
    if (typeof d.showModal === "function") {
      if (!d.open) d.showModal();
    } else {
      d.setAttribute("open", "");
    }
    const first = d.querySelector(".m3e-dialog__content input, .m3e-dialog__content select") || primaryBtn;
    if (first) setTimeout(() => { try { first.focus(); } catch (_) {} }, 30);
  });
}

function markInvalid(d, label, msg) {
  const field = Array.from(d.querySelectorAll(".dlg-field")).find((f) =>
    (f.querySelector(".dlg-field__label") || {}).textContent === label
  );
  if (field) {
    field.classList.add("dlg-field--bad");
    setTimeout(() => field.classList.remove("dlg-field--bad"), 1200);
    const input = field.querySelector("input, select");
    if (input) { try { input.focus(); } catch (_) {} }
  }
  const tip = d.querySelector(".dlg-tip");
  if (tip) tip.textContent = msg || "这里不能为空";
}

export function alertDialog(headline, body, okText) {
  return dialog({
    icon: "info",
    headline,
    content: body ? '<p class="dlg-text">' + esc(body) + "</p>" : "",
    actions: [{ label: okText || "好", value: true, primary: true }],
  }).then(() => undefined);
}

export function confirmDialog(headline, body, okText, danger) {
  return dialog({
    icon: danger ? "warning" : "help",
    headline,
    content: body ? '<p class="dlg-text">' + esc(body) + "</p>" : "",
    actions: [
      { label: "取消", value: false },
      { label: okText || "确定", value: true, primary: true, danger: !!danger },
    ],
    dismissValue: false,
  }).then((v) => v === true);
}

/** 表单:fields = [{id, label, value, placeholder, hint, type: "text"|"select", options}] */
export function formDialog(opts) {
  const fields = opts.fields || [];
  const body =
    '<div class="dlg-fields">' +
      fields
        .map((f) => {
          const id = "dlg-" + f.id;
          const input =
            f.type === "select"
              ? '<select id="' + id + '" class="dlg-input">' +
                  (f.options || [])
                    .map(
                      (o) =>
                        '<option value="' + esc(o.value) + '"' +
                        (o.value === f.value ? " selected" : "") + ">" + esc(o.label) + "</option>"
                    )
                    .join("") +
                "</select>"
              : '<input id="' + id + '" class="dlg-input" type="text" value="' + esc(f.value || "") +
                '" placeholder="' + esc(f.placeholder || "") + '" autocomplete="off" spellcheck="false">';
          return (
            '<div class="dlg-field">' +
              '<label class="dlg-field__label" for="' + id + '">' + esc(f.label) + "</label>" +
              input +
              (f.hint ? '<span class="dlg-field__hint">' + esc(f.hint) + "</span>" : "") +
            "</div>"
          );
        })
        .join("") +
    "</div>" +
    (opts.note ? '<p class="dlg-text dlg-tip">' + esc(opts.note) + "</p>" : '<p class="dlg-text dlg-tip"></p>');

  return dialog({
    icon: opts.icon,
    headline: opts.headline,
    content: body,
    // 表单里的联动(按地址自动选类型那种)从 onOpen 拿 DOM 自己接
    onOpen: opts.onOpen,
    actions: [
      { label: "取消", value: null },
      {
        label: opts.okText || "保存",
        primary: true,
        value: (d) => {
          const out = {};
          for (const f of fields) {
            const node = d.querySelector("#dlg-" + f.id);
            const v = node ? String(node.value || "").trim() : "";
            if (f.type !== "select" && f.required !== false && !v) {
              markInvalid(d, f.label, "「" + f.label + "」不能为空");
              return false;
            }
            out[f.id] = v;
          }
          return out;
        },
      },
    ],
  });
}

/* ---------- snackbar ---------- */

let toastTimer = 0;

function snackHost() {
  let h = document.querySelector(".m3e-snackbar-host");
  if (!h) {
    h = document.createElement("div");
    h.className = "m3e-snackbar-host";
    document.body.appendChild(h);
  }
  return h;
}

/** 底部 snackbar;同一时刻只留一条 */
export function toast(text, opts) {
  const o = opts || {};
  const host = snackHost();
  clearTimeout(toastTimer);
  host.innerHTML = "";

  const item = document.createElement("div");
  item.className = "m3e-snackbar-host__item";
  item.style.cssText =
    "scale:1;opacity:0;transform:translateY(10px);" +
    "transition:opacity .2s var(--m3e-sys-motion-easing-standard),transform .2s var(--m3e-sys-motion-easing-standard)";
  const actions =
    o.actionLabel || o.dismissible
      ? '<div class="m3e-snackbar__actions">' +
          (o.actionLabel
            ? '<button type="button" class="m3e-button m3e-button--text m3e-snackbar__action">' + esc(o.actionLabel) + "</button>"
            : "") +
          (o.dismissible
            ? '<button type="button" class="m3e-icon-button m3e-snackbar__dismiss" aria-label="关闭">' +
                '<span class="m3e-icon" aria-hidden="true">close</span></button>'
            : "") +
        "</div>"
      : "";
  item.innerHTML =
    '<div class="m3e-snackbar" role="status">' +
      '<div class="m3e-snackbar__text">' + esc(text) + "</div>" +
      actions +
    "</div>";
  host.appendChild(item);
  requestAnimationFrame(() => {
    item.style.opacity = "1";
    item.style.transform = "translateY(0)";
  });

  const close = () => {
    clearTimeout(toastTimer);
    item.style.opacity = "0";
    item.style.transform = "translateY(10px)";
    setTimeout(() => { if (item.parentNode) item.remove(); }, 220);
  };

  const act = item.querySelector(".m3e-snackbar__action");
  if (act) {
    act.onclick = () => {
      close();
      if (o.onAction) o.onAction();
    };
  }
  const dis = item.querySelector(".m3e-snackbar__dismiss");
  if (dis) dis.onclick = close;

  toastTimer = setTimeout(close, o.timeout || (o.actionLabel ? 7000 : 3600));
  return close;
}
