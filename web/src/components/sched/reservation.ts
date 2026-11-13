import type { Reservation, ReservationChange } from '@/api/sched'
import { clock } from './format'

export function describeSubmitter(submitter: string | null | undefined): string {
  if (!submitter) return '来源没记下'
  if (submitter === 'dashboard') return '看板发出（当时没记来源）'
  if (!submitter.startsWith('dashboard;')) return `${submitter} 发出`
  const fields: Record<string, string> = {}
  for (const part of submitter.split(';').slice(1)) {
    const i = part.indexOf('=')
    if (i >= 0) fields[part.slice(0, i)] = part.slice(i + 1)
  }
  const label = fields.client === 'page' ? '看板页面' : fields.client === 'api' ? '接口直调' : '看板发出'
  const addr = fields.addr
  return label + (addr && addr !== 'unknown' ? `（${['127.0.0.1', '::1', 'localhost'].includes(addr) ? '本机' : addr}）` : '')
}
export function formatSpan(ms: number): string {
  if (ms < 60000) return '不到 1 分钟'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60), remainder = minutes % 60
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`
}
export function reservationBanner(reservation: Reservation | null | undefined, change: ReservationChange | null | undefined, nowMs: number) {
  if (!reservation || !reservation.requestedCores) return null
  const matched = !!change && change.requestedCores === reservation.requestedCores && (change.untilAt ?? null) === (reservation.untilAt ?? null)
  const at = matched ? new Date(change.at) : null
  const pad = (n: number) => String(n).padStart(2, '0')
  const detail = [at ? `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())} 设的` : '设置时间读不到']
  if (matched) detail.push(describeSubmitter(change.submitter))
  const unlimited = !reservation.untilAt
  if (reservation.untilAt) {
    const remaining = Date.parse(reservation.untilAt) - nowMs
    detail.push(remaining > 0 ? `还剩 ${formatSpan(remaining)}，${clock(reservation.untilAt)} 自动取消` : '已到期，等派单员取消')
  } else detail.push(matched ? `不限期，已经留了 ${formatSpan(nowMs - Date.parse(change.at))}` : '不限期')
  return { tone: unlimited ? (matched && nowMs - Date.parse(change.at) >= 10800000 ? 'bad' : 'warn') : 'info',
    title: `主机给你留着 ${reservation.requestedCores} 核${reservation.fulfilledCores < reservation.requestedCores ? `（已兑现 ${reservation.fulfilledCores} 核）` : ''}`,
    detail: detail.join(' · '), unlimited }
}
