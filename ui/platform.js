// 平台判断集中在这一个文件里。
//
// 移动端适配只在这里做分支,别的模块一律读 platform.xxx:
// 这样"桌面必须和以前一模一样"这件事只需要在一个地方保证,
// 而且任何一处判断写错都不会悄悄影响别处。
//
// 判断依据只有 UA 和触摸点数,不依赖 Tauri 的 API(拿不到也不会抛错)。

const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";

/**
 * iPadOS 13 起 UA 和 macOS 一模一样("Macintosh; Intel Mac OS X"),
 * 只能靠"有触摸屏的 Mac"这一点区分。
 */
const isIOS =
  /iPad|iPhone|iPod/.test(ua) ||
  ((navigator && navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1));

const isAndroid = /Android/i.test(ua);

/** 有 MSE 才谈得上 hls.js;iOS 的 WKWebView 没有(ManagedMediaSource 也不稳) */
const hasMse =
  typeof window !== "undefined" &&
  (typeof window.MediaSource !== "undefined" || typeof window.ManagedMediaSource !== "undefined");

export const platform = {
  isIOS,
  isAndroid,
  /** iOS + Android:iOS 走 AVPlayer 原生 HLS,Android 仍然走 hls.js */
  isMobile: isIOS || isAndroid,
  hasMse,
  /**
   * 是否把 HLS 直接交给 <video>(AVPlayer)播,跳过 hls.js。
   * 只有 iOS 为 true —— 桌面/Android 的判断保持原样。
   */
  nativeHlsOnly: isIOS,
  /**
   * 切后台时是否暂停播放并落盘进度。
   * 只在移动端开启:桌面最小化窗口也会触发 visibilitychange,
   * 那属于"桌面行为",不允许变。
   */
  pauseOnHidden: isIOS || isAndroid,
};
