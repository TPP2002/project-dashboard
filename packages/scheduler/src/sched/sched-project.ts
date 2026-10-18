import {
  assertTransition, canonicalJson, CATEGORY_POLICY, contentHash, deriveTicketId, eventWithoutChecksum, isoTime,
  nextAttemptId, PAUSE_REASONS, SUBMIT_CLOCK_SKEW_TOLERANCE_MS, submissionId, TERMINAL_STATES, validateLedgerEvent, ledgerRecordTime,
  type AttemptSnapshot, type CommandReceipt, type LedgerCursor, type LedgerEvent,
  type PauseReason, type SchedulerCommand, type SubmissionReceipt, type TicketSnapshot, type TicketState,
  type Timing, type TimingPhase, type TimingSegment,
} from './sched-contract'
import { accountConfirmedSuspension } from './sched-suspend-accounting'
import { ELASTIC_CAP_CORES, elasticReplayAllowed } from './sched-elastic'

export interface ProjectionState {
  cursor: LedgerCursor
  /** 只有回拨流水出现后才记录；不能用未来的文件游标做实际作业计时。 */
  observedAt?: string
  tickets: Record<string, TicketSnapshot>
  // 键前缀防止合法 SAFE_SEGMENT（如 constructor）碰到对象原型成员。
  submissions: Record<string, SubmissionReceipt & { status: 'accepted' }>
  rejections: Record<string, SubmissionReceipt & { status: 'rejected' }>
  commands: Record<string, { request: SchedulerCommand; receipt: CommandReceipt | null }>
  reservations: Record<string, number>
  reservationUntil: Record<string, string | null>
  ownerHolds: Record<string, boolean>
  ciBorrows?: Record<string, { ticketId: string; attemptId: string; machine: string; lentAt: string; heldAt: string | null }>
  globalTimeline: LedgerEvent[]
}
export function submissionKey(key: string): string { return `key:${key}` }
/** 执行身份按当前 attempt 判断；旧执行曾派集群不影响下一执行的归属。 */
export function isLocalAttempt(ticket: TicketSnapshot): boolean {
  return ticket.request.execution !== 'cluster'
    && !ticket.timeline.some(event => event.type === 'dispatch-intent' && event.attemptId === ticket.currentAttemptId)
}
export function rejectionKey(key: string, hash: string): string { return contentHash([key, hash]) }
export function emptyProjection(): ProjectionState {
  return { cursor: { seq: 0, at: null, sha256: null }, tickets: {}, submissions: {}, rejections: {}, commands: {}, reservations: {}, reservationUntil: {}, ownerHolds: {}, globalTimeline: [] }
}
export function emptyTiming(): Timing { return { queuedMs: 0, runningMs: 0, pausedMs: 0, slowMs: 0 } }
export function totalTiming(timing: Timing): number { return timing.queuedMs + timing.runningMs + timing.pausedMs + timing.slowMs }
function attempt(id: string, at: string): AttemptSnapshot {
  return { attemptId: id, queuedAt: at, startedAt: null, endedAt: null, grantedCores: 0, permit: null, intent: null, dispatchedAt: null, codeRef: null, result: null, timing: emptyTiming(), segments: [] }
}
function move(ticket: TicketSnapshot, state: TicketState): void {
  assertTransition(ticket.state, state)
  ticket.state = state
}
function requireState(ticket: TicketSnapshot, ...states: TicketState[]): void {
  if (!states.includes(ticket.state)) throw new Error(`[sched] ${ticket.ticketId} 的 ${ticket.state} 状态不能应用此事件`)
}
function current(ticket: TicketSnapshot): AttemptSnapshot {
  const found = ticket.attempts.at(-1)
  if (!found || found.attemptId !== ticket.currentAttemptId) throw new Error('[sched] 当前执行号不一致')
  return found
}
function addInterval(target: { timing: Timing; segments: TimingSegment[] }, phase: TimingPhase, from: string, to: string): void {
  const milliseconds = Date.parse(to) - Date.parse(from)
  if (milliseconds < 0) throw new Error('[sched] 计时时间倒退')
  if (milliseconds === 0) return
  target.timing[phase] += milliseconds
  const previous = target.segments.at(-1)
  // 合并相邻同类段，增量分批与整本一次投影的 JSON 必须相同。
  if (previous?.phase === phase && previous.to === from) { previous.to = to; previous.milliseconds += milliseconds }
  else target.segments.push({ phase, from, to, milliseconds })
}
function advance(ticket: TicketSnapshot, at: string): void {
  if (ticket.endedAt !== null) return
  const phase: TimingPhase = ticket.state === 'running' ? 'runningMs' : ticket.state === 'paused' ? 'pausedMs' : ticket.state === 'slow' ? 'slowMs' : 'queuedMs'
  const target = ticket.pendingQueue ?? current(ticket)
  addInterval(target, phase, ticket.accountedAt, at)
  ticket.timing[phase] += Date.parse(at) - Date.parse(ticket.accountedAt)
  ticket.accountedAt = at
  if (!ticket.pendingQueue) accountConfirmedSuspension(ticket, current(ticket), at)
}
function pauseSet(ticket: TicketSnapshot, reasons: PauseReason[]): void {
  ticket.pauseReasons = PAUSE_REASONS.filter(reason => reasons.includes(reason))
}

