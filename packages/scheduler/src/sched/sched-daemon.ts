import deployment from './client/deployment-config.cjs'
/**
 * 独立派单进程：收件、指令、回报与本机回收后才授予；命令仍在客户端树外包装器执行。
 * 启动只重放一次；稳定节拍在内存推进。写入异常立即退出，重启从流水恢复。
 * 唯一的例外是工单快照这种**缓存**：单拍写失败只跳过这一拍(流水已落、心跳与快照本拍不写、下一拍全量补写)，
 * 连续 SNAPSHOT_WRITE_FAILURE_LIMIT 拍都失败才按原口径停(SCHED-DAEMON-STOPS-ON-SNAPSHOT-WRITE-FAIL-0925)。
 * 心跳同样是展示缓存，同一口径：偶发一拍写不进只告警一行、本拍派单照常，连续
 * HEARTBEAT_WRITE_FAILURE_LIMIT 拍都失败才停(SCHED-DISPATCHER-RESILIENCE-1009)。
 * 读入阶段不可用就整拍不写；进入保护区后发生故障不能猜测回滚已 fsync 的流水。
 * 读集群快照撞上执行机搬单的迁移锁是正常并发，不是写入异常：活锁短退避重读、仍撞本拍跳过；
 * 过期锁本拍不调度并报警；两种都照常续租、绝不退出(SCHED-DISPATCHER-DIED-NO-RESPAWN-0924)。
 * 快照里同一张单的双态记录(执行机刚搬完单、旧态文件删除挂起)同理:本拍跳过、照常续租、
 * 下一拍重读,不整个退出(SCHED-DISPATCHER-STATUS-CONFLICT-EXIT-0924)。
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { errorMessage, hasCode, productionSources, requireAgentProtocol, requireSha1 } from '../bot/cluster-lifecycle-contract'
import { transitionLifecycleJob, type LifecycleStateRecord } from '../bot/cluster-lifecycle'
import { ActiveTransitionLeaseError, TransitionLeaseBarrierError } from '../bot/cluster-lifecycle-lease'
import { LifecycleStateConflictError, readLifecycleStatusSnapshot, type LifecycleStatusSnapshot } from '../bot/cluster-lifecycle-status'
import { OwnerLeaseOccupiedError } from '../bot/cluster-owner'
import {
  canonicalJson, DISPATCH_TICK_MS, isoTime, jobHardTimeoutMs, menuHardTimeoutMs, REMOTE_KILL_GRACE_MS, remoteKillPath,
  RESIDENT_LEASE_HEARTBEAT_TIMEOUT_MS, residentLeasePath, schedControlPaths, schedPaths,
  submissionId, utcDate, validateRemoteKillInstruction, validateTicketOveruse,
  type EventDraft, type LedgerEvent, type RemoteKillInstruction, type SchedulerSources, type TicketOveruse,
  type TicketSnapshot,
} from './sched-contract'
import projects from './client/sched-projects.cjs'
import { acceptCommands, publishRemoteKillInstruction } from './sched-commands'
import { createCiLaneReserveReader, type CiLaneReserveReader } from './sched-ci-lanes'
import { createHubSwitchReader, type HubSwitchReader } from './sched-hub-switch-reader'
import { createCiPolicyReader, type CiPolicyReader } from './sched-ci-policy'
import { ciLabelObservations, createCiLabelRouter, type CiLabelRouter } from './sched-ci-labels'
import type { CiMachineObservation } from './sched-ci-availability'
import { productionCiLabelsGithub, type CiLabelGithubPort } from './sched-ci-labels-github'
import { createManagedLoadTracker, createOveruseReporter, managedAttempts, managedLoadInput, managedLoadMarks, matchedManagedReadings, recordManagedLoadTick } from './sched-managed-load'
import { createCiBorrowController } from './sched-ci-borrow'
import { createMemoryFloorConfigReader, createMemoryFloorReporter, createMemoryFloorTracker, evaluateMemoryGate,
  readMemoryReading, type MemoryFloorTracker, type MemoryGateEntry,
  type MemoryFloorReporter } from './sched-memory-floor'
import { readDispatcherConfig, SchedulerReadUnavailableError, writeDispatcherHeartbeat } from './sched-control'
import { applyResidentLeases, decideAdmission, machineLendView, pausedCiFrozenCores, residentLeaseCores,
  type MachineInput, type MemoryGateInput, type PausedCiTicketFact } from './sched-decide'
import { abandonOnStateConflict, ciActiveMachines, CI_YIELD_RECALL_MIN_INBOX_MS, handoffClusterTickets,
  type HandoffContext } from './sched-handoff'
import { ingestSubmissions, type IntakeHooks } from './sched-intake'
import { appendLedgerEvent, assertSchedulerWritable, causedByCode, emptyLedgerTail, readSchedDirectory } from './sched-ledger'
import {
  createSchedReadCache, readCommandBatchCached, readReportBatchCached, readSubmissionBatchCached,
  type SchedReadCache,
} from './sched-read-cache'
import { createSchedReadProgress } from './sched-read-progress'
import { dispatcherDecisionSnapshot, schedulerInputs } from './sched-machines'
import { createOriginProbe, type OriginProbe, type OriginProbeRequest, type OriginProbeResult } from './sched-origin-probe'
import { applyPlacementChecks } from './sched-portable'
import { applySnapshotGate } from './sched-snapshot-gate'
import { AUTO_JOB_MIN_AGENT_PROTOCOL, agentProtocolsFrom, autoJobHardTimeoutMs, repinAutoTickets } from './sched-auto-handoff'
import { createAutoLaunchReader, type AutoLaunchReader } from './sched-auto-launch'
import { createSnapshotSweeper, type SnapshotSweeper } from './sched-snapshot-sweeper'
import { appendUsageHistory, createUsageHistoryTracker, ensureUsageHistoryCapability, type UsageHistoryEntry } from './sched-usage-history'
import { claimSchedulerOwner, SCHED_OCCUPIED_EXIT_CODE, SCHED_OWNER_NAME, SCHED_RENEW_MS, type SchedulerOwner } from './sched-owner'
import { submissionKey, type ProjectionState } from './sched-project'
import { projectLedgerDelta } from './sched-project-delta'
import { publishSchedulerClient } from './sched-publish'
import { acceptReports } from './sched-reports'
import { activeAttemptSubmissions, readBeatBatchFor, reclaimLocalAttempts, reclaimQueuedCancelRequested, reclaimUnstartedGrants } from './sched-reclaim'
import { handoffLogPath, observeHandoff } from './sched-cluster-job'
import { acceptSuspensionReports } from './sched-suspend-reports'
import { measureSuspensionWindow } from './sched-suspend-timing'
import { executeLogRetention, sweepStaleSuspendBeatStaging, sweepTerminalBeats } from './sched-retention'
import { prepareLedgerReplay, rebuildTicketSnapshots, writeTicketSnapshot, type PreparedLedgerReplay, type RebuildResult } from './sched-tickets'
import { createWaitingTracker } from './sched-waiting'
import { createEtaBook, type EtaBook } from './sched-eta'
import { CROSS_MACHINE_WIRED } from './sched-placement'
import type { RemoteSchedulerPort, RemoteDomainContext } from './sched-remote'

export interface SchedulerDaemonOptions {
  mode?: 'local' | 'remote'
  remote?: RemoteSchedulerPort
  share: string; machine: string; host: string; pid: number; protocol: number; head: string
  sources: SchedulerSources
  readMachines?: () => LifecycleStatusSnapshot
  /** 撞活迁移锁时的同步退避；缺省真睡，测试注入以免真等、并在退避期间撤锁。 */
  sleepSync?: (ms: number) => void
  probeProcess?: (pid: number, signal: 0) => unknown
  originProbe?: OriginProbe
  crossMachine?: boolean
  warm?: (machine: string, project: string) => boolean
  etaBook?: EtaBook
  autoMinAgentProtocol?: number | null
  autoLaunch?: AutoLaunchReader
  snapshotSweeper?: SnapshotSweeper
  /**
   * SCHED-SELF-OVERHEAD-0925:终态指令/回报/心跳的读+解析缓存与账本尾增量。缺省启用;
   * 传 null 显式回到基线行为(直读 + 每次全量读尾文件),供对照测试与人工回退。
   * 目录枚举照旧每拍执行,新文件仍一拍可见。
   */
  readCache?: SchedReadCache | null
  log?: (message: string) => void
  /** CI-RUNNER-LABEL-ROUTING-0924:车道标签路由边车。缺省自建;注入 null 彻底不启用,测试注入假路由。 */
  ciLabels?: CiLabelRouter | null
  /** 标签路由的 GitHub 端口工厂;测试注入假端口,生产由独立进程入口注入 productionCiLabelsGithub;库内不设缺省。 */
  ciLabelsGithub?: () => CiLabelGithubPort | null
  /** SCHED-MR6-MEMORY-DIMENSION-0924:内存下限闸的记账器与边车。缺省自建;测试注入替身(如让边车抛错)。 */
  memoryFloorTracker?: MemoryFloorTracker
  memoryFloorReporter?: MemoryFloorReporter
  hooks?: { afterLedger?: (event: LedgerEvent) => void; beforeSnapshots?: () => void; intake?: IntakeHooks;
    handoff?: HandoffContext['checkpoint'] }
}
export interface SchedulerDaemon {
  readonly state: ProjectionState
  readonly owner: SchedulerOwner
  tick: () => boolean
  close: () => void
  commit: <T>(operation: (context: RemoteDomainContext) => T) => T
}
const IO_ERRORS = ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'EBUSY', 'ENOTDIR', 'ENETDOWN', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET']

/** Until an authenticated execution-host port is installed, a non-Windows
 * dispatcher cannot interpret its local PID table as Windows execution facts. */
export function probeDispatcherExecutionProcess(pid: number, signal: 0): unknown {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('[sched] execution-host process identity adapter unavailable'), { code: 'ENOTSUP' })
  }
  return process.kill(pid, signal)
}

/**
 * 读集群快照撞上迁移锁时的处理(SCHED-DISPATCHER-DIED-NO-RESPAWN-0924)。
 * 执行机把单从 inbox 搬进 running 要给它挂一把迁移锁；快照读取对每台机器 inbox/running 的每张单都核锁，
 * 撞上就抛 TransitionLeaseBarrierError。旧代码把它当写入异常整个退出，副机改为并发跑 1 核小单后搬单频繁，
 * 0924 凌晨派单员几分钟退一次。现在：活锁(有效期内，含 lease.json 还没落盘的「正在建」锁)按下面的序列
 * 原地重读，仍撞就本拍跳过——流水、快照、心跳一概不写，不退出；过期锁不重试，本拍不调度并报警。
 * 两种都照常续租，否则锁挂过 90 秒租期后，锁一撤派单员反而因续租失败退出。
 */
