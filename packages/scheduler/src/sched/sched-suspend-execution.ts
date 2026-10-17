/** 树外执行端接线：CI 观察、共享盘意图、控制端心跳、输出与正常退出；不写调度台账。 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createAgentCiObserver, type AgentCiObserver } from '../bot/cluster-agent-ci-observer'
import { createCiPolicyReader, type CiPolicyReader } from './sched-ci-policy'
import type { TicketSnapshot, SuspensionObservation } from './sched-contract'
import { SuspensionController, type ManagedExecution } from './sched-suspend'
import type { TreeMember } from './sched-suspend-native'
import { publishSuspendRecord, recordObservation, SuspendStore, suspendDirectory } from './sched-suspend-store'
import { suspendClock } from './sched-suspend-timing'

/**
 * SCHED-JOB-STRAGGLER-RECLAIM-0925 三档开关(SCHED_RESIDUE_RECLAIM 环境变量;测试一律显式传参):
 * - 'kill'(缺省):根进程已退出而作业里还有散兵满宽限,警告后 control.kill() 整树清理;
 * - 'audit':只警告不清理,满宽限警告一次,之后每 5 分钟再提醒一次;
 * - 'off':完全等于改前(不警告、不查成员、不清理)。
 */
export type ResidueReclaimMode = 'kill' | 'audit' | 'off'
/**
 * 根进程退出后,作业里残留进程的宽限毫秒数(负责人 0925 拍板 30 秒):宽限内散兵自己走完就
 * 什么都不做——vitest 之类正常收尾要几秒,绝不能误杀;满宽限还在才警告并(在 kill 档)清理。
 */
export const RESIDUE_GRACE_MS = 30_000
/** 整树清理失败后的重试间隔:循环不许崩,也不许每拍(250 毫秒)重试刷屏。 */
export const RESIDUE_KILL_RETRY_MS = 5_000
/** audit 档重复警告的间隔:满宽限警告一次,之后每 5 分钟再警告一次。 */
export const RESIDUE_AUDIT_REPEAT_MS = 5 * 60_000
/** 认不出的取值警告限一次(进程级):同一进程里反复读到坏取值只提醒一次,不刷屏。 */
let unrecognizedResidueModeWarned = false
/** 从环境读三档开关;认不出的取值按 'kill' 处理并限一次警告。测试不依赖真环境(用传参)。 */
export function residueModeFromEnv(env: NodeJS.ProcessEnv,
  warn: (line: string) => void = line => { console.warn(line) }): ResidueReclaimMode {
  const value = env.SCHED_RESIDUE_RECLAIM
  if (value === 'audit' || value === 'off') return value
  if (value !== undefined && value !== '' && value !== 'kill' && !unrecognizedResidueModeWarned) {
    unrecognizedResidueModeWarned = true
    warn('[sched] SCHED_RESIDUE_RECLAIM 取值不认识,按 kill 处理')
  }
  return 'kill'
}
/** Windows FILETIME(1601-01-01 起的 100 纳秒计数)与 Unix 纪元之间的固定差(100 纳秒单位)。 */
const FILETIME_TO_UNIX_100NS = 116_444_736_000_000_000n
/**
 * 散兵说明的缺省实现:跑一次 tasklist /FO CSV /NH 拿 pid→映像名,再配上成员表里 FILETIME 启动时间
 * 转北京时间。只在真的要警告/清理时才调用(不是每拍);失败、超时、非 Windows 一律「映像名未知」
 * 不抛错——说明散兵只是给警告凑料,绝不能因为它把清理本身挡住。
 */
