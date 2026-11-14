// 主题:M3 动态取色(种子色 + 明暗 + 配色风格 + 纯黑)。
// 用的是官方 Material Color Utilities,和 Android 上那套算法一致。
import { argbFromHex, hexFromArgb } from "./vendor/mcu/utils/string_utils.js";
import { Hct } from "./vendor/mcu/hct/hct.js";
import { SchemeTonalSpot } from "./vendor/mcu/scheme/scheme_tonal_spot.js";
import { SchemeVibrant } from "./vendor/mcu/scheme/scheme_vibrant.js";
import { SchemeExpressive } from "./vendor/mcu/scheme/scheme_expressive.js";
import { SchemeNeutral } from "./vendor/mcu/scheme/scheme_neutral.js";
import { SchemeMonochrome } from "./vendor/mcu/scheme/scheme_monochrome.js";
import { MaterialDynamicColors } from "./vendor/mcu/dynamiccolor/material_dynamic_colors.js";

const kebab = (s) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

const SCHEMES = {
  tonal: SchemeTonalSpot,
  vibrant: SchemeVibrant,
  expressive: SchemeExpressive,
  neutral: SchemeNeutral,
  mono: SchemeMonochrome,
};

// MCU 的角色名 → 我们 CSS 里的变量名
const ROLES = {
  primary: "primary",
  onPrimary: "on-primary",
  secondaryContainer: "secondary-container",
  onSecondaryContainer: "on-secondary-container",
  surface: "surface",
  onSurface: "on-surface",
  onSurfaceVariant: "on-surface-variant",
  surfaceContainerLow: "surface-container-low",
  surfaceContainer: "surface-container",
  surfaceContainerHigh: "surface-container-high",
  surfaceContainerHighest: "surface-container-highest",
  outlineVariant: "outline-variant",
  background: "background",
  onBackground: "on-background",
  error: "error",
};

export const SEEDS = [
  { id: "#6750a4", label: "紫" },
  { id: "#1a5fd0", label: "蓝" },
  { id: "#2e6b3e", label: "绿" },
  { id: "#a4420a", label: "橙" },
  { id: "#a83b62", label: "玫红" },
  { id: "#8a6c00", label: "黄" },
  { id: "#006874", label: "青" },
  { id: "#5c5c5c", label: "灰" },
];

const KEY = "reelbox.theme2";
const DEFAULTS = { mode: "dark", seed: "#6750a4", variant: "tonal", pureBlack: false };

export const state = { ...DEFAULTS };

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch (_) {}
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
}

function prefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function isDark() {
  return state.mode === "auto" ? prefersDark() : state.mode === "dark";
}

export function apply() {
  const dark = isDark();
  const root = document.documentElement;
  const Scheme = SCHEMES[state.variant] || SchemeTonalSpot;
  const scheme = new Scheme(Hct.fromInt(argbFromHex(state.seed)), dark, 0);
  // 0.4 版没有 toJSON,逐个角色取色
  for (const [name, dc] of Object.entries(MaterialDynamicColors)) {
    if (!dc || typeof dc.getArgb !== "function") continue;
    root.style.setProperty("--m3e-sys-color-" + kebab(name), hexFromArgb(dc.getArgb(scheme)));
  }
  if (dark && state.pureBlack) {
    root.style.setProperty("--m3e-sys-color-surface", "#000000");
    root.style.setProperty("--m3e-sys-color-background", "#000000");
    root.style.setProperty("--m3e-sys-color-surface-container-low", "#0a0a0a");
    root.style.setProperty("--m3e-sys-color-surface-container", "#111111");
    root.style.setProperty("--m3e-sys-color-surface-container-high", "#191919");
    root.style.setProperty("--m3e-sys-color-surface-container-highest", "#222222");
  }
  root.setAttribute("data-theme", dark ? "dark" : "light");
  syncUI();
}

function syncUI() {
  const segs = { segMode: "mode", segBlack: String(state.pureBlack ? 1 : 0), segVariant: "variant" };
  const pick = (sel, attr, val) =>
    document.querySelectorAll(sel + " button").forEach((b) =>
      b.setAttribute("aria-selected", b.getAttribute(attr) === val ? "true" : "false")
    );
  pick("#segMode", "data-mode", state.mode);
  pick("#segBlack", "data-black", state.pureBlack ? "1" : "0");
  pick("#segVariant", "data-v", state.variant);
  document.querySelectorAll("#swatches .swatch").forEach((b) =>
    b.setAttribute("aria-selected", b.getAttribute("data-seed") === state.seed ? "true" : "false")
  );
  const blackRow = document.getElementById("blackRow");
  if (blackRow) blackRow.style.opacity = isDark() ? "1" : ".45";
}

export function initTheme() {
  load();
  const box = document.getElementById("swatches");
  if (box) {
    box.innerHTML =
      SEEDS.map(
        (s) =>
          '<button class="swatch" data-seed="' + s.id + '" title="' + s.label +
          '" aria-selected="false" style="background:' + s.id + '"></button>'
      ).join("") +
      '<label class="swatch custom" title="自定义">' +
      '<input type="color" id="seedPick" value="' + state.seed + '">' +
      '<span class="m3e-icon">palette</span></label>';
    box.onclick = (e) => {
      const b = e.target.closest(".swatch");
      if (!b || b.classList.contains("custom")) return;
      state.seed = b.getAttribute("data-seed");
      save(); apply();
    };
    const pick = document.getElementById("seedPick");
    if (pick) {
      pick.oninput = () => {
        state.seed = pick.value;
        save(); apply();
      };
    }
  }
  const bind = (id, attr, fn) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      fn(b.getAttribute(attr));
      save(); apply();
    };
  };
  bind("segMode", "data-mode", (v) => (state.mode = v));
  bind("segBlack", "data-black", (v) => (state.pureBlack = v === "1"));
  bind("segVariant", "data-v", (v) => (state.variant = v));

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.mode === "auto") apply();
  });

  apply();
}
