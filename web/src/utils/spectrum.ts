// 灯条光谱（RGB 流光）配色：全站一套 + 五个部位各自可覆盖 + 状态瓦片的五档语义谱各自可覆盖。
//
// 分工约定：颜色字面量只存在于 styles/base.css 的「色站」变量里（--spec-cool / --spec-info / …），
// 本模块只负责「选哪套、怎么拼、存哪儿、写到哪个 CSS 变量上」。需要具体颜色值的地方
// （进度环的 SVG 描边、取色器的初值）一律从计算样式里回读色站，避免两处数值各写一套、改一处漏一处。
//
// 两组可覆盖的目标，机制相同、默认不同：
//   · 部位（PARTS）——进度条 / 进度环 / 卡片顶边 / 施工中竖条 / 额度条。除竖条外默认跟随全站流光。
//   · 状态谱（TILE_SPECS）——状态瓦片边框的五档语义色。默认各走自己的语义谱（状态语言优先于装饰）。
import { reactive, ref } from 'vue'

export type PresetId = 'cool' | 'warm' | 'full' | 'duo'
export type PartId = 'bar' | 'ring' | 'top' | 'edge' | 'quota'
/** 状态瓦片的五档语义谱，与 api/schema 的 StatusTone 一一对应。 */
export type TileSpecId = 'info' | 'warn' | 'ok' | 'bad' | 'n'

/** 一个部位（或全站）的配色：用某套预设、明确跟随全站、或自己挑一组颜色。 */
export type SpectrumChoice =
  | { kind: 'preset'; preset: PresetId }
  | { kind: 'custom'; colors: string[] }
  | { kind: 'global' }

export interface SpectrumConfig {
  version: 1
  global: SpectrumChoice
  /** 只登记「不用默认」的部位；缺省即该部位的默认（见 PARTS.defaultLabel）。 */
  parts: Partial<Record<PartId, SpectrumChoice>>
  /** 只登记「不按语义色」的状态谱；缺省即按语义色。 */
  tiles: Partial<Record<TileSpecId, SpectrumChoice>>
}

export const PRESETS: ReadonlyArray<{ id: PresetId; label: string }> = [
  { id: 'cool', label: '冷谱' },
  { id: 'warm', label: '暖谱' },
  { id: 'full', label: '全光谱' },
  { id: 'duo', label: '双色' },
]

/** defaultIsGlobal = 这个部位「不设置」时本来就跟随全站；false 的部位要额外给一个「跟随全站」选项。 */
export const PARTS: ReadonlyArray<{ id: PartId; label: string; hint: string; defaultLabel: string; defaultIsGlobal: boolean }> = [
  { id: 'bar', label: '任务进度条', hint: '任务卡、任务抽屉、看板顶部、CPU 预算里的进度条', defaultLabel: '跟随全站', defaultIsGlobal: true },
  { id: 'ring', label: '项目进度环', hint: '总览页每个项目卡上的完工圆环', defaultLabel: '跟随全站', defaultIsGlobal: true },
  { id: 'top', label: '卡片顶边流光', hint: '待拍板、被驳回、今日成果等卡片顶边那条细光', defaultLabel: '跟随全站', defaultIsGlobal: true },
  // 竖条讲的是「这张卡正在施工」，属于状态语言，所以默认跟状态瓦片一样走蓝谱，而不是跟随全站装饰色。
  { id: 'edge', label: '施工中竖条', hint: '施工中任务卡、运行中 Codex 行左侧那条竖光；默认与状态瓦片的蓝谱同色', defaultLabel: '按施工蓝谱', defaultIsGlobal: false },
  { id: 'quota', label: 'Codex 额度条', hint: 'Codex 战报与成本摘要里的额度进度条', defaultLabel: '跟随全站', defaultIsGlobal: true },
]

export const TILE_SPECS: ReadonlyArray<{ id: TileSpecId; label: string; hint: string }> = [
  { id: 'info', label: '蓝谱', hint: '施工中 / 待开工 / 可复工' },
  { id: 'warn', label: '琥珀谱', hint: '待拍板 / 压轴' },
  { id: 'ok', label: '绿谱', hint: '已拍板 / 收官（已完工整块填满、不流）' },
  { id: 'bad', label: '余烬谱', hint: '暂缓' },
  { id: 'n', label: '灰谱', hint: '未开工 / 已作废；平时不流，只在鼠标悬停时走一圈' },
]

/** 自定义配色允许的颜色个数：至少两色才看得出流动，太多则颜色被挤得看不清。 */
export const MIN_COLORS = 2
export const MAX_COLORS = 6

