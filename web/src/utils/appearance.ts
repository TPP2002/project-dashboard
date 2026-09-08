// 外观中心的本机设置。后续效果只读存档；本模块此阶段只落地灯条、密度和字号。
import { reactive } from 'vue'
import type { WorkfloorSettings } from '../workfloor/types'
import { DEFAULT_AGE_THRESHOLDS } from './ageLevel'

export const SPEEDS = [
  { value: 1.55, label: '慢' }, { value: 1, label: '中（默认）' }, { value: 0.62, label: '快' },
] as const
export const GLOW_SIZES = [
  { value: 0.65, label: '细' }, { value: 1, label: '标准（默认）' }, { value: 1.5, label: '粗' },
] as const
export const DENSITIES = [{ value: 1, label: '舒适' }, { value: 0.75, label: '紧凑' }] as const
export const CONFETTI_COUNTS = [
  { value: 26, label: '少' }, { value: 48, label: '适中' }, { value: 90, label: '多' },
] as const
export const PROJECT_COLORS = [
  { id: 'blue', label: '蓝' }, { id: 'green', label: '绿' }, { id: 'amber', label: '琥珀' },
  { id: 'pink', label: '粉' }, { id: 'purple', label: '紫' }, { id: 'gray', label: '灰' },
] as const
export const PROJECT_ICONS = [
  { id: 'kanban', label: '看板' }, { id: 'chart', label: '图表' },
  { id: 'network', label: '网络' }, { id: 'calendar', label: '日历' },
] as const
export const PROJECT_RINGS = [
  { id: 'project-glow', label: '项目色 + 跑马灯' },
  { id: 'project', label: '项目色实色' },
  { id: 'spectrum', label: '保持流光' },
] as const
export const WIRE_EVENTS = [
  { id: 'done', label: '完工' }, { id: 'pending', label: '待拍板' }, { id: 'block', label: '阻塞' },
] as const

export type ProjectColorId = (typeof PROJECT_COLORS)[number]['id']
export type ProjectIconId = (typeof PROJECT_ICONS)[number]['id']
export interface AppearanceConfig {
  version: 1
  speed: (typeof SPEEDS)[number]['value']
  glow: (typeof GLOW_SIZES)[number]['value']
  breathe: boolean
  density: (typeof DENSITIES)[number]['value']
  fontSize: 13 | 14 | 15 | 16
  confetti: boolean
  confettiCount: (typeof CONFETTI_COUNTS)[number]['value']
  streakFire: boolean
  /** 宽限日计入连击天数；这里只存开关，不改连击算法。 */
  streakGrace: boolean
  projectColor: boolean
  projectMark: 'icon' | 'letter'
  projectRing: (typeof PROJECT_RINGS)[number]['id']
  projectColors: Record<string, ProjectColorId>
  projectIcons: Record<string, ProjectIconId>
  sound: boolean
  notify: boolean
  notifyEvents: { pending: boolean; done: boolean; block: boolean }
  /** 分钟，三个严格递增的正整数，上限一年。 */
  ageThresholds: [number, number, number]
  /** 百分比，0~100，步长 5；静音时段为本地 HH:mm。 */
  volume: number
  quietStart: string
  quietEnd: string
  wireEvents: Record<(typeof WIRE_EVENTS)[number]['id'], boolean>
  workfloor: WorkfloorSettings
}

