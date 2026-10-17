/** 只在派单员受保护提交内执行。流水 fsync 先于实物，恢复复用确定性身份；不启动进程。 */
import { readFileSync } from 'node:fs'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import { errorMessage, hasCode } from '../bot/cluster-lifecycle-contract'
import { LifecycleStateConflictError, LifecycleTakeoverConflictError, buildLifecycleIdentity, publishLifecycleJob, transitionLifecycleJob,
  type LifecycleStateRecord } from '../bot/cluster-lifecycle'
import { causedByCode } from './sched-ledger'
import { finishQueuedTicket } from './sched-commands'
import { QUEUED_CANCEL_BACKSTOP_REASON } from './sched-reclaim'
import {
  canonicalJson, intentPath, nextAttemptId, schedPaths, submissionId,
  type CodeRef, type DispatchIntent, type EventDraft, type LedgerEvent, type SchedulerSources, type TicketSnapshot,
} from './sched-contract'
import { autoIntentCodeRef, clusterJobForTicket, handoffLogPath, handoffPublication, legacyHandoffIdentities,
  observeHandoff, payloadProtocolGate, reconcileLegacyClaimIdentities } from './sched-cluster-job'
import { AUTO_REQUEUE_SAME_MAX, autoPinData, autoRefusalDisposition, autoRetryCount, formatAutoRequeueReason,
  isAutoHandoffTicket, isUnknownAutoRefusal, preflightAutoHandoff, type AutoPreflightIo } from './sched-auto-handoff'
import type { AutoLaunchReader } from './sched-auto-launch'
import { rerunSelectionOf, shouldRerun, validateRerunPlan, type RerunEventData } from './sched-rerun'
import type { ProjectionState } from './sched-project'
import { writeTicketSnapshot } from './sched-tickets'
import { ActiveTransitionLeaseError } from '../bot/cluster-lifecycle-lease'
import { assertSameIdentity } from '../bot/cluster-lifecycle-contract'
import type { MachineInput } from './sched-decide'

export const CI_YIELD_RECALL_REASON = '执行机 CI 在跑,授予未领的集群单没带 CI 共存标,收回重排'
export const CI_YIELD_RECALL_MIN_INBOX_MS = 30_000
export function ciActiveMachines(machines: readonly MachineInput[]): ReadonlySet<string> {
  return new Set(machines.filter(machine => machine.fresh && machine.online && machine.ci === 'active')
    .map(machine => machine.name))
}

export type HandoffPoint = 'before-intent' | 'after-intent-ledger' | 'after-intent-file' | 'before-publish'
  | 'after-publish' | 'before-dispatched' | 'after-dispatched' | 'before-finished' | 'after-finished'
  | 'before-requeued' | 'after-requeued'
export interface HandoffContext {
  share: string; at: string; sources: SchedulerSources
  state: () => ProjectionState
  append: (draft: EventDraft) => LedgerEvent
  checkpoint?: (point: HandoffPoint, ticketId: string, attemptId: string) => void
  ciYieldRecall?: { activeMachines: ReadonlySet<string>; minInboxMs: number }
  agentProtocols?: ReadonlyMap<string, number | undefined>
  autoMinAgentProtocol?: number | null
  autoLaunch?: AutoLaunchReader
  autoPreflightIo?: AutoPreflightIo
  log?: (message: string) => void
}

export const AUTO_PREPARE_TIMEOUT_MS = 60 * 60_000
const unknownRefusalLogged = new Set<string>()

/**
 * 【SCHED-TRANSITION-RECOVERY-DUAL-STATE-EXIT】搬单撞上「同一张单同时出现在两个状态目录」时的统一处置。
 *
 * 执行机把单从一态搬进另一态是「先建目标态文件、再删源态文件」;共享盘删除挂起的那几秒里同一张单
 * 会同时出现在两个目录,几秒内自愈——是可分类的并发瞬态,不是故障。只认带类型的
 * LifecycleStateConflictError ⇒ 本拍放弃这一张单(不写流水、不落终态、不退出),下一拍按实物重看;
 * **其余任何错误原样上抛**,真故障一个字不放松(fail-closed 不放宽)。
 * 放弃只留一行日志,同一张单 60 秒最多一行——与派单员的跳拍日志同一把尺,免得每拍刷屏。
 * 返回 true = 已按双态放弃,调用方直接 return/continue;false = 不是双态,调用方照旧上抛。
 */
export const STATE_CONFLICT_LOG_INTERVAL_MS = 60_000
const stateConflictLoggedAt = new Map<string, number>()

/**
 * 【SCHED-TRANSITION-TAKEOVER-DUAL-STATE-0925】同一张单连续撞满这么多拍状态冲突(每拍至多记 1 次)
 * 就隔离。负责人 2026-10-08 拍板定为 3:双态/第三态瞬态一拍自愈是常态,连撞 3 拍说明这张单真被
 * 卡住了(共享盘挂了、有人手工动了状态文件),再无声放下去就是死循环。
 */
