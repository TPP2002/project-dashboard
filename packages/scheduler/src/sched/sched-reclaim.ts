/** 本机回收只做「确认整棵执行树已退出」的保守探测，不启动子进程，也不猜测异机进程存活；
 *  探不出整棵树就保持占用。唯一例外：心跳从未记录子进程号、控制端已死且停更超过宽限期
 *  （RECLAIM_NO_CHILD_GRACE_MS）时不可能再有子进程树，回收。主动终止残留进程树与作业对象纳管归 T4。
 *  SCHED-GRANTED-ORPHAN-NO-RECLAIM-0924 起,本文件还负责「授予后一直不开跑」的许可收回
 *  （reclaimUnstartedGrants）与心跳目录的按需读取（activeAttemptSubmissions + readBeatBatchFor）。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { errorMessage, hasCode } from '../bot/cluster-lifecycle-contract'
import {
  ATTEMPT_RECLAIM_AFTER_MS, GRANTED_START_RECLAIM_AFTER_MS, nextAttemptId, schedPaths, validateAttemptBeat,
  type AttemptBeat, type EventDraft, type TicketSnapshot,
} from './sched-contract'
import { finishQueuedTicket } from './sched-commands'
import { SchedulerReadUnavailableError } from './sched-control'
import { readSchedDirectory } from './sched-ledger'
import { isLocalAttempt } from './sched-project'
import { GRANTED_WAITING_ABANDONED_REASON, WAITING_ABANDONED_REASON } from './sched-waiting'

export interface BeatBatch { beats: Map<string, AttemptBeat>; invalid: string[] }
export function readBeatBatch(share: string): BeatBatch {
  const directory = schedPaths(share).beats
  const listing = readSchedDirectory(share, directory)
  if (listing.status !== 'ok') throw new SchedulerReadUnavailableError(`[sched] 心跳目录不可读:${listing.path}`)
  const batch: BeatBatch = { beats: new Map(), invalid: [] }
  for (const name of listing.value.filter(name => name.endsWith('.json'))) {
    let raw: string
    try { raw = readFileSync(join(directory, name), 'utf8') } catch (error) {
      throw new SchedulerReadUnavailableError(`[sched] 心跳不可读:${name}`, { cause: error })
    }
    try {
      const beat = validateAttemptBeat(JSON.parse(raw))
      if (`${beat.ticketId}--${beat.attemptId}.json` !== name) throw new Error('心跳文件名不符')
      batch.beats.set(name, beat)
    } catch (error) { batch.invalid.push(`${name}:${errorMessage(error)}`) }
  }
  return batch
}

/**
 * SCHED-BEATS-DIR-RETENTION-0924:在跑票的当前执行号集合。派单员每拍只需要这些执行的心跳;
 * 目录仍整目录枚举一次(不可读照旧整拍不写、也能发现文件名),但内容只读这份集合对应的文件,
 * 不再全目录逐个读——文件数随挂号量单调增长,全量读会拖慢派单员主循环。
 */
export function activeAttemptSubmissions(tickets: readonly TicketSnapshot[]): Set<string> {
  const wanted = new Set<string>()
  for (const ticket of tickets) {
    if (ticket.endedAt !== null || !['running', 'paused', 'slow'].includes(ticket.state)) continue
    wanted.add(`${ticket.ticketId}--${ticket.currentAttemptId}`)
  }
  return wanted
}

/** 与 readBeatBatch 同一套分类口径,但只读 wanted 集合里的文件;不在跑票的心跳文件一律不碰。
 *  wanted 里没有对应文件属正常(还没 spawn),静默跳过;被点名文件读失败仍整拍不可用。 */
