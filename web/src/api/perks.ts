import { authFetch } from '@/collaboration/http'

export interface PerksToday { status: string; statusName: string; detail: string; time: string }
export interface PerksPlatform {
  id: string; name: string; reward: string; url: string; loginUrl: string
  mode: 'click' | 'visit' | 'manual'; today: PerksToday | null
  last7: { date: string; status: string | null; statusName: string | null }[]
}
export interface PerksAccount { id: string; name: string; enabled: boolean; isDefault: boolean; platformIds: string[]; platforms: PerksPlatform[] }
export interface PerksActivity {
  kind: 'run' | 'login' | 'probe'; phase: 'queued' | 'starting' | 'running'; startedAt: string
  own: boolean; stopping: boolean; progress: { index: number; total: number; accountName: string; platformName: string } | null
}
export interface PerksLastRun { startedAt: string; finishedAt: string; outcome: 'done' | 'stopped' | 'failed'; ran: number; total: number; error: string }
export interface PerksJob { kind: 'login' | 'run' | 'schedule-on' | 'schedule-off'; label: string; startedAt: number; finishedAt: number | null; exitCode: number | null; reason: string; stopping?: boolean; stopped?: boolean }
export interface PerksState {
  date: string; dateLabel: string; summary: { done: number; action: number; unverified: number; manual: number }
  accounts: PerksAccount[]; platforms: PerksPlatform[]; selectablePlatforms: { id: string; name: string }[]
  scheduleInstalled: boolean; runTimes: string[]
  changes: { kind: 'added' | 'removed' | 'changed'; name: string; sourceLabel: string; detail: string }[]
  unintegrated: { name: string; url: string; reward: string; cadenceLabel: string }[]
  job: PerksJob | null; activity?: PerksActivity | null; lastRun?: PerksLastRun | null; calibration?: { total: number; pending: number } | null
}
export type PerksAction =
  | { action: 'run' | 'stop' }
  | { action: 'login'; account?: string; ids?: string[] }
  | { action: 'schedule'; on: boolean }
  | { action: 'account-add'; name: string; platformIds: string[] }
  | { action: 'account-update'; id: string; name?: string; platformIds?: string[]; enabled?: boolean }

export async function fetchPerksAvailable(): Promise<boolean> {
  try {
    const res = await authFetch('/api/perks/available')
    const body = await res.json()
    return res.ok && body.ok === true && body.available === true
  } catch { return false }
}
export async function fetchPerksState(signal?: AbortSignal): Promise<PerksState> {
  let res: Response
  try { res = await authFetch('/api/perks', { signal }) } catch { throw new Error('读取失败') }
  let body: { ok?: boolean; data?: PerksState; error?: string } | null = null
  try { body = await res.json() } catch { /* 按读取失败处理 */ }
  if (!res.ok || !body || body.ok !== true || !body.data) throw new Error(body?.error || '读取失败')
  return body.data
}
export async function postPerksAction(body: PerksAction): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await authFetch('/api/perks/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    let result: { ok?: boolean; error?: string } | null = null
    try { result = await res.json() } catch { /* 按操作失败处理 */ }
    if (!res.ok || !result || result.ok !== true) return { ok: false, error: result?.error || '操作失败' }
    return { ok: true }
  } catch { return { ok: false, error: '操作失败' } }
}