export const TRANSITION_LOCK_RETRY_DELAYS_MS: readonly number[] = [200, 200, 200]
/** 同一把锁的跳过/报警日志最多每 60 秒一行，免得一把卡住的锁每 2 秒刷一行。 */
export const TRANSITION_LOCK_LOG_INTERVAL_MS = 60_000
/**
 * 工单快照(缓存，不是事实源)连续写失败几拍才按原口径停派单员。
 * 改前一拍失败就永久停：0925 在管负载开关上线后，一次 rename EPERM(退避约 5 秒)就把派单员打死，
 * 之后每拍只报「派单员已经停止」，要人工重启才回来(SCHED-DAEMON-STOPS-ON-SNAPSHOT-WRITE-FAIL-0925)。
 */
export const SNAPSHOT_WRITE_FAILURE_LIMIT = 3
/**
 * 派单员心跳(展示缓存,给客户端与看板看,不是事实源)连续写失败几拍才按原口径停派单员。
 * 取 5:每拍 2 秒加原子写退避最多约 5 秒,连续 5 拍约半分钟写不进心跳,仍远小于客户端判
 * 「调度台挂了」的 2 分钟窗口。共享盘偶发 EPERM/EACCES/EBUSY 只咬一拍时,派单员只告警一行、
 * 下一拍照常派单,不再整个进程退出、连同监护器退避停摆两三分钟(SCHED-DISPATCHER-RESILIENCE-1009)。
 */
export const HEARTBEAT_WRITE_FAILURE_LIMIT = 5

/** 派单节拍是同步的(保护区里不能放 Promise)，退避只能同步睡。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 只对「活」迁移锁原地重读；过期锁、其他任何错误原样上抛，由节拍按原口径分类。 */
function readMachinesWithRetry(options: SchedulerDaemonOptions, checkpoint: () => void): LifecycleStatusSnapshot {
  const read = options.mode === 'remote' ? options.remote!.readMachines : options.readMachines
    ?? (() => readLifecycleStatusSnapshot(options.share, undefined, { tolerateMachineFaults: true }))
  const sleep = options.sleepSync ?? sleepSync
  for (let attempt = 0; ; attempt++) {
    checkpoint()
    try { return read() } catch (error) {
      if (!(error instanceof TransitionLeaseBarrierError) || attempt >= TRANSITION_LOCK_RETRY_DELAYS_MS.length
        || !error.isLiveAt(Date.parse(isoTime(options.sources.now())))) throw error
      sleep(TRANSITION_LOCK_RETRY_DELAYS_MS[attempt]!)
    }
  }
}

/**
 * 授予时该机本拍 CI 在跑就带 ciAware（UDQ-T4B-2）：执行侧据此开跑即整树降到最低优先级、不因 CI 冻住。
 * 读不到该机、或 CI 不是 active（含 unknown）一律不带——旧口径的许可逐字不变，缺省当 false。
 */
export function permitCiAware(machines: readonly MachineInput[], machine: string): { ciAware?: true } {
  return machines.find(candidate => candidate.name === machine)?.ci === 'active' ? { ciAware: true } : {}
}

/**
 * 借核让路用的事实:一条单只取「状态 + 暂停原因 + 许可机器 + 授予核数」四项。
 * 让路核只喂给借核规划(SCHED-DAEMON-STOPS-ON-SNAPSHOT-WRITE-FAIL-0925 卡2)，机器与心跳口径不动。
 */
function pausedCiFacts(state: ProjectionState): PausedCiTicketFact[] {
  const facts: PausedCiTicketFact[] = []
  for (const ticket of Object.values(state.tickets)) {
    const attempt = ticket.attempts.find(value => value.attemptId === ticket.currentAttemptId)
    const machine = attempt?.permit?.machine
    if (attempt === undefined || machine === undefined) continue
    facts.push({ state: ticket.state, pauseReasons: ticket.pauseReasons, machine, grantedCores: attempt.grantedCores })
  }
  return facts
}

/** 所有读操作先完成，读不到绝不代入空队列；坏指令带回保护区拒收，台账/控制格式错误仍抛出。
 *  wantedBeats 是在跑票的当前执行号(SCHED-BEATS-DIR-RETENTION-0924):心跳只读这些文件,
 *  不再全目录逐个读;目录本身仍整目录枚举,不可读照旧整拍不写。 */
function readTick(options: SchedulerDaemonOptions, machine: string, ciLanes: CiLaneReserveReader, hubSwitch: HubSwitchReader,
  ciPolicy: CiPolicyReader, memoryFloorConfig: { read(): import('./sched-memory-floor').MemoryFloorConfig },
  readCache: SchedReadCache, wantedBeats: ReadonlySet<string>, progress: ReturnType<typeof createSchedReadProgress>) {
  const paths = schedPaths(options.share)
  for (const directory of [paths.control, paths.ledger, paths.logs]) {
    progress.checkpoint()
    const read = readSchedDirectory(options.share, directory)
    if (read.status !== 'ok') throw new SchedulerReadUnavailableError(`[sched] 本拍共享盘不可读:${read.path}`)
  }
  assertSchedulerWritable(options.share)
  if (readDispatcherConfig(options.share)?.machine !== machine) throw new Error('[sched] 派单主机配置已改变，停止写入')
  // 未变的终态文件走缓存(分类口径与原函数逐字一致,见 sched-read-cache.ts);null = 基线直读。
  // 心跳不进缓存:在跑票的心跳每个节拍都被执行端整文件替换,缓存没有命中率,按需直读即可。
  const hub = progress.read('hub', () => hubSwitch.read())
  return {
    submissions: progress.read('submissions', () => readSubmissionBatchCached(options.share, readCache, progress.checkpoint)),
    commands: progress.read('commands', () => readCommandBatchCached(options.share, readCache, progress.checkpoint)),
    reports: progress.read('reports', () => readReportBatchCached(options.share, readCache, progress.checkpoint)),
    beats: progress.read('beats', () => options.mode === 'remote' ? options.remote!.readBeats() : readBeatBatchFor(options.share, wantedBeats)),
    machines: progress.read('machines', () => readMachinesWithRetry(options, progress.checkpoint)),
    // 与 dispatcher.json 同一处读法；缺文件就是缺省表，坏文件整份忽略并告警一次（见 sched-ci-lanes.ts）。
    ciLanes: progress.read('ci-lanes', () => ciLanes.read()),
    hubSwitch: hub,
    // 内存下限闸(SCHED-MR6-MEMORY-DIMENSION-0924):开关开才读配置;关 = 一字不读、零痕迹。
    ...(hub.memoryFloor === true ? { memoryFloorConfig: progress.read('memory-floor', () => memoryFloorConfig.read()) } : {}),
    // CI 相处方式(SCHED-CI-COEXIST-0925):缺文件 = 让路(改前行为);读不到沿用上一次的值,见 sched-ci-policy.ts。
    ciPolicy: progress.read('ci-policy', () => ciPolicy.mode()),
    // 终止指令目录旧共享盘可能还没有，缺目录不算失联；其余读失败仍按本拍不可用处理。
    killFiles: progress.read('kill-names', () => readKillInstructionNames(paths.kill)),
    // 长期占用的续约凭据同理：旧共享盘没有 leases/，缺目录不算失联。
    leaseFiles: progress.read('resident-leases', () => readResidentLeaseFiles(paths.leases, progress.checkpoint)),
  }
}

/** 旧共享盘在首发终止指令前没有 _control/kill/；目录缺失是正常态，其余错误原样上抛。 */
function readKillInstructionNames(directory: string): string[] {
  try { return readdirSync(directory).sort() } catch (error) {
    if (hasCode(error, 'ENOENT')) return []
    throw error
  }
}

/**
 * 长期占用单的续约凭据(SCHED-MR5-RESIDENT-LEASE-0924)：只取每个心跳文件的修改时刻。
 * 判活只看「这个文件还在被写」——mtime 与台账同域，不吃跨机钟偏；文件内容只给人看，
 * 坏内容不影响派单(它本来就是可再生的续约标记，不是事实源)。目录缺失是正常态。
 */
function readResidentLeaseFiles(directory: string, checkpoint: () => void): Map<string, number> {
  const files = new Map<string, number>()
  let names: string[]
  try { names = readdirSync(directory) } catch (error) {
    if (hasCode(error, 'ENOENT')) return files
    throw error
  }
  for (const name of names) {
    checkpoint()
    const match = /^(tk-[0-9a-f]{20})[.]json$/.exec(name)
    if (!match) continue
    try { files.set(match[1]!, statSync(join(directory, name)).mtimeMs) } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
  }
  return files
}

export interface RemoteKillContext {
  share: string; at: string; sources: SchedulerSources
  state: () => ProjectionState
  append: (draft: EventDraft) => LedgerEvent
  killFiles: readonly string[]
  log: (message: string) => void
  loggedNames: Set<string>
  autoLaunch?: AutoLaunchReader
}

function finishRemoteKill(context: RemoteKillContext, ticket: TicketSnapshot,
  data: Extract<EventDraft, { type: 'finished' }>['data']): void {
  context.append({ at: context.at, type: 'finished', ticketId: ticket.ticketId, attemptId: ticket.currentAttemptId, data })
}