export const STATE_CONFLICT_ISOLATE_AFTER_TICKS = 3
/** 隔离期间交接事务重探这张单的最小间隔:10 分钟一次,冲突消失自动解除,天然不刷屏。 */
export const STATE_CONFLICT_ISOLATION_REPROBE_MS = 10 * 60_000

/** 连击记录:同一张单最近一次撞冲突落在哪一拍、连着撞了几拍。 */
interface StateConflictStreak { count: number; lastAt: string }
/** 连击与隔离全在派单员内存(口径见 abandonOnStateConflict 注释);按 submissionId 记,新尝试是新单号。 */
const stateConflictStreaks = new Map<string, StateConflictStreak>()
const stateConflictIsolations = new Map<string, { since: string; lastProbeAt: string; lastAlertAt: string }>()
/** 「拍」的边界由 handoffClusterTickets 推进;null = 本进程还没跑过任何一拍。 */
let stateConflictCurrentTick: string | null = null
let stateConflictPreviousTick: string | null = null

/**
 * 换拍:at 与记录的本拍不同 ⇒ 上一拍 = 原本拍、本拍 = at;同一拍重复调用什么都不做。
 * 换拍时清两笔账:① 连击表里 lastAt 既不是上一拍也不是本拍的记录——上一拍这张单没撞冲突,
 * 连击断了,删;② 隔离表里 lastProbeAt 恰是上一拍、且连击表里已经没有它的单——上一拍就是
 * 它的重探且没再撞冲突 ⇒ 移出隔离表,恢复每拍调度。票据已结束或已换新尝试的单不专门清理:
 * 隔离表按 submissionId 记,新尝试是新单号,旧条目永远轮不到。
 */
function beginStateConflictTick(at: string, log?: (message: string) => void): void {
  if (stateConflictCurrentTick === at) return
  stateConflictPreviousTick = stateConflictCurrentTick
  stateConflictCurrentTick = at
  for (const [id, streak] of stateConflictStreaks) {
    if (streak.lastAt !== stateConflictPreviousTick && streak.lastAt !== at) stateConflictStreaks.delete(id)
  }
  if (stateConflictPreviousTick !== null) {
    for (const [id, isolation] of stateConflictIsolations) {
      if (isolation.lastProbeAt === stateConflictPreviousTick && !stateConflictStreaks.has(id)) {
        stateConflictIsolations.delete(id)
        log?.(`[sched] ${id} 隔离解除:重探那一拍没再撞上状态冲突,恢复每拍调度`)
      }
    }
  }
}

/**
 * 【SCHED-TRANSITION-RECOVERY-DUAL-STATE-EXIT】搬单撞上「同一张单同时出现在两个状态目录」时的统一处置。
 *
 * 执行机把单从一态搬进另一态是「先建目标态文件、再删源态文件」;共享盘删除挂起的那几秒里同一张单
 * 会同时出现在两个目录,几秒内自愈——是可分类的并发瞬态,不是故障。只认带类型的
 * LifecycleStateConflictError(含子类 LifecycleTakeoverConflictError)⇒ 本拍放弃这一张单
 * (不写流水、不落终态、不退出),下一拍按实物重看;**其余任何错误原样上抛**,
 * 真故障一个字不放松(fail-closed 不放宽)。
 * 放弃只留一行日志,同一张单 60 秒最多一行——与派单员的跳拍日志同一把尺,免得每拍刷屏。
 * 返回 true = 已按双态放弃,调用方直接 return/continue;false = 不是双态,调用方照旧上抛。
 *
 * 【SCHED-TRANSITION-TAKEOVER-DUAL-STATE-0925 补口径:连击与隔离】
 * - 为什么是 3:双态/第三态瞬态一拍自愈是常态;连续 3 拍还撞说明这张单被卡死了,数是负责人
 *   2026-10-08 拍板的(STATE_CONFLICT_ISOLATE_AFTER_TICKS)。数满即隔离:交接事务整拍跳过它,
 *   每 10 分钟重探一次,冲突消失自动解除;派单员本身不退出、其余单照常调度。
 * - 为什么只在内存、不落账:隔离落账要新事件类型、改账本与投影 schema,超出本卡范围;重启
 *   重数是有意的——派单员重启本来就要等旧租约过期,重数 3 拍(6 秒)没有额外代价。
 * - 隔离只作用于交接事务的调度跳过:撤单收尾那条路照旧每拍尝试,撞上就放弃(不退出)。
 * - 告警频率:进入隔离那行每次进入恰一行(连击每拍至多记一次,数满才进);隔离中仍冲突那行
 *   按重探间隔限频——交接事务对隔离单 10 分钟才重探一次,但撤单收尾那条路(sched-daemon)
 *   不受隔离跳过约束、每拍都会走到,不按间隔限就会隔离后每 2 秒刷一行。告警文案里不出现
 *   「本拍放弃这一张单」字样——既有用例按这几个字数放弃日志,告警与放弃是两条账。
 */