export async function describeTreeMembers(members: TreeMember[]): Promise<string> {
  const images = new Map<number, string>()
  if (process.platform === 'win32') {
    try {
      const output = await new Promise<string>((resolveTask, rejectTask) => {
        execFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 5_000, windowsHide: true, encoding: 'latin1' },
          (error, stdout) => { if (error !== null) rejectTask(error); else resolveTask(String(stdout)) })
      })
      for (const line of output.split(/\r?\n/)) {
        const matched = /^"([^"]*)","(\d+)"/.exec(line)
        const name = matched?.[1], pid = matched?.[2]
        if (name !== undefined && pid !== undefined) images.set(Number(pid), name)
      }
    } catch { images.clear() }
  }
  return members.map(member => {
    let started = '启动时间未知'
    try {
      const milliseconds = (BigInt(member.creationFileTime) - FILETIME_TO_UNIX_100NS) / 10_000n
      started = `启动于 ${new Date(Number(milliseconds)).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
    } catch { /* 转换失败就写「启动时间未知」 */ }
    return `${images.get(member.pid) ?? '映像名未知'}#${member.pid}(${started})`
  }).join(';')
}
/** 散兵回收的可注入面:缺省 mode 读环境、graceMs/now/describe 走上述缺省;测试一律显式传。 */
export interface ResidueReclaimOptions {
  mode?: ResidueReclaimMode
  graceMs?: number
  now?: () => number
  describe?: (members: TreeMember[]) => Promise<string>
}

export function suspensionObservation(control: SuspensionController): SuspensionObservation {
  return recordObservation(control.snapshot)
}
/**
 * 工单快照必须同步读:同一回合里开、读、关。异步读(fs/promises.readFile)的 open→read→close 跨好几个事件循环回合,
 * 句柄一直开着;同进程的守护进程(测试拓扑)覆盖改名同一个快照就撞 Windows EPERM,而它的改名退避是同步睡眠,
 * 卡住整个进程使句柄的 close 回调永远轮不到,重试全撞、守护进程停摆(SCHED-EXEC-JSONFILE-EPERM-0925)。
 * 同类写法见 sched-suspend-store.ts 的 recoverSuspendRecords。对调用方仍是 Promise,语义不变。
 */
async function jsonFile(file: string): Promise<unknown> { return JSON.parse(readFileSync(file, 'utf8')) }

export async function scheduledExecutionIdentity(share: string, id: string) {
  const ticket = await jsonFile(join(share, 'sched', 'tickets', `${id}.json`)) as TicketSnapshot
  const permit = ticket.attempts.at(-1)?.permit
  if (!permit || ticket.ticketId !== id || permit.attemptId !== ticket.currentAttemptId) throw new Error('[sched] 当前执行许可缺失')
  return { ticketId: id, attemptId: permit.attemptId, token: permit.token, category: permit.category, machine: permit.machine,
    grantedCores: permit.grantedCores }
}

