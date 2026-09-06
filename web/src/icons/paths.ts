// 功能图标精灵（B 双色）：唯一的 path 数据源，本身不含任何颜色字面量。
// 本文件由 web/scripts/sync-icons.cjs 从 docs/mockups/图标体系-mockup-v3-定稿.html 生成，请勿手改；
// 要改图标先改设计稿再重跑那个脚本，否则稿子与实现会分叉。

export interface IconDef {
  /** 描边部分：stroke 继承 currentColor，画在 tint 之上。 */
  readonly line: string
  /** 浅填部分：fill 继承 currentColor + 18% 不透明度，画在 line 之下；空串 = 纯线条图标。 */
  readonly tint: string
  /** 这个图标在界面里代表什么；供改稿时对照，不参与渲染。 */
  readonly use: string
}

export const ICON_PATHS = {
  home: { line: "<path d=\"M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z\"/>", tint: "<path class=\"tint\" d=\"M4 10.5 12 4l8 6.5V20H4z\"/>", use: "总览" },
  kanban: { line: "<rect x=\"3\" y=\"4\" width=\"5.5\" height=\"16\" rx=\"1.2\"/><rect x=\"9.25\" y=\"4\" width=\"5.5\" height=\"11\" rx=\"1.2\"/><rect x=\"15.5\" y=\"4\" width=\"5.5\" height=\"7\" rx=\"1.2\"/>", tint: "<rect class=\"tint\" x=\"3\" y=\"4\" width=\"5.5\" height=\"16\" rx=\"1.2\"/>", use: "看板" },
  bell: { line: "<path d=\"M6.5 9a5.5 5.5 0 0 1 11 0c0 6 2.5 7.5 2.5 7.5H4S6.5 15 6.5 9\"/><path d=\"M10.3 20.5a1.9 1.9 0 0 0 3.4 0\"/>", tint: "<path class=\"tint\" d=\"M6.5 9a5.5 5.5 0 0 1 11 0c0 6 2.5 7.5 2.5 7.5H4S6.5 15 6.5 9z\"/>", use: "顶栏铃铛 / 待拍板页头" },
  toland: { line: "<path d=\"M7 17 17 7\"/><path d=\"M8 7h9v9\"/>", tint: "<path class=\"tint\" d=\"M8 7h9v9z\"/>", use: "待落地" },
  history: { line: "<path d=\"M3 12a9 9 0 1 0 3.1-6.8\"/><path d=\"M3 3v6h6\"/><path d=\"M12 7v5l3.5 2\"/>", tint: "<circle class=\"tint\" cx=\"12\" cy=\"12\" r=\"9\" style=\"opacity:.12\"/>", use: "拍板历史" },
  calendar: { line: "<rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M8 3v4M16 3v4M3 10h18\"/>", tint: "<rect class=\"tint\" x=\"3\" y=\"10\" width=\"18\" height=\"11\" rx=\"1.5\"/>", use: "每日成果" },
  chart: { line: "<path d=\"M5 20v-7M11 20V5M17 20v-10\"/><path d=\"M3 20h18\"/>", tint: "<path class=\"tint\" d=\"M3.8 13h2.4v7H3.8zM9.8 5h2.4v15H9.8zM15.8 10h2.4v10h-2.4z\"/>", use: "洞察" },
  activity: { line: "<path d=\"M3 12h4l3-8 4 16 3-8h4\"/>", tint: "", use: "活动流" },
  alert: { line: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 8v4.5M12 16.5h.01\"/>", tint: "<circle class=\"tint\" cx=\"12\" cy=\"12\" r=\"9\"/>", use: "风险" },
  layers: { line: "<path d=\"m12 3 9 4.8-9 4.8-9-4.8z\"/><path d=\"m3 12.4 9 4.8 9-4.8\"/><path d=\"m3 17 9 4.8 9-4.8\"/>", tint: "<path class=\"tint\" d=\"m12 3 9 4.8-9 4.8-9-4.8z\"/>", use: "波次 / W 标签" },
  checks: { line: "<path d=\"m3 7 2 2 4-4\"/><path d=\"m3 17 2 2 4-4\"/><path d=\"M13 6h8M13 12h8M13 18h8\"/>", tint: "<rect class=\"tint\" x=\"12\" y=\"4\" width=\"10\" height=\"16\" rx=\"1.5\" style=\"opacity:.12\"/>", use: "验收 / 并行清单" },
  merge: { line: "<circle cx=\"18\" cy=\"18\" r=\"3\"/><circle cx=\"6\" cy=\"6\" r=\"3\"/><path d=\"M6 21V9a9 9 0 0 0 9 9\"/>", tint: "<circle class=\"tint\" cx=\"18\" cy=\"18\" r=\"3\"/><circle class=\"tint\" cx=\"6\" cy=\"6\" r=\"3\"/>", use: "占用防撞" },
  gantt: { line: "<path d=\"M4 6h8M8 12h9M12 18h8\"/>", tint: "<path class=\"tint\" d=\"M4 4.5h8a1.5 1.5 0 0 1 0 3H4zM8 10.5h9a1.5 1.5 0 0 1 0 3H8zM12 16.5h8a1.5 1.5 0 0 1 0 3h-8z\"/>", use: "甘特" },
  network: { line: "<circle cx=\"18\" cy=\"5\" r=\"2.6\"/><circle cx=\"6\" cy=\"12\" r=\"2.6\"/><circle cx=\"18\" cy=\"19\" r=\"2.6\"/><path d=\"m8.4 13.3 7.2 4.2M15.6 6.5 8.4 10.7\"/>", tint: "<circle class=\"tint\" cx=\"18\" cy=\"5\" r=\"2.6\"/><circle class=\"tint\" cx=\"6\" cy=\"12\" r=\"2.6\"/><circle class=\"tint\" cx=\"18\" cy=\"19\" r=\"2.6\"/>", use: "依赖" },
  search: { line: "<circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"m20 20-4.3-4.3\"/>", tint: "<circle class=\"tint\" cx=\"11\" cy=\"11\" r=\"6.5\"/>", use: "搜索" },
  cpu: { line: "<rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\"/><rect x=\"10\" y=\"10\" width=\"4\" height=\"4\"/><path d=\"M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4\"/>", tint: "<rect class=\"tint\" x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\"/>", use: "算力" },
  coins: { line: "<circle cx=\"8.5\" cy=\"8.5\" r=\"5.5\"/><path d=\"M17.9 10.6a5.5 5.5 0 1 1-7.3 7.3\"/><path d=\"M7.5 6.5h1.2v4\"/><path d=\"m16.3 14 .7.7-2.6 2.6\"/>", tint: "<circle class=\"tint\" cx=\"8.5\" cy=\"8.5\" r=\"5.5\"/>", use: "成本" },
  bot: { line: "<path d=\"M12 8V4H8\"/><rect x=\"4\" y=\"8\" width=\"16\" height=\"12\" rx=\"2\"/><path d=\"M2 14h2M20 14h2M15 13v2M9 13v2\"/>", tint: "<rect class=\"tint\" x=\"4\" y=\"8\" width=\"16\" height=\"12\" rx=\"2\"/>", use: "Codex / 建议档位" },
  book: { line: "<path d=\"M2.5 4.5H9a2 2 0 0 1 2 2v13.5a2 2 0 0 0-2-2H2.5z\"/><path d=\"M21.5 4.5H15a2 2 0 0 0-2 2v13.5a2 2 0 0 1 2-2h6.5z\"/>", tint: "<path class=\"tint\" d=\"M2.5 4.5H9a2 2 0 0 1 2 2v13.5a2 2 0 0 0-2-2H2.5z\"/>", use: "审阅台" },
  branch: { line: "<path d=\"M6 3v12\"/><circle cx=\"18\" cy=\"6\" r=\"3\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><path d=\"M18 9a9 9 0 0 1-9 9\"/>", tint: "<circle class=\"tint\" cx=\"18\" cy=\"6\" r=\"3\"/><circle class=\"tint\" cx=\"6\" cy=\"18\" r=\"3\"/>", use: "分支" },
  pr: { line: "<circle cx=\"18\" cy=\"18\" r=\"3\"/><circle cx=\"6\" cy=\"6\" r=\"3\"/><path d=\"M13 6h3a2 2 0 0 1 2 2v7\"/><path d=\"M6 9v12\"/>", tint: "<circle class=\"tint\" cx=\"18\" cy=\"18\" r=\"3\"/><circle class=\"tint\" cx=\"6\" cy=\"6\" r=\"3\"/>", use: "PR" },
  commit: { line: "<circle cx=\"12\" cy=\"12\" r=\"3.5\"/><path d=\"M3 12h5.5M15.5 12H21\"/>", tint: "<circle class=\"tint\" cx=\"12\" cy=\"12\" r=\"3.5\"/>", use: "提交" },
  tree: { line: "<path d=\"M12 22v-4\"/><path d=\"m7 18 5-7 5 7z\"/><path d=\"m8.5 12.5 3.5-5 3.5 5\"/><path d=\"m10 8 2-3.5 2 3.5\"/>", tint: "<path class=\"tint\" d=\"m7 18 5-7 5 7z\"/>", use: "worktree" },
  folder: { line: "<path d=\"M3 7.5A1.5 1.5 0 0 1 4.5 6h4.3l2 2h8.7A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z\"/>", tint: "<path class=\"tint\" d=\"M3 9.5h18v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z\"/>", use: "文件域" },
  ban: { line: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"m5.6 5.6 12.8 12.8\"/>", tint: "<circle class=\"tint\" cx=\"12\" cy=\"12\" r=\"9\"/>", use: "禁区" },
  alertTri: { line: "<path d=\"M12 3.5 2.9 19a1.2 1.2 0 0 0 1 1.8h16.2a1.2 1.2 0 0 0 1-1.8z\"/><path d=\"M12 9.5v4.5M12 17.5h.01\"/>", tint: "<path class=\"tint\" d=\"M12 3.5 2.9 19a1.2 1.2 0 0 0 1 1.8h16.2a1.2 1.2 0 0 0 1-1.8z\"/>", use: "阻塞理由" },
  parkingNote: { line: "<rect x=\"3.5\" y=\"3.5\" width=\"17\" height=\"17\" rx=\"2\"/><path d=\"M9.5 17V7h3.8a3 3 0 0 1 0 6H9.5\"/>", tint: "<rect class=\"tint\" x=\"3.5\" y=\"3.5\" width=\"17\" height=\"17\" rx=\"2\"/>", use: "暂缓遗留" },
  rotateCcw: { line: "<path d=\"M3 12a9 9 0 1 0 2.6-6.4\"/><path d=\"M3 3v6h6\"/>", tint: "<circle class=\"tint\" cx=\"12\" cy=\"12\" r=\"9\" style=\"opacity:.1\"/>", use: "复工依据" },
  file: { line: "<path d=\"M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z\"/><path d=\"M14 3v5h5\"/><path d=\"M8.5 13h7M8.5 17h5\"/>", tint: "<path class=\"tint\" d=\"M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z\"/>", use: "文档" },
  message: { line: "<path d=\"M20.5 14.5a2 2 0 0 1-2 2H8l-4.5 4V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z\"/>", tint: "<path class=\"tint\" d=\"M20.5 14.5a2 2 0 0 1-2 2H8l-4.5 4V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z\"/>", use: "留言(新)" },
  copy: { line: "<rect x=\"9\" y=\"9\" width=\"11\" height=\"11\" rx=\"2\"/><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"/>", tint: "<rect class=\"tint\" x=\"9\" y=\"9\" width=\"11\" height=\"11\" rx=\"2\"/>", use: "复制卡号" },
  archive: { line: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"4\" rx=\"1\"/><path d=\"M5 8v10.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V8\"/><path d=\"M10 12.5h4\"/>", tint: "<rect class=\"tint\" x=\"3\" y=\"4\" width=\"18\" height=\"4\" rx=\"1\"/>", use: "折叠已完工" },
  sparkles: { line: "<path d=\"m12 4 1.8 4.7 4.7 1.8-4.7 1.8L12 17l-1.8-4.7L5.5 10.5l4.7-1.8z\"/><path d=\"M4.5 3.5v3M3 5h3M19.5 16.5v3M18 18h3\"/>", tint: "<path class=\"tint\" d=\"m12 4 1.8 4.7 4.7 1.8-4.7 1.8L12 17l-1.8-4.7L5.5 10.5l4.7-1.8z\"/>", use: "空态·全清" },
  inbox: { line: "<g class=\"lid\"><path d=\"M5.6 5.2 2 12h20l-3.6-6.8A2 2 0 0 0 16.6 4H7.4a2 2 0 0 0-1.8 1.2z\"/></g><path d=\"M22 12h-6l-2 3h-4l-2-3H2\"/><path d=\"M2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6\"/>", tint: "<path class=\"tint\" d=\"M2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6h-6l-2 3h-4l-2-3z\"/>", use: "空态·暂无" },
  target: { line: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><circle cx=\"12\" cy=\"12\" r=\"5\"/><circle cx=\"12\" cy=\"12\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/>", tint: "<circle class=\"tint\" cx=\"12\" cy=\"12\" r=\"5\"/>", use: "空态·拍板历史" },
  flame: { line: "<path d=\"M12 21.5c4 0 6.5-2.6 6.5-6.3 0-2.7-1.6-4.9-3.1-6.3-.4 1.7-1.3 2.7-2.5 3.2.1-2.9-1.4-5.7-4.2-7.6.5 2.7-.8 4.6-2.2 6.4C5.4 12.4 5.5 14 5.5 15.2c0 3.7 2.5 6.3 6.5 6.3z\"/>", tint: "<path class=\"tint\" d=\"M12 21.5c4 0 6.5-2.6 6.5-6.3 0-2.7-1.6-4.9-3.1-6.3-.4 1.7-1.3 2.7-2.5 3.2.1-2.9-1.4-5.7-4.2-7.6.5 2.7-.8 4.6-2.2 6.4C5.4 12.4 5.5 14 5.5 15.2c0 3.7 2.5 6.3 6.5 6.3z\"/>", use: "连击" },
  hand: { line: "<path d=\"M18 11V6a2 2 0 0 0-4 0v5\"/><path d=\"M14 10V4a2 2 0 0 0-4 0v6\"/><path d=\"M10 10.5V6a2 2 0 0 0-4 0v8\"/><path d=\"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3 16.5a2 2 0 0 1 3-2.6L8 16\"/>", tint: "<path class=\"tint\" d=\"M6 14V6a2 2 0 0 1 4 0v4a2 2 0 0 1 4 0V6a2 2 0 0 1 4 0v2a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3 16.5a2 2 0 0 1 3-2.6z\"/>", use: "认领" },
  pencil: { line: "<path d=\"M17 3.5 20.5 7 8 19.5H4.5V16z\"/><path d=\"m14.5 6 3.5 3.5\"/>", tint: "<path class=\"tint\" d=\"M17 3.5 20.5 7 8 19.5H4.5V16z\"/>", use: "备注" },
  trending: { line: "<path d=\"m3 17 6-6 4 4 8-8\"/><path d=\"M15 7h6v6\"/>", tint: "<path class=\"tint\" d=\"M3 17l6-6 4 4 8-8v10H3z\" style=\"opacity:.1\"/>", use: "进度更新" },
  zap: { line: "<path d=\"M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z\"/>", tint: "<path class=\"tint\" d=\"M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z\"/>", use: "运行中 / 心跳" },
  download: { line: "<path d=\"M12 3v12\"/><path d=\"m7 10 5 5 5-5\"/><path d=\"M4 21h16\"/>", tint: "", use: "导出" },
  box: { line: "<path d=\"m12 2.5 8.5 4.5v10L12 21.5 3.5 17V7z\"/><path d=\"m3.5 7 8.5 4.5L20.5 7\"/><path d=\"M12 11.5v10\"/>", tint: "<path class=\"tint\" d=\"m12 2.5 8.5 4.5-8.5 4.5L3.5 7z\"/>", use: "整项目派单" },
  check: { line: "<path d=\"m5 12.5 4.5 4.5L19 7\"/>", tint: "", use: "已显示全部 / 拍板动作" },
  x: { line: "<path d=\"m6 6 12 12M18 6 6 18\"/>", tint: "", use: "关闭 / 作废动作" },
  settings: { line: "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8\"/>", tint: "<circle class=\"tint\" cx=\"12\" cy=\"12\" r=\"6\"/>", use: "设置 / 外观" },
  refresh: { line: "<path d=\"M21 12a9 9 0 1 1-2.6-6.4\"/><path d=\"M21 3v6h-6\"/>", tint: "<circle class=\"tint\" cx=\"12\" cy=\"12\" r=\"9\" style=\"opacity:.1\"/>", use: "刷新" },
  plug: { line: "<path d=\"M12 22v-5\"/><path d=\"M9 8V2M15 8V2\"/><path d=\"M18 8v5a6 6 0 0 1-12 0V8z\"/>", tint: "<path class=\"tint\" d=\"M18 8v5a6 6 0 0 1-12 0V8z\"/>", use: "连接状态" },
  sun: { line: "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4\"/>", tint: "<circle class=\"tint\" cx=\"12\" cy=\"12\" r=\"4\"/>", use: "浅色主题" },
  moon: { line: "<path d=\"M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z\"/>", tint: "<path class=\"tint\" d=\"M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z\"/>", use: "深色主题" },
  chevron: { line: "<path d=\"m7 10 5 5 5-5\"/>", tint: "", use: "折叠 / 展开（施工期补充，靠 CSS 旋转出上下左右四向）" },
  grip: { line: "<path d=\"M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01\" stroke-width=\"2.6\"/>", tint: "", use: "拖着换位的手柄（施工期补充）" },
  plus: { line: "<path d=\"M12 6v12M6 12h12\"/>", tint: "", use: "新增（施工期补充，与 x 配对）" },
} as const satisfies Record<string, IconDef>

export type IconName = keyof typeof ICON_PATHS

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[]