/** 内部写屏障；公共入口已经拥有整棵树，不需要屏障。状态机仅在本模块维护。 */
export interface ProjectionOwnership {
  ticket(id: string): void
  command(key: string): void
  borrow(key: string): void
}

function applyGlobal(state: ProjectionState, event: LedgerEvent, own?: ProjectionOwnership): boolean {
  switch (event.type) {
    case 'rejected-submission': {
      const data = event.data
      state.rejections[rejectionKey(data.idempotencyKey, data.contentHash)] = { ...data, status: 'rejected', at: event.at }
      break
    }
    case 'command-received': {
      const key = submissionKey(event.data.command.commandId)
      if (state.commands[key]) throw new Error('[sched] 指令重复登记')
      state.commands[key] = { request: event.data.command, receipt: null }
      break
    }
    case 'command-executed':
    case 'command-rejected': {
      own?.command(submissionKey(event.data.receipt.commandId))
      const entry = state.commands[submissionKey(event.data.receipt.commandId)]
      if (!entry || entry.receipt) throw new Error('[sched] 指令未登记或已有回执')
      entry.receipt = event.data.receipt
      if (event.type === 'command-executed' && entry.request.kind === 'jump-queue') {
        own?.ticket(entry.request.data.ticketId)
        const ticket = state.tickets[entry.request.data.ticketId]
        if (!ticket) throw new Error('[sched] 插队单子不存在')
        requireState(ticket, 'queued', 'unsatisfiable')
        ticket.band = 0
      }
      if (event.type === 'command-executed' && (entry.request.kind === 'pause-one' || entry.request.kind === 'resume-one')) {
        own?.ticket(entry.request.data.ticketId)
        const ticket = state.tickets[entry.request.data.ticketId]
        if (!ticket) throw new Error('[sched] 人工暂停目标不存在')
        ticket.manualPause = entry.request.kind === 'pause-one'
        if (!ticket.manualPause && ['queued', 'unsatisfiable'].includes(ticket.state)) {
          pauseSet(ticket, ticket.pauseReasons.filter(reason => reason !== 'manual'))
        }
      }
      break
    }
    case 'reservation-changed': {
      const key = submissionKey(event.data.machine)
      state.reservations[key] = event.data.requestedCores
      // 不带期限的修改也必须落 null，不能沿用上一档留下的自动取消时刻。
      state.reservationUntil[key] = event.data.untilAt ?? null
      break
    }
    case 'owner-hold-changed':
      state.ownerHolds[submissionKey(event.data.machine)] = event.data.held
      for (const previous of Object.values(state.tickets)) if (previous.endedAt === null
        && current(previous).permit?.machine === event.data.machine) {
        own?.ticket(previous.ticketId)
        const ticket = state.tickets[previous.ticketId]!
        const borrowed = state.ciBorrows?.[submissionKey(ticket.ticketId)]
        ticket.ownerHold = event.data.held || (borrowed?.attemptId === ticket.currentAttemptId && borrowed.heldAt !== null)
        ticket.lastSeq = event.seq; ticket.updatedAt = event.at
      }
      break
    case 'ci-borrow-changed': {
      const { ticketId, attemptId, machine, action } = event.data
      if (state.tickets[ticketId]?.endedAt === null) own?.ticket(ticketId)
      const ticket = state.tickets[ticketId]
      const attempt = ticket?.attempts.at(-1)
      if (!ticket || ticket.endedAt !== null || attempt?.attemptId !== ticket.currentAttemptId
        || attemptId !== ticket.currentAttemptId || attempt.permit?.machine !== machine) break
      const key = submissionKey(ticketId)
      if (action === 'lent') {
        if (!['granted', 'running', 'paused', 'slow'].includes(ticket.state)) break
        const entries = state.ciBorrows ??= {}
        entries[key] = { ticketId, attemptId, machine, lentAt: event.at, heldAt: null }
        break
      }
      own?.borrow(key)
      const borrowed = state.ciBorrows?.[key]
      if (!borrowed || borrowed.attemptId !== attemptId || borrowed.machine !== machine) break
      if (action === 'hold') {
        if (borrowed.heldAt !== null) break
        borrowed.heldAt = event.at
        ticket.ownerHold = true
      } else {
        if (borrowed.heldAt === null) break
        borrowed.heldAt = null
        ticket.ownerHold = state.ownerHolds[submissionKey(machine)] ?? false
      }
      ticket.lastSeq = event.seq; ticket.updatedAt = event.at
      break
    }
    case 'log-retention-run': break
    default: return false
  }
  if (event.type === 'command-received' || event.type === 'command-executed' || event.type === 'command-rejected') {
    const command = event.type === 'command-received' ? event.data.command : state.commands[submissionKey(event.data.receipt.commandId)]!.request
    if ('ticketId' in command.data) {
      const ticket = state.tickets[command.data.ticketId]
      // 无效目标也能收到拒绝回执；存在的目标保留人工操作完整流水，供直接读快照的看板使用。
      if (ticket && ticket.endedAt === null) {
        own?.ticket(ticket.ticketId)
        const target = state.tickets[ticket.ticketId]!
        target.lastSeq = event.seq; target.updatedAt = event.at; target.timeline.push(event)
      }
    }
  }
  state.globalTimeline.push(event)
  return true
}

