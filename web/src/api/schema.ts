// 状态枚举 / emoji 的单一真相源 = core/boardSchema.cjs（vite alias '@core' 解析）。
// 前端只在此补一套配色（读时用于泳道 / 徽章 / 进度环），不复制枚举、不产生漂移。
import { STATUS, STATUS_EMOJI, emojiFor } from '@core/boardSchema.cjs'

export { STATUS, STATUS_EMOJI, emojiFor }

// 泳道 / 排序顺序沿用 core STATUS 顺序
export const STATUS_ORDER: string[] = STATUS

// 状态配色：贴合状态语义（待拍板=橙告警、完工/已拍板=绿、暂缓=红、施工中=琥珀、压轴=紫）
export const STATUS_COLOR: Record<string, string> = {
  未开工: '#8a94a6',
  待开工: '#5b8def',
  待拍板: '#f5a623',
  已拍板: '#3fb950',
  施工中: '#e3a008',
  可复工: '#2bb0c9',
  收官: '#2f9e6f',
  已完工: '#2ea043',
  暂缓: '#d0637c',
  压轴: '#a371f7',
}

export function statusColor(s: string): string {
  return STATUS_COLOR[s] || '#8a94a6'
}

// 完工类状态（用于进度派生：done 计数）
export const DONE_STATUSES = new Set(['已完工'])
