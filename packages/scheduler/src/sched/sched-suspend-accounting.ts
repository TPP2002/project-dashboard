/** 将确认区间覆盖到本次执行段，保留排队段，四段并集仍等于总历时；不采信指令时刻。 */
import type { AttemptSnapshot, TicketSnapshot, TimingPhase } from './sched-contract'

export function accountConfirmedSuspension(ticket: TicketSnapshot, attempt: AttemptSnapshot, until: string): void {
  const observation = attempt.suspension
  if (!observation || !attempt.startedAt) return
  const from = Date.parse(attempt.startedAt), to = Date.parse(attempt.endedAt ?? until)
  // 回拨前的确认观察仍留作审计；其开始在当前墙钟之后时，不虚构反向区间的耗时。
  if (to < from) return
  const boundaries = new Set([from, to])
  for (const interval of [...observation.intervals, ...observation.slowIntervals]) {
    boundaries.add(Math.max(from, Math.min(to, Math.floor(interval.from))))
    if (interval.to !== null) boundaries.add(Math.max(from, Math.min(to, Math.floor(interval.to))))
  }
  // 去掉此前按回报受理时刻暂计的执行段，重新按确认区间分类；排队与其它执行不动。
  const old = { ...attempt.timing }
  attempt.segments = attempt.segments.filter(segment => segment.phase === 'queuedMs')
  attempt.timing = { queuedMs: old.queuedMs, runningMs: 0, pausedMs: 0, slowMs: 0 }
  const points = [...boundaries].sort((a, b) => a - b)
  const overlaps = (intervals: typeof observation.intervals, at: number): boolean => intervals.some(interval =>
    Math.floor(interval.from) <= at && (interval.to === null || Math.floor(interval.to) > at))
  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1]!, right = points[i]!
    if (right <= left) continue
    const phase: TimingPhase = overlaps(observation.intervals, left) ? 'pausedMs'
      : overlaps(observation.slowIntervals, left) ? 'slowMs' : 'runningMs'
    const previous = attempt.segments.at(-1)
    const leftIso = new Date(left).toISOString(), rightIso = new Date(right).toISOString()
    if (previous?.phase === phase && previous.to === leftIso) { previous.to = rightIso; previous.milliseconds += right - left }
    else attempt.segments.push({ phase, from: leftIso, to: rightIso, milliseconds: right - left })
    attempt.timing[phase] += right - left
  }
  for (const phase of ['runningMs', 'pausedMs', 'slowMs'] as const) ticket.timing[phase] += attempt.timing[phase] - old[phase]
}
