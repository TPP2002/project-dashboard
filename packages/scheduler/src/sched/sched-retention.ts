import { lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { errorMessage, hasCode } from '../bot/cluster-lifecycle-contract'
import {
  DAY_MS, isoTime, LOG_RETENTION_DAYS, schedPaths, TERMINAL_STATES, utcDate,
  type RetentionReport, type SchedulerSources, type TicketSnapshot,
} from './sched-contract'
import { assertSchedulerWritable, readSchedDirectory } from './sched-ledger'

export interface RetentionPlan { at: string; remove: string[]; retain: string[]; ignored: string[] }
function isDateDirectory(name: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return false
  try { isoTime(`${name}T00:00:00.000Z`); return true } catch { return false }
}

/** 按 UTC 日历日期，不按目录 mtime；90 天整保留，只有 91 天及更老的才入计划。 */
export function planLogRetention(now: string, names: readonly string[]): RetentionPlan {
  isoTime(now)
  const today = Date.parse(`${utcDate(now)}T00:00:00.000Z`)
  const plan: RetentionPlan = { at: now, remove: [], retain: [], ignored: [] }
  for (const name of [...new Set(names)].sort()) {
    if (!isDateDirectory(name)) { plan.ignored.push(name); continue }
    const age = (today - Date.parse(`${name}T00:00:00.000Z`)) / DAY_MS
    ;(age > LOG_RETENTION_DAYS ? plan.remove : plan.retain).push(name)
  }
  return plan
}

/** 不跟随日志目录里的符号链接/junction，防止清日志越过 logs 边界。 */
function assertPlainTree(root: string): void {
  const info = lstatSync(root)
  if (info.isSymbolicLink()) throw new Error('日志含符号链接，拒绝递归删除')
  if (info.isDirectory()) for (const name of readdirSync(root)) assertPlainTree(join(root, name))
}

/**
 * 只执行日志清理；不追加流水、不启动定时器。返回值就是 log-retention-run 的 data。
 * 任何读取/删除失败只记告警；注入 removeDirectory 供权限失败测试，真实调用默认 rmSync。
 */
export function executeLogRetention(
  share: string,
  sources: SchedulerSources,
  removeDirectory: (path: string) => void = path => rmSync(path, { recursive: true }),
): RetentionReport {
  const at = isoTime(sources.now())
  const root = resolve(schedPaths(share).logs)
  const report: RetentionReport = { at, deleted: [], retained: [], warnings: [] }
  try { assertSchedulerWritable(share) } catch (error) {
    report.warnings.push({ path: root, reason: errorMessage(error) }); return report
  }
  const listing = readSchedDirectory(share, root)
  if (listing.status !== 'ok') {
    report.warnings.push({ path: listing.path, reason: listing.status === 'unreadable' ? listing.reason : '尚未初始化' })
    return report
  }
  const plan = planLogRetention(at, listing.value)
  report.retained = [...plan.retain, ...plan.ignored].sort()
  for (const name of plan.remove) {
    const path = resolve(root, name)
    try {
      // 删除前核验解析后的绝对路径和链接；计划不接收调用方提供的任意路径。
      if (relative(root, path) !== name || !isDateDirectory(name) || lstatSync(root).isSymbolicLink()
        || !lstatSync(path).isDirectory()) throw new Error('日志目录边界不合法')
      assertPlainTree(path)
      assertSchedulerWritable(share)
      removeDirectory(path)
      report.deleted.push(name)
    } catch (error) { report.warnings.push({ path, reason: errorMessage(error) }) }
  }
  return report
}

/** _staging 里的回报暂存残片超过一天才回收；mtime 在未来的保留。 */
export const SUSPEND_BEAT_STAGING_MAX_AGE_MS = DAY_MS

/**
 * SCHED-BEATS-DIR-RETENTION-0924:已终结票的执行心跳文件保留窗。与 90 天日志保留规则对齐
 * （同用 LOG_RETENTION_DAYS × DAY_MS）:票终局满 90 天才删它的 beats。派单员读路径已改为
 * 只读在跑票(SCHED-BEATS-DIR-RETENTION-0924 的 readBeatBatchFor),这里只管共享盘不无限膨胀;
 * 宁可多留,绝不动在跑/排队票与仍在保留窗内的终态票。
 */
export const TERMINAL_BEATS_RETENTION_MS = LOG_RETENTION_DAYS * DAY_MS

/**
 * 只删「已终结(passed/failed/cancelled/voided)且终局满 TERMINAL_BEATS_RETENTION_MS」的票的
 * beats/<票号>--<执行号>.json;计划来自内存投影(state.tickets),投影里查不到的票一律保留。
 * unlink 是同卷原子动作,重入时 ENOENT 视为已删过;任何读/删失败只进 warnings,函数绝不抛。
 * 返回 deleted 为本次实际删掉的文件名(带 .json)。
 */
export function sweepTerminalBeats(share: string, at: string, tickets: Readonly<Record<string, TicketSnapshot>>,
  remove: (path: string) => void = unlinkSync): { deleted: string[]; warnings: { path: string; reason: string }[] } {
  const deleted: string[] = []
  const warnings: { path: string; reason: string }[] = []
  const directory = schedPaths(share).beats
  let names: string[]
  try { names = readdirSync(directory) } catch (error) {
    if (!hasCode(error, 'ENOENT')) warnings.push({ path: directory, reason: errorMessage(error) })
    return { deleted, warnings }
  }
  const now = Date.parse(isoTime(at))
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    const separator = name.indexOf('--')
    if (separator <= 0) continue
    const ticket = tickets[name.slice(0, separator)]
    // 查不到、尚未终局、终局未满保留窗的一律保留:宁可多留,绝不删仍在管的票。
    if (!ticket || ticket.endedAt === null || !TERMINAL_STATES.some(state => state === ticket.state)) continue
    // 与 planLogRetention 同一边界:90 天整整保留,更老才删。
    if (now - Date.parse(ticket.endedAt) <= TERMINAL_BEATS_RETENTION_MS) continue
    const path = join(directory, name)
    try {
      remove(path)
      deleted.push(name)
    } catch (error) {
      if (hasCode(error, 'ENOENT')) continue
      warnings.push({ path, reason: errorMessage(error) })
    }
  }
  return { deleted, warnings }
}

