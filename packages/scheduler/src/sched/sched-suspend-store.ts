/** 本机持久记录。先 fsync 再原子替换；共享盘只是回报副本，不能作为恢复账的存储位置。 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { open, readdir, rename } from 'node:fs/promises'
import { setTimeout as sleepAsync } from 'node:timers/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PauseReason, SuspensionObservation } from './sched-contract'
import type { CiMemory } from './sched-suspend-policy'
import type { SuspensionWindows } from './sched-suspend-timing'
import type { TreeMember } from './sched-suspend-native'

export type SuspendAction = 'suspend' | 'resume' | 'lower' | 'restore'
export interface SuspendOperation {
  id: number; action: SuspendAction; at: number; status: 'pending' | 'confirmed' | 'unconfirmed' | 'incomplete-tree-gone'
  results: Record<string, { member: TreeMember; status: string; detail?: unknown }>
}
export interface SuspendRecord extends SuspensionWindows {
  schema: 1; ticketId: string; attemptId: string; token: string; machine: string; share: string; category: string
  ownerPid: number; root: TreeMember | null; host: TreeMember | null; ended: boolean
  sequence: number; at: number; mode: 'running' | 'paused' | 'slow'; reasons: PauseReason[]
  manual: boolean; ownerHold: boolean; memory: CiMemory; ciPausedSince: number | null; priorityLow: boolean
  operation: SuspendOperation | null; operations: SuspendOperation[]; alert: string | null
  faulted?: boolean
  /**
   * 本轮 faulted 的起点(SCHED-FAULTED-SELF-HEAL-0925,毫秒、控制端时钟):holdAfterUncertainty 置
   * faulted 时只在还没有值时写入(重复调用不刷新起点、不动 healAttempts);自愈通过或永久退回人工后
   * 清空,下一次再 faulted 重新计时。可选是为兼容旧记录与外部逐字构造的 SuspendRecord。
   */
  faultedAt?: number | null
  /**
   * 这一次执行里已用掉的 faulted 自愈尝试次数(SCHED-FAULTED-SELF-HEAL-0925):整次执行累计、不清零,
   * 合计最多 SUSPEND_FAULT_HEAL_MAX_ATTEMPTS 次;超过后永久退回交人工,不再自动碰这棵树。
   */
  healAttempts?: number
  /** 最近一次自愈尝试开始的时刻(SCHED-FAULTED-SELF-HEAL-0925,毫秒、控制端时钟);尝试期间先落盘再动手。 */
  healLastAt?: number | null
  /**
   * 『暂时拿不准』开始时刻(0924 拍板【一】,毫秒、控制端时钟):执行期帮手/改状态/落盘拿不准时记下,
   * 核实通过即清空;连续超过 SUSPEND_UNCERTAIN_FAULT_MS 仍拿不准才升级 faulted 交人工。
   * 可选是为兼容旧记录与外部逐字构造的 SuspendRecord(缺省视为没有拿不准)。
   */
  uncertainSince?: number | null
  recoveryReportPending?: boolean
}
export function suspendDirectory(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'scheduler', 'sched-suspend')
}
export class SuspendStore {
  constructor(readonly file: string) {}
  read(): SuspendRecord | null { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as SuspendRecord : null }
  create(record: SuspendRecord): void {
    mkdirSync(dirname(this.file), { recursive: true })
    // 两个包装器同时读到“不存在”也只能有一个登记成功；此时还没有发送任何启动请求。
    const fd = openSync(this.file, 'wx')
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd) } finally { closeSync(fd) }
  }
  write(record: SuspendRecord): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const stage = `${this.file}.${process.pid}.tmp`
    const fd = openSync(stage, 'w')
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd) } finally { closeSync(fd) }
    try { renameSuspendFileSync(stage, this.file) }
    catch (error) {
      // 残留暂存件只会挡住下一次写入；删除失败不掩盖原错误。
      try { unlinkSync(stage) } catch { /* 清理失败不掩盖真正的错误 */ }
      throw error
    }
  }
}
/** 改名撞上瞬时占用(杀软/索引/跨进程读者)时的固定退避序列：20 次重试，最坏累计约 3.6 秒；不加随机抖动。 */
export const SUSPEND_RENAME_RETRY_DELAYS_MS: readonly number[] = [25, 50, 100, ...Array.from({ length: 17 }, () => 200)]
const RENAME_RETRYABLE_CODES = ['EPERM', 'EBUSY', 'EACCES'] as const
function renameErrorCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined
}
/** 同步小睡。这里刻意用同步：本调用链是同步 API，不能中途把控制权交出去。 */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}
/** 覆盖改名遇短暂句柄占用按固定序列退避；不可重试码或预算用尽都原样抛最后一次的原始错误对象(保留 code)。 */
export function renameSuspendFileSync(from: string, to: string, sleep: (ms: number) => void = sleepSync): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return }
    catch (error) {
      const code = renameErrorCode(error)
      if (code === undefined || !(RENAME_RETRYABLE_CODES as readonly string[]).includes(code)
        || attempt >= SUSPEND_RENAME_RETRY_DELAYS_MS.length) throw error
      sleep(SUSPEND_RENAME_RETRY_DELAYS_MS[attempt]!)
    }
  }
}
/** renameSuspendFileSync 的异步版：同一预算、同一组可重试错误码；缺省退避用 node:timers/promises 的 setTimeout。 */
export async function renameSuspendFile(from: string, to: string,
  sleep: (ms: number) => Promise<void> = milliseconds => sleepAsync(milliseconds)): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return }
    catch (error) {
      const code = renameErrorCode(error)
      if (code === undefined || !(RENAME_RETRYABLE_CODES as readonly string[]).includes(code)
        || attempt >= SUSPEND_RENAME_RETRY_DELAYS_MS.length) throw error
      await sleep(SUSPEND_RENAME_RETRY_DELAYS_MS[attempt]!)
    }
  }
}
export function processGone(pid: number): boolean {
  try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
export function recordObservation(record: SuspendRecord): SuspensionObservation {
  return { sequence: record.sequence, at: record.at, mode: record.mode, reasons: record.reasons,
    intervals: record.intervals, slowIntervals: record.slowIntervals, alert: record.alert, ended: record.ended }
}
/**
 * 回报只复制已经刷盘的事实；失败不改变本机控制/收尾，下一拍可重送。
 * 顶层 at = 发布时刻的真实墙钟(CLUSTER-ATTEMPTLOAD-WALLCLOCK-FRESHNESS-1014):消费端按
 * |快照墙钟 − beat.at| ≤ 30s(READING_FRESHNESS_MS)判新鲜,而 record.at 走 suspendClock
 * 执行观测轴(performance.timeOrigin 进程启动锚定,系统对时不重锚),对时后与墙钟的恒差
 * 可达 34 秒,拿它当发布时刻会把文件刚写、根与样本都正常的新鲜在管作业判旧整单拒收
 * (副机实测 at 比文件 mtime 慢 35~37 秒、采样恒空)。只换顶层 at;record.at / suspend.at /
 * 区间 / elapsed 等计时值一字不改,30 秒鲜度窗与 PID 复用防线不改。
 */
export async function publishSuspendRecord(record: SuspendRecord, sleep?: (ms: number) => Promise<void>): Promise<void> {
  const name = `${record.ticketId}--${record.attemptId}`
  const stage = join(record.share, 'sched', '_staging', `${name}-${process.pid}-${record.sequence}.suspend-beat`)
  const handle = await open(stage, 'w')
  try {
    try {
      await handle.writeFile(JSON.stringify({ ticketId: record.ticketId, attemptId: record.attemptId, machine: record.machine,
        at: new Date().toISOString(), ...(record.root ? { childPid: record.root.pid } : {}),
        token: record.token, suspend: recordObservation(record) }))
      await handle.sync()
    } finally { await handle.close() }
    await renameSuspendFile(stage, join(record.share, 'sched', 'beats', `${name}.json`), sleep)
  } catch (error) {
    // 改名失败不在 _staging 留残片；删除失败不掩盖原错误。
    try { unlinkSync(stage) } catch { /* 清理失败不掩盖真正的错误 */ }
    throw error
  }
}
const recoveryPublications = new Map<string, Promise<void>>()
/**
 * share 根目录已不存在的记录按有界次数补送后放弃(SCHED-TEST-SUSPEND-LEAK-0924 兜底):
 * 临时盘删了就是永久 ENOENT,继续每拍重试只会让代理日志每 5 秒刷一行、永不放弃。
 * 次数取 12(按 5 秒一拍约合 1 分钟):真实共享盘仍在时本计数被清零、行为与原来完全一致
 * (share 根存在就一直重试),只有根确实消失才开始计数;放弃只停补送,本机记录一条不动,
 * 代理进程重启后对本记录重新给一轮有界次数。测试据此注入假 share 判定有界行为。
 */
export const SUSPEND_RECOVERY_SHARE_GONE_MAX_ATTEMPTS = 12
const recoveryShareGoneAttempts = new Map<string, number>()
const recoveryAbandonedReports = new Set<string>()
function queueRecoveryPublication(file: string, record: SuspendRecord, options: {
  warn: (message: string) => void; publish?: (record: SuspendRecord) => Promise<void>
}): Promise<void> {
  const previous = recoveryPublications.get(file)
  if (previous) return previous
  if (recoveryAbandonedReports.has(file)) return Promise.resolve()
  if (existsSync(record.share)) recoveryShareGoneAttempts.delete(file)
  else {
    const attempts = (recoveryShareGoneAttempts.get(file) ?? 0) + 1
    recoveryShareGoneAttempts.set(file, attempts)
    if (attempts > SUSPEND_RECOVERY_SHARE_GONE_MAX_ATTEMPTS) {
      recoveryShareGoneAttempts.delete(file)
      recoveryAbandonedReports.add(file)
      options.warn(`[sched] 死亡收尾回报已放弃：共享盘根目录不存在，补送 ${SUSPEND_RECOVERY_SHARE_GONE_MAX_ATTEMPTS} 次仍未恢复，不再每拍重试:${file}`)
      return Promise.resolve()
    }
  }
  const work = Promise.resolve().then(() => (options.publish ?? publishSuspendRecord)(record)).then(() => {
    const store = new SuspendStore(file), current = store.read()
    if (!current?.ended || current.sequence !== record.sequence) return
    current.recoveryReportPending = false; store.write(current)
  }).catch(error => options.warn(`[sched] 死亡收尾回报未送达，本机账已收尾:${String(error)}`))
    .finally(() => { recoveryPublications.delete(file) })
  recoveryPublications.set(file, work)
  return work
}

/** 逐文件异步扫描，绝不等待进程退出或执行任何恢复操作；T3 的三步恢复由原入口独立执行。 */
export async function recoverSuspendRecords(directory = suspendDirectory(), options: {
  now: () => number; gone?: (pid: number) => boolean; warn: (message: string) => void
  publish?: (record: SuspendRecord) => Promise<void>
}): Promise<Promise<void>[]> {
  let names: string[]
  try { names = (await readdir(directory)).filter(name => name.endsWith('.json')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const publications: Promise<void>[] = []
  for (const name of names) {
    const file = join(directory, name)
    try {
      // 必须同步读：同一代理进程里正在写的活记录会被 renameSync 覆盖，而异步读的 open→read→close
      // 跨好几个事件循环回合，主线程让出期间句柄一直开着 ⇒ Windows 上覆盖改名报 EPERM；
      // 且同步退避重试救不回来——同步睡眠卡住主线程，read 后续的 close 回调永远轮不到，句柄不释放。
      // readdir 保持 async 实测不冲突。
      const record = JSON.parse(readFileSync(file, 'utf8')) as SuspendRecord
      if (record.schema !== 1 || !Number.isSafeInteger(record.ownerPid) || record.ownerPid < 1) throw new Error('离线记录身份非法')
      if (record.ended) {
        if (record.recoveryReportPending) publications.push(queueRecoveryPublication(file, record, options))
        continue
      }
      const gone = options.gone ?? processGone
      // 只接受根不存在；身份/权限未知一律保留原记录，不因读不到就宣布已退出。
      if (!gone(record.ownerPid)) continue
      if ((record.root !== null && !gone(record.root.pid)) || (record.host !== null && !gone(record.host.pid))) {
        const alert = '控制端已退出，树或宿主仍存在或无法确认；保持原状态，交人工核对'
        if (record.alert !== alert) { record.alert = alert; new SuspendStore(file).write(record); options.warn(`[sched] ${alert}`) }
        continue
      }
      for (const operation of [...record.operations, ...(record.operation ? [record.operation] : [])]) {
        if (operation.status === 'pending' || operation.status === 'unconfirmed') operation.status = 'incomplete-tree-gone'
      }
      const at = options.now()
      for (const interval of [...record.intervals, ...record.slowIntervals]) if (interval.to === null) interval.to = at
      record.ended = true; record.at = at; record.sequence++; record.recoveryReportPending = true
      record.alert = '控制端与执行树已退出；未完成操作随树消亡，仅收尾账目，等待原恢复流程重排'
      new SuspendStore(file).write(record)
      options.warn(`[sched] ${record.ticketId}/${record.attemptId}: ${record.alert}`)
      publications.push(queueRecoveryPublication(file, record, options))
    } catch (error) { options.warn(`[sched] 离线账核对失败，保持原记录:${name}:${String(error)}`) }
  }
  // 返回本机扫描结果时不等共享盘。测试/主动收尾可等待这些句柄，代理主循环只安排后台补送。
  return publications
}

export function startSuspendRecovery(options: Parameters<typeof recoverSuspendRecords>[1] & { directory?: string }): () => void {
  let inFlight = false, stopped = false
  const sweep = (): void => {
    if (inFlight || stopped) return
    inFlight = true
    void recoverSuspendRecords(options.directory, options).catch(error => options.warn(`[sched] 离线账扫描失败:${String(error)}`))
      .finally(() => { inFlight = false })
  }
  const timer = setInterval(sweep, 5000); timer.unref(); sweep()
  return () => { stopped = true; clearInterval(timer) }
}