export function abandonOnStateConflict(error: unknown, options: {
  submissionId: string
  at: string
  log?: (message: string) => void
}): boolean {
  if (!(error instanceof LifecycleStateConflictError)) return false
  const id = options.submissionId
  // 连击:同一拍多次放弃只算一拍(lastAt 相同 ⇒ 不加);否则 +1。恰好数满且尚未隔离 ⇒ 进隔离表并告警。
  const streak = stateConflictStreaks.get(id)
  if (streak === undefined || streak.lastAt !== options.at) {
    const count = (streak?.count ?? 0) + 1
    stateConflictStreaks.set(id, { count, lastAt: options.at })
    const isolation = stateConflictIsolations.get(id)
    if (isolation !== undefined) {
      // 已隔离的单又撞上:交接事务对隔离单 10 分钟才重探一次;但撤单收尾那条路(sched-daemon)
      // 不受隔离跳过约束、每拍都会走到 ⇒ 这行告警按重探间隔限频(打了就刷新 lastAlertAt),
      // 不然隔离后每 2 秒刷一行。不足间隔就静默:连击照常更新,隔离保持,返回值照常 true。
      if (Date.parse(options.at) - Date.parse(isolation.lastAlertAt) >= STATE_CONFLICT_ISOLATION_REPROBE_MS) {
        isolation.lastAlertAt = options.at
        options.log?.(`[sched][报警] ${id} 隔离中重探仍撞上状态冲突,继续隔离:${error.message}`)
      }
    } else if (count === STATE_CONFLICT_ISOLATE_AFTER_TICKS) {
      stateConflictIsolations.set(id, { since: options.at, lastProbeAt: options.at, lastAlertAt: options.at })
      options.log?.(`[sched][报警] ${id} 连续 ${STATE_CONFLICT_ISOLATE_AFTER_TICKS} 拍搬单撞上状态冲突,已隔离这张单:`
        + `派单员不退出、其余单照常调度;交接事务每 ${STATE_CONFLICT_ISOLATION_REPROBE_MS / 60_000} 分钟重探一次,`
        + `冲突消失自动解除;请人工核对共享盘该单的状态文件与迁移锁:${error.message}`)
    }
  }
  const nowMs = Date.parse(options.at)
  const key = `${id}:${error.message}`
  for (const [logged, loggedAt] of stateConflictLoggedAt) {
    if (nowMs - loggedAt >= STATE_CONFLICT_LOG_INTERVAL_MS) stateConflictLoggedAt.delete(logged)
  }
  if (!stateConflictLoggedAt.has(key)) {
    stateConflictLoggedAt.set(key, nowMs)
    // 接管支第三态与无锁支双态是两种瞬态,日志里分开说人话;其余文字与 60 秒限频照旧。
    const reason = error instanceof LifecycleTakeoverConflictError
      ? '接管过期迁移锁时撞上第三态(搬单尾巴或另一方刚动过这张单)'
      : '搬单撞上同一张单的双态(多半是执行机刚搬完、旧态文件还在等共享盘收走)'
    options.log?.(`[sched] ${id} 本拍放弃这一张单:${reason},下一拍按实物重看:${error.message}`)
  }
  return true
}
function startedCodeRef(ticket: TicketSnapshot): CodeRef {
  return ticket.request.execution === 'auto' ? ticket.attempts.at(-1)!.intent!.codeRef : ticket.request.codeRef
}

const NOT_STARTED_REASON_PREFIX = '开跑未确认:'
const NOT_STARTED_REQUEUE_LIMIT = 2

function validNotStarted(value: unknown, ticket: TicketSnapshot): value is { attemptId: string; state: 'granted'; waitedMs: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const mark = value as Record<string, unknown>
  return mark.attemptId === ticket.currentAttemptId && mark.state === 'granted'
    && Number.isSafeInteger(mark.waitedMs) && (mark.waitedMs as number) >= 0
}

/** 已存在必须逐字相同；不会用 replace 修复被改过的意图证据。 */
function persistIntent(context: HandoffContext, intent: DispatchIntent): void {
  const path = intentPath(context.share, intent.ticketId, intent.attemptId)
  const bytes = canonicalJson(intent)
  try {
    const old = readFileSync(path, 'utf8')
    if (old !== bytes) throw new Error('[sched] 派发意图文件与台账字节冲突')
    return
  } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
  try { publishLifecycleFileAtomically(path, bytes, 'create-only', schedPaths(context.share).staging) }
  catch (error) {
    if (!causedByCode(error, 'EEXIST') || readFileSync(path, 'utf8') !== bytes) throw error
  }
}

