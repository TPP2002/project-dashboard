import projects from './client/sched-projects.cjs'
import hubSwitch from './client/sched-hub-switch.cjs'
import menuRules from './client/sched-menu.cjs'
import type { HubSwitch } from './client/sched-hub-switch.cjs'
import type { AgentJobClass } from '../bot/cluster-agent-job-class'
import { isoTime, type SubmissionRequest, type TicketSnapshot } from './sched-contract'
import type { QueuedTicket, PlacementInput } from './sched-decide'
import { ETA_DEFAULT_WARMUP_MS, ETA_SHIP_MS, type EtaBook } from './sched-eta'
import type { ProjectionState } from './sched-project'
import { ORIGIN_PROBE_TIMEOUT_MS } from './sched-origin-probe'

/** HUB6 挂号端合并时打开(SCHED-HUB6-REMOTE-FOLLOW-0924);auto 单只由 exec 在 hub.json portable=on 且名单放行时挂出,开关关着就不会有 auto 单。 */
export const CROSS_MACHINE_WIRED = true
export interface PlacementContext {
  hub: HubSwitch; crossMachine: boolean; eta: EtaBook
  warm?: (machine: string, project: string) => boolean
}
export function autoJobClass(request: SubmissionRequest): AgentJobClass {
  return projects.getMenuItem(request.project, request.menu?.item)?.category ?? 'solo'
}

/** 仅为已接入的副机偏好留出所有者探测预算；未知来源仍不能成为远端候选。
 * 纯准入门，不写 placement 结论，也不让等待单以空候选进入无法满足判定。
 * 从实际 queuedAt 起最多等两次探测预算，坏时间或时钟回退直接沿用挂号机回退。
 */
export function shouldWaitForPreferredPlacement(input: {
  now: string; ticket: TicketSnapshot; machineNames: readonly string[]; context: PlacementContext
}): boolean {
  const { ticket, context } = input
  const request = ticket.request
  if (ticket.placement !== undefined || request.execution !== 'auto' || !request.origin || !request.menu
    || !context.crossMachine || !hubSwitch.portableAllowed(context.hub, request.project, request.menu.item)) return false
  const project = projects.getProject(request.project)
  if (project?.accepted !== true || !project.preferredMachines?.some(machine => machine !== request.origin
      && request.allowedMachines.includes(machine) && project.machines.includes(machine)
      && input.machineNames.includes(machine))
    || projects.getMenuItem(request.project, request.menu.item)?.portable !== true
    || !menuRules.validateMenuArgs(request.project, request.menu.item, request.menu.args).ok) return false
  let elapsed: number
  try { elapsed = Date.parse(isoTime(input.now)) - Date.parse(isoTime(ticket.queuedAt)) }
  catch { return false }
  return elapsed >= 0 && elapsed < 2 * ORIGIN_PROBE_TIMEOUT_MS
}

export function placementInputs(input: { state: ProjectionState; queue: readonly QueuedTicket[]; machineNames: readonly string[];
  context: PlacementContext }): { candidates: Readonly<Record<string, string[]>>; placement: PlacementInput } {
  const candidates: Record<string, string[]> = {}
  const entries: Record<string, PlacementInput['perTicket'][string]> = {}
  for (const queued of input.queue) {
    const ticket = input.state.tickets[queued.ticketId]
    const request = ticket?.request
    if (!request || request.execution !== 'auto' || !request.origin || !request.menu
      || !hubSwitch.portableAllowed(input.context.hub, request.project, request.menu.item)) continue
    const origin = request.origin
    const allowed = ticket.placement?.portable === true && input.context.crossMachine
      ? [origin, ...request.allowedMachines.filter(machine => machine !== origin
        && projects.getProject(request.project)?.machines.includes(machine)
        && input.machineNames.includes(machine))] : [origin]
    candidates[queued.ticketId] = allowed
    const menu = projects.getMenuItem(request.project, request.menu.item)
    const perMachine: Record<string, { shipMs: number; warmupMs: number }> = {}
    for (const machine of allowed) perMachine[machine] = machine === origin ? { shipMs: 0, warmupMs: 0 }
      : { shipMs: ETA_SHIP_MS,
        warmupMs: input.context.warm?.(machine, projects.normalizeProjectId(request.project).id) === true
          ? 0 : ETA_DEFAULT_WARMUP_MS }
    const preferredMachines = allowed.length > 1
      ? projects.getProject(request.project)?.preferredMachines?.filter(machine => allowed.includes(machine)) : undefined
    entries[queued.ticketId] = { origin, jobClass: autoJobClass(request),
      elastic: request.menu.elastic === true && menu !== null && typeof menu.cores === 'object'
        && request.category === 'unit-test',
      runMs: input.context.eta.runMs(request.project, request.work.type, request.category, request.requestedCores),
      perMachine, ...(!preferredMachines?.length ? {} : { preferredMachines }) }
  }
  return { candidates, placement: { perTicket: entries } }
}
