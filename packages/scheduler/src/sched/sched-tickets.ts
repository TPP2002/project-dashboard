import { mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import { errorMessage, hasCode } from '../bot/cluster-lifecycle-contract'
import {
  attemptId, canonicalJson, CATEGORY_POLICY, contentHash, deriveTicketId, fields, integer, isoTime, list, oneOf,
  PAUSE_REASONS, schedPaths, STATE_TRANSITIONS, ticketId, ticketPath, validateController, validateLedgerEvent,
  validateSubmission, validateTicketOveruse,
  type ReadResult, type TicketSnapshot, type Timing,
} from './sched-contract'
import { assertSchedulerWritable, readLedger, readSchedDirectory } from './sched-ledger'
import { projectLedger, totalTiming, type ProjectionState } from './sched-project'

/** 快照是缓存，但损坏缓存不能伪装成“没有这张单”；调用方可明确选择重建。 */
function parseSnapshot(raw: string, id: string): TicketSnapshot {
  const ticket = JSON.parse(raw) as TicketSnapshot
  if (!ticket || ticket.formatVersion !== 1 || ticket.ticketId !== ticketId(id)) throw new Error('[sched] 快照版本或单号不符')
  validateSubmission(ticket.request)
  if (deriveTicketId(ticket.request.project, ticket.request.idempotencyKey) !== id || contentHash(ticket.request) !== ticket.contentHash) throw new Error('[sched] 快照挂号身份不符')
  if (!Object.hasOwn(STATE_TRANSITIONS, ticket.state) || !Array.isArray(ticket.attempts) || !ticket.attempts.length
    || !Array.isArray(ticket.timeline) || !Array.isArray(ticket.pauseReasons)) throw new Error('[sched] 快照状态或执行列表不合法')
  isoTime(ticket.createdAt); isoTime(ticket.updatedAt); isoTime(ticket.accountedAt); integer(ticket.lastSeq, 1)
  const timing = (value: unknown): void => {
    const duration = (amount: unknown): void => { integer(amount) }
    fields(value, { queuedMs: duration, runningMs: duration, pausedMs: duration, slowMs: duration })
  }
  timing(ticket.timing)
  list(oneOf(PAUSE_REASONS), 0, true)(ticket.pauseReasons)
  if (ticket.registerOnly !== CATEGORY_POLICY[ticket.request.category].registerOnly || typeof ticket.cancelRequested !== 'boolean'
    || ticket.currentAttemptId !== ticket.attempts.at(-1)!.attemptId) throw new Error('[sched] 快照类别或当前执行不匹配')
  const accumulated: Timing = { queuedMs: 0, runningMs: 0, pausedMs: 0, slowMs: 0 }
  for (const [index, attempt] of ticket.attempts.entries()) {
    if (attemptId(attempt.attemptId) !== `a${index + 1}`) throw new Error('[sched] 快照执行号不连续')
    isoTime(attempt.queuedAt); integer(attempt.grantedCores); timing(attempt.timing)
    if (attempt.controller !== undefined) validateController(attempt.controller)
    for (const phase of Object.keys(accumulated) as (keyof Timing)[]) accumulated[phase] += attempt.timing[phase]
  }
  if (ticket.pendingQueue) {
    isoTime(ticket.pendingQueue.from); timing(ticket.pendingQueue.timing)
    for (const phase of Object.keys(accumulated) as (keyof Timing)[]) accumulated[phase] += ticket.pendingQueue.timing[phase]
  }
  if (canonicalJson(accumulated) !== canonicalJson(ticket.timing)) throw new Error('[sched] 快照各次执行计时与总计不符')
  ticket.timeline.forEach(validateLedgerEvent)
  if (ticket.endedAt !== null && totalTiming(ticket.timing) !== Date.parse(isoTime(ticket.endedAt)) - Date.parse(ticket.createdAt)) throw new Error('[sched] 快照四段计时不守恒')
  // 超用标记(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925)是可丢失的展示缓存:只认在管四态
  // 里与当前执行号一致的那张;终态票据带标记、标记挂在旧执行上、快照内标记带单号(单号是边车
  // 条目才有的键,快照本体上已有),都是写坏的缓存,照坏快照拒收。
  if (ticket.overuse !== undefined) {
    validateTicketOveruse(ticket.overuse)
    if ('ticketId' in ticket.overuse) throw new Error('[sched] 快照超用标记不合法:快照内标记不带单号')
    if (ticket.overuse.attemptId !== ticket.currentAttemptId
      || !['granted', 'running', 'paused', 'slow'].includes(ticket.state)) throw new Error('[sched] 快照超用标记与当前执行或状态不符')
  }
  return ticket
}

export function writeTicketSnapshot(share: string, ticket: TicketSnapshot): void {
  assertSchedulerWritable(share)
  const paths = schedPaths(share)
  const encoded = canonicalJson(ticket)
  parseSnapshot(encoded, ticket.ticketId)
  // 快照/暂存目录本身丢失可重建；共享盘及格式闸必须先成功，不能误建另一份队列。
  mkdirSync(paths.tickets, { recursive: true }); mkdirSync(paths.staging, { recursive: true })
  publishLifecycleFileAtomically(ticketPath(share, ticket.ticketId), encoded, 'replace', paths.staging)
}

function readSnapshotFile(share: string, id: string): ReadResult<TicketSnapshot | null> {
  const path = ticketPath(share, id)
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      const directory = readSchedDirectory(share, schedPaths(share).tickets)
      if (directory.status !== 'ok') return directory
      return { status: 'ok', value: null }
    }
    return { status: 'unreadable', path, reason: errorMessage(error) }
  }
  return { status: 'ok', value: parseSnapshot(raw, id) }
}

