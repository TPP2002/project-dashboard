/** 性能读数保留原值，只扣确认挂起窗口的并集。文件来自树外控制端，不依赖共享盘。 */
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

export interface SuspendInterval { from: number; to: number | null }
export interface SuspensionWindows { intervals: SuspendInterval[]; slowIntervals: SuspendInterval[] }
export interface SuspensionMeasurement { rawMs: number; suspendedMs: number; elapsedMs: number; comparable: boolean }

export function intersectedMs(from: number, to: number, intervals: readonly SuspendInterval[]): number {
  const clipped = intervals.map(interval => {
    if (!Number.isFinite(interval.from) || (interval.to !== null && (!Number.isFinite(interval.to) || interval.to < interval.from))) {
      throw new Error('[sched] 挂起计时区间非法')
    }
    return [Math.max(from, interval.from), Math.min(to, interval.to ?? to)] as const
  }).filter(([left, right]) => right > left).sort((a, b) => a[0] - b[0])
  let total = 0, end = from
  for (const [left, right] of clipped) { total += Math.max(0, right - Math.max(left, end)); end = Math.max(end, right) }
  return total
}
export function measureSuspensionWindow(from: number, to: number, windows: SuspensionWindows): SuspensionMeasurement {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error('[sched] 测量窗口非法')
  const rawMs = to - from, suspendedMs = intersectedMs(from, to, windows.intervals)
  return { rawMs, suspendedMs, elapsedMs: rawMs - suspendedMs, comparable: intersectedMs(from, to, windows.slowIntervals) === 0 }
}
export const suspendClock = (): number => performance.timeOrigin + performance.now()

/** 标记存在却读不到本机账时拒绝产出可比读数；无标记的旧作业保持原来的原始计时。 */
export function startSuspensionMeasurement(options: { now?: () => number; file?: string; read?: (file: string) => string } = {}) {
  const now = options.now ?? suspendClock, from = now(), file = options.file ?? process.env.SCHED_SUSPEND_RECORD
  return (): SuspensionMeasurement => {
    const to = now()
    if (!file) return measureSuspensionWindow(from, to, { intervals: [], slowIntervals: [] })
    const record = JSON.parse((options.read ?? (path => readFileSync(path, 'utf8')))(file)) as SuspensionWindows
    if (!Array.isArray(record.intervals) || !Array.isArray(record.slowIntervals)) throw new Error('[sched] 挂起计时账缺区间')
    return measureSuspensionWindow(from, to, record)
  }
}
