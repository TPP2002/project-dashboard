/** 只读心跳里的确认结果，由派单员追加事实。操作号由本机持久账产生，回报可重复投递。 */
import { canonicalJson, type EventDraft } from './sched-contract'
import type { ProjectionState } from './sched-project'
import type { BeatBatch } from './sched-reclaim'

export function acceptSuspensionReports(input: {
  at: string; state: () => ProjectionState; beats: BeatBatch; append: (event: EventDraft) => unknown; log: (line: string) => void
}): void {
  for (const beat of input.beats.beats.values()) {
    if (!beat.suspend) continue
    const ticket = input.state().tickets[beat.ticketId], active = ticket?.attempts.at(-1)
    if (!ticket || ticket.currentAttemptId !== beat.attemptId || ticket.endedAt !== null || !active?.permit
      || active.permit.token !== beat.token || active.permit.machine !== beat.machine) continue
    // T3 在交接阶段才投影 started；先来的确认回报留在心跳里，下一拍按原执行号读取。
    if (!['running', 'paused', 'slow'].includes(ticket.state)) continue
    const previous = active.suspension
    if (previous && beat.suspend.sequence <= previous.sequence) {
      if (previous.sequence === beat.suspend.sequence && canonicalJson(previous) !== canonicalJson(beat.suspend)) {
        input.log('[sched] 同序号挂起回报内容冲突，保持原状态')
      }
      continue
    }
    // 无状态/区间/告警变化的续租只保活，不把每秒采样膨胀成整份台账事件。
    if (previous) {
      const { sequence: _oldSequence, at: _oldAt, ...oldValue } = previous
      const { sequence: _newSequence, at: _newAt, ...newValue } = beat.suspend
      if (canonicalJson(oldValue) === canonicalJson(newValue)) continue
    }
    input.append({ at: input.at, ticketId: beat.ticketId, attemptId: beat.attemptId, type: 'suspension-observed',
      data: { observation: beat.suspend } })
  }
}