export function readTicketSnapshot(share: string, id: string): ReadResult<TicketSnapshot | null> {
  ticketId(id)
  const directory = readSchedDirectory(share, schedPaths(share).tickets)
  if (directory.status !== 'ok') return directory
  return readSnapshotFile(share, id)
}

/** 空目录返回 ok + []；共享盘故障与尚未初始化不会丢失区别。 */
export function readTicketSnapshots(share: string): ReadResult<TicketSnapshot[]> {
  const directory = readSchedDirectory(share, schedPaths(share).tickets)
  if (directory.status !== 'ok') return directory
  const snapshots: TicketSnapshot[] = []
  for (const name of directory.value) {
    if (!/^tk-[0-9a-f]{20}\.json$/.test(name)) throw new Error(`[sched] 快照目录含未知文件:${name}`)
    const result = readSnapshotFile(share, name.slice(0, -5))
    if (result.status !== 'ok') return result
    if (result.value === null) return { status: 'unreadable', path: join(schedPaths(share).tickets, name), reason: '扫描期间快照消失' }
    snapshots.push(result.value)
  }
  return { status: 'ok', value: snapshots }
}

/**
 * 一次整本台账重放的成果(SCHED-STARTUP-REPLAY-LEASE-1017):完整校验过的台账只重放一遍得到的投影,
 * 加上取它那一刻的台账指纹。启动重放要分多笔 commit 才写得完快照,每笔都重读重投影整本台账,
 * 上万张单子的共享盘上单是重放就吃掉大半个租期;现在重放只做一次,后续每笔 commit 只在
 * 台账指纹丝毫没变时复用这份投影,任何变化都按原口径重新完整重放,绝不拿过期投影写快照。
 */
export interface PreparedLedgerReplay {
  readonly state: ProjectionState
  readonly fingerprint: string
}

/**
 * 台账目录的变更指纹:逐日文件的 名称/size/mtimeMs/ctimeMs 按名排序拼接(读缓存同口径取 size+mtimeMs,
 * 这里再加 ctimeMs 堵「改内容后手动回拨 mtime」)。台账只追加或修剪坏尾,任何一次写入至少会改 size
 * 或 mtime;不含 inode,避免换盘/重挂载带来的假变化——假变化只会多重放一遍,真变化绝不会漏判。
 * 目录不可读/文件消失按读侧原口径返回不可读,不吞掉。
 */
function ledgerFingerprint(share: string): ReadResult<string> {
  const directory = schedPaths(share).ledger
  const listing = readSchedDirectory(share, directory)
  if (listing.status !== 'ok') return listing
  const marks: string[] = []
  for (const name of listing.value) {
    const path = join(directory, name)
    try {
      const stat = statSync(path)
      marks.push(`${name}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`)
    } catch (error) { return { status: 'unreadable', path, reason: errorMessage(error) } }
  }
  return { status: 'ok', value: marks.join('|') }
}

/**
 * 只读的完整重放:读全部台账(校验和、seq 连续、日期与时间序全部照旧校验,中间坏行照旧抛错)再整本投影。
 * 不写任何东西,所以可以放在 owner.commit 之外——重放再慢,调用方也能在 checkpoint 里续租:
 * 读完台账一次、投影完一次。投影必须是一整次 projectLedger 调用(未结单子要推进到同一个观察时刻,
 * 切片会改计时分段与规范编码),所以续租点只能落在这两个整段之间,不能落在段内。
 * 指纹先于读台账取:台账若在读的当中被改,指纹对不上最新内容,后面的复用判定只会偏向重放。
 */
