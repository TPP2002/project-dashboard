// 状态枚举的单一真相源 = core/boardSchema.cjs。
// 经 vite 虚拟模块 'virtual:board-schema'（Node 端 require core 的 CJS 后内联成 ESM）注入，
// dev 与 build 一致、零漂移，不让浏览器直接加载 .cjs。前端只在此补配色与图标映射。
//
// 注意：core 那边的 STATUS_EMOJI / emojiFor 只服务 CLI 终端输出（终端画不了 SVG），
// 界面一律走下面的 STATUS_ICON → StatusTile，前端不再 import emojiFor。
import { STATUS } from 'virtual:board-schema'
import { STATUS_GLYPHS, type StatusGlyph, type StatusGlyphKey } from '@/icons/statusGlyphs'

export { STATUS }

// 泳道 / 排序顺序沿用 core STATUS 顺序
export const STATUS_ORDER: string[] = STATUS

// 状态只落到设计系统的五种语义色阶，避免组件各自维护一套颜色。
export type StatusTone = 'n' | 'ok' | 'warn' | 'bad' | 'info'
export const STATUS_TONE: Record<string, StatusTone> = {
  未开工: 'n',
  待开工: 'info',
  待拍板: 'warn',
  已拍板: 'ok',
  施工中: 'info',
  可复工: 'info',
  收官: 'ok',
  已完工: 'ok',
  暂缓: 'bad',
  压轴: 'warn',
  已作废: 'n',
}

export function statusTone(s: string): StatusTone {
  return STATUS_TONE[s] || 'n'
}

export function statusColor(s: string): string {
  const tone = statusTone(s)
  return tone === 'n' ? 'var(--text-3)' : `var(--${tone})`
}

/** 状态 → 瓦片记号。记号本身（含灯条速度、动效）在 icons/statusGlyphs.ts，正本是 v3 定稿设计稿。 */
export const STATUS_ICON: Record<string, StatusGlyphKey> = {
  未开工: 'none',
  待开工: 'queued',
  待拍板: 'ask',
  已拍板: 'decided',
  施工中: 'building',
  可复工: 'resume',
  收官: 'wrap',
  已完工: 'done',
  暂缓: 'parked',
  压轴: 'finale',
  已作废: 'void',
}

/** 画一枚状态瓦片需要知道的全部：语义色 + 记号 + 灯条参数。StatusTile 只认这个返回值。 */
export interface StatusMeta extends StatusGlyph {
  tone: StatusTone
}

// 认不出的状态退回「未开工」的静态样子：宁可画个中性瓦片，也不要在界面上开天窗。
export function statusMeta(s: string): StatusMeta {
  return { ...STATUS_GLYPHS[STATUS_ICON[s] || 'none'], tone: statusTone(s) }
}

// 完工类状态（用于进度派生：done 计数）
export const DONE_STATUSES = new Set(['已完工'])