function applyTicket(state: ProjectionState, event: LedgerEvent, own?: ProjectionOwnership): void {
  if (event.type === 'submitted') {
    const { request, contentHash: hash } = event.data
    if (event.ticketId !== deriveTicketId(request.project, request.idempotencyKey) || event.attemptId !== 'a1'
      || hash !== contentHash(request)) throw new Error('[sched] 挂号身份/哈希/时间不匹配')
    const clockSkewMs = Date.parse(request.createdAt) - Date.parse(event.at)
    if (clockSkewMs > SUBMIT_CLOCK_SKEW_TOLERANCE_MS) throw new Error(`[sched] 挂号时间超前 ${clockSkewMs} 毫秒，超过跨机时钟偏差容忍值 ${SUBMIT_CLOCK_SKEW_TOLERANCE_MS} 毫秒`)
    // 只调整投影的起点，不改请求及其哈希；客户端略快也不能让排队/施工计时出现负数。
    const createdAt = request.createdAt < event.at ? request.createdAt : event.at
    const key = submissionKey(request.idempotencyKey)
    if (state.submissions[key] || state.tickets[event.ticketId]) throw new Error('[sched] 重复 submitted')
    const registerOnly = CATEGORY_POLICY[request.category].registerOnly
    const first = attempt('a1', createdAt)
    if (registerOnly) first.startedAt = createdAt
    state.tickets[event.ticketId] = {
      formatVersion: 1, ticketId: event.ticketId, request, contentHash: hash, state: registerOnly ? 'running' : 'queued',
      registerOnly, pauseReasons: [], cancelRequested: false, currentAttemptId: 'a1', attempts: [first], band: 1,
      queuedAt: createdAt, createdAt, updatedAt: event.at, endedAt: null, unsatisfiableReason: null,
      accountedAt: createdAt, pendingQueue: null, timing: emptyTiming(), lastSeq: event.seq, timeline: [event],
    }
    state.submissions[key] = { status: 'accepted', idempotencyKey: request.idempotencyKey, contentHash: hash, ticketId: event.ticketId, at: event.at }
    return
  }
  if (event.ticketId === undefined) throw new Error('[sched] 票据事件缺单号')
  own?.ticket(event.ticketId)
  const ticket = state.tickets[event.ticketId]
  if (!ticket || ticket.endedAt !== null || event.attemptId !== ticket.currentAttemptId) throw new Error('[sched] 单子不存在、已结束或执行号过期')
  advance(ticket, event.at)
  const active = current(ticket)
  switch (event.type) {
    case 'granted': {
      const permit = event.data.permit
      if (ticket.request.execution === 'auto' && permit.machine !== ticket.request.origin && ticket.placement?.portable !== true) {
        throw new Error('[sched] auto 单未判可搬就授予别的机器')
      }
      // 弹性授予写入只追加台账后，回滚只许关掉多给，不许把重放校验改回等式。
      if (ticket.registerOnly || active.result || ticket.pauseReasons.length || permit.ticketId !== ticket.ticketId
        || permit.attemptId !== active.attemptId || permit.category !== ticket.request.category
        || permit.grantedCores < ticket.request.requestedCores
        || (permit.grantedCores > ticket.request.requestedCores
          && !(elasticReplayAllowed(ticket.request) && permit.grantedCores <= ELASTIC_CAP_CORES))
        || !ticket.request.allowedMachines.includes(permit.machine)
        // 长期占用单(SCHED-MR5-RESIDENT-LEASE-0924)：标记两侧必须一致，核数恰等于申请(无弹性)——
        // 记多少核就从这台机器扣多少核，多给少给都会让看板上的账与实物对不上。
        || (permit.resident === true) !== (ticket.request.resident === true)
        || (ticket.request.resident === true && permit.grantedCores !== ticket.request.requestedCores)
        || permit.issuedAt !== event.at) throw new Error('[sched] 授予与申请身份不符')
      move(ticket, 'granted'); active.permit = permit; active.grantedCores = permit.grantedCores
      ticket.ownerHold = state.ownerHolds[submissionKey(permit.machine)] ?? false
      break
    }
    case 'dispatch-intent': {
      requireState(ticket, 'granted')
      const intent = event.data.intent
      const expectedCodeRef = ticket.request.execution === 'auto' && active.snapshotReady
        ? { kind: 'commit' as const, value: active.snapshotReady.commit } : ticket.request.codeRef
      if (active.intent || intent.ticketId !== ticket.ticketId || intent.attemptId !== active.attemptId
        || intent.machine !== active.permit?.machine || contentHash(intent.codeRef) !== contentHash(expectedCodeRef)
        || intent.createdAt !== event.at) throw new Error('[sched] 派发意图不匹配或重复')
      active.intent = intent
      break
    }
    case 'dispatched':
      requireState(ticket, 'granted')
      if (!active.intent || active.dispatchedAt || event.data.submissionId !== submissionId(ticket.ticketId, active.attemptId)) throw new Error('[sched] 缺意图、重复投递或提交号不符')
      active.dispatchedAt = event.at
      break
    case 'started':
      requireState(ticket, 'granted')
      if (ticket.registerOnly || ticket.pauseReasons.length) throw new Error('[sched] 只登记或暂停意图尚未清除')
      move(ticket, 'running'); active.startedAt = event.at; active.codeRef = event.data.codeRef
      if (event.data.controller) {
        if (event.data.controller.machine !== active.permit?.machine) throw new Error('[sched] 控制端与许可机器不符')
        active.controller = event.data.controller
      }
      break
    case 'paused':
      requireState(ticket, 'running', 'slow', 'paused')
      if (ticket.pauseReasons.includes(event.data.reason)) throw new Error('[sched] 暂停原因重复')
      pauseSet(ticket, [...ticket.pauseReasons, event.data.reason])
      if (ticket.state !== 'paused') move(ticket, 'paused')
      break
    case 'resumed':
      if (!ticket.pauseReasons.includes(event.data.reason) || (event.data.actor === 'automatic' && event.data.reason !== 'ci')) throw new Error('[sched] 暂停原因不存在或自动解除人工暂停')
      requireState(ticket, 'paused', 'queued', 'unsatisfiable')
      pauseSet(ticket, ticket.pauseReasons.filter(reason => reason !== event.data.reason))
      if (ticket.state === 'paused' && ticket.pauseReasons.length === 0) move(ticket, 'running')
      break
    case 'slowed':
      if (CATEGORY_POLICY[ticket.request.category].slowAfterCiPauseMin === null
        || ticket.pauseReasons.length !== 1 || ticket.pauseReasons[0] !== 'ci') throw new Error('[sched] 只有纯 CI 暂停的跑分类可以低速')
      move(ticket, 'slow')
      break
    case 'restored':
      requireState(ticket, 'slow')
      if (ticket.pauseReasons.some(reason => reason !== 'ci')) throw new Error('[sched] 人工暂停尚未清除')
      pauseSet(ticket, []); move(ticket, 'running')
      break
    case 'suspension-observed': {
      requireState(ticket, 'running', 'paused', 'slow')
      const observation = event.data.observation
      if (active.suspension && observation.sequence <= active.suspension.sequence) throw new Error('[sched] 挂起回报序号未递增')
      active.suspension = observation
      pauseSet(ticket, observation.reasons)
      if (ticket.state !== observation.mode) move(ticket, observation.mode)
      accountConfirmedSuspension(ticket, active, event.at)
      break
    }
    case 'finished': {
      if (active.result) throw new Error('[sched] 执行重复结束')
      active.result = { outcome: event.data.result, reason: event.data.reason,
        ...(event.data.exitCode === undefined ? {} : { exitCode: event.data.exitCode }),
        ...(event.data.logFile === undefined ? {} : { logFile: event.data.logFile }),
        // 用量折算(SCHED-CORES-HISTORY-AUTOCORRECT-1010):没有任何读数的执行不带该字段,只加不改。
        ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
      }; active.endedAt = event.at
      if (event.data.terminal) {
        move(ticket, event.data.result === 'handoff-interrupted' ? 'failed' : event.data.result)
        ticket.endedAt = event.at
      } else {
        if (ticket.registerOnly) throw new Error('[sched] 只登记单不能重排执行')
        if (ticket.state !== 'queued') move(ticket, 'queued')
        ticket.pendingQueue = { from: event.at, timing: emptyTiming(), segments: [] }
      }
      break
    }
    case 'requeued': {
      if (ticket.registerOnly || event.data.nextAttemptId !== nextAttemptId(active.attemptId)) throw new Error('[sched] 重排执行号必须逐一递增')
      if (!active.result) {
        if (!event.data.previousResult) throw new Error('[sched] 直接重排必须记录旧执行结果')
        active.result = { outcome: event.data.previousResult, reason: event.data.reason }; active.endedAt = event.at
      } else if (event.data.previousResult && event.data.previousResult !== active.result.outcome) throw new Error('[sched] 重排与旧结果冲突')
      const fresh = attempt(event.data.nextAttemptId, ticket.pendingQueue?.from ?? event.at)
      if (ticket.pendingQueue) { fresh.timing = ticket.pendingQueue.timing; fresh.segments = ticket.pendingQueue.segments }
      ticket.pendingQueue = null; ticket.currentAttemptId = fresh.attemptId; ticket.attempts.push(fresh)
      ticket.queuedAt = fresh.queuedAt; ticket.band = event.data.atHead ? 0 : 1
      if (ticket.state !== 'queued') move(ticket, 'queued')
      ticket.unsatisfiableReason = null
      // T4a 的进程状态随旧树死亡；人工意图留在逻辑单，不能被换号或自动重排清掉。
      if (active.suspension) pauseSet(ticket, [])
      break
    }
    case 'placement-checked': {
      if (ticket.request.execution !== 'auto') throw new Error('[sched] 非 auto 单不能落认可搬结论')
      requireState(ticket, 'queued', 'unsatisfiable')
      const data = event.data
      ticket.placement = { portable: data.portable, reason: data.reason,
        ...(data.detail === undefined ? {} : { detail: data.detail }),
        ...(data.ownerSid === undefined ? {} : { ownerSid: data.ownerSid }),
        checkedAt: event.at, attemptId: event.attemptId }
      break
    }
    case 'snapshot-ready': {
      if (ticket.request.execution !== 'auto' || ticket.state !== 'granted' || !active.permit
        || active.permit.machine === ticket.request.origin || active.snapshotReady || active.intent
        || event.data.bundle !== `${ticket.ticketId}.bundle`) throw new Error('[sched] auto 单快照就绪状态不合法')
      active.snapshotReady = { ...event.data, readyAt: event.at }
      break
    }
    case 'cancel-requested': ticket.cancelRequested = true; break
    case 'marked-unsatisfiable': move(ticket, 'unsatisfiable'); ticket.unsatisfiableReason = event.data.reason; break
    case 'cleared-unsatisfiable': move(ticket, 'queued'); ticket.unsatisfiableReason = null; break
    default: throw new Error('[sched] 未处理的票据事件')
  }
  ticket.updatedAt = event.at; ticket.lastSeq = event.seq; ticket.timeline.push(event)
}