/** 实物落账口径与 sched-handoff.reconcileRecord 一致；那边已常规收作业侧终态(含 paused/slow)，这里只管撤单、硬超时与执行方消失。 */
function settleRemoteKilledRecord(context: RemoteKillContext, id: string, record: LifecycleStateRecord): void {
  const ticket = context.state().tickets[id]!
  if (record.state === 'inbox') {
    // 不可达防御：开跑过的单不会有信箱实物；真出现时按交接事务同款撤单搬运处理。
    if (!ticket.cancelRequested) return
    writeTicketSnapshot(context.share, ticket)
    try {
      transitionLifecycleJob({ share: context.share, epoch: record.epoch, machine: record.machine,
        submissionId: record.submissionId, from: 'inbox', to: 'quarantine', result: { ok: false, reason: '调度撤单' }, sources: context.sources })
    } catch (error) {
      // 同单双态(执行机刚搬完、旧态文件删除挂起)只放弃这一张单本拍不动,下一拍按实物重看。
      if (abandonOnStateConflict(error, { submissionId: record.submissionId, at: context.at, log: context.log })) return
      throw error
    }
    finishRemoteKill(context, ticket, { result: 'cancelled', terminal: true, reason: '调度撤单' })
    return
  }
  const result = record.result!
  const reason = typeof result.reason === 'string' && result.reason ? result.reason : `${record.state} terminal`
  if (ticket.cancelRequested && ['调度撤单', '开跑前发现已撤单'].includes(reason)) {
    finishRemoteKill(context, ticket, { result: 'cancelled', terminal: true, reason })
    return
  }
  const exitCode = Number.isSafeInteger(result.exitCode) ? result.exitCode as number : 1
  const logFile = handoffLogPath(result.logFile)
  // 执行机重启只结束本次执行；pendingQueue 留给下一拍的交接事务重排，与本文件不抢事务。
  if (record.state === 'failed' && reason === '执行机重启') {
    finishRemoteKill(context, ticket, { result: 'failed', terminal: false, reason, exitCode,
      ...(logFile === undefined ? {} : { logFile }) })
    return
  }
  const passed = record.state === 'done' && result.exitCode === 0
  finishRemoteKill(context, ticket, { result: passed ? 'passed' : 'failed', terminal: true, reason,
    exitCode: passed ? 0 : exitCode === 0 ? 1 : exitCode, ...(logFile === undefined ? {} : { logFile }) })
}

/**
 * 长期占用单的心跳断线销单(SCHED-MR5-RESIDENT-LEASE-0924)：静默超过
 * RESIDENT_LEASE_HEARTBEAT_TIMEOUT_MS 就写 finished(voided) 自动销单，授予的核当拍释放。
 * 判活锚点取「续约文件 mtime」与「许可签发时刻」里较晚的一个：从没写过心跳的单子
 * 从授予起算，绝不因为文件晚到而误销；文件被写(哪怕内容坏了)就算续约。只认字面 resident 单，
 * 其他单子一律不看(逐字节不变)。
 */
export interface ResidentLeaseContext {
  at: string
  state: () => ProjectionState
  append: (draft: EventDraft) => LedgerEvent
  /** 本拍读到的续约文件(单号 → mtime 毫秒)。缺失的单子按许可签发时刻起算。 */
  leaseFiles: ReadonlyMap<string, number>
  log: (message: string) => void
  logged: Set<string>
}
export function expireResidentLeases(context: ResidentLeaseContext): void {
  const nowMs = Date.parse(context.at)
  for (const id of Object.keys(context.state().tickets).sort()) {
    const ticket = context.state().tickets[id]!
    if (ticket.request.resident !== true || ticket.endedAt !== null || ticket.cancelRequested) continue
    if (!['queued', 'unsatisfiable', 'granted'].includes(ticket.state)) continue
    const issuedAt = ticket.attempts.at(-1)?.permit?.issuedAt
    const anchor = Math.max(issuedAt === undefined ? Date.parse(ticket.queuedAt) : Date.parse(issuedAt),
      context.leaseFiles.get(id) ?? 0)
    if (nowMs - anchor < RESIDENT_LEASE_HEARTBEAT_TIMEOUT_MS) continue
    const seconds = Math.round(RESIDENT_LEASE_HEARTBEAT_TIMEOUT_MS / 1000)
    // 从没授予过的(机器名单里没有这台机)是「登记了个压根不成立的占用」,一同按超时销单,
    // 理由里说清它没被授予；否则它会永远挂在排队里，看板上的排队数一直虚高。
    const reason = ticket.state === 'granted'
      ? `心跳断超时:长期占用登记 ${seconds} 秒没有续约,自动销单`
      : `心跳断超时:长期占用登记 ${seconds} 秒既没被授予也没有续约,自动销单`
    context.append({ at: context.at, type: 'finished', ticketId: id, attemptId: ticket.currentAttemptId,
      data: { result: 'voided', terminal: true, reason } })
    context.log(`[sched] ${id} 长期占用登记 ${seconds} 秒没有续约(心跳断),已自动销单并释放授予的核`)
  }
}

