import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { nextAttemptId, SNAPSHOT_READY_TIMEOUT_MS, snapshotBundleName, snapshotDir,
  snapshotManifestPath, submissionId, validateSnapshotManifest,
  type EventDraft, type LedgerEvent, type TicketSnapshot } from './sched-contract'
import { finishQueuedTicket } from './sched-commands'
import { QUEUED_CANCEL_BACKSTOP_REASON } from './sched-reclaim'
import type { ProjectionState } from './sched-project'

export function applySnapshotGate(context: {
  share: string; at: string; state: () => ProjectionState; append: (draft: EventDraft) => LedgerEvent;
  logged: Set<string>; log?: (message: string) => void;
  readManifest?: (path: string) => string; statBundle?: (path: string) => number
}): void {
  const read = context.readManifest ?? ((path: string) => readFileSync(path, 'utf8'))
  const stat = context.statBundle ?? ((path: string) => statSync(path).size)
  const active = new Set(Object.values(context.state().tickets).filter(ticket => ticket.state === 'granted')
    .map(ticket => submissionId(ticket.ticketId, ticket.currentAttemptId)))
  for (const key of context.logged) if (!active.has(key)) context.logged.delete(key)
  const warn = (ticket: TicketSnapshot, detail: string): void => {
    const key = submissionId(ticket.ticketId, ticket.currentAttemptId)
    if (context.logged.has(key)) return
    context.logged.add(key)
    try { context.log?.(`[sched] 快照清单未就绪:${key}:${detail}`) } catch { /* 告警端口不得停派单员 */ }
  }
  for (const id of Object.keys(context.state().tickets).sort()) {
    let ticket = context.state().tickets[id]!
    if (ticket.request.execution !== 'auto') continue
    const latest = () => ticket.attempts.at(-1)!
    if (ticket.state === 'queued' && ticket.pendingQueue !== null
      && latest().result?.outcome === 'handoff-interrupted' && latest().result!.reason.startsWith('snapshot-')) {
      // 撤单中的断点不重排(SCHED-REQUEUE-IGNORES-CANCEL-1009):旧执行已 finished、不能再结束一次,
      // 先续完已批准的重排再直接终局排队身份——与撤单指令、等待心跳判死同一套事件,兜底原因落账。
      if (ticket.cancelRequested) {
        finishQueuedTicket(context.append, ticket, context.at, QUEUED_CANCEL_BACKSTOP_REASON)
        continue
      }
      const reason = latest().result!.reason
      context.append({ at: context.at, type: 'requeued', ticketId: id, attemptId: ticket.currentAttemptId,
        data: { nextAttemptId: nextAttemptId(ticket.currentAttemptId), reason, atHead: true } })
      ticket = context.state().tickets[id]!
    }
    if ((ticket.state === 'queued' || ticket.state === 'unsatisfiable') && ticket.pendingQueue === null
      && ticket.placement?.portable !== false) {
      const results = ticket.attempts.map(attempt => attempt.result?.reason).filter((reason): reason is string => reason !== undefined)
      const last = results.at(-1)
      const refused = last?.startsWith('snapshot-refused:') ? last.slice('snapshot-refused:'.length) : null
      const lateCount = results.filter(reason => reason.startsWith('snapshot-late:')).length
      if (refused || lateCount >= 2) {
        context.append({ at: context.at, type: 'placement-checked', ticketId: id, attemptId: ticket.currentAttemptId,
          data: { portable: false, reason: refused ?? 'snapshot-late' } })
        ticket = context.state().tickets[id]!
      }
    }
    const attempt = latest()
    if (ticket.state !== 'granted' || !attempt.permit || attempt.permit.machine === ticket.request.origin
      || attempt.snapshotReady || attempt.intent) continue
    let manifest: ReturnType<typeof validateSnapshotManifest> | null
    try {
      manifest = validateSnapshotManifest(JSON.parse(read(snapshotManifestPath(context.share, id, ticket.currentAttemptId))))
      if (manifest.ticketId !== id || manifest.attemptId !== ticket.currentAttemptId) throw new Error('identity')
      if (manifest.state === 'ready') {
        if (manifest.bundle !== snapshotBundleName(id)) throw new Error('bundle-name')
        if (stat(join(snapshotDir(context.share), manifest.bundle)) !== manifest.bundleBytes) throw new Error('bundle-bytes')
      }
    } catch (error) { warn(ticket, error instanceof Error ? error.message : String(error)); manifest = null }
    if (manifest?.state === 'ready') {
      context.append({ at: context.at, type: 'snapshot-ready', ticketId: id, attemptId: ticket.currentAttemptId,
        data: { commit: manifest.commit, base: manifest.base, bundle: manifest.bundle, bundleBytes: manifest.bundleBytes } })
      continue
    }
    const issued = Date.parse(attempt.permit.issuedAt)
    const elapsed = Date.parse(context.at) - issued
    if (manifest?.state !== 'refused' && elapsed < SNAPSHOT_READY_TIMEOUT_MS) continue
    const reason = manifest?.state === 'refused'
      ? `snapshot-refused:${manifest.reason}` : `snapshot-late:${Math.floor(elapsed / 1_000)}`
    const oldAttempt = ticket.currentAttemptId
    // 撤单中的收回不重排(SCHED-REQUEUE-IGNORES-CANCEL-1009):直接 finished(cancelled, terminal:true),
    // 原因沿用原值;终局后 placement-checked 的投影前置(queued/unsatisfiable)不成立,钉机那步一并跳过。
    if (ticket.cancelRequested) {
      context.append({ at: context.at, type: 'finished', ticketId: id, attemptId: oldAttempt,
        data: { result: 'cancelled', terminal: true, reason } })
      continue
    }
    context.append({ at: context.at, type: 'finished', ticketId: id, attemptId: oldAttempt,
      data: { result: 'handoff-interrupted', reason, terminal: false } })
    context.append({ at: context.at, type: 'requeued', ticketId: id, attemptId: oldAttempt,
      data: { nextAttemptId: nextAttemptId(oldAttempt), reason, atHead: true } })
    ticket = context.state().tickets[id]!
    const lateCount = ticket.attempts.filter(value => value.result?.reason.startsWith('snapshot-late:')).length
    if (manifest?.state === 'refused' || lateCount >= 2) {
      context.append({ at: context.at, type: 'placement-checked', ticketId: id, attemptId: ticket.currentAttemptId,
        data: { portable: false, reason: manifest?.state === 'refused' ? manifest.reason : 'snapshot-late',
          ...(manifest?.state === 'refused' ? { detail: manifest.detail } : {}) } })
    }
  }
}
