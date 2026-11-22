// 直播源示例:分类/列表 + play 直接给流。
//
// 直播和点播的区别只在播放器那边(没有进度、断了重连),契约完全是同一套:
//   list  → 频道
//   play  → 一条流(多档清晰度就返回数组)
// detail 不会被调用 —— 直播没有详情页。

reelbox.define({
  id: "livedemo",
  name: "直播演示",
  kind: "reelbox",
  version: "1",

  list: async function () {
    return {
      items: [
        { id: "unified", title: "Unified Streaming", poster: "" },
        { id: "mux", title: "Mux 测试片", poster: "" },
      ],
      next: "",
    };
  },

  play: async function (ctx, arg) {
    const map = {
      unified: "https://demo.unified-streaming.com/k8s/live/stable/scte35.isml/.m3u8",
      mux: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    };
    const url = map[arg.id] || "";
    if (!url) throw new Error("unsupported: 没有这个频道");
    return { url: url, mime: "application/x-mpegURL" };
  },
});