export function prepareLedgerReplay(share: string, checkpoint?: () => void): ReadResult<PreparedLedgerReplay> {
  const fingerprint = ledgerFingerprint(share)
  if (fingerprint.status !== 'ok') return fingerprint
  const ledger = readLedger(share)
  if (ledger.status !== 'ok') return ledger
  checkpoint?.()
  assertSchedulerWritable(share)
  const state = projectLedger(ledger.value.events)
  checkpoint?.()
  return { status: 'ok', value: { state, fingerprint: fingerprint.value } }
}

/**
 * 重建的增量控制(SCHED-DISPATCHER-RESILIENCE-1009 ⑤):全部可省,不传时行为与原来完全一致。
 * onTicket 每处理完一张单子调一次——真写了的与字节相同而跳过的都算;返回 'pause' 表示调用方
 * 要求当拍让位(派单员要在重建途中跳出 commit 去续租):重建立即停止处理后续单子,已写的快照
 * 照常有效,返回值带 paused: true、多余快照的清理留到收尾那一次。resumeAfter 从这张单子(含)
 * 之后继续:之前的单子视为已处理,不读盘、不写盘、不回调,调用方续租后增量续上。
 * replay(SCHED-STARTUP-REPLAY-LEASE-1017)是调用方此前备好的整本重放:台账指纹没变才复用、
 * 不再重读重投影;指纹变了(或读不出指纹)就丢掉它按原口径重新完整重放,并从第一张单子重新核对
 * (旧锚点属于旧投影),重放出的新成果经 onReplay 交还调用方,后续续传才复用得上新的。
 */
export interface RebuildControl {
  onTicket?: (ticket: TicketSnapshot) => 'pause' | undefined | void
  resumeAfter?: string
  replay?: PreparedLedgerReplay
  onReplay?: (replay: PreparedLedgerReplay) => void
}
export type RebuildResult = ReadResult<ProjectionState> & { paused?: true }

/** 只能由唯一写者调用；台账有效才覆盖缓存，重建不修改台账或其损坏尾行。 */
export function rebuildTicketSnapshots(share: string, control: RebuildControl = {}): RebuildResult {
  let replay = control.replay
  let reused = false
  if (replay !== undefined) {
    const current = ledgerFingerprint(share)
    if (current.status !== 'ok') return current
    if (current.value === replay.fingerprint) {
      // 复用的投影照样过一遍可写闸:与原来「读完台账、投影前」那一道闸同一位置的等价检查。
      assertSchedulerWritable(share)
      reused = true
    } else replay = undefined
  }
  if (replay === undefined) {
    const fresh = prepareLedgerReplay(share)
    if (fresh.status !== 'ok') return fresh
    replay = fresh.value
    control.onReplay?.(replay)
  }
  const state = replay.state
  const directory = schedPaths(share).tickets
  mkdirSync(directory, { recursive: true })
  const tickets = Object.values(state.tickets)
  // 断点续传的锚点在续租间隙丢了(台账被外部改动等极端情形):从头再来,宁可多读一遍不漏写。
  // 传了 replay 却没能复用时,锚点来自旧投影,同样从头核对;没传 replay 时锚点口径与原来一致。
  const anchored = control.resumeAfter !== undefined && (control.replay === undefined || reused)
  const start = anchored ? tickets.findIndex(ticket => ticket.ticketId === control.resumeAfter) + 1 : 0
  let paused = false
  for (let index = start; index < tickets.length; index++) {
    const ticket = tickets[index]!
    // 增量重建:先按投影算出这张单的规范编码,与磁盘上现有快照的原始字节比,一样就跳过,
    // 不一样或文件缺失才走原来的原子写——快照内容与格式一字未改,只是不再整盘重写
    // (共享盘 8695 个快照的启动重放实测 12~50 秒,大头就是这批没变化的原子写)。
    // 读失败(非 ENOENT)按读侧原口径返回不可读,不吞掉:坏盘不能伪装成“内容不同”。
    const encoded = canonicalJson(ticket)
    const path = ticketPath(share, ticket.ticketId)
    let existing: Buffer | undefined
    try { existing = readFileSync(path) } catch (error) {
      if (!hasCode(error, 'ENOENT')) return { status: 'unreadable', path, reason: errorMessage(error) }
    }
    if (existing === undefined || !existing.equals(Buffer.from(encoded, 'utf8'))) writeTicketSnapshot(share, ticket)
    if (control.onTicket?.(ticket) === 'pause') { paused = true; break }
  }
  if (paused) return { status: 'ok', value: state, paused: true }
  const listing = readSchedDirectory(share, directory)
  if (listing.status !== 'ok') return listing
  for (const name of listing.value) {
    if (!/^tk-[0-9a-f]{20}\.json$/.test(name)) throw new Error('[sched] 重建发现未知快照文件')
    if (!state.tickets[name.slice(0, -5)]) unlinkSync(join(directory, name))
  }
  return { status: 'ok', value: state }
}
