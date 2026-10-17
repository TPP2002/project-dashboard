/**
 * 指令流水顺序固定为收到→领域效果→回执。一次只结清一条，才受理下一条。
 * 崩溃后未结清指令从流水找已写效果，补回执而不重复效果；过期不否认已经完成的效果。
 * 读取只分类不写入：新编号的坏内容回拒绝回执，不入流水；坏文件名只记日志跳过。
 * 已在流水出现的编号若变成坏内容仍按编号冲突停写，不能覆盖原回执。
 * 本模块所有写入都要求调用方处在派单员受保护提交内。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import { errorMessage } from '../bot/cluster-lifecycle-contract'
import {
  canonicalJson, nextAttemptId, remoteKillPath, schedPaths, segment, submissionId, TERMINAL_STATES,
  validateCommand, validateRemoteKillInstruction, type CommandReceipt, type EventDraft, type LedgerEvent,
  type RemoteKillInstruction, type SchedulerCommand, type TicketSnapshot,
} from './sched-contract'
import { SchedulerReadUnavailableError } from './sched-control'
import { causedByCode, readSchedDirectory } from './sched-ledger'
import { isLocalAttempt, submissionKey, type ProjectionState } from './sched-project'

interface CommandBatch {
  commands: SchedulerCommand[]
  invalid: { commandId: string; reason: string }[]
  invalidNames: string[]
}

/** 全部文件读完后才交给受保护提交；任何文件读失败都不能提前写出拒收回执。 */
export function readCommandBatch(share: string): CommandBatch {
  const paths = schedPaths(share)
  const listing = readSchedDirectory(share, paths.commands)
  if (listing.status !== 'ok') throw new SchedulerReadUnavailableError(`[sched] 指令目录不可读:${listing.path}`)
  const batch: CommandBatch = { commands: [], invalid: [], invalidNames: [] }
  for (const name of listing.value.filter(name => name.endsWith('.json'))) {
    const id = name.slice(0, -5)
    try { segment(id) } catch { batch.invalidNames.push(name); continue }
    let raw: string
    try { raw = readFileSync(join(paths.commands, name), 'utf8') } catch (error) {
      throw new SchedulerReadUnavailableError(`[sched] 指令不可读:${name}`, { cause: error })
    }
    try {
      const command = validateCommand(JSON.parse(raw))
      if (command.commandId !== id) throw new Error('[sched] 指令编号与文件名不符')
      batch.commands.push(command)
    } catch (error) {
      const summary = errorMessage(error).replace(/\s+/g, ' ').trim().slice(0, 200)
      batch.invalid.push({ commandId: id, reason: `指令格式非法:${summary}` })
    }
  }
  return batch
}

interface CommandContext {
  share: string; at: string; dispatcherHost: string
  state: () => ProjectionState
  append: (draft: EventDraft) => LedgerEvent
  deliveredReceipts: Set<string>
  loggedInvalidNames: Set<string>
  log: (message: string) => void
  afterReceipt?: (receipt: CommandReceipt) => void
}

function deliverReceipt(context: CommandContext, receipt: CommandReceipt): void {
  if (context.deliveredReceipts.has(receipt.commandId)) return
  const paths = schedPaths(context.share)
  publishLifecycleFileAtomically(join(paths.commandReceipts, `${receipt.commandId}.json`), canonicalJson(receipt), 'replace', paths.staging)
  context.afterReceipt?.(receipt)
  context.deliveredReceipts.add(receipt.commandId)
}

/**
 * T5 远程终止指令：执行端每拍读取的终止开关。首发时刻是派单员宽限收尾的唯一锚点，
 * 因此 create-only 撞上已有文件不算错误(先发的指令继续算数)；只有明确的修复路径才 replace。
 * 旧共享盘没有 _control/kill/ 目录，发布时补建。
 */
export function publishRemoteKillInstruction(share: string, instruction: RemoteKillInstruction,
  mode: 'create-only' | 'replace' = 'create-only'): void {
  validateRemoteKillInstruction(instruction)
  const paths = schedPaths(share)
  mkdirSync(paths.kill, { recursive: true })
  try {
    publishLifecycleFileAtomically(remoteKillPath(share, instruction.ticketId, instruction.attemptId),
      canonicalJson(instruction), mode, paths.staging)
  } catch (error) {
    if (mode !== 'create-only' || !causedByCode(error, 'EEXIST')) throw error
  }
}