export interface ManagedRun {
  pid: number; done: Promise<number | null>; stop: () => Promise<void>; snapshot: () => SuspensionObservation
  ciDuringJob?: () => { maxWorkers: number; firstSeenAt: string; lastSeenAt: string; seenSamples: number; samples: number }
}
export async function startManagedExecution(input: ManagedExecution & {
  directory?: string; warn: (line: string) => void; output?: (chunk: Buffer) => unknown; publishBeat?: boolean
  /** 测试只能显式传观察器；省略仍观察本机真实 CI，不读取环境或命令行旁路。 */
  ciObserver?: AgentCiObserver
  /** CI 相处方式开关(SCHED-CI-COEXIST-0925);省略时读共享盘上的 ci-policy.json,缺文件 = 让路(改前行为)。 */
  ciPolicy?: CiPolicyReader
  /**
   * 散兵回收(SCHED-JOB-STRAGGLER-RECLAIM-0925):根进程已退出而作业里还有散兵满 RESIDUE_GRACE_MS
   * 宽限,警告并按档处置。缺省 mode=residueModeFromEnv(process.env)、graceMs=RESIDUE_GRACE_MS、
   * now=suspendClock、describe=默认的映像名查询;测试一律显式传,不依赖环境。
   */
  residue?: ResidueReclaimOptions
}): Promise<ManagedRun> {
  const key = createHash('sha256').update(resolve(input.share)).digest('hex').slice(0, 16)
  const file = join(input.directory ?? suspendDirectory(), `${key}-${input.ticketId}--${input.attemptId}.json`)
  const store = new SuspendStore(file), control = new SuspensionController({ store, warn: input.warn })
  const initial = await jsonFile(join(input.share, 'sched', 'tickets', `${input.ticketId}.json`)) as TicketSnapshot
  if (initial.currentAttemptId !== input.attemptId || initial.endedAt !== null || initial.cancelRequested) {
    throw new Error('[sched] 启动前许可已失效或撤销')
  }
  const policy = input.ciPolicy ?? createCiPolicyReader({ share: input.share, warn: input.warn, now: suspendClock })
  const intent = { manual: initial.manualPause ?? initial.pauseReasons.includes('manual'), ownerHold: initial.ownerHold ?? false,
    ciCoexist: policy.mode() === 'coexist' }
  const observer = input.ciObserver ?? createAgentCiObserver({ now: suspendClock }); observer.start()
  const observe = () => {
    const reading = observer.read()
    return { state: reading.state, observedAt: Date.parse(reading.observedAt) }
  }
  let root
  try { root = await control.manage(input, intent, observe) } catch (error) { observer.stop(); throw error }
  const ciDuringJob = { maxWorkers: 0, firstSeenAt: '', lastSeenAt: '', seenSamples: 0, samples: 0 }
  let lastCiSample: string | undefined
  let stopped = false, busy = false, lastPolicy = -Infinity
  let cancelling = false
  // SCHED-JOB-STRAGGLER-RECLAIM-0925 的散兵账,与 busy/stopped 同级活在闭包里(控制端与树同生共死,
  // 不落盘、不进对外回报)。residueExitedAt:第一次读到「树非空且根已退出」的时刻,此后不清零——
  // control.poll() 在只读查询失败时兜底返回 { empty:false, exitCode:null },那种读数既不能开始计时
  // 也不能把已开始的计时清零。warned/killAt/failed:警告只发一次、清理按 RESIDUE_KILL_RETRY_MS 限频。
  const residueMode = input.residue?.mode ?? residueModeFromEnv(process.env, input.warn)
  const residueGraceMs = input.residue?.graceMs ?? RESIDUE_GRACE_MS
  const residueNow = input.residue?.now ?? suspendClock
  const residueDescribe = input.residue?.describe ?? describeTreeMembers
  let residueExitedAt: number | null = null
  let residueKillWarned = false
  let residueAuditAt: number | null = null
  let residueKillAt: number | null = null
  let residueKillFailed = false
  // 警告一行中文:只写根退出码、剩余成员数与每个成员的「映像名#pid(启动于 北京时间)」(至多前
  // 8 个,其余写「等 N 个」),绝不写命令行、环境变量、令牌。成员表取不到不影响后面的清理,只是
  // 警告里少列;describe 抛错则映像名一律写「未知」。
  const warnStragglers = async (exitCode: number, mode: 'kill' | 'audit'): Promise<void> => {
    const seconds = Math.round(residueGraceMs / 1000)
    const tail = mode === 'kill' ? '整树清理' : '只记录不清理,每 5 分钟再提醒'
    let members: TreeMember[] | null
    try { members = await control.members() } catch { members = null }
    if (members === null) {
      input.warn(`[sched] 任务主命令已退出(退出码 ${exitCode}),作业里仍有散兵进程但成员表读取失败,满 ${seconds} 秒宽限仍未退出,${tail}`)
      return
    }
    const listed = members.slice(0, 8)
    let names: string
    try { names = await residueDescribe(listed) }
    catch { names = listed.map(member => `映像名未知#${member.pid}(启动时间未知)`).join(';') }
    const rest = members.length - listed.length
    const shown = names === '' ? '' : rest > 0 ? `,${names},等 ${rest} 个` : `,${names}`
    input.warn(`[sched] 任务主命令已退出(退出码 ${exitCode}),作业里仍有 ${members.length} 个散兵进程${shown},满 ${seconds} 秒宽限仍未退出,${tail}`)
  }
  const offsets = new Map<string, number>()
  const output = async (drain = false): Promise<void> => {
    if (!input.output) return
    for (const name of ['workload.stdout.log', 'workload.stderr.log']) {
      const handle = await open(join(`${file}.native`, name), 'r')
      try {
        let offset = offsets.get(name) ?? 0
        // 一拍至多读两块；大日志不能霸占观察与续租节拍。
        for (let block = 0; drain || block < 2; block++) {
          const bytes = Buffer.alloc(64 * 1024)
          const read = await handle.read(bytes, 0, bytes.length, offset)
          if (read.bytesRead === 0) break
          await input.output(bytes.subarray(0, read.bytesRead)); offset += read.bytesRead
          offsets.set(name, offset)
        }
        offsets.set(name, offset)
      } finally { await handle.close() }
    }
  }
  const beat = async (): Promise<void> => {
    if (input.publishBeat === false) return
    await publishSuspendRecord(control.snapshot)
  }
  const readIntent = async (): Promise<void> => {
    const ticket = await jsonFile(join(input.share, 'sched', 'tickets', `${input.ticketId}.json`)) as TicketSnapshot
    if (ticket.currentAttemptId !== input.attemptId || ticket.endedAt !== null) { cancelling = true; return }
    intent.manual = ticket.manualPause ?? ticket.pauseReasons.includes('manual')
    intent.ownerHold = ticket.ownerHold ?? intent.ownerHold
    cancelling ||= ticket.cancelRequested
  }
  let resolveDone!: (code: number | null) => void, rejectDone!: (error: unknown) => void
  // SCHED-RUN-EXITCODE-NULL-FALSE-RED:整树已退出但退出码读不出时兑现 null(独立结论),不默认补数。
  const done = new Promise<number | null>((resolveResult, reject) => { resolveDone = resolveResult; rejectDone = reject })
  // 调用方接到 handle 前也必须有拒绝处理器。
  void done.catch(() => {})
  let intentWork: Promise<void> | undefined, beatWork: Promise<void> | undefined, outputWork: Promise<void> | undefined
  // 共享盘/日志各自单航道，不串进本机 CI 控制；挂住的 I/O 也不能积攒无界并发。
  const exchange = (): void => {
    if (stopped) return
    intentWork ??= readIntent().catch(error => input.warn(`[sched] 意图读取失败，保留原意图:${String(error)}`))
      .finally(() => { intentWork = undefined })
    beatWork ??= beat().catch(error => input.warn(`[sched] 回报未送达，本机账已保留:${String(error)}`))
      .finally(() => { beatWork = undefined })
    outputWork ??= output().catch(error => input.warn(`[sched] 日志回传未完成，原文保留在本机:${String(error)}`))
      .finally(() => { outputWork = undefined })
  }
  const stopTimers = (): void => { stopped = true; clearInterval(timer); clearInterval(exchangeTimer); observer.stop() }
  const settleReports = async (): Promise<void> => {
    // 结束前排空正常日志；网络故障不妨碍释放执行槽，本机完整日志与流水仍可核对。
    const forwarding = Promise.all([
      (outputWork ?? Promise.resolve()).then(() => output(true)),
      (beatWork ?? Promise.resolve()).then(beat),
    ]).then(() => {})
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([forwarding, new Promise<void>(resolveTimeout => {
        timeout = setTimeout(() => { input.warn('[sched] 收尾回传仍在等待；完整原文与流水保留在本机'); resolveTimeout() }, 3000)
      })])
    } catch (error) { input.warn(`[sched] 收尾回传未送达:${String(error)}`) }
    finally { clearTimeout(timeout) }
  }
  const finish = async (code: number | null): Promise<void> => {
    stopTimers()
    try { await control.finish(); await settleReports(); resolveDone(code) } catch (error) { rejectDone(error) }
  }
  const cycle = async (): Promise<void> => {
    if (busy || stopped) return
    busy = true
    try {
      const polled = await control.poll()
      // SCHED-RUN-EXITCODE-NULL-FALSE-RED:成员表空但退出码未读出(宿主有界等待后仍为 null)时,
      // 如实上送 null 交调用方按「退出码未确认」记账;撤单仍是 5。绝不默认补 1 冒充失败。
      if (polled.empty) { await finish(cancelling ? 5 : polled.exitCode); return }
      // SCHED-JOB-STRAGGLER-RECLAIM-0925:主命令(根进程)已退出而作业里还有散兵的限时回收。
      // 判据(已拍死):一次 poll 读到「empty 为假且 exitCode 非 null」= 根已退出而散兵仍在,
      // 第一次读到那一刻起算宽限;exitCode 为 null 的读数(根还活着,或只读失败的兜底)既不能开始
      // 计时也不能把已开始的计时清零。根还活着一律不动(长跑命令绝不能误杀);撤单(cancelling)
      // 路径一字不变,本功能不介入;off 档完全等于改前。整个检查包在 try/catch:任何错误只告警,
      // 绝不向外抛——外层 catch 会把它当「执行树状态未确认」走挂起保护,那是错的。
      if (residueMode !== 'off' && !cancelling && polled.exitCode !== null) {
        try {
          if (residueExitedAt === null) residueExitedAt = residueNow()
          const residueAt = residueNow()
          if (residueAt - residueExitedAt >= residueGraceMs) {
            if (residueMode === 'audit') {
              if (residueAuditAt === null || residueAt - residueAuditAt >= RESIDUE_AUDIT_REPEAT_MS) {
                await warnStragglers(polled.exitCode, 'audit')
                residueAuditAt = residueAt
              }
            } else {
              if (!residueKillWarned) { await warnStragglers(polled.exitCode, 'kill'); residueKillWarned = true }
              if (residueKillAt === null || residueKillFailed && residueAt - residueKillAt >= RESIDUE_KILL_RETRY_MS) {
                residueKillAt = residueAt
                try { await control.kill(); residueKillFailed = false } catch (error) {
                  residueKillFailed = true
                  input.warn(`[sched] 散兵清理未成功:${String(error)},${Math.round(RESIDUE_KILL_RETRY_MS / 1000)} 秒后重试`)
                }
              }
            }
          }
        } catch (error) { input.warn(`[sched] 散兵检查失败,本拍跳过:${String(error)}`) }
      }
      const now = suspendClock()
      if (now - lastPolicy >= 1000) {
        lastPolicy = now
        if (cancelling) await control.kill()
        else {
          const reading = observer.read()
          if (reading.observedAt !== lastCiSample) {
            lastCiSample = reading.observedAt; ciDuringJob.samples++
            if (reading.state === 'active') {
              ciDuringJob.maxWorkers = Math.max(ciDuringJob.maxWorkers, reading.ciWorkers)
              ciDuringJob.firstSeenAt ||= reading.observedAt; ciDuringJob.lastSeenAt = reading.observedAt; ciDuringJob.seenSamples++
            }
          }
          // 共存模式:CI 只是外部负载,不冻结也不降优先级;每拍重读开关,改文件几秒内生效(手动暂停/所有者占用不受影响)。
          intent.ciCoexist = policy.mode() === 'coexist'
          await control.tick(observe(), intent)
        }
      }
    } catch (error) {
      input.warn(`[sched] 执行树状态未确认:${String(error)}`)
      if (control.settleLostTree()) {
        stopTimers(); await settleReports()
        resolveDone(1)
      } else {
        try { await control.holdAfterUncertainty(String(error)) }
        catch (holdError) { input.warn(`[sched] 挂起保护未确认，保留占用:${String(holdError)}`) }
      }
    } finally { busy = false }
  }
  const timer = setInterval(() => { void cycle() }, 250)
  const exchangeTimer = setInterval(exchange, 1000)
  exchange()
  void cycle()
  return { pid: root.pid, done, snapshot: () => suspensionObservation(control), ciDuringJob: () => ({ ...ciDuringJob }), stop: async () => {
    if (stopped) return
    cancelling = true; await control.kill(); await done
  } }
}
