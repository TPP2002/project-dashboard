import type { CommandInput, MachineSnapshot, SchedEtaModel, TicketEstimate, TicketSummary, TicketState } from '@/api/sched'
import type { CiJob, CiThrottle } from '@/api/schedCiJobs'

export const stateLabels: Record<TicketState, string> = { queued: '排队中', granted: '已授予，等待开跑', running: '运行中',
  paused: '暂停中', slow: '低速继续', unsatisfiable: '无法满足', passed: '通过', failed: '失败', cancelled: '已撤单', voided: '已作废' }
/** 施工单(category=codex-build)的终态只说明工人怎么结束的,不冒充验收结论;其余类别与状态不在此列。 */
const buildOutcomeLabels: Partial<Record<TicketState, string>> = { passed: '工人跑完', failed: '工人异常退出' }
/** 单个状态/执行结果(state 或 outcome)的文案:按类别挑选,台账结果列、详情状态与执行记录共用这一个口径。 */
export function stateLabel(state: string, category?: string | null): string {
  return (category === 'codex-build' ? buildOutcomeLabels[state as TicketState] : undefined) || stateLabels[state as TicketState] || state
}
export const pauseLabels: Record<string, string> = { ci: 'CI 优先', manual: '手动暂停', 'owner-hold': '你在用电脑' }
export function ticketLabel(ticket: Pick<TicketSummary, 'state' | 'cancelRequested' | 'pauseReasons'> & { resident?: boolean; category?: string }) {
  if (ticket.cancelRequested && !['passed', 'failed', 'cancelled', 'voided'].includes(ticket.state)) return '撤单处理中'
  const stateText = ticket.resident === true && ticket.state === 'granted' ? '常驻占用中' : stateLabel(ticket.state, ticket.category)
  return [stateText, ...ticket.pauseReasons.map(reason => pauseLabels[reason] || reason)].join(' · ')
}
export function ticketTone(ticket: Pick<TicketSummary, 'state' | 'cancelRequested' | 'pauseReasons'> & { resident?: boolean }): 'bad' | 'warn' | 'ok' | 'info' | 'muted' {
  return ticket.resident === true && ticket.state === 'granted' ? 'ok' : tone(ticket.state)
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
  const blocked = Array.isArray(job.candidateMachines) && job.candidateMachines.length === 0 ? '没有在线 runner 能接' : null
  return [job.project || job.repository, job.workflow, job.job, job.cardTitle || job.title,
    queuedMs === null ? '排队时长未知' : `排队 ${Math.floor(queuedMs / 60_000)} 分钟`, blocked, stale].filter(Boolean).join(' · ')
}
/** 唯一候选在线才把排队作业挪到那台机器的卡上；读不准、多台或没有候选都留在主机卡。 */
export function ciQueuedForCard(queued: CiJob[], machine: string, host: string, onlineMachines: string[] = []): CiJob[] {
  return queued.filter(job => {
    const candidates = job.candidateMachines
    const owner = Array.isArray(candidates) && candidates.length === 1 && onlineMachines.includes(candidates[0]) ? candidates[0] : host
    return owner === machine
  })
}
/** 同一台机器一个 runner 时直接点名，其余情况用通用说法。 */
export function ciQueueHeading(jobs: CiJob[]) {
  const first = jobs[0]?.candidateRunners
  const only = Array.isArray(first) && first.length === 1 ? first[0] : null
  const same = only !== null && jobs.every(job => Array.isArray(job.candidateRunners)
    && job.candidateRunners.length === 1 && job.candidateRunners[0] === only)
  return same ? `排队等 ${only}(${jobs.length})` : `排队等 runner(${jobs.length})`
}
export function ciRunnersDiffer(observed: string[] | null | undefined, jobs: CiJob[]) {
  if (!Array.isArray(observed) || !observed.every(runner => typeof runner === 'string')) return false
  const actual = new Set(jobs.flatMap(job => job.runner === null ? [] : [job.runner]))
  const heartbeat = new Set(observed)
  return actual.size !== heartbeat.size || [...actual].some(runner => !heartbeat.has(runner))
}
/** 额度吃紧时的一句话解释;读不到额度就只说是为省额度,不编数字。时间一律按本机时区两位补零。 */
export function ciThrottleNote(throttle: CiThrottle | null | undefined, nowMs: number): { text: string; warn: boolean } | null {
  if (!throttle) return null
  const minutes = Math.max(1, Math.round(throttle.intervalMs / 60000))
  if (throttle.level === 'paused') {
    const at = throttle.nextAt === null ? null : new Date(throttle.nextAt)
    const resume = at && Number.isFinite(at.getTime())
      ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} 恢复`
      : '稍后恢复'
    return { text: `GitHub 查询额度快用完了,检查作业暂停刷新,${resume}`, warn: true }
  }
  if (throttle.remaining !== null && throttle.limit !== null) {
    return { text: `GitHub 查询额度剩 ${throttle.remaining}/${throttle.limit},检查作业改为每 ${minutes} 分钟刷新`, warn: false }
  }
  return { text: `为省 GitHub 查询额度,检查作业改为每 ${minutes} 分钟刷新`, warn: false }
}
export function commandLabel(input: CommandInput) {
  if (input.kind === 'jump-queue') return `插队 ${input.data.ticketId}`
  if (input.kind === 'cancel') return `撤单 ${input.data.ticketId}`
  if (input.kind === 'pause-one') return `暂停 ${input.data.ticketId}`
  if (input.kind === 'resume-one') return `恢复 ${input.data.ticketId}`
  if (input.kind === 'owner-hold') return '一键全部暂停（主机）'
  if (input.kind === 'owner-release') return '恢复主机上的活'
  if (input.kind === 'reserve') return `预留主机 ${input.data.requestedCores} 核${input.data.durationMinutes ? ` · ${input.data.durationMinutes / 60} 小时` : input.data.requestedCores ? ' · 不限期' : ''}`
  return '调度指令'
}
/** 判据一律 ticket.resident === true；缺省或 false 都是普通单。 */
export function isResidentTicket(ticket: { resident?: boolean }): boolean {
  return ticket.resident === true
}
/** 常驻占用单张数：机器卡收起时用它说明被收起几条，页头用它给出总数。 */
export function residentCount(tickets: { resident?: boolean }[]): number {
  return tickets.filter(isResidentTicket).length
}
/** 隐藏常驻占用时去掉它们，原顺序、原对象不变，也不改动传入数组；显示时原样返回。 */
export function visibleTickets<T extends { resident?: boolean }>(tickets: T[], showResident: boolean): T[] {
  return showResident ? tickets : tickets.filter(ticket => !isResidentTicket(ticket))
}

/** 估时文案:旧估值逐字沿用原模板,学了模型的改成「一般跑 a~b」并说清超时后还要多久。 */
export type EstimateText = { headline: string; detail: string; title: string; warn: boolean }
/** 只读渲染入参:两种估值与展示附加字段的可能键都在,缺了按「暂无」处理。 */
type EstimateInput = {
  kind: TicketEstimate['kind']
  code?: string; reason?: string
  startAt?: string; waitMs?: number; finishAt?: string; remainingMs?: number; overdue?: boolean
  machine?: string; medianMs?: number; sampleCount?: number
  lowMs?: number; highMs?: number; basis?: string; level?: number; learned?: boolean; tail?: boolean
  remainingLowMs?: number; remainingHighMs?: number
  ciHeadroom?: number; slowdown?: number; slowdownEstimated?: boolean
}

function slowdownNote(slowdown: number | undefined, estimated: boolean | undefined) {
  return slowdown === undefined ? '' : ` · 低优先级耗时 ${Number(slowdown.toFixed(2))} 倍（${estimated === false ? '实测' : '估'}）`
}

export function describeEstimate(estimate?: EstimateInput | null): EstimateText {
  if (!estimate) return { headline: '算不出（读不到预估数据）', detail: '', title: '', warn: false }
  if (estimate.kind === 'unavailable') return { headline: `算不出（${estimate.reason}）`, detail: '', title: '', warn: false }
  const note = slowdownNote(estimate.slowdown, estimate.slowdownEstimated)
  if (estimate.learned === true) {
    const title = `依据:${estimate.basis};中位 ${duration(estimate.medianMs)}`
    if (estimate.kind === 'wait') return { headline: `预计等待 ${duration(estimate.waitMs)}`,
      detail: ` · ${stamp(estimate.startAt)} 开跑 · 一般跑 ${duration(estimate.lowMs)}~${duration(estimate.highMs)}${note}`, title, warn: false }
    if (estimate.overdue) return { headline: '已超出常见耗时', warn: true, title,
      detail: (estimate.tail === true ? ` · 按已跑时长估,还要约 ${duration(estimate.remainingMs)}(把握不大)`
        : ` · 按同类活里更慢的几次估,还要约 ${duration(estimate.remainingMs)}`) + note }
    return { headline: `预计完成 ${stamp(estimate.finishAt)}`, title, warn: false,
      detail: ` · 一般跑 ${duration(estimate.lowMs)}~${duration(estimate.highMs)}${note}` }
  }
  const title = `同类最近 ${estimate.sampleCount} 次执行的中位耗时：${duration(estimate.medianMs)}`
  const headline = estimate.kind === 'wait' ? `预计等待 ${duration(estimate.waitMs)}`
    : estimate.overdue ? '已超出预计耗时' : `预计完成 ${stamp(estimate.finishAt)}`
  const start = estimate.kind === 'wait' ? ` · ${stamp(estimate.startAt)} 开跑` : ''
  const total = estimate.medianMs === undefined ? undefined : estimate.medianMs * (estimate.slowdown ?? 1)
  return { headline, title, warn: estimate.kind === 'completion' && estimate.overdue === true,
    detail: `${start} · 预计跑 ${duration(total)}${note}` }
}

/** 页头小标签:报告估时模型自己的准确度;没读到状态或未就绪时如实说明。 */
export function etaModelPill(info: SchedEtaModel | null | undefined): { text: string; title: string; ok: boolean } {
  if (info === null || info === undefined) return { text: '', title: '', ok: false }
  if (info.loaded === false) return { text: '估时模型未就绪 · 暂用旧口径', title: info.reason, ok: false }
  if (info.accuracy.n === 0) return { text: '估时模型刚起步 · 还没有对照数据', title: `已学 ${info.buckets} 组`, ok: true }
  const percent = (value: number | null) => Math.round((value ?? 0) * 100)
  return { text: `估时模型 · 近 ${info.accuracy.n} 次误差 30% 内 ${percent(info.accuracy.within30)}%`, ok: true,
    title: `范围命中 ${percent(info.accuracy.intervalHit)}% · 误差 50% 内 ${percent(info.accuracy.within50)}% · 学习于 ${stamp(info.updatedAt)}` }
}
