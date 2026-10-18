import menu from './client/sched-menu.cjs'
import projects from './client/sched-projects.cjs'
import hubSwitch from './client/sched-hub-switch.cjs'
import type { HubSwitch } from './client/sched-hub-switch.cjs'
import { ingestedSubmissionPath } from './sched-intake'
import type { EventDraft, LedgerEvent, SchedulerEventData, SubmissionRequest, TicketSnapshot } from './sched-contract'
import type { OriginProbeRequest, OriginProbeResult } from './sched-origin-probe'
import type { ProjectionState } from './sched-project'

export function needsPlacementCheck(ticket: TicketSnapshot, hub: HubSwitch): boolean {
  return ticket.request.execution === 'auto' && (ticket.state === 'queued' || ticket.state === 'unsatisfiable')
    && ticket.pendingQueue === null && !ticket.cancelRequested && ticket.placement === undefined
    && ticket.request.menu !== undefined
    && hubSwitch.portableAllowed(hub, ticket.request.project, ticket.request.menu.item)
}

export function menuVerdict(request: SubmissionRequest): SchedulerEventData['placement-checked'] | null {
  const ref = request.menu
  if (!ref) return { portable: false, reason: 'unknown-command', detail: 'missing-menu:menu' }
  const checked = menu.validateMenuArgs(request.project, ref.item, ref.args)
  if (!checked.ok) return { portable: false, reason: 'unknown-command', detail: `${checked.why}:${checked.detail}`.slice(0, 500) }
  const item = projects.getMenuItem(request.project, ref.item)
  if (!item) return { portable: false, reason: 'unknown-command', detail: 'no-such-item:menu' }
  if (!item.portable) return { portable: false, reason: item.pinReason ?? 'pinned' }
  return null
}

export function applyPlacementChecks(context: {
  share: string; at: string; hub: HubSwitch; state: () => ProjectionState;
  append: (draft: EventDraft) => LedgerEvent; results: readonly OriginProbeResult[];
  log?: (message: string) => void
}): OriginProbeRequest[] {
  const sorted = <T extends { ticketId: string }>(items: readonly T[]): T[] =>
    [...items].sort((a, b) => a.ticketId.localeCompare(b.ticketId))
  for (const result of sorted(context.results)) {
    const ticket = context.state().tickets[result.ticketId]
    if (!ticket || ticket.currentAttemptId !== result.attemptId || !needsPlacementCheck(ticket, context.hub)) continue
    const data: SchedulerEventData['placement-checked'] = result.verdict === 'owner'
      ? result.trusted
        ? { portable: true, reason: null, ownerSid: result.ownerSid }
        : { portable: false, reason: 'sandbox-origin', ownerSid: result.ownerSid, detail: 'owner-not-self' }
      : { portable: false, reason: 'sandbox-origin', detail: `owner-probe-failed:${result.detail}`.slice(0, 500) }
    context.append({ at: context.at, type: 'placement-checked', ticketId: ticket.ticketId,
      attemptId: ticket.currentAttemptId, data })
  }
  const requests: OriginProbeRequest[] = []
  for (const ticket of sorted(Object.values(context.state().tickets))) {
    if (!needsPlacementCheck(ticket, context.hub)) continue
    const verdict = menuVerdict(ticket.request)
    if (verdict) {
      context.append({ at: context.at, type: 'placement-checked', ticketId: ticket.ticketId,
        attemptId: ticket.currentAttemptId, data: verdict })
      continue
    }
    requests.push({ ticketId: ticket.ticketId, attemptId: ticket.currentAttemptId,
      path: ingestedSubmissionPath(context.share, ticket.request.idempotencyKey, ticket.contentHash, ticket.timeline[0]!.at) })
  }
  return requests
}
