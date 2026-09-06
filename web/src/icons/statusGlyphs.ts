// 状态记号（D 灯条语言）：11 个状态各自的瓦片语义与自创记号。
// 本文件由 web/scripts/sync-icons.cjs 从 docs/mockups/图标体系-mockup-v3-定稿.html 生成，请勿手改。
// 每个记号都是 24×24 视框内的 SVG 片段；记号里的动效 class（a-*）由 StatusTile.vue 的样式定义。

/** 灯条速度：急 2.4s / 常 3.4s / 慢 5s / 余烬 6.4s。 */
export type SpecSpeed = 'fast' | 'normal' | 'slow' | 'ember'

export interface StatusGlyph {
  /** 英文键，只作样式钩子与调试用，不面向用户。 */
  readonly key: string
  /** 边框是否走流光谱；false = 静态细线边框。 */
  readonly spec: boolean
  readonly speed: SpecSpeed
  /** 灯条是否反向流（可复工专用：像把进度倒着推回来）。 */
  readonly reverse: boolean
  /** 底色是否整块填满（已完工专用：结论不需要流动）。 */
  readonly fill: boolean
  /** 是否半透明（已作废专用）。 */
  readonly dim: boolean
  /** 记号 SVG 片段。 */
  readonly mark: string
  /** 这枚瓦片在讲什么；供改稿对照，不参与渲染。 */
  readonly note: string
  /** 「微」档下是否仍然循环（三档动效里 calm 只留待拍板 / 施工中 / 暂缓）。 */
  readonly calm: boolean
}

export const STATUS_GLYPHS = {
  none: {
    key: "none", spec: false, speed: "normal", reverse: false,
    fill: false, dim: false, calm: false,
    mark: "<circle class=\"a-ring\" cx=\"12\" cy=\"12\" r=\"4.6\" stroke-dasharray=\"2.3 2.3\"/>",
    note: "虚线环极慢转(12s):闲置,没人碰",
  },
  queued: {
    key: "queued", spec: false, speed: "normal", reverse: false,
    fill: false, dim: false, calm: false,
    mark: "<circle class=\"a-dot1\" cx=\"6.5\" cy=\"12\" r=\"1.7\" fill=\"currentColor\" stroke=\"none\"/><circle class=\"a-dot2\" cx=\"12\" cy=\"12\" r=\"1.7\" fill=\"currentColor\" stroke=\"none\"/><circle class=\"a-dot3\" cx=\"17.5\" cy=\"12\" r=\"1.7\" fill=\"currentColor\" stroke=\"none\"/>",
    note: "三点起伏:排着队",
  },
  ask: {
    key: "ask", spec: true, speed: "fast", reverse: false,
    fill: false, dim: false, calm: true,
    mark: "<g class=\"a-pulse\"><path d=\"M9.4 9.3a2.7 2.7 0 1 1 3.9 2.3c-1 .5-1.3 1.1-1.3 2.1\"/><path d=\"M12 17.4h.01\" stroke-width=\"2.8\"/></g>",
    note: "琥珀谱急流 2.4s + 问号呼吸:等你出手",
  },
  decided: {
    key: "decided", spec: true, speed: "slow", reverse: false,
    fill: false, dim: false, calm: false,
    mark: "<path class=\"a-draw\" d=\"m7 12.6 3.2 3.2 6.8-7.4\"/><path d=\"M7 18.5h10\" style=\"opacity:.45\"/>",
    note: "绿谱慢流 5s + 勾反复画一笔:定了,等人接",
  },
  building: {
    key: "building", spec: true, speed: "normal", reverse: false,
    fill: false, dim: false, calm: true,
    mark: "<path d=\"M5.5 19h13\" style=\"opacity:.45\"/><path class=\"a-b1\" d=\"M7.5 16.5v-3.5\"/><path class=\"a-b2\" d=\"M12 16.5v-7\"/><path class=\"a-b3\" d=\"M16.5 16.5v-10.5\"/>",
    note: "蓝谱常流 3.4s + 三根柱子在长:正在发生",
  },
  resume: {
    key: "resume", spec: true, speed: "normal", reverse: true,
    fill: false, dim: false, calm: false,
    mark: "<g class=\"a-spin\"><path d=\"M7 12.6a5 5 0 1 0 1.6-3.7\"/><path d=\"M6.4 6.2v3.4h3.4\"/></g>",
    note: "蓝谱反向流 + 回旋箭头转一圈:可以接着做了",
  },
  wrap: {
    key: "wrap", spec: true, speed: "slow", reverse: false,
    fill: false, dim: false, calm: false,
    mark: "<path d=\"M8 19V5.5\"/><g class=\"a-wave\"><path d=\"M8 6h8.6l-1.7 3 1.7 3H8\"/></g>",
    note: "绿谱慢流 + 旗子轻摆:收尾中",
  },
  done: {
    key: "done", spec: false, speed: "normal", reverse: false,
    fill: true, dim: false, calm: false,
    mark: "<path class=\"a-draw\" d=\"m7 12.4 3.3 3.3 6.7-7.4\"/>",
    note: "整块填满、无边框流光 + 勾反复画:成了(结论不需要流动)",
  },
  parked: {
    key: "parked", spec: true, speed: "ember", reverse: false,
    fill: false, dim: false, calm: true,
    mark: "<g class=\"a-breathe\"><path d=\"M9.4 8.3v7.4M14.6 8.3v7.4\"/></g>",
    note: "余烬谱 6.4s + 暂停条慢呼吸:压着的火",
  },
  finale: {
    key: "finale", spec: false, speed: "normal", reverse: false,
    fill: false, dim: false, calm: false,
    mark: "<g class=\"a-twinkle\"><path d=\"m12 5.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L12 15.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z\"/></g>",
    note: "无边框流光 + 星闪:留到最后,先别急",
  },
  void: {
    key: "void", spec: false, speed: "normal", reverse: false,
    fill: false, dim: true, calm: false,
    mark: "<path d=\"m8.5 8.5 7 7M15.5 8.5l-7 7\"/>",
    note: "半透明、全静:不再算数",
  },
} as const satisfies Record<string, StatusGlyph>

export type StatusGlyphKey = keyof typeof STATUS_GLYPHS
