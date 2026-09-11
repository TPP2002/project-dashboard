import type { CommandInput, LegacySync, Receipt, TicketFilters } from '@/api/sched'

export type Period = 'today' | 'd7' | 'd90' | 'all' | 'custom'
export interface LedgerPrefs extends TicketFilters { period: Period }
export interface SubmittedCommand {
  commandId: string; input: CommandInput; createdAt: string; expiresAt: string; share: string
  legacy?: LegacySync; receipt?: Receipt
}
export const DEFAULT_FILTERS: LedgerPrefs = { project: '', machine: '', submitter: '', result: '', from: '', to: '', period: 'd7' }
const FILTER_KEY = 'dashboard.sched.filters.v1'
const COMMAND_KEY = 'dashboard.sched.commands.v1'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const date = (value: unknown): value is string => value === '' || (typeof value === 'string' && iso(`${value}T00:00:00.000Z`))
const boundedText = (value: unknown): value is string => typeof value === 'string' && value.length <= 500
const RESULTS = ['', 'queued', 'granted', 'running', 'paused', 'slow', 'unsatisfiable', 'passed', 'failed', 'cancelled', 'voided']

function load(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null }
}
export function saveLocal(key: 'filters' | 'commands', value: LedgerPrefs | SubmittedCommand[]): boolean {
  try { localStorage.setItem(key === 'filters' ? FILTER_KEY : COMMAND_KEY, JSON.stringify(value)); return true }
  catch { return false }
}
/** 逐字段恢复；不展开持久化对象，未知键和脏值不会进入请求。 */
export function loadFilters(): LedgerPrefs {
  const raw = load(FILTER_KEY), result = { ...DEFAULT_FILTERS }
  if (!object(raw)) return result
  for (const key of ['project', 'machine', 'submitter'] as const) if (boundedText(raw[key])) result[key] = raw[key]
  if (typeof raw.result === 'string' && RESULTS.includes(raw.result)) result.result = raw.result
  if (typeof raw.period === 'string' && ['today', 'd7', 'd90', 'all', 'custom'].includes(raw.period)) result.period = raw.period as Period
  if (date(raw.from)) result.from = raw.from
  if (date(raw.to)) result.to = raw.to
  if (result.from && result.to && result.from > result.to) { result.from = ''; result.to = '' }
  return result
}
function commandInput(raw: unknown): CommandInput | null {
  if (!object(raw) || !object(raw.data)) return null
  if (raw.kind === 'jump-queue' || raw.kind === 'cancel') {
    if (typeof raw.data.ticketId === 'string' && /^tk-[0-9a-f]{20}$/.test(raw.data.ticketId)) return { kind: raw.kind, data: { ticketId: raw.data.ticketId } }
  }
  if (raw.kind === 'owner-hold' || raw.kind === 'owner-release') return { kind: raw.kind, data: {} }
  if (raw.kind === 'reserve') {
    const { requestedCores: cores, durationMinutes: duration } = raw.data
    if (cores !== 0 && cores !== 5 && cores !== 10 && cores !== 15) return null
    if (duration !== undefined && duration !== 60 && duration !== 180) return null
    if (cores === 0 && duration !== undefined) return null
    return { kind: 'reserve', data: { requestedCores: cores, ...(duration ? { durationMinutes: duration } : {}) } }
  }
  return null
}
export function loadCommands(): SubmittedCommand[] {
  const raw = load(COMMAND_KEY)
  if (!Array.isArray(raw)) return []
  const result: SubmittedCommand[] = []
  for (const value of raw.slice(0, 50)) {
    if (!object(value) || typeof value.commandId !== 'string' || !/^dash-[A-Za-z0-9._-]+$/.test(value.commandId)
      || !iso(value.createdAt) || !iso(value.expiresAt) || value.expiresAt < value.createdAt || !boundedText(value.share)) continue
    const input = commandInput(value.input)
    if (!input) continue
    const item: SubmittedCommand = { commandId: value.commandId, createdAt: value.createdAt, expiresAt: value.expiresAt, share: value.share, input }
    if (object(value.legacy) && typeof value.legacy.ok === 'boolean') {
      item.legacy = { ok: value.legacy.ok, ...(boundedText(value.legacy.error) ? { error: value.legacy.error } : {}) }
    }
    const receipt = value.receipt
    if (object(receipt) && receipt.commandId === item.commandId && iso(receipt.at)
      && (receipt.status === 'executed' || ((receipt.status === 'rejected' || receipt.status === 'expired') && boundedText(receipt.reason)))) {
      item.receipt = { commandId: item.commandId, at: receipt.at, status: receipt.status,
        ...(boundedText(receipt.reason) ? { reason: receipt.reason } : {}) }
    }
    result.push(item)
  }
  return result
}
/** 服务端编号携带创建时刻；据此取精确的十分钟期限，不用客户端时钟猜提交时刻。 */
export function commandTimes(id: string) {
  const parts = /^dash-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-/.exec(id)
  if (!parts) throw new Error('指令编号缺少提交时刻，请刷新核对回执')
  const createdAt = `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}.${parts[7]}Z`
  return { createdAt, expiresAt: new Date(Date.parse(createdAt) + 600000).toISOString() }
}
export function queryFilters(prefs: LedgerPrefs, nowMs: number): TicketFilters {
  const { period, ...filters } = prefs
  if (period === 'custom') {
    // 日期输入代表负责人本地的一整天，发送明确 UTC 边界避免跨时区少算记录。
    return { ...filters, from: prefs.from ? new Date(`${prefs.from}T00:00:00`).toISOString() : '',
      to: prefs.to ? new Date(`${prefs.to}T23:59:59.999`).toISOString() : '' }
  }
  if (period === 'all') return { ...filters, from: '', to: '' }
  const start = new Date(nowMs), end = new Date(nowMs)
  start.setHours(0, 0, 0, 0); end.setHours(23, 59, 59, 999)
  start.setDate(start.getDate() - (period === 'd7' ? 6 : period === 'd90' ? 89 : 0))
  return { ...filters, from: start.toISOString(), to: end.toISOString() }
}
