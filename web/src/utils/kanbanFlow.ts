import type { Task } from '../types'

/** YYYY-MM-DD 是本地日历日期；空值及无效日期返回 null，不按 UTC 或日期溢出猜测。 */
export function localDayStart(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  if (year < 100) date.setFullYear(year)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date.getTime() : null
}

function progressTime(task: Task): number {
  const stamp = task.lastProgressAt
  const time = stamp ? (localDayStart(stamp) ?? new Date(stamp).getTime()) : NaN
  return Number.isFinite(time) ? time : localDayStart(task.dates?.start) ?? Infinity
}

/** 精确进度时间优先、开工日兜底；没有时间线索排最后，同时间保留输入顺序且不改输入。 */
export function sortStalestFirst(tasks: readonly Task[]): Task[] {
  return tasks.map((task, index) => ({ task, index, time: progressTime(task) }))
    .sort((a, b) => (a.time === b.time ? a.index - b.index : a.time - b.time))
    .map(item => item.task)
}

/** now 是显式注入的毫秒时间戳；未来开工日按 0 计龄，缺失或非法日期不显示卡龄。 */
export function cardAgeMs(task: Task, now: number): number | null {
  const start = localDayStart(task.dates?.start)
  return start === null || !Number.isFinite(now) ? null : Math.max(0, now - start)
}

/** 毫秒向下取整到分钟、小时或天；不足一分钟显示 0m。 */
export function formatAge(ms: number): string {
  const elapsed = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`
  return `${Math.floor(elapsed / 86_400_000)}d`
}

export function isOverLimit(count: number, limit: number): boolean {
  return limit > 0 && count > limit
}