export function readBeatBatchFor(share: string, wanted: ReadonlySet<string>): BeatBatch {
  const directory = schedPaths(share).beats
  const listing = readSchedDirectory(share, directory)
  if (listing.status !== 'ok') throw new SchedulerReadUnavailableError(`[sched] 心跳目录不可读:${listing.path}`)
  const present = new Set(listing.value)
  const batch: BeatBatch = { beats: new Map(), invalid: [] }
  for (const submission of [...wanted].sort()) {
    const name = `${submission}.json`
    if (!present.has(name)) continue
    let raw: string
    try { raw = readFileSync(join(directory, name), 'utf8') } catch (error) {
      throw new SchedulerReadUnavailableError(`[sched] 心跳不可读:${name}`, { cause: error })
    }
    try {
      const beat = validateAttemptBeat(JSON.parse(raw))
      if (`${beat.ticketId}--${beat.attemptId}.json` !== name) throw new Error('心跳文件名不符')
      batch.beats.set(name, beat)
    } catch (error) { batch.invalid.push(`${name}:${errorMessage(error)}`) }
  }
  return batch
}

/** 只有 ESRCH 证明不存在；EPERM 与未知探测错误都不回收。 */
export function processIsGone(pid: number, probe: (pid: number, signal: 0) => unknown = process.kill): boolean {
  try { probe(pid, 0); return false } catch (error) { return hasCode(error, 'ESRCH') }
}

/** 无 childPid 心跳的回收宽限期：控制端已死且心跳停更超过它，才认定「不可能再有子进程树」而回收。 */
export const RECLAIM_NO_CHILD_GRACE_MS = 5 * 60_000

export function reclaimLocalAttempts(options: {
  at: string; machine: string; tickets: readonly TicketSnapshot[]; beats: BeatBatch
  append: (draft: EventDraft) => unknown; probe?: (pid: number, signal: 0) => unknown; log?: (message: string) => void
  loggedHoldNames: Set<string>
}): void {
  for (const ticket of options.tickets) {
    const holdName = `${ticket.ticketId}--${ticket.currentAttemptId}`
    // 离开 running/paused/slow（含被回收成终态）就清键；同一执行再次进入「保持占用」还能重新记一行。
    if (!isLocalAttempt(ticket) || !['running', 'paused', 'slow'].includes(ticket.state)) { options.loggedHoldNames.delete(holdName); continue }
    const attempt = ticket.attempts.find(value => value.attemptId === ticket.currentAttemptId)
    if (!attempt?.controller || attempt.controller.machine !== options.machine || attempt.permit?.machine !== options.machine || !attempt.startedAt) continue
    const beat = options.beats.beats.get(`${ticket.ticketId}--${attempt.attemptId}.json`)
    // 异机伪造心跳不能替本机续租；无有效心跳时只从开跑时刻计时。
    const localBeat = beat?.machine === options.machine && beat.at > attempt.startedAt ? beat : undefined
    if (Date.parse(options.at) - Date.parse(localBeat?.at ?? attempt.startedAt) <= ATTEMPT_RECLAIM_AFTER_MS) continue
    if (!processIsGone(attempt.controller.pid, options.probe)) continue
    // 无本机有效心跳 = 命令尚未 spawn，不存在子进程树，只按包装进程判定（沿用原判据）。
    // 有本机有效心跳就必须连被包装命令的子进程一起确认退出：childPid 仍在、字段缺失或探测失败
    // 都确认不了整棵树，一律不回收、保持占用；主动终止残留树与作业对象纳管归 T4。
    const managed = localBeat?.suspend !== undefined && localBeat.token === attempt.permit.token
    const closedBeforeRootRecorded = managed && localBeat.suspend!.ended && localBeat.childPid === undefined
    // 包装器可能在 spawn 之前就死（0914 实证 <historical-ticket>：心跳只写一拍、无 childPid，控制端早已不存在），
    // 这时永远等不到子进程号；控制端已死 + 心跳停更超过宽限期 ⇒ 不可能再有子进程树，应回收，
    // 否则票据永远停在 running、授予核一直计入已授予、撤单完不成。宽限期内仍按「可能正在 spawn」保持占用。
    const noChildPastGrace = localBeat !== undefined && localBeat.childPid === undefined && !closedBeforeRootRecorded
      && Date.parse(options.at) - Date.parse(localBeat.at) >= RECLAIM_NO_CHILD_GRACE_MS
    if (localBeat && !closedBeforeRootRecorded && !noChildPastGrace
      && (localBeat.childPid === undefined || !processIsGone(localBeat.childPid, options.probe))) {
      // 降噪同 loggedInvalidNames：同一执行只在第一次进入「保持占用」时记一行，每拍重复不再刷屏。
      if (!options.loggedHoldNames.has(holdName)) {
        const reason = localBeat.childPid === undefined ? '心跳缺少被包装命令子进程号' : `被包装命令子进程 ${localBeat.childPid} 仍在或探测失败`
        options.log?.(`[sched] 本机单子已超时且包装进程已退出，${reason}，整棵执行树确认不了，保持占用:${ticket.ticketId}/${attempt.attemptId}`)
        options.loggedHoldNames.add(holdName)
      }
      continue
    }
    options.loggedHoldNames.delete(holdName)
    // 两种回收凭据：无 childPid 且停更超过宽限期的走 REASONS[1]，其余（子进程号确亡 / 无心跳原判据 /
    // 树根收尾前死亡）沿用 REASONS[0]。撤单中的单子不重排(SCHED-REQUEUE-IGNORES-CANCEL-1009):
    // 重排出来的新执行带着撤单标记永远等不到授予、也没人终结它(09-26 起两张单各挂 12 天),
    // 这里直接 finished(cancelled, terminal:true),原因沿用原值;未撤单的行为一字不变。
    const result = ticket.cancelRequested ? 'cancelled' as const : 'failed' as const
    const reason = noChildPastGrace ? DISPATCHER_RECLAIM_REASONS[1] : DISPATCHER_RECLAIM_REASONS[0]
    options.append({ at: options.at, type: 'finished', ticketId: ticket.ticketId, attemptId: attempt.attemptId,
      data: { result, terminal: !managed || ticket.cancelRequested, reason } })
    if (managed && !ticket.cancelRequested) options.append({ at: options.at, type: 'requeued', ticketId: ticket.ticketId, attemptId: attempt.attemptId,
      data: { nextAttemptId: nextAttemptId(attempt.attemptId), reason: '控制端死亡，原执行树已终止', atHead: true } })
  }
}

