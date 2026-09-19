import type { CommandInput, MachineSnapshot, TicketSummary, TicketState } from '@/api/sched'
import type { CiJob } from '@/api/schedCiJobs'

export const stateLabels: Record<TicketState, string> = { queued: '排队中', granted: '已授予，等待开跑', running: '运行中',
  paused: '暂停中', slow: '低速继续', unsatisfiable: '无法满足', passed: '通过', failed: '失败', cancelled: '已撤单', voided: '已作废' }
export const pauseLabels: Record<string, string> = { ci: 'CI 优先', manual: '手动暂停', 'owner-hold': '你在用电脑' }
export function ticketLabel(ticket: Pick<TicketSummary, 'state' | 'cancelRequested' | 'pauseReasons'>) {
  if (ticket.cancelRequested && !['passed', 'failed', 'cancelled', 'voided'].includes(ticket.state)) return '撤单处理中'
  return [stateLabels[ticket.state], ...ticket.pauseReasons.map(reason => pauseLabels[reason] || reason)].join(' · ')
}
export function tone(state: string): 'bad' | 'warn' | 'ok' | 'info' | 'muted' {
  if (['failed', 'unsatisfiable', 'rejected', 'expired'].includes(state)) return 'bad'
  if (['paused', 'slow', 'submitted'].includes(state)) return 'warn'
  if (['running', 'passed', 'executed'].includes(state)) return 'ok'
  return ['cancelled', 'voided'].includes(state) ? 'muted' : 'info'
}
export function duration(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return '暂无'
  if (ms < 60000) return `${Math.floor(ms / 1000)} 秒`
  const minutes = Math.floor(ms / 60000)
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
export function stamp(at: string | null | undefined) {
  return at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '暂无'
}
export function clock(at: string) {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}
export function age(at: string | null, now: number): number | null {
  return at && Number.isFinite(Date.parse(at)) ? Math.max(0, now - Date.parse(at)) : null
}
export function freshness(machine: MachineSnapshot, now: number) {
  const heartbeat = age(machine.heartbeatAt, now), load = age(machine.loadSampledAt, now)
  const ageMs = heartbeat === null || load === null ? null : Math.max(heartbeat, load)
  return { ageMs, stale: !machine.fresh || ageMs === null || ageMs > 30000 }
}
export function ciJobLabel(job: CiJob, now: number) {
  const elapsed = age(job.startedAt, now)
  const remaining = elapsed === null || job.expectedMs === null ? null : job.expectedMs - elapsed
  const estimate = remaining === null ? '预计还要多久：算不出'
    : remaining < 0 ? '已超出平均' : `预计还要 ${duration(remaining)}`
  const dataAge = age(job.updatedAt ?? null, now)
  const stale = job.staleSince ? dataAge === null ? '数据时间未知' : `数据 ${Math.floor(dataAge / 1000)} 秒前` : null
  return [job.project, job.workflow, job.job, job.cardTitle || job.title,
    elapsed === null ? '已跑时长未知' : `已跑 ${duration(elapsed)}`, estimate, stale].filter(Boolean).join(' · ')
}
export function ciQueuedLabel(job: CiJob, now: number) {
  const queuedMs = age(job.queuedAt, now)
  const dataAge = age(job.updatedAt ?? null, now)
  const stale = job.staleSince ? dataAge === null ? '数据时间未知' : `数据 ${Math.floor(dataAge / 1000)} 秒前` : null
  return [job.project || job.repository, job.workflow, job.job, job.cardTitle || job.title,
    queuedMs === null ? '排队时长未知' : `排队 ${Math.floor(queuedMs / 60_000)} 分钟`, stale].filter(Boolean).join(' · ')
}
export function ciRunnersDiffer(observed: string[] | null | undefined, jobs: CiJob[]) {
  if (!Array.isArray(observed) || !observed.every(runner => typeof runner === 'string')) return false
  const actual = new Set(jobs.flatMap(job => job.runner === null ? [] : [job.runner]))
  const heartbeat = new Set(observed)
  return actual.size !== heartbeat.size || [...actual].some(runner => !heartbeat.has(runner))
}
export function commandLabel(input: CommandInput) {
  if (input.kind === 'jump-queue') return `插队 ${input.data.ticketId}`
  if (input.kind === 'cancel') return `撤单 ${input.data.ticketId}`
  if (input.kind === 'pause-one') return `暂停 ${input.data.ticketId}`
  if (input.kind === 'resume-one') return `恢复 ${input.data.ticketId}`
  if (input.kind === 'owner-hold') return '一键全部暂停（主机）'
  if (input.kind === 'owner-release') return '恢复主机上的活'
  if (input.kind === 'reserve') return `预留主机 ${input.data.requestedCores} 核${input.data.durationMinutes ? ` · ${input.data.durationMinutes / 60} 小时` : ''}`
  return '调度指令'
}