/** 无 I/O/时钟读取。输入不变；既能整本重放，也能把新事件增量投到启动重放后的状态。 */
export function projectLedger(events: readonly LedgerEvent[], initial: ProjectionState = emptyProjection()): ProjectionState {
  return projectLedgerEvents(events, structuredClone(initial))
}

/** @internal 调用方必须拥有容器，且在共享深层对象的全部写点提供写屏障。不要直接供消费者调用。 */
export function projectLedgerEvents(events: readonly LedgerEvent[], state: ProjectionState, own?: ProjectionOwnership): ProjectionState {
  for (const original of events) {
    // 深层键序也统一，不能让内存构造和规范 JSON 读回的事件在 timeline/globalTimeline 中分叉。
    const event = JSON.parse(canonicalJson(original)) as LedgerEvent
    validateLedgerEvent(event)
    if (contentHash(eventWithoutChecksum(event)) !== event.sha256) throw new Error('[sched] 投影事件校验和失败')
    const recordedAt = ledgerRecordTime(event)
    if (event.seq !== state.cursor.seq + 1 || (state.cursor.at !== null && recordedAt < state.cursor.at)) throw new Error('[sched] 投影序号断裂或时间倒序')
    if (event.recordedAt !== undefined && event.at < (state.observedAt ?? state.cursor.at ?? event.at)) {
      // 不改旧事件/累计耗时；回拨无法推算的区间不虚构为负数，也不冻结之后的真实计时。
      for (const ticket of Object.values(state.tickets)) {
        if (ticket.endedAt === null && ticket.accountedAt > event.at) {
          own?.ticket(ticket.ticketId)
          state.tickets[ticket.ticketId]!.accountedAt = event.at
        }
      }
    }
    if (!applyGlobal(state, event, own)) applyTicket(state, event, own)
    state.cursor = { seq: event.seq, at: recordedAt, sha256: event.sha256 }
    if (event.recordedAt !== undefined || state.observedAt !== undefined) state.observedAt = event.at
  }
  const observedAt = state.observedAt ?? state.cursor.at
  if (observedAt !== null) for (const ticket of Object.values(state.tickets)) {
    if (ticket.endedAt !== null) continue
    own?.ticket(ticket.ticketId)
    advance(state.tickets[ticket.ticketId]!, observedAt)
  }
  return state
}

/** 看板可显式传入观察时刻；该视图不能拿回去当收件游标，避免未来事件被提前计时。 */
export function projectTicketsAt(state: ProjectionState, at: string): TicketSnapshot[] {
  isoTime(at)
  const observedAt = state.observedAt ?? state.cursor.at
  if (observedAt !== null && at < observedAt) throw new Error('[sched] 观察时刻早于投影游标')
  return Object.values(structuredClone(state.tickets)).sort((a, b) => a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0)
    .map(ticket => { if (!TERMINAL_STATES.some(terminal => terminal === ticket.state)) advance(ticket, at); return ticket })
}