/** 只有此指令收到之后的匹配效果才算完成，不能把更早的同值设置误认作本次效果。 */
function persistedEffect(state: ProjectionState, command: SchedulerCommand): boolean {
  const received = state.globalTimeline.find(event => event.type === 'command-received' && event.data.command.commandId === command.commandId)
  if (!received) return false
  const after = (event: LedgerEvent): boolean => event.seq > received.seq
  if (command.kind === 'reserve') return state.globalTimeline.some(event => after(event) && event.type === 'reservation-changed'
    && event.data.machine === command.data.machine && event.data.requestedCores === command.data.requestedCores
    && (event.data.untilAt !== undefined) === (command.data.durationMinutes !== undefined))
  if (command.kind === 'owner-hold' || command.kind === 'owner-release') return state.globalTimeline.some(event => after(event)
    && event.type === 'owner-hold-changed' && event.data.machine === command.data.machine && event.data.held === (command.kind === 'owner-hold'))
  if (command.kind === 'cancel') return state.tickets[command.data.ticketId]?.timeline.some(event => after(event)
    && ((event.type === 'finished' && event.data.terminal && event.data.result === 'cancelled')
      || event.type === 'cancel-requested')) ?? false
  if (command.kind === 'finish') return state.tickets[command.data.ticketId]?.timeline.some(event => after(event)
    && event.type === 'finished' && event.data.terminal && event.data.result === command.data.result) ?? false
  return false
}

function execute(context: CommandContext, command: SchedulerCommand): CommandReceipt {
  const { at, dispatcherHost, append } = context
  const receipt = { commandId: command.commandId, at }
  const reject = (reason: string): CommandReceipt => ({ ...receipt, status: 'rejected', reason })
  if (persistedEffect(context.state(), command)) return { ...receipt, status: 'executed' }
  if (command.expiresAt <= at) return { ...receipt, status: 'expired', reason: '指令已过期' }
  if (command.kind === 'pause-one' || command.kind === 'resume-one') {
    const ticket = context.state().tickets[command.data.ticketId]
    if (!ticket || ticket.endedAt !== null || ticket.registerOnly) return reject('目标不存在、已结束或不是调度执行')
    // command-executed 持久投影人工意图；进程确认由树外控制端回报，不能提前计暂停时间。
    return { ...receipt, status: 'executed' }
  }
  if ('machine' in command.data) {
    if (command.data.machine !== dispatcherHost) return reject('只能操作派单主机')
    if (command.kind === 'reserve') {
      const { machine, requestedCores, durationMinutes } = command.data
      // 以派单员实际执行时刻计时，避免看板时钟偏差吃掉或延长预留时长。
      append({ at, type: 'reservation-changed', data: { machine, requestedCores,
        ...(durationMinutes === undefined ? {} : { untilAt: new Date(Date.parse(at) + durationMinutes * 60_000).toISOString() }),
      } })
    }
    else if (command.kind === 'owner-hold' || command.kind === 'owner-release') {
      append({ at, type: 'owner-hold-changed', data: { machine: dispatcherHost, held: command.kind === 'owner-hold' } })
    }
  } else {
    const ticket = context.state().tickets[command.data.ticketId]
    if (!ticket) return reject('单子不存在')
    if (command.kind === 'cancel' && ['granted', 'running', 'paused', 'slow'].includes(ticket.state)) {
      if (!isLocalAttempt(ticket)) {
        const active = ticket.attempts.at(-1)!
        if ((ticket.request.execution !== 'cluster' && ticket.request.execution !== 'auto') || !active.intent) return reject('集群单子尚未写派发意图')
        if (!ticket.cancelRequested) append({ at, type: 'cancel-requested', ticketId: ticket.ticketId,
          attemptId: ticket.currentAttemptId, data: { reason: command.data.reason ?? '请求撤单' } })
        // T5：集群开跑后不再拒绝撤单。granted(未开跑)没有可终止的树，仍只落标记，
        // 由交接事务隔离信箱身份；running/paused/slow 额外下达远程终止指令——回执 executed 只代表
        // 指令受理，票据终态由执行回报(实物迁移到 failed/done)或派单员宽限收尾落账。
        if (ticket.state !== 'granted') publishRemoteKillInstruction(context.share, {
          schema: 1, ticketId: ticket.ticketId, attemptId: ticket.currentAttemptId,
          submissionId: submissionId(ticket.ticketId, ticket.currentAttemptId),
          machine: active.intent.machine, source: `command:${command.commandId}`,
          reason: `远程终止:撤单指令 ${command.commandId}`, createdAt: at,
        })
        return { ...receipt, status: 'executed' }
      }
      if (ticket.state === 'granted') append({ at, type: 'finished', ticketId: ticket.ticketId,
        attemptId: ticket.currentAttemptId, data: { result: 'cancelled', terminal: true, reason: '撤单(未开跑)' } })
      else if (!ticket.cancelRequested) append({ at, type: 'cancel-requested', ticketId: ticket.ticketId,
        attemptId: ticket.currentAttemptId, data: { reason: command.data.reason ?? '请求撤单' } })
      return { ...receipt, status: 'executed' }
    }
    if (command.kind === 'finish') {
      // 只登记类单子（挂号即 running、零核、从不排队）的正常完工入口（UDQ-T6C-REGISTER-ONLY-FINISH）。
      // 执行类单子必须走 run 包装与回报链路，不许用 finish 抄近路绕过许可与回报。
      if (!ticket.registerOnly) return reject('finish 只适用只登记类单子；执行类单子必须走 run 包装与回报链路')
      // 已终态幂等（撤单先到、或 collect/end 重试）：回执按已终态处理，不报错也不重复写事件。
      // ticket 的判空已由上方「单子不存在」分支照实收窄；闭包里引用 let 变量会丢收窄，先取值再进闭包。
      const ticketState = ticket.state
      if (TERMINAL_STATES.some(terminal => terminal === ticketState)) return { ...receipt, status: 'executed' }
      append({ at, type: 'finished', ticketId: ticket.ticketId, attemptId: ticket.currentAttemptId,
        data: { result: command.data.result, reason: command.data.reason ?? '只登记单完工', terminal: true } })
      return { ...receipt, status: 'executed' }
    }
    if (ticket.state !== 'queued' && ticket.state !== 'unsatisfiable') {
      return reject('单子已不在排队中')
    }
    if (command.kind === 'cancel') finishQueuedTicket(append, ticket, at, '排队撤单')
    // 插队的 band 由 command-executed 投影生效，没有第二个非原子写点。
  }
  return { ...receipt, status: 'executed' }
}