function finish(context: HandoffContext, ticket: TicketSnapshot, data: Extract<EventDraft, { type: 'finished' }>['data']): void {
  context.checkpoint?.('before-finished', ticket.ticketId, ticket.currentAttemptId)
  context.append({ at: context.at, type: 'finished', ticketId: ticket.ticketId, attemptId: ticket.currentAttemptId, data })
  context.checkpoint?.('after-finished', ticket.ticketId, ticket.currentAttemptId)
}

/**
 * 【SCHED-REQUEUE-IGNORES-CANCEL-1009】finished(terminal:false)+requeued 的撤单口径:
 * 撤单中的单子不再重排——重排出来的新执行带着撤单标记永远等不到授予(准入排除撤单票),
 * 也没人终结它(09-26 起两张单各挂 12 天),直接 finished(cancelled, terminal:true),
 * 原因沿用原值。返回 true = 已按撤单终局,调用方跳过 requeued;false = 已按原 data 落账,照旧重排。
 */
function finishForRequeue(context: HandoffContext, ticket: TicketSnapshot,
  data: Extract<EventDraft, { type: 'finished' }>['data']): boolean {
  if (!ticket.cancelRequested || data.terminal) { finish(context, ticket, data); return false }
  finish(context, ticket, { ...data, result: 'cancelled', terminal: true })
  return true
}

/** finished(false) 与 requeued 之间断电时，pendingQueue 是唯一续做凭据。rerun? 是补跑标记(d3)。 */
function requeue(context: HandoffContext, ticket: TicketSnapshot, rerun?: RerunEventData): void {
  const active = ticket.attempts.at(-1)!
  if (!active.result || !ticket.pendingQueue) throw new Error('[sched] 重排缺旧执行结束证据')
  context.checkpoint?.('before-requeued', ticket.ticketId, active.attemptId)
  context.append({ at: context.at, type: 'requeued', ticketId: ticket.ticketId, attemptId: active.attemptId,
    data: { nextAttemptId: nextAttemptId(active.attemptId), reason: active.result.reason, atHead: true,
      ...(rerun === undefined ? {} : { rerun }) } })
  context.checkpoint?.('after-requeued', ticket.ticketId, active.attemptId)
}

function requeueAuto(context: HandoffContext, ticket: TicketSnapshot, options: {
  mode: 'pin' | 'retry'; code: string; detail: string; result: 'handoff-interrupted' | 'failed';
  exitCode?: number; logFile?: string
}): void {
  const reason = formatAutoRequeueReason(options.mode, options.code, options.detail)
  // 撤单中的不重排(口径见 finishForRequeue),未撤单的行为一字不变。
  if (finishForRequeue(context, ticket, { result: options.result, terminal: false, reason,
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
    ...(options.logFile === undefined ? {} : { logFile: options.logFile }) })) return
  requeue(context, context.state().tickets[ticket.ticketId]!)
  if (options.mode === 'pin') {
    const fresh = context.state().tickets[ticket.ticketId]!
    context.append({ at: context.at, type: 'placement-checked', ticketId: ticket.ticketId,
      attemptId: fresh.currentAttemptId, data: autoPinData(reason) })
  }
  context.log?.(`[sched] ${ticket.ticketId} auto 回排:${options.mode}:${options.code}`)
}

function autoPreflight(context: HandoffContext, ticket: TicketSnapshot) {
  return preflightAutoHandoff({ share: context.share, agentProtocols: context.agentProtocols,
    autoMinAgentProtocol: context.autoMinAgentProtocol, io: context.autoPreflightIo }, ticket)
}

function dispatched(context: HandoffContext, ticket: TicketSnapshot, intent: DispatchIntent): void {
  if (ticket.attempts.at(-1)!.dispatchedAt !== null) return
  context.checkpoint?.('before-dispatched', ticket.ticketId, intent.attemptId)
  context.append({ at: context.at, type: 'dispatched', ticketId: ticket.ticketId, attemptId: intent.attemptId,
    data: { submissionId: intent.submissionId } })
  context.checkpoint?.('after-dispatched', ticket.ticketId, intent.attemptId)
}