/** 票据终局后清掉残留的续约文件；还有活着的长期占用单时保留它的凭据。 */
export function cleanupResidentLeases(share: string, leaseFiles: ReadonlyMap<string, number>, liveTicketIds: ReadonlySet<string>): void {
  for (const id of leaseFiles.keys()) {
    if (liveTicketIds.has(id)) continue
    try { unlinkSync(residentLeasePath(share, id)) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
  }
}

/** 还在用凭据的长期占用单：未终局、且已经拿到许可(或正在等授予的第一拍)。 */
function liveResidentTicketIds(state: ProjectionState): Set<string> {
  const live = new Set<string>()
  for (const ticket of Object.values(state.tickets)) {
    if (ticket.request.resident !== true || ticket.endedAt !== null || ticket.cancelRequested) continue
    live.add(ticket.ticketId)
  }
  return live
}

/**
 * 挂号即授予(SCHED-MR5-RESIDENT-LEASE-0924)：长期占用单不排队、不吃准入——它登记的是
 * 「这台机器上已经跑着的服务」，所以派单员在读快照后当拍直接授予，许可带 resident 标、
 * 核数恰等于申请值，于是它计入该机 grantedCores、当拍就从队列里消失。
 * 机器名字不在本拍集群名单里(登记错了机器)时不授予，只记一行，不猜、不造机器。
 */
export interface ResidentGrantContext {
  at: string
  state: () => ProjectionState
  append: (draft: EventDraft) => LedgerEvent
  sources: SchedulerSources
  machineNames: readonly string[]
  log: (message: string) => void
  logged: Set<string>
}
export function grantResidentLeases(context: ResidentGrantContext): void {
  for (const id of Object.keys(context.state().tickets).sort()) {
    const ticket = context.state().tickets[id]!
    if (ticket.request.resident !== true || ticket.state !== 'queued' || ticket.endedAt !== null || ticket.cancelRequested) continue
    const machine = ticket.request.allowedMachines[0]!
    if (!context.machineNames.includes(machine)) {
      if (!context.logged.has(`machine:${id}`)) {
        context.logged.add(`machine:${id}`)
        context.log(`[sched] ${id} 的长期占用机器 ${machine} 不在本拍集群名单里，先不授予`)
      }
      continue
    }
    context.append({ at: context.at, type: 'granted', ticketId: id, attemptId: ticket.currentAttemptId, data: { permit: {
      ticketId: id, attemptId: ticket.currentAttemptId, token: context.sources.nonce(), machine,
      category: ticket.request.category, grantedCores: ticket.request.requestedCores,
      issuedAt: context.at, resident: true,
    } } })
    context.log(`[sched] ${id} 长期占用登记:${machine} ${ticket.request.requestedCores} 核，等心跳续约`)
  }
}

/**
 * auto 单的硬超时(SCHED-MENU-HARD-TIMEOUT-0924，HUB4 裁定 4 的落地)：菜单项写了 hardTimeoutMin
 * 就按它算(任何项目都认)；菜单没写时只有 rogue 退回 JOB_HARD_TIMEOUT_MS，其余项目不限——
 * 与它们今天在挂号机本机跑一致。rogue 的菜单项不写这个字段，故 rogue 判据与结果一字不变。
 */
export function autoJobHardTimeoutLimit(ticket: TicketSnapshot): number | undefined {
  const menu = ticket.request.menu
  const item = menu === undefined ? null : projects.getMenuItem(ticket.request.project, menu.item)
  return menuHardTimeoutMs(item) ?? autoJobHardTimeoutMs(ticket)
}

/**
 * T5 远程终止终局检查：每拍在交接事务之后、快照之前执行，只管 running/paused/slow 的集群单
 * (交接事务不处理暂停/低速)。硬超时在此判；cancelRequested 的单保证指令在档，然后按实物、
 * 宽限与活性三重证据收尾。活性否决用两个文件的共享盘 mtime——与台账同域可比，不受执行机钟偏影响：
 * 指令发布之后心跳文件仍在更新说明执行端活着(尚未吃到指令)，该拍绝不收尾；执行机消失后心跳
 * 停更，才允许宽限期满按「远程终止」落 failed 终态。绝不单凭心跳过期收尾。
 */
export function remoteKillClusterTickets(context: RemoteKillContext): void {
  const liveKillSubmissions = new Set<string>()
  for (const id of Object.keys(context.state().tickets).sort()) {
    let ticket = context.state().tickets[id]!
    if ((ticket.request.execution !== 'cluster' && ticket.request.execution !== 'auto') || ticket.endedAt !== null || ticket.pendingQueue) continue
    if (!['running', 'paused', 'slow'].includes(ticket.state)) continue
    const active = ticket.attempts.at(-1)!
    if (!active.intent || !active.permit || active.startedAt === null) continue
    let timedOut = false
    const limit = ticket.request.execution === 'auto' ? autoJobHardTimeoutLimit(ticket) : jobHardTimeoutMs(ticket.request.work.type)
    const launchAt = ticket.request.execution === 'auto'
      ? context.autoLaunch?.effectiveLaunchAt(ticket, context.at) : active.startedAt
    if (limit !== undefined && launchAt !== undefined && !ticket.cancelRequested) {
      // 有效耗时只扣已确认挂起区间；slow 计入运行，低速不豁免硬超时。
      const effective = measureSuspensionWindow(Date.parse(launchAt), Date.parse(context.at),
        { intervals: active.suspension?.intervals ?? [], slowIntervals: active.suspension?.slowIntervals ?? [] }).elapsedMs
      if (effective >= limit) {
        context.append({ at: context.at, type: 'cancel-requested', ticketId: id, attemptId: ticket.currentAttemptId,
          data: { reason: `硬超时:${ticket.request.work.type} 有效耗时 ${Math.floor(effective / 1000)}s 超过上限 ${Math.round(limit / 60_000)} 分钟(已扣除确认挂起时段)` } })
        timedOut = true
        ticket = context.state().tickets[id]!
        context.log(`[sched] ${id} 触发硬超时(${ticket.request.work.type} 有效 ${Math.floor(effective / 1000)}s ≥ ${Math.round(limit / 60_000)} 分钟)，已记撤单并下达远程终止`)
      }
    }
    if (!ticket.cancelRequested) continue
    const submission = submissionId(id, ticket.currentAttemptId)
    liveKillSubmissions.add(submission)
    const path = remoteKillPath(context.share, id, ticket.currentAttemptId)
    let instruction: RemoteKillInstruction | undefined
    try { instruction = validateRemoteKillInstruction(JSON.parse(readFileSync(path, 'utf8'))) }
    catch (error) {
      if (!hasCode(error, 'ENOENT')) {
        // 坏指令文件修不回来就没人能终止这棵树；replace 重发以新首发时刻重新起算宽限。
        context.log(`[sched] ${submission} 的终止指令不可读(${errorMessage(error)})，重发修复`)
        instruction = undefined
      }
    }
    // 档上已有指令(比如人工先撤了单、超时后到)时沿用首发时刻，不重置宽限锚点。
    if (instruction === undefined) publishRemoteKillInstruction(context.share, {
      schema: 1, ticketId: id, attemptId: ticket.currentAttemptId, submissionId: submission,
      machine: active.intent.machine, source: timedOut ? `hard-timeout:${ticket.request.work.type}` : 'dispatcher-recover',
      reason: timedOut ? `远程终止:硬超时(${ticket.request.work.type})` : '远程终止:派单员补发(受理与发布间断档)',
      createdAt: context.at,
    }, 'replace')
    if (instruction === undefined) continue // 本拍刚发布，宽限从下一拍起算。
    let observation: ReturnType<typeof observeHandoff>
    // 观察不加闸(SCHED-PAYLOAD-FIELD-PROTOCOL-GATE 第三轮修正):闸只管发布,读数抖动不许收窄「期望」。
    try { observation = observeHandoff(context.share, ticket, active.intent, context.at) }
    catch (error) {
      // 活迁移锁只代表执行机正在搬运；本文件不接管任何租约，下一拍重新观察。
      if (error instanceof ActiveTransitionLeaseError) continue
      throw error
    }
    if (observation.kind === 'transition' || observation.kind === 'unknown') continue
    if (observation.kind === 'absent' || observation.kind === 'claim-only') {
      if (observation.kind === 'claim-only') {
        finishRemoteKill(context, ticket, { result: 'handoff-interrupted', terminal: false,
          reason: '交接中断:只有永久 claim，五态皆无，旧提交永远不能开跑' })
        continue
      }
      // 与交接事务同一立场：已确认投递的实物消失是证据损毁，不能证明未开跑，禁止换号重发。
      if (active.dispatchedAt !== null) throw new Error('[sched] 已确认投递的工单实物消失，不能证明未开跑，禁止换号重发')
      continue
    }
    const record = observation.record
    if (record.state !== 'running') { settleRemoteKilledRecord(context, id, record); continue }
    if (Date.parse(context.at) - Date.parse(instruction.createdAt) < REMOTE_KILL_GRACE_MS) continue
    // 活性否决：指令发布之后心跳文件仍在共享盘上更新 = 执行端活着还没吃到指令，绝不收尾。
    let beatMtime: number | undefined
    try { beatMtime = statSync(join(schedPaths(context.share).beats, `${submission}.json`)).mtimeMs } catch { /* 无心跳文件 = 执行方已消失。 */ }
    let instructionMtime: number | undefined
    try { instructionMtime = statSync(path).mtimeMs } catch { /* 刚被清理则下一拍重发。 */ }
    if (beatMtime !== undefined && instructionMtime !== undefined && beatMtime > instructionMtime) {
      if (!context.loggedNames.has(`alive:${submission}`)) {
        context.loggedNames.add(`alive:${submission}`)
        context.log(`[sched] ${submission} 已下达终止指令但心跳仍在更新，执行端未吃下指令，暂不收尾`)
      }
      continue
    }
    context.log(`[sched] ${submission} 终止指令宽限 ${Math.round(REMOTE_KILL_GRACE_MS / 1000)}s 届满仍无回报与终止性实物，按执行方消失收尾`)
    finishRemoteKill(context, ticket, { result: 'failed', terminal: true, exitCode: 1,
      reason: `远程终止:指令发出 ${Math.round(REMOTE_KILL_GRACE_MS / 1000)}s 内无回报与终止性实物，按执行方消失收尾` })
  }
  cleanupRemoteKillInstructions(context, liveKillSubmissions)
}

/** 票据终局后清掉指令文件；未终结单子的指令保留，供执行端重试读取与事后核对。 */
function cleanupRemoteKillInstructions(context: RemoteKillContext, live: ReadonlySet<string>): void {
  for (const name of context.killFiles) {
    if (!name.endsWith('.json')) {
      if (!context.loggedNames.has(`name:${name}`)) {
        context.loggedNames.add(`name:${name}`)
        context.log(`[sched] 终止指令目录含未知文件名，已跳过:${JSON.stringify(name)}`)
      }
      continue
    }
    const submission = name.slice(0, -5)
    if (live.has(submission)) continue
    try { unlinkSync(join(schedPaths(context.share).kill, name)) }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
  }
}

export function startSchedulerDaemon(options: SchedulerDaemonOptions): SchedulerDaemon {
  if (options.mode === 'remote' && !options.remote) throw new Error('[sched] remote port required')
  if (options.mode !== 'remote' && options.remote) throw new Error('[sched] remote port requires explicit remote mode')
  if (!deployment.getDeploymentConfig().machines.some((machine: { name: string }) => machine.name === options.machine)) {
    throw new Error('[scheduler-config] dispatcher machine not configured')
  }
  assertSchedulerWritable(options.share)
  requireAgentProtocol(options.protocol, 'dispatcher.protocol'); requireSha1(options.head, 'dispatcher.head')
  const config = readDispatcherConfig(options.share)
  // 必须在抢全局租约前核对明确的本机身份，不能借用配置里的主机名冒领写者。
  if (!config || config.machine !== options.machine) throw new Error('[sched] 本机不是指定的派单主机')
  const owner = claimSchedulerOwner(options)
  // 既有共享盘补 usage-history-v1 能力位(SCHED-CORES-HISTORY-AUTOCORRECT-1010):与
  // publishSchedulerClient 同一发布事务(读 format → 并集 → 原子 replace,见 sched-usage-history.ts)。
  /**
   * 启动重放(SCHED-DISPATCHER-RESILIENCE-1009 ⑤):重建改增量——内容没变的快照只读字节比对、
   * 不再整盘重写;重建途中距上次续租超过半个租期就先续租,慢重放不再把 90 秒租约熬到只剩一截。
   * 续租点刻意不在 commit 回调里:owner 的 guard 是同机排他文件锁(create-only),commit 持锁期间
   * 嵌套 renew 会撞上自己刚建的 guard、按「正被另一个活着的进程占用」失败,再经 sched-owner 的
   * 包装把写者永久停掉;commit 回调抛任何异常同样会停写者。所以进度回调只发 'pause' 信号让重建
   * 当拍让位、commit 正常返回,续租在 commit 之外做完,再开下一笔 commit 从断点增量续上——
   * 已写好的快照一次字节比对就跳过,断点之前的单子连盘都不读。完成的那一刻距上次续租必不足
   * 半个租期,租约永远留有余量。
   *
   * 整本台账的重读与重投影(SCHED-STARTUP-REPLAY-LEASE-1017):共享盘上万张单子时,这一步本身就要
   * 几十秒,旧写法每一笔 commit 都重来一遍——每笔只剩一点写快照的进度,续租前后租约被反复吃光,
   * 最终在 owner.renew 报租约过期、启动失败。现在这一步是纯只读,放在 commit 之外只做一次:
   * 读完台账、投影完各续租一次(续租点只落在两个整段之间,投影仍是一整次调用,规范编码一字不变),
   * 之后每笔 commit 只在台账指纹没变时复用这份投影,变了就按原口径从头完整重放。
   * 台账校验一条没松(校验和/seq/日期/时间序照旧,中间坏行照旧抛错),租约时长与续租节奏也一个没改。
   */
  const halfLeaseMs = owner.handle.leaseDurationMs / 2
  let lastStartupRenewMs = Date.parse(isoTime(options.sources.now()))
  /** 距上次续租已满 minimumAgeMs 才续;owner.renew 自身另有 SCHED_RENEW_MS 的节流,续租失败按原口径抛:启动失败,交给看护重拉。 */
  const renewStartupLease = (minimumAgeMs: number): void => {
    if (Date.parse(isoTime(options.sources.now())) - lastStartupRenewMs < minimumAgeMs) return
    owner.renew()
    lastStartupRenewMs = Date.parse(isoTime(options.sources.now()))
  }
  const prepared = prepareLedgerReplay(options.share, () => renewStartupLease(SCHED_RENEW_MS))
  if (prepared.status !== 'ok') throw new Error(`[sched] 启动重放失败:${prepared.status}:${prepared.path}`)
  let replay: PreparedLedgerReplay | undefined = prepared.value
  let renewResumeAfter: string | undefined
  let rebuilt: RebuildResult
  for (;;) {
    let pauseForRenewal = false
    rebuilt = owner.commit(() => {
      if (options.mode !== 'remote') publishSchedulerClient(options.share)
      ensureUsageHistoryCapability(options.share) // 幂等,每轮增量 commit 都可重做
      return rebuildTicketSnapshots(options.share, {
        replay,
        onReplay: next => { replay = next },
        resumeAfter: renewResumeAfter,
        onTicket: ticket => {
          if (Date.parse(isoTime(options.sources.now())) - lastStartupRenewMs < halfLeaseMs) return
          renewResumeAfter = ticket.ticketId
          pauseForRenewal = true
          return 'pause'
        },
      })
    })
    if (rebuilt.status !== 'ok' || !pauseForRenewal) break
    renewStartupLease(0) // commit 已正常返回:续租在 commit 之外做,绝不嵌套。
  }
  replay = undefined // 启动重放结束:重放产物不再被引用,后续由逐拍增量接手。
  if (rebuilt.status !== 'ok') throw new Error(`[sched] 启动重放失败:${rebuilt.status}:${rebuilt.path}`)
  let state = rebuilt.value
  let tick = 0
  let stopped = false
  // SCHED-SELF-OVERHEAD-0925:终态文件读缓存与账本尾增量,随进程走;null 显式回基线行为。
  const readCache = options.readCache === undefined ? createSchedReadCache() : options.readCache
  const ledgerTail = readCache === null ? null : emptyLedgerTail()
  // null 仍禁用缓存和账本尾增量;复用同口径批读器,使直读对照也有逐文件续租点。
  const tickReadCache = readCache ?? createSchedReadCache({ passthrough: true })
  const renewReadOwner = (): void => {
    try { owner.renew() } catch (error) { stopped = true; throw error }
  }
  const readProgress = createSchedReadProgress(() => Date.parse(isoTime(options.sources.now())), renewReadOwner, options.log)
  // 只缓存本进程已写出的回执；重启为空，能补齐流水已完成但文件未写出的切点。
  const deliveredReceipts = new Set<string>()
  const loggedInvalidNames = new Set<string>()
  const reportReceipts = new Set<string>()
  const invalidReportNames = new Set<string>()
  // 本机回收「保持占用」日志的已记集合：跨拍保留，同一执行只记第一次；离态/回收时由回收器清键。
  const loggedHoldNames = new Set<string>()
  // 远程终止终局检查的日志去重集合：跨拍保留，同一执行只报第一次。
  const loggedKillNames = new Set<string>()
  // 长期占用单的告警去重集合（登记错机器只报一次）。
  const loggedResidentNames = new Set<string>()
  const loggedSnapshotNames = new Set<string>()
  // 挂号端等待心跳(SCHED-QUEUED-ORPHAN-LIVENESS-1009):seq 观察记录只在本进程内存里,重启后第一次见只记不判。
  const waitingTracker = createWaitingTracker()
  let loggedWaitingFailure = false
  let loggedQueuedCancelFailure = false
  const retainedDays = new Set(state.globalTimeline.filter(event => event.type === 'log-retention-run').map(event => utcDate(event.at)))
  // 每拍现读，改文件立刻生效；告警限频状态跟着进程走（跨拍只报一行）。
  const ciLaneReader = createCiLaneReserveReader({ share: options.share, warn: message => options.log?.(message) })
  const hubSwitchReader = createHubSwitchReader({ share: options.share, warn: message => options.log?.(message) })
  const ciPolicyReader = createCiPolicyReader({ share: options.share, warn: message => options.log?.(message),
    notice: message => options.log?.(message), now: () => Date.parse(isoTime(options.sources.now())) })
  const managedLoadTracker = createManagedLoadTracker({ warn: message => options.log?.(message) })
  // 超用标红(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925):边车写盘器跟进程走;失败只告警一次,成功拍复位。
  const overuseReporter = createOveruseReporter({ share: options.share, warn: message => warnProbe(message) })
  // 用量历史(SCHED-CORES-HISTORY-AUTOCORRECT-1010):按执行累计代理心跳实测;统计不依赖
  // managedLoad 开关,任何失败只告警一次(成功拍复位)、绝不停派单。
  const usageTracker = createUsageHistoryTracker()
  let loggedUsageFailure = false
  const usageFailure = (error: unknown): void => {
    if (!loggedUsageFailure) warnProbe(`[sched] 用量历史统计出错,本拍照常派单:${errorMessage(error)}`)
    loggedUsageFailure = true
  }
  const ciBorrowController = createCiBorrowController({ warn: message => options.log?.(message) })
  // 内存下限闸(SCHED-MR6-MEMORY-DIMENSION-0924):读配置器只在 hub.memoryFloor 为 true 时才被碰;
  // 记账器与边车写盘器可注入(测试),缺省用真身。
  const memoryFloorConfigReader = createMemoryFloorConfigReader({ share: options.share, warn: message => options.log?.(message) })
  const memoryFloorTracker = options.memoryFloorTracker ?? createMemoryFloorTracker()
  const memoryFloorReporter = options.memoryFloorReporter ?? createMemoryFloorReporter({ share: options.share,
    log: message => options.log?.(message) })
  const originProbe = options.mode === 'remote' ? options.remote!.originProbe : options.originProbe ?? createOriginProbe({ log: message => options.log?.(message),
    now: () => Date.parse(isoTime(options.sources.now())) })
  const etaBook = options.etaBook ?? createEtaBook(Object.values(state.tickets))
  const crossMachine = options.crossMachine ?? CROSS_MACHINE_WIRED
  const autoLaunch = options.autoLaunch ?? createAutoLaunchReader({ share: options.share, log: message => options.log?.(message) })
  const snapshotSweeper = options.snapshotSweeper ?? createSnapshotSweeper({ share: options.share,
    now: () => Date.parse(isoTime(options.sources.now())), log: message => options.log?.(message) })
  let probeRequests: OriginProbeRequest[] = []
  let loggedProbeReadFailure = false
  let loggedProbeStartFailure = false
  let loggedEtaFailure = false
  let loggedSweepFailure = false
  const warnProbe = (message: string): void => { try { options.log?.(message) } catch { /* 告警不得停派单员 */ } }
  // 快照(缓存)写失败的连续拍数与「该全量重写」标记，都跟着进程走；成功拍清零，见 refreshSnapshots。
  let snapshotsDirty = false
  let snapshotWriteFailures = 0
  // 心跳(展示缓存)写失败的连续拍数,跟着进程走;成功一拍清零,见下方 writeDispatcherHeartbeat 调用。
  let heartbeatWriteFailures = 0
  /**
   * 超用标记(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925)的「已写出」一栏:按单号记上次成功
   * 写进快照的标记规范编码,没标记不存键。标记因读数过期(执行机掉线)或总开关关掉(tracker 清空)
   * 而消失时,当拍已经现算不出它,previous 若按当拍现算做种子,revision 就和要写的完全一致、
   * 快照不重写,磁盘上带 overuse 的旧快照永远擦不掉;拿「已写出的」当种子,消失那一拍 revision
   * 才对不上,快照重写、标记落空。snapshotsDirty 整表清空不用动它:previous 清了自然全量重写,
   * 写成功后按写出的内容更新。
   */
  const writtenMarks = new Map<string, string>()
  /**
   * 快照写失败的降级：本拍跳过(流水已落不撤、心跳与快照本拍不写、下一拍全量补写)，只记一行告警；
   * 连续到上限才把原错误抛回保护区，由 owner 按原口径停派单员。告警每拍一行，上限本身就封住了刷屏。
   */
  const snapshotWriteFailure = (error: unknown): boolean => {
    snapshotWriteFailures += 1
    try {
      options.log?.(`[sched] 快照写入失败,本拍跳过(连续第 ${snapshotWriteFailures}/${SNAPSHOT_WRITE_FAILURE_LIMIT} 拍):${errorMessage(error)}`)
    } catch { /* 告警不得停派单员 */ }
    if (snapshotWriteFailures >= SNAPSHOT_WRITE_FAILURE_LIMIT) throw error
    return false
  }
  // CI-RUNNER-LABEL-ROUTING-0924:车道标签路由边车。初始化失败只告警,派单照常;off 档零开销。
  let ciLabels: CiLabelRouter | null = null
  if (deployment.getDeploymentConfig().ci.labels !== null && options.ciLabels !== null) {
    if (options.ciLabels !== undefined) ciLabels = options.ciLabels
    else {
      try {
        ciLabels = createCiLabelRouter({ share: options.share,
          host: { machine: options.machine, pid: options.pid, protocol: options.protocol, head: options.head },
          now: () => isoTime(options.sources.now()),
          ...(options.ciLabelsGithub !== undefined ? { github: options.ciLabelsGithub } : {}),
          log: message => warnProbe(message) })
      } catch (error) { warnProbe(`[sched] CI 标签路由初始化失败,派单照常:${errorMessage(error)}`) }
    }
  }
  let ciLabelBatch: { at: string; machines: CiMachineObservation[] } = { at: isoTime(options.sources.now()), machines: [] }
  let loggedCiLabelFailure = false
  // 内存闸边车/记账的失败只告警一次,成功拍复位;派单绝不能被边车卡住。
  let loggedMemoryFloorFailure = false
  // 超用标记/边车的失败只告警一次,成功拍复位;标记是展示缓存,绝不能反过来卡住派单。
  let loggedOveruseFailure = false
  const append = (draft: EventDraft): LedgerEvent => {
    // 用量历史(SCHED-CORES-HISTORY-AUTOCORRECT-1010):全部 11 处 finished 事件写入点
    // (sched-commands / sched-daemon / sched-handoff / sched-reclaim / sched-reports /
    // sched-snapshot-gate / sched-waiting)都经此漏斗落账,这里统一折出该次执行的累计
    // 实测塞进 data.usage;没有任何读数的执行不带该字段,事件逐字节与改前一致。
    if (draft.type === 'finished') {
      try {
        const usage = usageTracker.finish({ ticketId: draft.ticketId, attemptId: draft.attemptId })
        if (usage !== null) draft = { ...draft, data: { ...draft.data, usage } }
      } catch (error) { usageFailure(error) }
    }
    // 仅在下方 owner.commit 的真实写者 fencing 内启用；普通追加仍拒绝墙钟倒退。
    const event = appendLedgerEvent(options.share, draft, state.cursor, ledgerTail, true)
    state = projectLedgerDelta([event], state)
    // 带用量的结束顺手滚进统计文件(按 usageKey 分组、每组最近 20 条、失败只告警)。
    if (event.type === 'finished' && event.data.usage !== undefined) {
      try {
        const ticket = state.tickets[event.ticketId!]
        const attempt = ticket?.attempts.find(value => value.attemptId === event.attemptId)
        if (ticket !== undefined && attempt !== undefined) {
          const usageKey = ticket.request.usageKey ?? `${ticket.request.project}|${ticket.request.work.type}`
          const entry: UsageHistoryEntry = { at: event.at, ticketId: event.ticketId!,
            project: ticket.request.project, workType: ticket.request.work.type, usageKey,
            grantedCores: attempt.grantedCores, requestedCores: ticket.request.requestedCores,
            runningMs: attempt.startedAt === null ? 0 : Math.max(0, Date.parse(event.at) - Date.parse(attempt.startedAt)),
            ...event.data.usage }
          appendUsageHistory({ share: options.share, key: usageKey, entry, warn: message => warnProbe(message) })
          loggedUsageFailure = false
        }
      } catch (error) { usageFailure(error) }
    }
    if (event.type === 'finished' && event.data.result === 'passed') {
      try { etaBook.add(state.tickets[event.ticketId]!); loggedEtaFailure = false }
      catch (error) {
        if (!loggedEtaFailure) warnProbe(`[sched] 预计完成样本更新失败:${errorMessage(error)}`)
        loggedEtaFailure = true
      }
    }
    options.hooks?.afterLedger?.(event)
    return event
  }
  // 迁移锁跳过/报警日志的限频表(键 → 上次记日志的毫秒)；过了间隔的条目随手清掉，表不会越积越长。
  const barrierLoggedAt = new Map<string, number>()
  /** 读快照撞上迁移锁：本拍什么都不写(流水、快照、心跳)，记一行限频日志后照常续租，不退出。 */
  const skipBarrierTick = (barrier: TransitionLeaseBarrierError): void => {
    const nowMs = Date.parse(isoTime(options.sources.now()))
    const live = barrier.isLiveAt(nowMs)
    const key = `${live ? 'live' : 'expired'}:${barrier.message}`
    for (const [logged, at] of barrierLoggedAt) {
      if (nowMs - at >= TRANSITION_LOCK_LOG_INTERVAL_MS) barrierLoggedAt.delete(logged)
    }
    if (!barrierLoggedAt.has(key)) {
      barrierLoggedAt.set(key, nowMs)
      options.log?.(live
        ? `[sched] 本拍跳过调度：读集群快照撞上执行机正在搬单的迁移锁，重读 ${TRANSITION_LOCK_RETRY_DELAYS_MS.length} 次仍在；`
          + `流水、快照、心跳本拍都不写，下一拍再读:${barrier.message}`
        : `[sched][报警] 集群快照里有已过期、没人收拾的迁移锁，本拍不调度；派单员不退出、照常续租，`
          + `每拍重读，锁被接管或清掉后自动恢复:${barrier.message}`)
    }
    owner.renew()
  }
  /**
   * 读快照撞上「同一张单同时出现在两个状态目录」(SCHED-DISPATCHER-STATUS-CONFLICT-EXIT):
   * 多半是执行机刚搬完单、旧态文件还在等共享盘收走,几秒内自愈。旧代码当真故障整个退出,
   * 看护反复重拉、调度台停摆。现在:本拍什么都不写(流水、快照、心跳),记一行限频日志后
   * 照常续租,下一拍重读;限频表与迁移锁共用(同一把尺,60 秒最多一行)。
   */
  const skipConflictTick = (conflict: LifecycleStateConflictError): void => {
    const nowMs = Date.parse(isoTime(options.sources.now()))
    const key = `conflict:${conflict.message}`
    for (const [logged, at] of barrierLoggedAt) {
      if (nowMs - at >= TRANSITION_LOCK_LOG_INTERVAL_MS) barrierLoggedAt.delete(logged)
    }
    if (!barrierLoggedAt.has(key)) {
      barrierLoggedAt.set(key, nowMs)
      options.log?.(`[sched] 本拍跳过调度：集群快照里同一张单出现双态(多半是执行机刚搬完单、旧态文件删除挂起)，`
        + `流水、快照、心跳本拍都不写，下一拍再读，派单员不退出:${conflict.message}`)
    }
    owner.renew()
  }
  return {
    get state() { return state }, owner,
    commit: operation => {
      if (stopped || owner.stopped) throw new Error('[sched] 派单员已经停止')
      owner.renew()
      return owner.commit(() => operation({ at: isoTime(options.sources.now()), state: () => state, append }))
    },
    tick: () => {
      if (stopped || owner.stopped) throw new Error('[sched] 派单员已经停止')
      renewReadOwner()
      let input: ReturnType<typeof readTick>
      // 上一拍结束时的在跑集合决定本拍要读哪些心跳;刚开跑的单下一拍才进集合,晚一拍可见,无害。
      const wantedBeats = activeAttemptSubmissions(Object.values(state.tickets))
      try { input = readTick(options, config.machine, ciLaneReader, hubSwitchReader, ciPolicyReader, memoryFloorConfigReader,
        tickReadCache, wantedBeats, readProgress) } catch (error) {
        // checkpoint 续租错误即使带 EIO/EPERM 也不能被包装为可恢复读失败。
        if (stopped || owner.stopped) { stopped = true; throw error }
        if (error instanceof TransitionLeaseBarrierError) {
          // 续租失败与保护区里一样永久停写：owner 已自行停止，这里同步标记并上抛。
          try { skipBarrierTick(error) } catch (renewError) { stopped = true; throw renewError }
          return false
        }
        if (error instanceof LifecycleStateConflictError) {
          // 同单双态是执行机搬单尾巴造成的几秒自愈瞬态:本拍跳过、照常续租,绝不退出。
          try { skipConflictTick(error) } catch (renewError) { stopped = true; throw renewError }
          return false
        }
        if (error instanceof SchedulerReadUnavailableError || IO_ERRORS.some(code => causedByCode(error, code))) {
          renewReadOwner()
          options.log?.(`[sched] 本拍不写入，下一拍再读:${errorMessage(error)}`)
          return false
        }
        stopped = true
        throw error
      }
      try {
        owner.renew()
        const committed = owner.commit(() => {
          const at = isoTime(options.sources.now())
          const sources = { ...options.sources, now: () => at }
          /**
           * 超用标记(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925)只认在管四态里与当前执行一致的;
           * revision 第三段带标记的规范编码:标记变了(哪怕台账没动)也要重写快照,
           * 无标记的票据 revision 与改前逐字相同,快照字节不变。
           */
          const usableMark = (marks: ReadonlyMap<string, TicketOveruse>, ticket: TicketSnapshot): TicketOveruse | undefined => {
            const raw = marks.get(ticket.ticketId)
            if (raw === undefined || raw.attemptId !== ticket.currentAttemptId
              || !['granted', 'running', 'paused', 'slow'].includes(ticket.state)) return undefined
            // 兜底:标记是展示缓存,校验不过就丢标记照写快照,绝不让它拖垮快照写入、把派单员停掉。
            try { validateTicketOveruse(raw); return raw } catch { return undefined }
          }
          const revisionOf = (marks: ReadonlyMap<string, TicketOveruse>, ticket: TicketSnapshot): string => {
            const mark = usableMark(marks, ticket)
            return `${ticket.lastSeq}/${ticket.accountedAt}/${mark === undefined ? '' : canonicalJson(mark)}`
          }
          // previous 的种子用「已写出」的标记(writtenMarks),不用本拍现算:标记消失的那一拍
          // (读数过期、开关关、终态),现算已经没有它,拿现算当种子会让 revision 恰好一致、
          // 磁盘上的旧标记擦不掉。refreshSnapshots 里的 revision 仍按现算,两者之差就是要重写的。
          const previous = new Map(Object.values(state.tickets).map(ticket =>
            [ticket.ticketId, `${ticket.lastSeq}/${ticket.accountedAt}/${writtenMarks.get(ticket.ticketId) ?? ''}`]))
          /**
           * 写成功才记账；上一拍失败过就整表清空重来——票据的 revision 自己不会变回来，只认 revision
           * 会让失败那张永远补不上。返回 false = 本拍跳过(调用方直接返回，心跳与后续写入本拍不做)。
           */
          const refreshSnapshots = (): boolean => {
            if (snapshotsDirty) { previous.clear(); snapshotsDirty = false }
            const marks = managedLoadMarks(managedLoadTracker, at)
            for (const ticket of Object.values(state.tickets)) {
              const revision = revisionOf(marks, ticket)
              if (previous.get(ticket.ticketId) === revision) continue
              const overuse = usableMark(marks, ticket)
              try { writeTicketSnapshot(options.share, overuse === undefined ? ticket : { ...ticket, overuse }) }
              catch (error) { snapshotsDirty = true; return snapshotWriteFailure(error) }
              previous.set(ticket.ticketId, revision)
              // 写成功才记「已写出」:快照里现在真有什么,种子下一拍就按什么算。
              if (overuse === undefined) writtenMarks.delete(ticket.ticketId)
              else writtenMarks.set(ticket.ticketId, canonicalJson(overuse))
            }
            // 票据从投影里消失(回收、清账),已写出的标记跟着作废;键在而无票,种子就无从对上。
            for (const id of writtenMarks.keys()) if (!Object.hasOwn(state.tickets, id)) writtenMarks.delete(id)
            snapshotWriteFailures = 0
            return true
          }
          state = ingestSubmissions(options.share, state, sources, { ...options.hooks?.intake,
            batch: input.submissions, project: projectLedgerDelta }, true).state
          acceptCommands({ share: options.share, at, dispatcherHost: config.machine, remote: options.mode === 'remote', state: () => state, append,
            deliveredReceipts, loggedInvalidNames, log: message => options.log?.(message) }, input.commands)
          const untilAt = state.reservationUntil[submissionKey(config.machine)]
          if (untilAt && untilAt <= at) append({ at, type: 'reservation-changed', data: {
            machine: config.machine, requestedCores: 0, reason: '限时到期,自动取消预留',
          } })
          // 长期占用单(SCHED-MR5-RESIDENT-LEASE-0924)：先按心跳判销单，再当拍授予新登记的，
          // 最后清掉终局票据残留的凭据。这三步都排在排队/准入之前——登记即授予的单子不进队列。
          const machineNames = input.machines.machines.map(candidate => candidate.machine)
          if (options.mode !== 'remote') expireResidentLeases({ at, state: () => state, append, leaseFiles: input.leaseFiles,
            log: message => options.log?.(message), logged: loggedResidentNames })
          grantResidentLeases({ at, state: () => state, append, sources, machineNames,
            log: message => options.log?.(message), logged: loggedResidentNames })
          cleanupResidentLeases(options.share, input.leaseFiles, liveResidentTicketIds(state))
          acceptSuspensionReports({ at, state: () => state, append, beats: input.beats, log: message => options.log?.(message) })
          acceptReports({ share: options.share, at, state: () => state, append, remote: options.mode === 'remote', deliveredReceipts: reportReceipts,
            loggedInvalidNames: invalidReportNames, log: message => options.log?.(message) }, input.reports)
          for (const invalid of input.beats.invalid) options.log?.(`[sched] 忽略非法执行心跳:${invalid}`)
          if (options.mode !== 'remote') reclaimLocalAttempts({ at, machine: config.machine, tickets: Object.values(state.tickets), beats: input.beats,
            append, probe: options.probeProcess ?? probeDispatcherExecutionProcess, log: message => options.log?.(message), loggedHoldNames })
          // 授予后一直不开跑的本机单按「挂号端没来领」收回(SCHED-GRANTED-ORPHAN-NO-RECLAIM);
          // 只动 granted 的本机单,auto/集群单不在此列。
          if (options.mode !== 'remote') reclaimUnstartedGrants({ at, machine: config.machine, tickets: Object.values(state.tickets), append,
            log: message => options.log?.(message) })
          // 挂号端等待心跳停更 2 分钟 = 挂号端已不在:排队的撤单、授予未开跑的立即收回(SCHED-QUEUED-ORPHAN-LIVENESS-1009)。
          // 判定自身出错只告警(连续失败只报一行)、本拍照常派单;写流水失败与别处同口径上抛,不在这里吞掉。
          let waitingAppendError = false
          try {
            if (options.mode !== 'remote') waitingTracker.reclaim({ at, share: options.share, tickets: Object.values(state.tickets),
              append: draft => { try { return append(draft) } catch (error) { waitingAppendError = true; throw error } },
              log: message => options.log?.(message) })
            loggedWaitingFailure = false
          } catch (error) {
            if (waitingAppendError) throw error
            if (!loggedWaitingFailure) warnProbe(`[sched] 等待心跳判定出错，本拍跳过判定、照常派单:${errorMessage(error)}`)
            loggedWaitingFailure = true
          }
          // 存量兜底撤单(SCHED-REQUEUE-IGNORES-CANCEL-1009):处理完指令之后、准入决策之前,
          // 把排队中还带着撤单标记的单子(旧版派单员重排出来的、断电留下的)按兜底原因终局。
          // 判定自身出错只告警(连续失败只报一行)、本拍照常派单;写流水失败与别处同口径上抛。
          let queuedCancelAppendError = false
          try {
            reclaimQueuedCancelRequested({ at, tickets: Object.values(state.tickets),
              append: draft => { try { return append(draft) } catch (error) { queuedCancelAppendError = true; throw error } },
              log: message => options.log?.(message) })
            loggedQueuedCancelFailure = false
          } catch (error) {
            if (queuedCancelAppendError) throw error
            if (!loggedQueuedCancelFailure) warnProbe(`[sched] 排队撤单兜底出错，本拍跳过兜底、照常派单:${errorMessage(error)}`)
            loggedQueuedCancelFailure = true
          }
          let probeResults: OriginProbeResult[] = []
          try { probeResults = originProbe.take(); loggedProbeReadFailure = false }
          catch (error) { if (!loggedProbeReadFailure) warnProbe(`[sched] 所有者探测结论不可读:${errorMessage(error)}`); loggedProbeReadFailure = true }
          probeRequests = applyPlacementChecks({ share: options.share, at, hub: input.hubSwitch, state: () => state,
            append, results: probeResults, log: message => options.log?.(message) })
          repinAutoTickets({ at, state: () => state, append, log: message => options.log?.(message) })
          const inputs = schedulerInputs({ now: at, snapshot: input.machines, state, dispatcherHost: config.machine,
            ciLanes: input.ciLanes, ciCoexist: input.ciPolicy === 'coexist', managedLoadEnabled: input.hubSwitch.managedLoad,
            placement: { hub: input.hubSwitch, crossMachine, eta: etaBook,
              ...(options.warm ? { warm: options.warm } : {}) } })
          // 准入：实际用量开时剔除常驻授予核、保留实测外部负载；关时走原外部负载抵扣口径。
          const residentCores = residentLeaseCores(Object.values(state.tickets))
          const residentActualUsage = input.hubSwitch.residentActualUsage === true
          // 实测退回(SCHED-ACTUAL-USAGE-ADMISSION-1010):两开关互相独立,四个组合都要自洽。
          const actualUsageAdmission = input.hubSwitch.actualUsageAdmission === true
          const leased = { ...inputs,
            machines: applyResidentLeases(inputs.machines, residentCores, residentActualUsage),
            queue: inputs.queue.filter(ticket => state.tickets[ticket.ticketId]?.request.resident !== true) }
          // 两开关同时开时，常驻 CPU 已全额留在外部负载，托管实测也不能再把它抵扣掉;
          // 实测退回只挂在托管实测(managedLoad)开的前提下,同一遍重算带出 creditCores——
          // residentActualUsage 开时重算剔除常驻执行,关时名单照旧但常驻单在 credit 里被跳过。
          if ((residentActualUsage || actualUsageAdmission) && leased.managedLoad !== undefined) leased.managedLoad = managedLoadInput({
            now: at, snapshot: input.machines, machines: leased.machines, attempts: managedAttempts(state, residentActualUsage),
            ...(actualUsageAdmission ? { actualUsageAdmission: true } : {}) })
          // 卡2:纯 CI 暂停占住的核这拍并没在跑,先让给能让路的短活;收回走借核控制器同一套冻结/归还。
          // 只喂给借核规划,准入口径、心跳里的 grantedCores/availableCores 与许可形状一字不动。
          const lendView = machineLendView(leased.machines, pausedCiFrozenCores(pausedCiFacts(state), leased.machines))
          // CI-RUNNER-LABEL-ROUTING-0924:租约后的机器表加执行心跳,就是标签路由看到的全部世界。
          ciLabelBatch = { at, machines: ciLabelObservations({ at, machines: leased.machines, snapshot: input.machines }) }
          const borrow = ciBorrowController.plan({ at, enabled: input.hubSwitch.ciBorrow && input.ciPolicy !== 'coexist' && leased.managedLoad !== undefined,
            state, snapshot: input.machines, machines: lendView, managedLoad: leased.managedLoad, queue: leased.queue })
          // 内存下限闸(SCHED-MR6-MEMORY-DIMENSION-0924):开关关(input.memoryFloorConfig 不在)就完全不碰内存
          // 读数,准入与边车零改动;开了才按三态算闸——blocked 的机器这拍不放新活(单子继续排队,不判无法满足),
          // single 态同一份读数只放一张(记账器按读数 sampledAt 记账,读数换新自然恢复)。
          let memoryGate: Record<string, MemoryGateEntry> | undefined
          if (input.memoryFloorConfig !== undefined) {
            const readings: Record<string, ReturnType<typeof readMemoryReading>> = {}
            for (const candidate of input.machines.machines) {
              readings[candidate.machine] = readMemoryReading(candidate.heartbeat?.load?.memory)
            }
            // 内存闸：实际用量开时只认已剔除后的非常驻授予核，关时仍减一次常驻核。
            memoryGate = evaluateMemoryGate({ now: at, machines: leased.machines, readings, residentCores, residentActualUsage,
              consumed: memoryFloorTracker.consumed, config: input.memoryFloorConfig })
          }
          const memory: MemoryGateInput | undefined = memoryGate === undefined ? undefined
            : { perMachine: Object.fromEntries(Object.entries(memoryGate).map(([name, entry]) => [name, { mode: entry.mode }])) }
          const decision = decideAdmission({ now: at, ...leased, ...(borrow.admission === undefined ? {} : { ciBorrow: borrow.admission }),
            ...(memory === undefined ? {} : { memory }) })
          // 单放行记账与边车落盘都在准入之后;失败只告警一次,成功拍复位,边车绝不能反过来卡住派单。
          if (memoryGate !== undefined) {
            try {
              memoryFloorTracker.afterDecision(decision.grants, memoryGate)
              memoryFloorReporter.report({ at, gate: memoryGate })
              loggedMemoryFloorFailure = false
            } catch (error) {
              if (!loggedMemoryFloorFailure) warnProbe(`[sched] 内存闸出错,本拍照常派单:${errorMessage(error)}`)
              loggedMemoryFloorFailure = true
            }
          }
          // 无法满足→排队必须先落流水，之后才能按合法迁移授予。
          for (const id of decision.cleared) {
            const ticket = state.tickets[id]!
            if (ticket.state === 'unsatisfiable') append({ at, type: 'cleared-unsatisfiable', ticketId: id,
              attemptId: ticket.currentAttemptId, data: { reason: '允许机器的容量已能满足申请' } })
          }
          for (const grant of decision.grants) {
            const ticket = state.tickets[grant.ticketId]!
            append({ at, type: 'granted', ticketId: ticket.ticketId, attemptId: ticket.currentAttemptId, data: { permit: {
              ticketId: ticket.ticketId, attemptId: ticket.currentAttemptId, token: options.sources.nonce(),
              machine: grant.machine, category: ticket.request.category, grantedCores: grant.cores, issuedAt: at,
              // 共存模式下 CI 只是外部负载:许可不带 ciAware(带了就会被压到最低优先级)。
              ...(input.ciPolicy === 'coexist' ? {} : permitCiAware(leased.machines, grant.machine)),
            } } })
          }
          for (const grant of decision.borrowGrants ?? []) append({ at, type: 'ci-borrow-changed', data: {
            machine: grant.machine, ticketId: grant.ticketId, attemptId: state.tickets[grant.ticketId]!.currentAttemptId,
            action: 'lent', reason: borrow.lentReasons[grant.machine] ?? '借核',
          } })
          for (const action of borrow.actions) append({ at, type: 'ci-borrow-changed', data: action })
          for (const blocked of decision.unsatisfiable) {
            const ticket = state.tickets[blocked.ticketId]!
            if (ticket.state !== 'unsatisfiable') append({ at, type: 'marked-unsatisfiable', ticketId: ticket.ticketId,
              attemptId: ticket.currentAttemptId, data: { reason: blocked.reason } })
          }
          if (options.mode === 'remote') options.remote!.snapshot({ at, state: () => state, append })
          else applySnapshotGate({ share: options.share, at, state: () => state, append,
            logged: loggedSnapshotNames, log: message => options.log?.(message) })
          const handoff = options.mode === 'remote' ? options.remote!.handoff : handoffClusterTickets
          handoff({ share: options.share, at, sources, state: () => state, append,
            // 共存下 CI 只是外部负载:许可本就不带共存标,不能拿「没带标」当收回理由(SCHED-CI-COEXIST-0925)。
            ...(input.ciPolicy === 'coexist' ? {} : { ciYieldRecall: { activeMachines: ciActiveMachines(leased.machines), minInboxMs: CI_YIELD_RECALL_MIN_INBOX_MS } }),
            agentProtocols: agentProtocolsFrom(input.machines),
            autoMinAgentProtocol: options.autoMinAgentProtocol === undefined ? AUTO_JOB_MIN_AGENT_PROTOCOL : options.autoMinAgentProtocol,
            autoLaunch,
            log: message => options.log?.(message),
            ...(options.hooks?.handoff ? { checkpoint: options.hooks.handoff } : {}) })
          // 必须排在交接事务之后：作业侧终态(含 paused/slow)的常规回填先由它结清，
          // 这里只管撤单、硬超时与执行方消失的收尾；双方都以投影终态幂等。
          if (options.mode === 'remote') options.remote!.reclaim({ at, state: () => state, append })
          else remoteKillClusterTickets({ share: options.share, at, sources, state: () => state, append,
            killFiles: input.killFiles, log: message => options.log?.(message), loggedNames: loggedKillNames, autoLaunch })
          autoLaunch.prune(new Set(Object.values(state.tickets).filter(ticket => ticket.request.execution === 'auto'
            && ticket.endedAt === null && ticket.attempts.at(-1)?.intent)
            .map(ticket => submissionId(ticket.ticketId, ticket.currentAttemptId))))
          options.hooks?.beforeSnapshots?.()
          if (!refreshSnapshots()) return false
          if (!retainedDays.has(utcDate(at))) {
            const report = executeLogRetention(options.share, sources)
            append({ at, type: 'log-retention-run', data: report })
            // 顺手回收 _staging 里改名失败留下的 *.suspend-beat 残片；不落台账，log-retention-run 契约不变。
            const sweep = sweepStaleSuspendBeatStaging(options.share, sources)
            if (sweep.deleted.length > 0 || sweep.warnings.length > 0) {
              const first = sweep.warnings[0]
              options.log?.(`[sched] 清理 _staging 里超过 24 小时的回报暂存残片 ${sweep.deleted.length} 个`
                + (first === undefined ? '' : `;另有 ${sweep.warnings.length} 条清理告警，第一条:${first.path}:${first.reason}`))
            }
            // SCHED-BEATS-DIR-RETENTION:同一低频周期里清一次终局满 90 天的执行心跳;失败只告警不停拍。
            const beats = sweepTerminalBeats(options.share, at, state.tickets)
            if (beats.deleted.length > 0 || beats.warnings.length > 0) {
              const first = beats.warnings[0]
              options.log?.(`[sched] 清理终局满 90 天票的执行心跳 ${beats.deleted.length} 个`
                + (first === undefined ? '' : `;另有 ${beats.warnings.length} 条清理告警，第一条:${first.path}:${first.reason}`))
            }
            retainedDays.add(utcDate(at))
            // 跨日但没有单子事件时，清理流水仍会推进计时，补齐这些确实变化的缓存。
            if (!refreshSnapshots()) return false
          }
          const tickets = Object.values(state.tickets)
          // 心跳写失败降级(SCHED-DISPATCHER-RESILIENCE-1009 病根①),口径与快照写入降级一致:
          // 未到上限只告警一行,本拍派单早已完成、后续步骤照常;连续到上限才把原错误抛回保护区停派单员。
          try {
            const decisionBody = dispatcherDecisionSnapshot({ ...leased, decision, snapshot: input.machines,
              dispatcherHost: config.machine, reservationUntil: state.reservationUntil })
            writeDispatcherHeartbeat(options.share, {
              machine: config.machine, pid: options.pid, protocol: options.protocol, head: options.head, at,
              tick: ++tick, cursorSeq: state.cursor.seq,
              queued: tickets.filter(ticket => ticket.state === 'queued' || ticket.state === 'unsatisfiable').length,
              granted: tickets.filter(ticket => ticket.state === 'granted').length,
              ...decisionBody,
              // 实测退回(SCHED-ACTUAL-USAGE-ADMISSION-1010):退回 >0 才给机器条目加 actualUsageCreditCores
              // 展示字段;开关关/本拍无退回不增键,心跳字节与改前一致。availableCores 已含这份退回。
              machines: decisionBody.machines.map(machine => {
                const credit = leased.managedLoad?.perMachine[machine.name]?.creditCores
                return credit !== undefined && credit > 0 ? { ...machine, actualUsageCreditCores: credit } : machine
              }),
            })
            heartbeatWriteFailures = 0
          } catch (error) {
            heartbeatWriteFailures += 1
            try {
              options.log?.(`[sched] 心跳写入失败,本拍跳过、派单照常(连续第 ${heartbeatWriteFailures}/${HEARTBEAT_WRITE_FAILURE_LIMIT} 拍):${errorMessage(error)}`)
            } catch { /* 告警不得停派单员 */ }
            if (heartbeatWriteFailures >= HEARTBEAT_WRITE_FAILURE_LIMIT) throw error
          }
          try {
            // 托管负载：与准入共用同一机器表和实测口径；实际用量开时常驻不抵扣，关时照旧。
            recordManagedLoadTick(managedLoadTracker, { share: options.share, at, enabled: input.hubSwitch.managedLoad,
              snapshot: input.machines, state, machines: leased.machines, managedLoad: leased.managedLoad, residentActualUsage,
              log: message => options.log?.(message) })
          } catch (error) { managedLoadTracker.warnFailure(error) }
          try {
            // 用量历史(SCHED-CORES-HISTORY-AUTOCORRECT-1010):同一份代理心跳读数按执行累计,
            // managedLoad 开关关着也照样观察(统计不参与准入、不依赖该开关);执行从投影里
            // 消失(清账/回收尾巴)时顺手丢弃累计,记账表不随进程寿命膨胀。
            const attempts = managedAttempts(state)
            const active = new Set(attempts.map(attempt => `${attempt.ticketId}--${attempt.attemptId}`))
            for (const key of usageTracker.keys()) if (!active.has(key)) usageTracker.forget(key)
            usageTracker.observe({ at, readings: matchedManagedReadings({ now: at, snapshot: input.machines,
              machines: leased.machines, attempts }) })
            loggedUsageFailure = false
          } catch (error) { usageFailure(error) }
          // 超用标红(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925):边车只在开关开时落盘,关 = 零痕迹;
          // 边车与标记失败只告警,本拍照常派单。快照重刷不受开关管:开关关掉的那一拍 tracker 已清空,
          // 残留标记要靠这次重刷从已写出的快照里擦掉(无残留时 revision 全对得上,它什么都不写);
          // 开关开着时它让本拍的新读数当拍可见。
          if (input.hubSwitch.managedLoad) {
            try {
              overuseReporter.report({ at, marks: managedLoadMarks(managedLoadTracker, at) })
              loggedOveruseFailure = false
            } catch (error) {
              if (!loggedOveruseFailure) warnProbe(`[sched] 超用标记出错,本拍照常派单:${errorMessage(error)}`)
              loggedOveruseFailure = true
            }
          }
          if (!refreshSnapshots()) return false
          return true
        })
        try { originProbe.request(probeRequests); probeRequests = []; originProbe.pump(); loggedProbeStartFailure = false }
        catch (error) { if (!loggedProbeStartFailure) warnProbe(`[sched] 所有者探测启动失败:${errorMessage(error)}`); loggedProbeStartFailure = true }
        try { snapshotSweeper.pump(() => state); loggedSweepFailure = false }
        catch (error) {
          if (!loggedSweepFailure) warnProbe(`[sched] 快照清理启动失败:${errorMessage(error)}`)
          loggedSweepFailure = true
        }
        if (ciLabels !== null) {
          try { ciLabels.pump(ciLabelBatch); loggedCiLabelFailure = false }
          catch (error) {
            if (!loggedCiLabelFailure) warnProbe(`[sched] CI 标签路由出错,派单照常:${errorMessage(error)}`)
            loggedCiLabelFailure = true
          }
        }
        return committed
      } catch (error) { stopped = true; throw error }
    },
    close: () => {
      stopped = true
      tickReadCache.close()
      originProbe.close()
      snapshotSweeper.close()
      try { ciLabels?.close() } catch { /* 关边车失败不影响释放租约 */ }
      owner.release()
    },
  }
}

/** 睡眠端口也可注入；独立进程自己的定时器不依赖代理作业循环。 */
export async function runSchedulerDaemon(options: SchedulerDaemonOptions, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<void> {
  const daemon = startSchedulerDaemon(options)
  let running = true
  const stop = (): void => { running = false }
  const onExit = (): void => {
    try { daemon.close() } catch (error) { options.log?.(`[sched] 释放写者失败:${errorMessage(error)}`) }
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  // IPC 断开能覆盖父代理硬杀；同步卡住父代理不会断开 IPC。
  process.once('disconnect', stop); process.once('exit', onExit)
  try {
    while (running) {
      const started = Date.parse(isoTime(options.sources.now()))
      daemon.tick()
      await sleep(Math.max(0, DISPATCH_TICK_MS - (Date.parse(isoTime(options.sources.now())) - started)))
    }
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    process.removeListener('disconnect', stop); process.removeListener('exit', onExit)
    daemon.close()
  }
}

/**
 * 进程日志的时间前缀(SCHED-DISPATCHER-RESILIENCE-1009 病根②):监护器把派单员 stderr 原样落盘,
 * 旧日志每行没有时间,事后只能靠前后行猜。每行写成 `<ISO 时间> <原文>`,原文一字不改;
 * 时钟与输出端可注入,测试不依赖真墙钟(运维日志不是游戏业务代码,缺省真墙钟)。
 */
export interface TimestampedLoggerOptions {
  /** 时钟:返回 ISO 时间文本。 */
  now?: () => string
  /** 输出端:缺省写 stderr。 */
  write?: (line: string) => void
}
export function createTimestampedLogger(options: TimestampedLoggerOptions = {}): (message: string) => void {
  const now = options.now ?? ((): string => new Date().toISOString())
  const write = options.write ?? ((line: string): void => { console.error(line) })
  return message => { write(`${now()} ${message}`) }
}

/**
 * 致命错误的完整文本:Error 打完整 stack(stack 缺失时退回「名字: 消息」),其他值 String(值) 原样。
 * 旧入口只打一行 errorMessage(error),堆栈全丢,出错位置对不上(SCHED-DISPATCHER-RESILIENCE-1009)。
 */
export function formatFatalError(error: unknown): string {
  return error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const required = (flag: string): string => {
    const index = process.argv.indexOf(flag)
    const value = index < 0 ? undefined : process.argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`[sched] 必须指定 ${flag}`)
    return value
  }
  let share = ''
  // 入口日志统一走带 ISO 时间前缀的写法;致命错误带完整堆栈,事后能对上时间与出错位置。
  const entryLog = createTimestampedLogger()
  Promise.resolve().then(() => {
    share = required('--share')
    return runSchedulerDaemon({ share, host: hostname(), pid: process.pid,
      machine: required('--machine'),
      protocol: Number(required('--protocol')), head: required('--head'), sources: productionSources, log: entryLog,
      ciLabelsGithub: deployment.getDeploymentConfig().ci.labels ? productionCiLabelsGithub : undefined })
  }).catch((error: unknown) => {
    entryLog(formatFatalError(error))
    if (error instanceof OwnerLeaseOccupiedError) {
      try { entryLog(`[sched] 占用者:${readFileSync(join(schedControlPaths(share).owner, `${SCHED_OWNER_NAME}.json`), 'utf8')}`) }
      catch (readError) { entryLog(`[sched] 占用者详情不可读:${errorMessage(readError)}`) }
      process.exitCode = SCHED_OCCUPIED_EXIT_CODE
    } else process.exitCode = 1
  })
}
