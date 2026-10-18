/** 回报是客户端输入，事件才是事实；所有写入由派单员在受保护提交中调用。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import { errorMessage } from '../bot/cluster-lifecycle-contract'
import {
  canonicalJson, parseReportName, reportName, schedPaths, TERMINAL_STATES, validateReport,
  type AttemptReport, type EventDraft, type LedgerEvent, type ReportReceipt,
} from './sched-contract'
import { SchedulerReadUnavailableError } from './sched-control'
import { readSchedDirectory } from './sched-ledger'
import { isLocalAttempt, type ProjectionState } from './sched-project'
import { reclaimedByDispatcher } from './sched-reclaim'

interface ReportBatch {
  reports: AttemptReport[]
  invalid: { name: string; reason: string }[]
  invalidNames: string[]
}

/** 缺省字段保持缺省，旧回报重放逐字节不变；出生身份随 started 事件一起持久化。 */
function reportController(report: Extract<AttemptReport, { phase: 'started' }>) {
  return { machine: report.machine, pid: report.pid,
    ...(report.creationFileTime === undefined ? {} : { creationFileTime: report.creationFileTime }),
    ...(report.createdAt === undefined ? {} : { createdAt: report.createdAt }),
    ...(report.verifier === undefined ? {} : { verifier: report.verifier }),
  }
}

/** 分类过程中不写任何回执；任一文件读失败则本拍没有提交。 */
export function readReportBatch(share: string): ReportBatch {
  const directory = schedPaths(share).reports
  const listing = readSchedDirectory(share, directory)
  if (listing.status !== 'ok') throw new SchedulerReadUnavailableError(`[sched] 回报目录不可读:${listing.path}`)
  const batch: ReportBatch = { reports: [], invalid: [], invalidNames: [] }
  for (const name of listing.value.filter(name => name.endsWith('.json'))) {
    try { parseReportName(name) } catch { batch.invalidNames.push(name); continue }
    let raw: string
    try { raw = readFileSync(join(directory, name), 'utf8') } catch (error) {
      throw new SchedulerReadUnavailableError(`[sched] 回报不可读:${name}`, { cause: error })
    }
    try {
      const report = validateReport(JSON.parse(raw))
      if (reportName(report) !== name) throw new Error('[sched] 回报编号与文件名不符')
      batch.reports.push(report)
    } catch (error) {
      batch.invalid.push({ name, reason: `回报格式非法:${errorMessage(error).replace(/\s+/g, ' ').trim().slice(0, 200)}` })
    }
  }
  return batch
}

interface ReportContext {
  remote?: boolean
  share: string; at: string
  state: () => ProjectionState
  append: (draft: EventDraft) => LedgerEvent
  deliveredReceipts: Set<string>; loggedInvalidNames: Set<string>
  log: (message: string) => void
}

function deliver(context: ReportContext, receipt: ReportReceipt): void {
  const key = `${receipt.name}:${receipt.status}`
  if (context.deliveredReceipts.has(key)) return
  const paths = schedPaths(context.share)
  publishLifecycleFileAtomically(join(paths.reportReceipts, receipt.name), canonicalJson(receipt), 'replace', paths.staging)
  context.deliveredReceipts.add(key)
}

/** controller 区分客户端 started 与旧的无控制端事件；回收/未开跑撤单不能冒充客户端开跑。 */
function persistedEvent(state: ProjectionState, identity: ReturnType<typeof parseReportName>): LedgerEvent | undefined {
  const ticket = state.tickets[identity.ticketId]
  const started = ticket?.timeline.find(event => event.attemptId === identity.attemptId && event.type === 'started' && event.data.controller)
  if (!started) return undefined
  return identity.phase === 'started' ? started
    : ticket?.timeline.find(event => event.attemptId === identity.attemptId && event.type === 'finished')
}

function rejection(state: ProjectionState, report: AttemptReport, remote = false): string | null {
  const ticket = state.tickets[report.ticketId]
  if (!ticket) return '单子不存在'
  if (TERMINAL_STATES.some(value => value === ticket.state)) return '单子已终结'
  if (ticket.currentAttemptId !== report.attemptId) return '执行号已过期'
  const attempt = ticket.attempts.find(value => value.attemptId === report.attemptId)
  if (!attempt?.permit || attempt.permit.token !== report.token) return '许可令牌不符'
  if (attempt.permit.machine !== report.machine) return '许可机器不符'
  if (!remote && !isLocalAttempt(ticket)) return '集群单子回报归 T3'
  if (remote && report.phase === 'started' && !report.creationFileTime) return '远程开跑必须有控制端出生身份'
  if (report.phase === 'started') {
    if (ticket.state !== 'granted' || ticket.pauseReasons.length) return '开跑回报只接受已授予且未暂停的单子'
  } else if (!['running', 'paused', 'slow'].includes(ticket.state)) return '结束回报只接受正在执行的单子'
  return null
}