function reconcileRecord(context: HandoffContext, id: string, record: LifecycleStateRecord): void {
  let ticket = context.state().tickets[id]!
  if (record.state === 'inbox') {
    if (ticket.cancelRequested) {
      // 先落标记，覆盖代理在迁移前抢到 running 的窗口；竞争迁移失败则由下一实例按实物续做。
      writeTicketSnapshot(context.share, ticket)
      try {
        transitionLifecycleJob({ share: context.share, epoch: record.epoch, machine: record.machine,
          submissionId: record.submissionId, from: 'inbox', to: 'quarantine', result: { ok: false, reason: '调度撤单' }, sources: context.sources })
      } catch (error) {
        // 同单双态(执行机刚搬完、旧态文件删除挂起)只放弃这一张单本拍不动,下一拍按实物重看。
        if (abandonOnStateConflict(error, { submissionId: record.submissionId, at: context.at, log: context.log })) return
        throw error
      }
      finish(context, ticket, { result: 'cancelled', terminal: true, reason: '调度撤单' })
      return
    }
    const active = ticket.attempts.at(-1)
    if (context.ciYieldRecall && ticket.request.execution === 'cluster' && ticket.endedAt === null
      && ticket.state === 'granted' && active !== undefined && active.attemptId === ticket.currentAttemptId
      && active.permit !== null && active.permit.ciAware !== true
      && context.ciYieldRecall.activeMachines.has(active.permit.machine)
      && active.dispatchedAt !== null
      && Date.parse(context.at) - Date.parse(active.dispatchedAt) >= context.ciYieldRecall.minInboxMs) {
      try {
        transitionLifecycleJob({ share: context.share, epoch: record.epoch, machine: record.machine,
          submissionId: record.submissionId, from: 'inbox', to: 'quarantine',
          result: { ok: false, reason: CI_YIELD_RECALL_REASON }, sources: context.sources })
      } catch (error) {
        context.log?.(`[sched] 收回 ${id} 未成(本拍放弃,下拍按实物重看):${errorMessage(error)}`)
        return
      }
      if (!finishForRequeue(context, ticket, { result: 'handoff-interrupted', terminal: false, reason: CI_YIELD_RECALL_REASON })) requeue(context, context.state().tickets[id]!)
    }
    return
  }
  if (record.state === 'running') {
    if (ticket.cancelRequested) writeTicketSnapshot(context.share, ticket)
    if (ticket.state === 'granted') context.append({ at: context.at, type: 'started', ticketId: id,
      attemptId: ticket.currentAttemptId, data: { codeRef: startedCodeRef(ticket) } })
    ticket = context.state().tickets[id]!
    if (ticket.request.execution === 'auto' && !ticket.cancelRequested && ticket.state === 'running' && context.autoLaunch) {
      const active = ticket.attempts.at(-1)!
      if (active.startedAt && context.autoLaunch.effectiveLaunchAt(ticket, context.at) === undefined
        && Date.parse(context.at) - Date.parse(active.startedAt) >= AUTO_PREPARE_TIMEOUT_MS) {
        requeueAuto(context, ticket, { mode: 'pin', code: 'prepare-timeout',
          detail: `领单 ${Math.floor((Date.parse(context.at) - Date.parse(active.startedAt)) / 60_000)} 分钟仍未开跑`,
          result: 'handoff-interrupted' })
      }
    }
    return
  }
  const result = record.result!
  const reason = typeof result.reason === 'string' && result.reason ? result.reason : `${record.state} terminal`
  if (ticket.cancelRequested && ['调度撤单', '开跑前发现已撤单'].includes(reason)) {
    finish(context, ticket, { result: 'cancelled', terminal: true, reason })
    return
  }
  if (record.state === 'quarantine' && reason === CI_YIELD_RECALL_REASON && ticket.state === 'granted') {
    if (!finishForRequeue(context, ticket, { result: 'handoff-interrupted', terminal: false, reason })) requeue(context, context.state().tickets[id]!)
    return
  }
  const exitCode = Number.isSafeInteger(result.exitCode) ? result.exitCode as number : 1
  const logFile = handoffLogPath(result.logFile)
  // 重启是已确认旧树退出的专门恢复路径；普通失败不自动重试。
  if (record.state === 'failed' && reason === '执行机重启') {
    if (!finishForRequeue(context, ticket, { result: 'failed', terminal: false, reason, exitCode,
      ...(logFile === undefined ? {} : { logFile }) })) requeue(context, context.state().tickets[id]!)
    return
  }
  if (record.state === 'failed' && validNotStarted(result.notStarted, ticket)) {
    if (ticket.cancelRequested) {
      finish(context, ticket, { result: 'cancelled', terminal: true, reason: '开跑前发现已撤单' })
      return
    }
    const previousReturns = ticket.attempts.filter(attempt => attempt.result?.outcome === 'handoff-interrupted'
      && attempt.result.reason.startsWith(NOT_STARTED_REASON_PREFIX)).length
    if (previousReturns < NOT_STARTED_REQUEUE_LIMIT) {
      finish(context, ticket, { result: 'handoff-interrupted', terminal: false,
        reason: `开跑未确认:许可已授予但执行端等 ${result.notStarted.waitedMs / 1000} 秒仍未见开跑确认,未拉起命令、零用例未跑;退回排队队首重来,不计失败(第 ${previousReturns + 1} 次,上限 2 次)`,
        ...(logFile === undefined ? {} : { logFile }) })
      requeue(context, context.state().tickets[id]!)
      return
    }
    finish(context, ticket, { result: 'voided', terminal: true,
      reason: '开跑未确认:已退回排队 2 次仍未等到开跑确认,本单作废(零用例未跑,不是测试红;请查派单员是否停摆、交接是否卡住)',
      ...(logFile === undefined ? {} : { logFile }) })
    return
  }
  if (ticket.request.execution === 'auto' && record.state === 'failed' && result.exitCode === 2
    && typeof result.refused === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(result.refused)) {
    if (ticket.cancelRequested) {
      finish(context, ticket, { result: 'cancelled', terminal: true, reason: '调度撤单' })
      return
    }
    const code = result.refused
    if (isUnknownAutoRefusal(code) && !unknownRefusalLogged.has(code)) {
      unknownRefusalLogged.add(code); context.log?.(`[sched] 未知拒跑码:${code}`)
    }
    const disposition = autoRefusalDisposition(code)
    if (disposition !== 'terminal') {
      const saturated = disposition === 'retry' && autoRetryCount(ticket) >= AUTO_REQUEUE_SAME_MAX
      requeueAuto(context, ticket, { mode: saturated ? 'pin' : disposition, code,
        detail: saturated ? `${reason};回排不换机已满 2 次` : reason,
        result: 'failed', exitCode: 2, logFile })
      return
    }
  }
  // d3 补跑(UDQ-T4B):普通失败且执行端带来合法补跑计划、作业类型/类别策略开了闸、
  // 且这张单还没用过补跑预算,就按 terminal:false 结束本次执行,再带身份选择重排一次。
  // 队列规则照常走 atHead 重排,不插队也不新开通道。
  const plan = validateRerunPlan(result.rerunPlan)
  if (record.state === 'failed' && plan !== undefined && shouldRerun(context.state().tickets[id]!, plan)) {
    const rerunReason = `暂停误伤超时:${plan.eligible.length} 条用例在确认挂起期间超时,按 d3 补跑一次(每单预算 1 次)`
    if (finishForRequeue(context, ticket, { result: 'failed', terminal: false, reason: rerunReason, exitCode,
      ...(logFile === undefined ? {} : { logFile }) })) return
    requeue(context, context.state().tickets[id]!, {
      reason: rerunReason, retainedFailures: plan.retainedFailures,
      selection: plan.eligible.map(item => ({ identity: item.identity, sourceSha256: item.sourceSha256 })),
    })
    return
  }
  // 补跑执行的终局:补跑绿不得冒充首跑绿——理由必须写明这是补跑;首跑保留的旧失败同样显性失败。
  const rerun = rerunSelectionOf(context.state().tickets[id]!)
  if (rerun !== undefined && ['done', 'failed'].includes(record.state)) {
    const rerunPassed = record.state === 'done' && result.exitCode === 0
    // 两拍间可能已跑完；补 started 保持 granted→running→终态 的投影顺序。
    if (rerunPassed && ticket.state === 'granted') {
      context.append({ at: context.at, type: 'started', ticketId: id, attemptId: ticket.currentAttemptId,
        data: { codeRef: startedCodeRef(ticket) } })
      ticket = context.state().tickets[id]!
    }
    if (rerunPassed && rerun.retainedFailures === 0) {
      finish(context, ticket, { result: 'passed', terminal: true,
        reason: `补跑(第 1 次,共 1 次预算)通过:首跑 ${rerun.selection.length} 条暂停误伤超时用例已按身份补跑`,
        exitCode: 0, ...(logFile === undefined ? {} : { logFile }) })
      return
    }
    if (rerunPassed) {
      finish(context, ticket, { result: 'failed', terminal: true,
        reason: `补跑的 ${rerun.selection.length} 条超时用例已通过,但首跑另有 ${rerun.retainedFailures} 条失败原样保留`,
        exitCode: 1, ...(logFile === undefined ? {} : { logFile }) })
      return
    }
    finish(context, ticket, { result: 'failed', terminal: true,
      reason: `补跑(第 1 次,共 1 次预算)仍失败:${reason}`,
      exitCode: exitCode === 0 ? 1 : exitCode, ...(logFile === undefined ? {} : { logFile }) })
    return
  }
  const passed = record.state === 'done' && result.exitCode === 0
  // 两拍间可能已跑完；补 started 保持 granted→running→passed 的投影顺序。
  if (passed && ticket.state === 'granted') {
    context.append({ at: context.at, type: 'started', ticketId: id, attemptId: ticket.currentAttemptId,
      data: { codeRef: startedCodeRef(ticket) } })
    ticket = context.state().tickets[id]!
  }
  // 补跑计划带了备注(如「低速期间超时…未补跑」)而整单仍失败时,备注随失败理由一起留档(全角括号包裹)。
  const planNote = plan !== undefined && plan.notes.length > 0 && !passed
    ? `（${plan.notes.join(';')}）` : ''
  finish(context, ticket, { result: passed ? 'passed' : 'failed', terminal: true, reason: `${reason}${planNote}`,
    exitCode: passed ? 0 : exitCode === 0 ? 1 : exitCode, ...(logFile === undefined ? {} : { logFile }) })
}