/**
 * 只回收 _staging 这一层里回报改名失败留下的 *.suspend-beat 残片(不递归)；
 * lstat 只认普通文件(目录与符号链接一律保留)，.lifecycle-publish-*.tmp 等其他暂存件不碰。
 * 目录不存在返回空结果；任何读/删失败只进 warnings，函数绝不抛。
 */
export function sweepStaleSuspendBeatStaging(share: string, sources: SchedulerSources,
  remove: (path: string) => void = unlinkSync): { deleted: string[]; warnings: { path: string; reason: string }[] } {
  const deleted: string[] = []
  const warnings: { path: string; reason: string }[] = []
  const staging = schedPaths(share).staging
  let names: string[]
  try { names = readdirSync(staging) } catch (error) {
    if (!hasCode(error, 'ENOENT')) warnings.push({ path: staging, reason: errorMessage(error) })
    return { deleted, warnings }
  }
  const now = Date.parse(isoTime(sources.now()))
  for (const name of names.sort()) {
    if (!name.endsWith('.suspend-beat')) continue
    const path = join(staging, name)
    try {
      const info = lstatSync(path)
      if (!info.isFile()) continue
      if (now - info.mtimeMs < SUSPEND_BEAT_STAGING_MAX_AGE_MS) continue
      remove(path)
      deleted.push(name)
    } catch (error) { warnings.push({ path, reason: errorMessage(error) }) }
  }
  return { deleted, warnings }
}