/** 重启可以只凭已 fsync 的领域事件恢复回执；回报 at 不覆盖派单员的全局事件时钟。 */
function sameEffect(state: ProjectionState, report: AttemptReport, event: LedgerEvent): boolean {
  const attempt = state.tickets[report.ticketId]?.attempts.find(value => value.attemptId === report.attemptId)
  if (attempt?.permit?.token !== report.token || attempt.permit.machine !== report.machine) return false
  if (report.phase === 'started' && event.type === 'started') return canonicalJson(event.data) === canonicalJson({
    codeRef: report.codeRef, controller: reportController(report),
  })
  return report.phase === 'finished' && event.type === 'finished' && event.data.terminal
    && event.data.result === report.result && event.data.reason === report.reason
}

export function acceptReports(context: ReportContext, batch: ReportBatch): void {
  for (const invalid of batch.invalid) {
    if (persistedEvent(context.state(), parseReportName(invalid.name))) throw new Error('[sched] 回报编号被不同内容重用')
  }
  for (const name of batch.invalidNames) {
    if (context.loggedInvalidNames.has(name)) continue
    context.log(`[sched] 回报文件名非法，已跳过:${JSON.stringify(name)}`)
    context.loggedInvalidNames.add(name)
  }
  for (const invalid of batch.invalid) deliver(context, { ...invalid, status: 'rejected', at: context.at })
  // 文件名字序中 finished 早于 started，必须显式先处理同一执行的开跑。
  const ordered = [...batch.reports].sort((a, b) => {
    const left = `${a.ticketId}--${a.attemptId}`, right = `${b.ticketId}--${b.attemptId}`
    return left === right ? (a.phase === b.phase ? 0 : a.phase === 'started' ? -1 : 1) : left < right ? -1 : 1
  })
  for (const report of ordered) {
    const name = reportName(report)
    // Cluster completion still belongs to handoff's original result/rerun
    // reconciliation. The new native started gate does not turn a wrapper's
    // abbreviated finished report into a replacement for that domain result.
    const ticket = context.state().tickets[report.ticketId]
    if (context.remote && report.phase === 'finished' && ticket && !isLocalAttempt(ticket)) {
      deliver(context, { name, status: 'rejected', at: context.at, reason: '集群单子结束回报归交接结果对账' })
      continue
    }
    const previous = persistedEvent(context.state(), report)
    if (previous) {
      if (!sameEffect(context.state(), report, previous)) {
        // 自动回收结束不是此回报的效果：终态迟到结果仍拒收，不当作重复客户端回报。
        // SCHED-LATE-FINISH-AFTER-GRACE-RECLAIM-0924：回收原因按派单员回收名单全量识别
        // （控制端失联、无子进程停更超宽限、授予后未开跑），不再只认第一种——宽限期回收
        // 之后再到的结束回报过去会抛「回报编号被不同内容重用」，一张迟到回报就能让
        // 派单员整拍失败停摆；这里改为拒收回执，派单照常推进。
        // 与原判据一致不核对 terminal：managed 回收先写 terminal:false 的结束再重排，
        // 撞上迟到结束同样按「不是这份回报的效果」拒收。
        if (report.phase === 'finished' && previous.type === 'finished'
          && reclaimedByDispatcher(previous.data.reason)) {
          deliver(context, { name, status: 'rejected', at: context.at, reason: '单子已终结' }); continue
        }
        throw new Error('[sched] 回报编号被不同内容重用')
      }
      deliver(context, { name, status: 'accepted', at: context.at }); continue
    }
    const reason = rejection(context.state(), report, context.remote)
    if (reason) { deliver(context, { name, status: 'rejected', at: context.at, reason }); continue }
    const identity = { at: context.at, ticketId: report.ticketId, attemptId: report.attemptId }
    if (report.phase === 'started') context.append({ ...identity, type: 'started', data: {
      codeRef: report.codeRef, controller: reportController(report),
    } })
    else context.append({ ...identity, type: 'finished', data: { result: report.result, reason: report.reason, terminal: true } })
    deliver(context, { name, status: 'accepted', at: context.at })
  }
}