/**
 * 停在 paused/slow 的集群单按作业侧终态落账，口径与 running 单完全一致(含撤单与执行机重启分支)。
 * 只做终态回填：不发布、不接管租约、不重排；absent/claim-only/transition 与撤单/硬超时
 * 一律留给 sched-daemon.remoteKillClusterTickets。
 */
function settleSuspendedFromJobSide(context: HandoffContext, ticket: TicketSnapshot): void {
  const intent = ticket.attempts.at(-1)!.intent
  if (!intent) return
  let observation: ReturnType<typeof observeHandoff>
  // 观察不加闸(SCHED-PAYLOAD-FIELD-PROTOCOL-GATE 第三轮修正):在飞实物按发布时的读数落档,
  // 读数现在可能更低,收窄「期望」只会误判漂移;旧形状对账会认出任何更短的实物。
  try { observation = observeHandoff(context.share, ticket, intent, context.at) }
  catch (error) {
    // 活迁移锁只代表执行机正在搬运；本拍跳过，不接管任何租约。
    if (error instanceof ActiveTransitionLeaseError) return
    throw error
  }
  if (observation.kind !== 'record') return
  // running/inbox 还没有可落的终态；absent/claim-only 的证据规则归撤单/硬超时路径，这里不替它判断。
  if (observation.record.state === 'running' || observation.record.state === 'inbox') return
  dispatched(context, ticket, intent)
  reconcileRecord(context, ticket.ticketId, observation.record)
}