/** 授予后未开跑收回的终局原因(SCHED-GRANTED-ORPHAN-NO-RECLAIM-0924):常量字符串,
 *  客户端与迟到回报识别都按这份原文比对,不拼接时长等动态内容。 */
export const GRANTED_NEVER_STARTED_REASON = '授予后未开跑且无存活信号，按挂号端没来领回收(本机回收)'
/** 存量兜底撤单原因(SCHED-REQUEUE-IGNORES-CANCEL-1009):常量字符串,迟到回报按这份原文识别。 */
export const QUEUED_CANCEL_BACKSTOP_REASON = '排队中带撤单标记，撤单指令已执行过，兜底撤单'
/** 派单员本机回收写下的全部 finished 原因。迟到的客户端终态回报撞上这些事件时,
 *  回收不是那份回报的效果,按「单子已终结」拒收回执,不当作回报编号重用停写(card 3)。 */
export const DISPATCHER_RECLAIM_REASONS = [
  '控制端失联且进程已退出(本机回收)',
  '控制端失联、心跳未记录子进程且停更超过 5 分钟(本机回收)',
  GRANTED_NEVER_STARTED_REASON,
  // 等待心跳判挂号端已不在(SCHED-QUEUED-ORPHAN-LIVENESS-1009,sched-waiting.ts):排队撤单与授予收回两种。
  WAITING_ABANDONED_REASON,
  GRANTED_WAITING_ABANDONED_REASON,
  // 排队存量兜底撤单(SCHED-REQUEUE-IGNORES-CANCEL-1009,reclaimQueuedCancelRequested)。
  QUEUED_CANCEL_BACKSTOP_REASON,
] as const
export function reclaimedByDispatcher(reason: string): boolean {
  return (DISPATCHER_RECLAIM_REASONS as readonly string[]).includes(reason)
}