const CONFIG_KEY = 'board-spectrum-config'
const LEGACY_KEY = 'board-spectrum' // 旧版只存一个预设 id，升级时迁移成 global
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

/** 配色版本号：需要「具体颜色」的组件（进度环）靠它知道该回读色站了。 */
export const spectrumRevision = ref(0)

/** 当前配色，界面直接绑定这份。 */
export const spectrum = reactive<SpectrumConfig>({
  version: 1,
  global: { kind: 'preset', preset: 'cool' },
  parts: {},
  tiles: {},
})

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key) }
  catch (_) { return null }
}

function writeStorage(key: string, value: string) {
  try { localStorage.setItem(key, value) }
  catch (_) { /* 禁用站点存储时仍可在当前页面切换，只是刷新后回到默认。 */ }
}

function isPresetId(value: unknown): value is PresetId {
  return PRESETS.some(preset => preset.id === value)
}

function isPartId(value: unknown): value is PartId {
  return PARTS.some(part => part.id === value)
}

function isTileSpecId(value: unknown): value is TileSpecId {
  return TILE_SPECS.some(spec => spec.id === value)
}

/** 只收六位十六进制色（取色器的输出格式），其余一律丢弃，避免脏数据拼出非法渐变。 */
function normalizeColors(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const colors = value.filter((item): item is string => typeof item === 'string' && COLOR_RE.test(item))
  return colors.length >= MIN_COLORS ? colors.slice(0, MAX_COLORS) : null
}

function normalizeChoice(value: unknown): SpectrumChoice | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw.kind === 'preset' && isPresetId(raw.preset)) return { kind: 'preset', preset: raw.preset }
  if (raw.kind === 'global') return { kind: 'global' }
  if (raw.kind === 'custom') {
    const colors = normalizeColors(raw.colors)
    if (colors) return { kind: 'custom', colors }
  }
  return null
}

/** 存档里的一张「目标 → 配色」表，逐项校验后收下，脏键直接丢弃。 */
function normalizeMap<Id extends string>(value: unknown, isId: (key: unknown) => key is Id): Partial<Record<Id, SpectrumChoice>> {
  const out: Partial<Record<Id, SpectrumChoice>> = {}
  if (typeof value !== 'object' || value === null) return out
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const choice = normalizeChoice(raw)
    if (isId(key) && choice) out[key] = choice
  }
  return out
}

function loadConfig(): SpectrumConfig {
  const stored = readStorage(CONFIG_KEY)
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Record<string, unknown>
      const global = normalizeChoice(parsed.global)
      // 老存档没有 tiles 字段，读出来就是空表 = 五档谱全按语义色，正是新装时该有的样子。
      if (global) return { version: 1, global, parts: normalizeMap(parsed.parts, isPartId), tiles: normalizeMap(parsed.tiles, isTileSpecId) }
    } catch (_) { /* 存档损坏就当没存过，落回下面的旧键 / 默认值。 */ }
  }
  const legacy = readStorage(LEGACY_KEY)
  if (isPresetId(legacy)) return { version: 1, global: { kind: 'preset', preset: legacy }, parts: {}, tiles: {} }
  return { version: 1, global: { kind: 'preset', preset: 'cool' }, parts: {}, tiles: {} }
}

function persist() {
  writeStorage(CONFIG_KEY, JSON.stringify({ version: 1, global: spectrum.global, parts: spectrum.parts, tiles: spectrum.tiles }))
  // 旧键继续维护：装了旧版前端的浏览器标签页仍能读出一个合理的预设。
  if (spectrum.global.kind === 'preset') writeStorage(LEGACY_KEY, spectrum.global.preset)
}

/** 首尾同色地闭合色环——平移一整张背景图后画面完全复原，循环才没有接缝。 */
export function closeCycle(colors: string[]): string[] {
  const list = colors.filter(color => COLOR_RE.test(color)).slice(0, MAX_COLORS)
  if (!list.length) return []
  if (list.length === 1) return [list[0], list[0]]
  return [...list, list[0]]
}

/** 反向操作：把闭合过的色环还原成「可编辑的那几个颜色」，给取色器当初值。 */
export function openCycle(colors: string[]): string[] {
  if (colors.length > 2 && colors[0] === colors[colors.length - 1]) return colors.slice(0, -1)
  return colors.slice()
}