/** 每拍授予后、快照前调用；包括已投递执行的后续结果，无本机单子副作用。 */
export function handoffClusterTickets(context: HandoffContext): void {
  // 一进函数先推进「拍」的边界:连击清洗、隔离解除都以拍为单位(口径见 beginStateConflictTick)。
  beginStateConflictTick(context.at, context.log)
  for (const id of Object.keys(context.state().tickets).sort()) {
    let ticket = context.state().tickets[id]!
    if ((ticket.request.execution !== 'cluster' && !isAutoHandoffTicket(ticket)) || ticket.endedAt !== null) continue
    if (ticket.pendingQueue) {
      // 撤单中的断点不重排(SCHED-REQUEUE-IGNORES-CANCEL-1009):旧执行已 finished、不能再结束一次,
      // 先续完已批准的重排再直接终局排队身份——与撤单指令、等待心跳判死同一套事件,兜底原因落账。
      if (ticket.cancelRequested) {
        finishQueuedTicket(context.append, ticket, context.at, QUEUED_CANCEL_BACKSTOP_REASON)
        continue
      }
      const reason = ticket.attempts.at(-1)?.result?.reason
      requeue(context, ticket)
      if (ticket.request.execution === 'auto' && reason?.startsWith('handoff-pin:')) {
        const fresh = context.state().tickets[id]!
        context.append({ at: context.at, type: 'placement-checked', ticketId: id,
          attemptId: fresh.currentAttemptId, data: autoPinData(reason) })
      }
      continue
    }
    if (ticket.state === 'queued' && ticket.cancelRequested) {
      finish(context, ticket, { result: 'cancelled', terminal: true, reason: '撤单后不再重发' }); continue
    }
    // 【SCHED-TRANSITION-TAKEOVER-DUAL-STATE-0925】隔离中的单:距上次重探不足重探间隔就整拍
    // 不碰(不观察、不搬运、不落账、不打日志),给它时间自愈、也给共享盘减负;到时间了这一拍
    // 就是重探,更新 lastProbeAt 后照常往下走。撤单收尾那条路(sched-daemon)不受此影响。
    const isolatedId = ticket.attempts.at(-1)?.intent?.submissionId
    if (isolatedId !== undefined) {
      const isolation = stateConflictIsolations.get(isolatedId)
      if (isolation !== undefined) {
        if (Date.parse(context.at) - Date.parse(isolation.lastProbeAt) < STATE_CONFLICT_ISOLATION_REPROBE_MS) continue
        isolation.lastProbeAt = context.at
      }
    }
    if (ticket.state === 'paused' || ticket.state === 'slow') { settleSuspendedFromJobSide(context, ticket); continue }
    if (!['granted', 'running'].includes(ticket.state)) continue
    let intent = ticket.attempts.at(-1)!.intent
    let freshIntent = false
    if (!intent) {
      if (ticket.state !== 'granted') throw new Error('[sched] 集群运行单缺派发意图')
      if (ticket.request.execution === 'auto') {
        if (ticket.cancelRequested) {
          finish(context, ticket, { result: 'cancelled', terminal: true, reason: '撤单后不再投递' })
          continue
        }
        const preflight = autoPreflight(context, ticket)
        if (!preflight.ok) {
          requeueAuto(context, ticket, { mode: 'pin', code: preflight.code,
            detail: preflight.detail, result: 'handoff-interrupted' })
          continue
        }
      } else clusterJobForTicket(ticket)
      context.checkpoint?.('before-intent', id, ticket.currentAttemptId)
      intent = { ticketId: id, attemptId: ticket.currentAttemptId, submissionId: submissionId(id, ticket.currentAttemptId),
        machine: ticket.attempts.at(-1)!.permit!.machine,
        codeRef: ticket.request.execution === 'auto' ? autoIntentCodeRef(ticket) : ticket.request.codeRef,
        createdAt: context.at }
      context.append({ at: context.at, type: 'dispatch-intent', ticketId: id, attemptId: ticket.currentAttemptId, data: { intent } })
      freshIntent = true
      context.checkpoint?.('after-intent-ledger', id, ticket.currentAttemptId)
      ticket = context.state().tickets[id]!
    }
    persistIntent(context, intent)
    context.checkpoint?.('after-intent-file', id, intent.attemptId)
    if (ticket.cancelRequested) writeTicketSnapshot(context.share, ticket)
    let observation: ReturnType<typeof observeHandoff>
    // 闸(SCHED-PAYLOAD-FIELD-PROTOCOL-GATE)只管「第一次发布」这一件事:observation 与撤单租约
    // 对账一律**不加闸**、按全形状重建期望,再交给 legacyHandoffIdentities 认「更短」的在飞实物。
    // 协议号读数随时会抖(执行机重启、心跳缺失 ⇒ 按闸保守省略);闸若也收窄观察,重建期望会比
    // 发布时的实物更短,旧形状只会往更短摘、认不出更长的实物,必判漂移把派单员整个拽退出。
    const gate = payloadProtocolGate(context.agentProtocols, intent.machine)
    try { observation = observeHandoff(context.share, ticket, intent, context.at) }
    catch (error) {
      if (!(error instanceof ActiveTransitionLeaseError) || error.isLiveAt(Date.parse(context.at))
        || error.lease.from !== 'inbox' || error.lease.to !== 'quarantine'
        || !((ticket.cancelRequested && error.lease.result?.reason === '调度撤单')
          || error.lease.result?.reason === CI_YIELD_RECALL_REASON)) throw error
      const lease = error.lease
      // 仅接续本事务留下的隔离搬运，其他迁移仍由其执行者恢复。
      // 换代瞬间在飞的旧单,租约里的身份按旧载荷形状(无 queueRank/ciAware)算:重建期望同样**不加闸**
      // 按全形状算,旧形状候选由 legacyHandoffIdentities 从全形状里摘——读数怎么抖都不影响对账。
      const publication = handoffPublication(context.share, ticket, intent)
      const expected = reconcileLegacyClaimIdentities(lease.identity,
        buildLifecycleIdentity({ ...publication, epoch: lease.identity.epoch }),
        legacyHandoffIdentities(publication, lease.identity.epoch))
      assertSameIdentity(lease.identity, expected, 'sched cancellation lease')
      try {
        transitionLifecycleJob({ share: context.share, epoch: lease.identity.epoch, machine: intent.machine,
          submissionId: intent.submissionId, from: lease.from, to: lease.to, metadata: lease.metadata,
          result: lease.result, sources: context.sources })
      } catch (error) {
        // 恢复接续时撞上同单双态同样只放弃这一张单:锁已不在了,实物变成两态,下一拍按实物重看。
        if (abandonOnStateConflict(error, { submissionId: intent.submissionId, at: context.at, log: context.log })) continue
        throw error
      }
      observation = observeHandoff(context.share, ticket, intent, context.at)
    }
    if (observation.kind === 'transition') continue
    if ((observation.kind === 'absent' || observation.kind === 'claim-only') && ticket.attempts.at(-1)!.dispatchedAt !== null) {
      throw new Error('[sched] 已确认投递的工单实物消失，不能证明未开跑，禁止换号重发')
    }
    if (observation.kind === 'claim-only') {
      if (!finishForRequeue(context, ticket, { result: 'handoff-interrupted', terminal: false,
        reason: '交接中断:只有永久 claim，五态皆无，旧提交永远不能开跑' })) requeue(context, context.state().tickets[id]!)
    } else if (observation.kind === 'absent') {
      if (ticket.request.execution === 'auto' && !freshIntent) {
        const preflight = autoPreflight(context, ticket)
        if (!preflight.ok) {
          requeueAuto(context, ticket, { mode: 'pin', code: preflight.code,
            detail: preflight.detail, result: 'handoff-interrupted' })
          continue
        }
      }
      context.checkpoint?.('before-publish', id, intent.attemptId)
      publishLifecycleJob({ ...handoffPublication(context.share, ticket, intent, gate), sources: context.sources })
      context.checkpoint?.('after-publish', id, intent.attemptId)
      dispatched(context, ticket, intent)
    } else {
      dispatched(context, ticket, intent)
      reconcileRecord(context, id, observation.record)
    }
  }
}