/**
 * 【SCHED-REQUEUE-IGNORES-CANCEL-1009】每拍兜底:排队中(queued/unsatisfiable)还带着撤单标记
 * 的存量单直接终局。历史上有三个重排点(本机回收/交接重排/快照门)不看撤单标记,把撤单中的
 * 单子写回排队——准入永远不选撤单票,也没人终结它,09-26 起两张单各挂了 12 天。重排点已修,
 * 这里再扫一遍,旧版派单员或断电留下的存量也能清掉。走 finishQueuedTicket,与撤单指令、
 * 等待心跳判死同一套事件;断点形态(旧执行已 finished、requeued 未写)先续完重排再终局。
 */
export function reclaimQueuedCancelRequested(options: {
  at: string; tickets: readonly TicketSnapshot[]; append: (draft: EventDraft) => unknown; log?: (message: string) => void
}): void {
  for (const ticket of options.tickets) {
    if (ticket.endedAt !== null || !['queued', 'unsatisfiable'].includes(ticket.state) || !ticket.cancelRequested) continue
    options.log?.(`[sched] ${ticket.ticketId}/${ticket.currentAttemptId} 排队中仍带撤单标记，按兜底撤单终结`)
    finishQueuedTicket(options.append, ticket, options.at, QUEUED_CANCEL_BACKSTOP_REASON)
  }
}

/**
 * SCHED-GRANTED-ORPHAN-NO-RECLAIM / SCHED-GRANTED-NEVER-STARTED-RECLAIM:
 * 本机单授予后 GRANTED_START_RECLAIM_AFTER_MS 内既没有开跑回报、也没有任何存活信号 ⇒
 * 挂号端(排队等待的对话)很可能已经不在了,而许可的核一直扣在派单员账上——旧口径只有
 * 「已开跑、控制端失联」的回收,授予后没有任何收回路径。这里写 finished 终局收回,
 * 原因码「挂号端没来领」;已请求撤单的跟本机回收同口径记 cancelled。
 * 边界:只管 execution 缺省/local 且当前执行没有派发意图的本机单;auto 单开跑前的收回
 * (60 秒无心跳收回重排)与集群单归交接口径,绝不在此触碰;registerOnly 单挂号即 running、
 * 零核、不排队,永远不会处于 granted。存活信号的现行口径 = 开跑回报本身:一旦开跑,
 * 票据离开 granted,本规则不再适用;「是否给等待中的客户端加显式轻量心跳」是待定点
 * (docs/plans/SCHED-GRANTED-ORPHAN-NO-RECLAIM-0924-待定点.md),先按保守方案做。
 */
export function reclaimUnstartedGrants(options: {
  at: string; machine: string; tickets: readonly TicketSnapshot[]
  append: (draft: EventDraft) => unknown; log?: (message: string) => void
}): void {
  for (const ticket of options.tickets) {
    if (ticket.state !== 'granted' || ticket.registerOnly) continue
    // 常驻长期占用单(SCHED-MR5-RESIDENT-LEASE-0924)挂号当拍授予、本来就永不「开跑」——它的存活信号是
    // 续约凭据,由租约的心跳断超时另行销单;这里若也按「授予后没开跑」收,常驻登记只能活 10 分钟(整合时补)。
    if (ticket.request.resident === true) continue
    if (ticket.request.execution === 'auto' || !isLocalAttempt(ticket)) continue
    const attempt = ticket.attempts.find(value => value.attemptId === ticket.currentAttemptId)
    if (!attempt?.permit || attempt.permit.machine !== options.machine) continue
    if (Date.parse(options.at) - Date.parse(attempt.permit.issuedAt) < GRANTED_START_RECLAIM_AFTER_MS) continue
    options.log?.(`[sched] ${ticket.ticketId}/${attempt.attemptId} 授予后 `
      + `${Math.round(GRANTED_START_RECLAIM_AFTER_MS / 60_000)} 分钟未开跑且无存活信号，收回许可(挂号端没来领)`)
    options.append({ at: options.at, type: 'finished', ticketId: ticket.ticketId, attemptId: attempt.attemptId,
      data: { result: ticket.cancelRequested ? 'cancelled' as const : 'failed' as const, terminal: true,
        reason: GRANTED_NEVER_STARTED_REASON } })
  }
}