const CONFIG_KEY = 'board-appearance-config'
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/** 每次新建覆盖表，恢复默认时不会留下旧项目的本机覆盖。 */
export function defaultAppearance(): AppearanceConfig {
  return {
    version: 1, speed: 1, glow: 1, breathe: false, density: 1, fontSize: 14,
    confetti: true, confettiCount: 48, streakFire: true, streakGrace: true,
    projectColor: true, projectMark: 'icon', projectRing: 'project-glow',
    projectColors: Object.create(null), projectIcons: Object.create(null),
    sound: false, volume: 35, quietStart: '22:30', quietEnd: '08:30',
    notify: false, notifyEvents: { pending: true, done: true, block: true },
    ageThresholds: [...DEFAULT_AGE_THRESHOLDS],
    wireEvents: { done: true, pending: true, block: true },
    workfloor: { world: 'launch', dayNight: 'theme', detail: 'ultra', height: 'standard', position: 'bottom', zoom: 1.5, camera: 'fixed', soundLink: true },
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function oneOf<T extends string | number>(value: unknown, values: readonly T[], fallback: T): T {
  return values.find(candidate => candidate === value) ?? fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function time(value: unknown, fallback: string): string {
  return typeof value === 'string' && TIME_RE.test(value) ? value : fallback
}

/** 存档读回与输入提交共用；任一档非法时整组拒收。 */
export function isAgeThresholds(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3
    && value.every(item => typeof item === 'number' && Number.isInteger(item) && item > 0 && item <= 525600)
    && value[0] < value[1] && value[1] < value[2]
}

function overrides<T extends string>(value: unknown, allowed: readonly T[]): Record<string, T> {
  const out: Record<string, T> = Object.create(null)
  for (const [id, candidate] of Object.entries(record(value))) {
    if (!id.trim() || ['__proto__', 'constructor', 'prototype'].includes(id)) continue
    const valid = allowed.find(item => item === candidate)
    if (valid) out[id] = valid
  }
  return out
}

/** 逐字段收下合法值；一个坏字段不应抹掉其它已保存的选择。 */
export function normalizeAppearance(value: unknown): AppearanceConfig {
  const raw = record(value)
  const defaults = defaultAppearance()
  const events = record(raw.wireEvents)
  const notifyEvents = record(raw.notifyEvents)
  const workfloor = record(raw.workfloor)
  return {
    version: 1,
    speed: oneOf(raw.speed, SPEEDS.map(item => item.value), defaults.speed),
    glow: oneOf(raw.glow, GLOW_SIZES.map(item => item.value), defaults.glow),
    breathe: bool(raw.breathe, defaults.breathe),
    density: oneOf(raw.density, DENSITIES.map(item => item.value), defaults.density),
    fontSize: oneOf(raw.fontSize, [13, 14, 15, 16] as const, defaults.fontSize),
    confetti: bool(raw.confetti, defaults.confetti),
    confettiCount: oneOf(raw.confettiCount, CONFETTI_COUNTS.map(item => item.value), defaults.confettiCount),
    streakFire: bool(raw.streakFire, defaults.streakFire),
    streakGrace: bool(raw.streakGrace, defaults.streakGrace),
    projectColor: bool(raw.projectColor, defaults.projectColor),
    projectMark: oneOf(raw.projectMark, ['icon', 'letter'] as const, defaults.projectMark),
    projectRing: oneOf(raw.projectRing, PROJECT_RINGS.map(item => item.id), defaults.projectRing),
    projectColors: overrides(raw.projectColors, PROJECT_COLORS.map(item => item.id)),
    projectIcons: overrides(raw.projectIcons, PROJECT_ICONS.map(item => item.id)),
    sound: bool(raw.sound, defaults.sound),
    notify: bool(raw.notify, defaults.notify),
    notifyEvents: {
      pending: bool(notifyEvents.pending, defaults.notifyEvents.pending),
      done: bool(notifyEvents.done, defaults.notifyEvents.done),
      block: bool(notifyEvents.block, defaults.notifyEvents.block),
    },
    ageThresholds: isAgeThresholds(raw.ageThresholds) ? [...raw.ageThresholds] : defaults.ageThresholds,
    volume: typeof raw.volume === 'number' && Number.isFinite(raw.volume) && raw.volume >= 0 && raw.volume <= 100
      && raw.volume % 5 === 0 ? raw.volume : defaults.volume,
    quietStart: time(raw.quietStart, defaults.quietStart),
    quietEnd: time(raw.quietEnd, defaults.quietEnd),
    wireEvents: {
      done: bool(events.done, defaults.wireEvents.done),
      pending: bool(events.pending, defaults.wireEvents.pending),
      block: bool(events.block, defaults.wireEvents.block),
    },
    workfloor: {
      world: oneOf(workfloor.world, ['off', 'launch', 'mech'] as const, defaults.workfloor.world),
      dayNight: oneOf(workfloor.dayNight, ['theme', 'night', 'clock'] as const, defaults.workfloor.dayNight),
      detail: oneOf(workfloor.detail, ['standard', 'ultra'] as const, defaults.workfloor.detail),
      height: oneOf(workfloor.height, ['standard', 'compact'] as const, defaults.workfloor.height),
      position: oneOf(workfloor.position, ['top', 'bottom'] as const, defaults.workfloor.position),
      zoom: oneOf(workfloor.zoom, [1, 1.25, 1.5, 1.75, 2] as const, defaults.workfloor.zoom),
      camera: oneOf(workfloor.camera, ['fixed', 'pan'] as const, defaults.workfloor.camera),
      soundLink: bool(workfloor.soundLink, defaults.workfloor.soundLink),
    },
  }
}

function loadAppearance(): AppearanceConfig {
  try { return normalizeAppearance(JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null')) }
  catch (_) { return defaultAppearance() /* 存档损坏或站点存储不可用，只退回本机默认。 */ }
}

export const appearance = reactive<AppearanceConfig>(loadAppearance())

/** 默认值不留内联覆盖，尺寸与时长由 base.css 单一来源决定。可重复调用。 */
export function applyAppearance(persistNow = true) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const values: Record<string, string | null> = {
    '--sp-k': appearance.speed === 1 ? null : String(appearance.speed),
    '--gl-k': appearance.glow === 1 ? null : String(appearance.glow),
    '--gl-op': appearance.glow === 0.65 ? '.82' : null,
    '--dens': appearance.density === 1 ? null : String(appearance.density),
    '--fs': appearance.fontSize === 14 ? null : `${appearance.fontSize}px`,
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === null) root.style.removeProperty(key)
    else root.style.setProperty(key, value)
  }
  if (appearance.breathe) root.setAttribute('data-edge', 'breathe')
  else root.removeAttribute('data-edge')
  if (persistNow) {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(appearance)) }
    catch (_) { /* 无法保存时仍在本页生效，刷新后使用上次存档或默认值。 */ }
  }
}

/** 所有控件经过同一校验入口，再更新本页与存档。 */
export function setAppearance<K extends keyof Omit<AppearanceConfig, 'version'>>(key: K, value: AppearanceConfig[K]) {
  Object.assign(appearance, normalizeAppearance({ ...appearance, [key]: value }))
  applyAppearance()
}

export function resetAppearance() {
  Object.assign(appearance, defaultAppearance())
  applyAppearance()
}

// 与 spectrum 一样，挂载界面前先还原，避免首屏闪回默认尺寸。
if (typeof document !== 'undefined') applyAppearance(false)
