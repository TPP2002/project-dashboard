#!/usr/bin/env node
// 从设计稿正本重新生成图标数据，保证「稿子怎么画的，代码就怎么画」。
//
// 正本 = docs/mockups/图标体系-mockup-v3-定稿.html。稿子里的 ST（状态记号）与 IC（功能图标）
// 两张表是手写的 JS 字面量，本脚本原样取出来转成 TS，不做任何"顺手美化"——
// 一旦有人凭记忆手改 web/src/icons/*.ts，稿子与实现就会分叉，谁也说不清哪份是对的。
//
// 用法：node web/scripts/sync-icons.cjs
// 改图标的正确顺序：先改设计稿 → 跑本脚本 → 跑 npm --prefix web run typecheck。
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const MOCKUP = path.join(REPO, 'docs', 'mockups', '图标体系-mockup-v3-定稿.html')
const OUT_DIR = path.join(REPO, 'web', 'src', 'icons')

// 施工期补充：v3 定稿第 04 节没覆盖「可折叠分组」「拖着换位」「新增一项」这三种交互，
// 界面里却在用（侧栏分组、外观面板分组、审阅台书架、菜单设置的拖拽条、取色器加色）。
// 按同一套线性语言补三枚，用途里标明出处，等负责人拍板是收编进正本还是另换画法。
const EXTRA = {
  chevron: ['<path d="m7 10 5 5 5-5"/>', '', '折叠 / 展开（施工期补充，靠 CSS 旋转出上下左右四向）'],
  grip: ['<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="2.6"/>', '', '拖着换位的手柄（施工期补充）'],
  plus: ['<path d="M12 6v12M6 12h12"/>', '', '新增（施工期补充，与 x 配对）'],
}

const SPEED = { '': 'normal', 'sp-fast': 'fast', 'sp-slow': 'slow', 'sp-ember': 'ember' }
const q = value => JSON.stringify(String(value))

const src = fs.readFileSync(MOCKUP, 'utf8')

/** 从稿子里切出一段字面量。找不到就直接报错——宁可停下，也不要生成半份数据。 */
function grab(startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  if (start < 0) throw new Error(`设计稿里找不到「${startMarker}」，稿子结构变了，先对一下再跑`)
  const end = src.indexOf(endMarker, start)
  if (end < 0) throw new Error(`「${startMarker}」这段没有收尾，稿子可能被截断了`)
  return src.slice(start + startMarker.length, end)
}

const ST = eval('([' + grab('const ST = [', '\n];') + '])')
const IC = Object.assign({}, eval('({' + grab('const IC = {', '\n};') + '})'), EXTRA)

const iconsFile = `// 功能图标精灵（B 双色）：唯一的 path 数据源，本身不含任何颜色字面量。
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
${Object.entries(IC).map(([key, def]) => `  ${key}: { line: ${q(def[0])}, tint: ${q(def[1] || '')}, use: ${q(def[2])} },`).join('\n')}
} as const satisfies Record<string, IconDef>

export type IconName = keyof typeof ICON_PATHS

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[]
`

const glyphsFile = `// 状态记号（D 灯条语言）：11 个状态各自的瓦片语义与自创记号。
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
${ST.map(row => {
  const [key, , , spec, speed, reverse, mark, note, calm] = row
  return [
    `  ${key}: {`,
    `    key: ${q(key)}, spec: ${!!spec}, speed: ${q(SPEED[speed])}, reverse: ${reverse === 'sp-rev'},`,
    `    fill: ${key === 'done'}, dim: ${key === 'void'}, calm: ${calm === '循环'},`,
    `    mark: ${q(mark)},`,
    `    note: ${q(note)},`,
    '  },',
  ].join('\n')
}).join('\n')}
} as const satisfies Record<string, StatusGlyph>

export type StatusGlyphKey = keyof typeof STATUS_GLYPHS
`

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'paths.ts'), iconsFile)
fs.writeFileSync(path.join(OUT_DIR, 'statusGlyphs.ts'), glyphsFile)
console.log(`已同步：${Object.keys(IC).length} 枚功能图标（含 ${Object.keys(EXTRA).length} 枚施工期补充） / ${ST.length} 枚状态记号`)