/**
 * 结束一张排队中(queued/unsatisfiable)的单子:撤单指令与等待心跳判死(sched-waiting.ts)共用
 * 同一套事件,两处不各写一份。重排投影把当前执行号推进到 nextAttemptId,所以 finished 落在新执行上。
 */
export function finishQueuedTicket(append: (draft: EventDraft) => unknown, ticket: TicketSnapshot, at: string, reason: string): void {
  let attemptId = ticket.currentAttemptId
  if (ticket.pendingQueue) {
    // 旧执行已经 finished，不能再结束一次；先续完已批准的重排，再直接结束排队身份。
    const active = ticket.attempts.at(-1)!
    if (!active.result) throw new Error('[sched] 待重排单缺旧执行结果')
    const next = nextAttemptId(ticket.currentAttemptId)
    append({ at, type: 'requeued', ticketId: ticket.ticketId, attemptId,
      data: { nextAttemptId: next, reason: active.result.reason, atHead: true } })
    attemptId = next
  }
  append({ at, type: 'finished', ticketId: ticket.ticketId, attemptId, data: { result: 'cancelled', terminal: true, reason } })
}

export function acceptCommands(context: CommandContext, batch: CommandBatch): void {
  // 先检查整批非法内容是否撞上已收编号，绝不把已有执行回执改成格式拒收。
  for (const invalid of batch.invalid) {
    if (context.state().commands[submissionKey(invalid.commandId)]) throw new Error('[sched] 指令编号被不同内容重用')
  }
  for (const name of batch.invalidNames) {
    if (context.loggedInvalidNames.has(name)) continue
    context.log(`[sched] 指令文件名非法，已跳过:${JSON.stringify(name)}`)
    context.loggedInvalidNames.add(name)
  }
  for (const invalid of batch.invalid) deliverReceipt(context, { ...invalid, status: 'rejected', at: context.at })
  const received = context.state().commands
  // 投影按收到事件的台账顺序登记指令；未结清的先续做，不受本拍文件名或下达时间影响。
  const pending = Object.values(received).filter(entry => !entry.receipt).map(entry => entry.request)
  const known = batch.commands.filter(command => received[submissionKey(command.commandId)])
  const fresh = batch.commands.filter(command => !received[submissionKey(command.commandId)]).sort((a, b) => {
    // createdAt 已校验为统一 UTC 毫秒格式；同刻用 JS 字符序，避免机器区域设置改变结果。
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
    return a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0
  })
  const commands = new Map([...pending, ...known, ...fresh].map(command => [command.commandId, command]))
  for (const incoming of commands.values()) {
    let entry = context.state().commands[submissionKey(incoming.commandId)]
    if (entry && canonicalJson(entry.request) !== canonicalJson(incoming)) throw new Error('[sched] 指令编号被不同内容重用')
    if (!entry) {
      context.append({ at: context.at, type: 'command-received', data: { command: incoming } })
      entry = context.state().commands[submissionKey(incoming.commandId)]!
      // 格式拒收不占台账编号；修正后首次合法受理必须更新之前的拒收回执。
      context.deliveredReceipts.delete(incoming.commandId)
    }
    let receipt = entry.receipt
    if (!receipt) {
      receipt = execute(context, entry.request)
      if (receipt.status === 'executed') context.append({ at: context.at, type: 'command-executed', data: { receipt } })
      else context.append({ at: context.at, type: 'command-rejected', data: { receipt } })
    }
    deliverReceipt(context, receipt)
  }
}