/** 一个选择对应的 CSS 色站表达式：预设与「跟随全站」直接引用色站变量，自定义才落具体色值。 */
function stopsExpr(choice: SpectrumChoice): string {
  if (choice.kind === 'preset') return `var(--spec-${choice.preset})`
  if (choice.kind === 'global') return 'var(--spec-active)'
  return closeCycle(choice.colors).join(', ')
}

/** 按逗号切色站，括号内的逗号不算（防 rgb()/color-mix() 这类写法被切碎）。 */
function splitStops(value: string): string[] {
  const stops: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) { stops.push(current.trim()); current = '' }
    else current += ch
  }
  stops.push(current.trim())
  return stops.filter(Boolean)
}

/** 回读某个 CSS 色站变量此刻的实际颜色（已闭合，首尾同色）。 */
export function readStops(cssVar: string): string[] {
  if (typeof document === 'undefined') return []
  return splitStops(getComputedStyle(document.documentElement).getPropertyValue(cssVar))
}

/** 某个部位此刻实际用的颜色（含收尾重复色，可直接当渐变色站用）。 */
export function partColors(part: PartId): string[] {
  return readStops(`--spec-${part}`)
}

/** 某套预设的颜色（去掉收尾重复色），用作自定义取色器的初值。 */
export function presetColors(preset: PresetId): string[] {
  return openCycle(readStops(`--spec-${preset}`))
}

/** 某个目标最终生效的 CSS 色站变量名——预览条与取色器初值都读它，跟真灯条同一个数据源。 */
export function cssVarOf(target: 'global' | PartId | TileSpecId): string {
  if (target === 'global') return '--spec-active'
  return isTileSpecId(target) ? `--spec-tile-${target}` : `--spec-${target}`
}

/** 某个目标当前可编辑的颜色列表：非自定义时给出它此刻的实际颜色，好让用户在原样基础上改。 */
export function editableColors(target: 'global' | PartId | TileSpecId): string[] {
  const choice = target === 'global' ? spectrum.global
    : isTileSpecId(target) ? spectrum.tiles[target]
      : spectrum.parts[target]
  if (choice?.kind === 'custom') return choice.colors.slice()
  return openCycle(readStops(cssVarOf(target)))
}

/** 把当前配色写进 DOM：预设走 data-spectrum（CSS 里已映射），自定义与分部位/分档走内联变量。 */
export function applySpectrum(persistNow = true) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (spectrum.global.kind === 'custom') {
    root.setAttribute('data-spectrum', 'custom')
    root.style.setProperty('--spec-active', closeCycle(spectrum.global.colors).join(', '))
  } else {
    // 全站那一档没有「跟随全站」的说法，非自定义即预设；存档若被改坏也退回冷谱而不是留空。
    root.setAttribute('data-spectrum', spectrum.global.kind === 'preset' ? spectrum.global.preset : 'cool')
    root.style.removeProperty('--spec-active')
  }
  // 删掉内联变量 = 回落到 base.css 里的默认（部位多为 var(--spec-active)，竖条与状态谱为语义谱）。
  for (const part of PARTS) {
    const choice = spectrum.parts[part.id]
    if (choice) root.style.setProperty(`--spec-${part.id}`, stopsExpr(choice))
    else root.style.removeProperty(`--spec-${part.id}`)
  }
  for (const spec of TILE_SPECS) {
    const choice = spectrum.tiles[spec.id]
    if (choice) root.style.setProperty(`--spec-tile-${spec.id}`, stopsExpr(choice))
    else root.style.removeProperty(`--spec-tile-${spec.id}`)
  }
  spectrumRevision.value += 1
  if (persistNow) persist()
}

export function setGlobal(choice: SpectrumChoice) {
  spectrum.global = choice
  applySpectrum()
}

/** 传 null = 该部位改回默认。 */
export function setPart(part: PartId, choice: SpectrumChoice | null) {
  if (choice) spectrum.parts[part] = choice
  else delete spectrum.parts[part]
  applySpectrum()
}

/** 传 null = 该档状态谱改回「按语义色」。 */
export function setTileSpec(spec: TileSpecId, choice: SpectrumChoice | null) {
  if (choice) spectrum.tiles[spec] = choice
  else delete spectrum.tiles[spec]
  applySpectrum()
}

// 模块一加载就还原配色，再由 Vue 挂载界面，避免首屏闪一下默认光谱。
if (typeof document !== 'undefined') {
  const loaded = loadConfig()
  spectrum.global = loaded.global
  spectrum.parts = loaded.parts
  spectrum.tiles = loaded.tiles
  applySpectrum(false)
}
