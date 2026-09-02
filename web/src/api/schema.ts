// 状态枚举 / emoji 的单一真相源 = core/boardSchema.cjs。
// 经 vite 虚拟模块 'virtual:board-schema'（Node 端 require core 的 CJS 后内联成 ESM）注入，
// dev 与 build 一致、零漂移，不让浏览器直接加载 .cjs。前端只在此补一套配色。
import { STATUS, STATUS_EMOJI, emojiFor } from 'virtual:board-schema'

export { STATUS, STATUS_EMOJI, emojiFor }

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
}

export function statusTone(s: string): StatusTone {
  return STATUS_TONE[s] || 'n'
}

export function statusColor(s: string): string {
  const tone = statusTone(s)
  return tone === 'n' ? 'var(--text-3)' : `var(--${tone})`
}

// 完工类状态（用于进度派生：done 计数）
export const DONE_STATUSES = new Set(['已完工'])
