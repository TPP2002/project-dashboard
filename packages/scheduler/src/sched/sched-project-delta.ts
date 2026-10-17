import type { LedgerEvent } from './sched-contract'
import { emptyProjection, projectLedgerEvents, type ProjectionOwnership, type ProjectionState } from './sched-project'

/** 可选的因果计数，不读时钟；只在资源实验/测试要求时计算克隆字节，生产不做序列化统计。 */
export interface ProjectionCloneStats {
  ticketClones: number
  terminalTicketClones: number
  ticketCloneBytes: number
}

/**
 * @internal daemon 独占追加入口。结果中的未改历史只读共享，不能当公共深层可变副本使用。
 * 容器先复制；状态机在每个深层写点取所有权。同批后半抛错时，草稿直接丢弃，initial 不变。
 * 没有跨调用的 WeakMap/保留表，旧引用的生命周期完全由消费者决定。
 */
export function projectLedgerDelta(events: readonly LedgerEvent[], initial: ProjectionState = emptyProjection(),
  stats?: ProjectionCloneStats): ProjectionState {
  const state: ProjectionState = {
    ...initial,
    cursor: { ...initial.cursor },
    tickets: { ...initial.tickets },
    submissions: { ...initial.submissions },
    rejections: { ...initial.rejections },
    commands: { ...initial.commands },
    reservations: { ...initial.reservations },
    reservationUntil: { ...initial.reservationUntil },
    ownerHolds: { ...initial.ownerHolds },
    ...(initial.ciBorrows === undefined ? {} : { ciBorrows: { ...initial.ciBorrows } }),
    globalTimeline: [...initial.globalTimeline],
  }
  const own: ProjectionOwnership = {
    ticket(id) {
      const ticket = state.tickets[id]
      if (ticket === undefined || ticket !== initial.tickets[id]) return
      // 包括 attempts/segments/pendingQueue/suspension/timeline；不能只复制第一层票据。
      state.tickets[id] = structuredClone(ticket)
      if (stats !== undefined) {
        stats.ticketClones++
        if (ticket.endedAt !== null) stats.terminalTicketClones++
        stats.ticketCloneBytes += Buffer.byteLength(JSON.stringify(ticket), 'utf8')
      }
    },
    command(key) {
      const entry = state.commands[key]
      // 状态机只替换 receipt，request 与原 receipt 均只读。
      if (entry !== undefined && entry === initial.commands[key]) state.commands[key] = { ...entry }
    },
    borrow(key) {
      const entry = state.ciBorrows?.[key]
      // 借核条目全部是标量，heldAt 的修改必须隔离旧引用。
      if (entry !== undefined && entry === initial.ciBorrows?.[key]) state.ciBorrows![key] = { ...entry }
    },
  }
  return projectLedgerEvents(events, state, own)
}
