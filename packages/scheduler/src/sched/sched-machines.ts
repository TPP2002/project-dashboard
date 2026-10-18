/**
 * 心跳与台账到准入输入的纯换算，不读磁盘、不读本机时钟或环境覆盖值。
 * 过渡期把 busyCores 全额当外部负载（自己的运行占用也算），宁少派、不超派；
 * T4 按执行树实测扣除后替换，不能拿授予核数抵扣实测忙碌核数。
 */
import type { LifecycleStatusSnapshot } from '../bot/cluster-lifecycle-status'
import { agentJobClass } from '../bot/cluster-agent-job-class'
import { isDedicatedComputeHost } from '../lib/cpuLease'
import { isoTime, READING_FRESHNESS_MS, RESERVATION_LEVELS, segment, type DispatcherHeartbeat } from './sched-contract'
import { ciReserveCores, CI_LANE_RESERVE_DEFAULTS, type CiLaneReserveTable } from './sched-ci-lanes'
import { compareQueuedTickets, type AdmissionDecision, type AgentSlotInput, type MachineInput, type QueuedTicket } from './sched-decide'
import { submissionKey, type ProjectionState } from './sched-project'
import { isElasticRequest } from './sched-elastic'
import { managedAttempts, managedLoadInput } from './sched-managed-load'
import type { ManagedLoadInput } from './sched-decide'
import { autoJobClass, placementInputs, shouldWaitForPreferredPlacement, type PlacementContext } from './sched-placement'
import type { PlacementInput } from './sched-decide'

/**
 * 心跳里的 runner 名会原样写进派单员心跳,而契约对 `ciRunners` 逐项走 `segment`(只许 `[A-Za-z0-9._-]`);
 * 名字含空格或非 ASCII 时原样透传会让 `writeDispatcherHeartbeat` 抛错,把整个派单员停掉(2026-09-14 复核发现)。
 * 只要有一个名字过不了这道判据,就整份按「认不出」处理:名字记 null、余量取该机整机配额(与拍板③同口径)。
 */
function heartbeatSafeRunners(runners: readonly string[] | undefined): string[] | undefined {
  if (runners === undefined || runners.length === 0) return undefined
  for (const name of runners) { try { segment(name) } catch { return undefined } }
  return [...runners]
}

export function schedulerInputs(input: {
  now: string; snapshot: LifecycleStatusSnapshot; state: ProjectionState; dispatcherHost: string
  /** 车道余量表,由派单员主循环从 _control/ci-lanes.json 读;缺省用内置表。 */
  ciLanes?: CiLaneReserveTable
  /** 共存模式(SCHED-CI-COEXIST-0925):CI 只是外部负载,不再按车道历史峰值预留,准入只看实测负载。 */
  ciCoexist?: boolean
  managedLoadEnabled?: boolean
  placement?: PlacementContext
}): { machines: MachineInput[]; queue: QueuedTicket[]; agentSlots: AgentSlotInput; managedLoad?: ManagedLoadInput;
  placement?: PlacementInput } {
  const now = Date.parse(isoTime(input.now))
  const fresh = (at: string | undefined): boolean => at !== undefined
    && Number.isFinite(Date.parse(at)) && Math.abs(now - Date.parse(at)) <= READING_FRESHNESS_MS
  const granted = new Map<string, number>()
  const occupied = new Map<string, number>()
  const vitestActive = new Set<string>()
  const soloActive = new Set<string>()
  for (const ticket of Object.values(input.state.tickets)) {
    if (!['granted', 'running', 'paused', 'slow'].includes(ticket.state)) continue
    const attempt = ticket.attempts.find(value => value.attemptId === ticket.currentAttemptId)
    if (attempt?.permit) {
      granted.set(attempt.permit.machine, (granted.get(attempt.permit.machine) ?? 0) + attempt.grantedCores)
      if (ticket.request.execution === 'cluster' || (ticket.request.execution === 'auto'
        && attempt.permit.machine !== ticket.request.origin)) {
        occupied.set(attempt.permit.machine, (occupied.get(attempt.permit.machine) ?? 0) + 1)
        const jobClass = ticket.request.execution === 'auto' ? autoJobClass(ticket.request)
          : agentJobClass(ticket.request.work.type)
        if (jobClass === 'vitest') vitestActive.add(attempt.permit.machine)
        if (jobClass === 'solo') soloActive.add(attempt.permit.machine)
      }
    }
  }
  const machines = input.snapshot.machines.map(({ machine, heartbeat, fault }): MachineInput => {
    const load = heartbeat?.load
    const dedicated = isDedicatedComputeHost(machine)
    const key = submissionKey(machine)
    const requested = input.state.reservations[key] ?? 0
    if (!RESERVATION_LEVELS.includes(requested as typeof RESERVATION_LEVELS[number])) throw new Error('[sched] 投影预留档位非法')
    const quotaCores = Math.floor((load?.cores ?? 0) * (dedicated ? 1 : 0.85))
    const ci = load?.ci.state ?? 'unknown'
    return {
      name: machine, preference: dedicated ? 0 : 1,
      quotaCores,
      grantedCores: granted.get(machine) ?? 0, externalLoadCores: load?.busyCores ?? 0,
      ...(machine === input.dispatcherHost ? { reservation: { requestedCores: requested as typeof RESERVATION_LEVELS[number] } } : {}),
      fresh: load?.cores !== undefined && load.busyCores !== undefined
        && fresh(heartbeat?.at) && fresh(load.sampledAt) && fresh(load.ci.observedAt),
      ci, ownerHold: input.state.ownerHolds[key] ?? false,
      online: heartbeat !== undefined && fault === undefined,
      ciReserveCores: input.ciCoexist === true ? 0 : ciReserveCores({ quotaCores, ci, runners: heartbeatSafeRunners(load?.ci.runners),
        table: input.ciLanes ?? CI_LANE_RESERVE_DEFAULTS }),
    }
  }).sort((a, b) => a.preference - b.preference || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const machineNames = input.snapshot.machines.map(item => item.machine)
  let queue = Object.values(input.state.tickets).flatMap((ticket): QueuedTicket[] => {
    if ((ticket.state !== 'queued' && ticket.state !== 'unsatisfiable') || ticket.cancelRequested || ticket.manualPause || ticket.pauseReasons.length || ticket.pendingQueue) return []
    if (input.placement && shouldWaitForPreferredPlacement({ now: input.now, ticket, machineNames, context: input.placement })) return []
    return [{ ticketId: ticket.ticketId, requestedCores: ticket.request.requestedCores,
      allowedMachines: ticket.request.execution === 'auto' ? [ticket.request.origin!] : [...ticket.request.allowedMachines], queuedAt: ticket.queuedAt, band: ticket.band, state: ticket.state }]
  })
  const placement = input.placement === undefined ? undefined : placementInputs({ state: input.state, queue,
    machineNames, context: input.placement })
  if (placement) queue = queue.map(item => placement.candidates[item.ticketId]
    ? { ...item, allowedMachines: placement.candidates[item.ticketId]! } : item)
  const agentSlots: AgentSlotInput = {
    perMachine: Object.fromEntries(input.snapshot.machines.map(({ machine, heartbeat }) => [machine, {
      capacity: heartbeat?.jobSlots?.max ?? 1,
      occupied: Math.max(occupied.get(machine) ?? 0, heartbeat?.jobSlots?.running ?? 0),
      ...(vitestActive.has(machine) ? { vitestActive: true } : {}),
      ...(soloActive.has(machine) ? { soloActive: true } : {}),
    }])),
    clusterTicketIds: queue.filter(ticket => input.state.tickets[ticket.ticketId]?.request.execution === 'cluster').map(ticket => ticket.ticketId),
    ticketClass: Object.fromEntries(queue.filter(ticket => input.state.tickets[ticket.ticketId]?.request.execution === 'cluster')
      .map(ticket => [ticket.ticketId, agentJobClass(input.state.tickets[ticket.ticketId]!.request.work.type)])),
    elasticTicketIds: queue.filter(ticket => isElasticRequest(input.state.tickets[ticket.ticketId]!.request))
      .map(ticket => ticket.ticketId),
  }
  return { machines, queue, agentSlots,
    ...(input.managedLoadEnabled === true ? { managedLoad: managedLoadInput({ now: input.now, snapshot: input.snapshot,
      machines, attempts: managedAttempts(input.state) }) } : {}),
    ...(placement && Object.keys(placement.placement.perTicket).length > 0 ? { placement: placement.placement } : {}) }
}

/** 只拼接本拍已算出的结果，不再次准入；授予增量加回机器计数，队列移除已授予单再编名次。
 * 作业槽快照(SCHED-SLOTS-VISIBLE-ON-DASH-0924):agentSlots/placement 经 {...leased} 传进来,只组装
 * 展示字段(本拍新授予的集群/远端 auto 单加回槽占用),不重算准入、不改任何授予结论。 */
export function dispatcherDecisionSnapshot(input: {
  machines: readonly MachineInput[]; queue: readonly QueuedTicket[]; decision: AdmissionDecision
  snapshot: LifecycleStatusSnapshot; dispatcherHost: string; reservationUntil: ProjectionState['reservationUntil']
  /** 本拍准入用的作业槽输入;缺省(旧调用方)时不写 agentSlots 键,输出与加字段前逐字节相同。 */
  agentSlots?: AgentSlotInput
  /** 本拍准入用的选机输入,只用来认「远端 auto 单」(perTicket 带挂号机 origin);缺省时 auto 授予一律按本地算。 */
  placement?: PlacementInput
}): Pick<DispatcherHeartbeat, 'machines' | 'queue' | 'locks'> {
  const before = new Map(input.machines.map(machine => [machine.name, machine]))
  const readings = new Map(input.snapshot.machines.map(machine => [machine.machine, machine.heartbeat]))
  const granted = new Map<string, number>()
  const grantedTickets = new Set<string>()
  const grantedSlots = new Map<string, number>()
  for (const grant of input.decision.grants) {
    granted.set(grant.machine, (granted.get(grant.machine) ?? 0) + grant.cores)
    grantedTickets.add(grant.ticketId)
    // 本拍新授予里会占作业槽的:集群单每张都占;auto 单只在自己挂号机之外跑才占(本地 auto 不占)。
    // placement 没有 perTicket 项的 auto 单(开关关、或不可搬只回挂号机)只能落在挂号机,不占槽。
    const placed = input.placement?.perTicket[grant.ticketId]
    if (input.agentSlots !== undefined && (input.agentSlots.clusterTicketIds.includes(grant.ticketId)
      || (placed !== undefined && placed.origin !== grant.machine))) {
      grantedSlots.set(grant.machine, (grantedSlots.get(grant.machine) ?? 0) + 1)
    }
  }
  const reasons = new Map(input.decision.unsatisfiable.map(ticket => [ticket.ticketId, ticket.reason]))
  return {
    machines: input.decision.machines.map(machine => {
      const original = before.get(machine.name)
      if (!original) throw new Error('[sched] 决策机器缺少本拍输入')
      const heartbeat = readings.get(machine.name)
      // 只有 CI 在跑时心跳才带名字;认不出、名字不合规、非 active 或旧代理没升级都记 null。
      const ci = heartbeat?.load?.ci
      // 作业槽展示(SCHED-SLOTS-VISIBLE-ON-DASH-0924):执行心跳带合法 jobSlots 才给实测值,占用取
      // 准入输入里 max(投影集群/远端auto件数, 执行端上报 running)再加本拍新授予的占槽单;occupied
      // 允许超过 capacity(超占如实保留)。旧执行心跳没报 jobSlots 写 null,缺键与 null 都表示未知,
      // 不拿准入回退值 1/0 假装实测。纯展示字段,不参与准入。
      const jobSlots = heartbeat?.jobSlots
      const slots = input.agentSlots === undefined ? undefined
        : jobSlots === undefined ? null
          : { capacity: jobSlots.max,
              occupied: (input.agentSlots.perMachine[machine.name]?.occupied ?? 0) + (grantedSlots.get(machine.name) ?? 0) }
      return { ...original, ...machine, grantedCores: original.grantedCores + (granted.get(machine.name) ?? 0),
        reservation: machine.name === input.dispatcherHost
          ? { ...machine.reservation, untilAt: input.reservationUntil[submissionKey(machine.name)] ?? null } : null,
        heartbeatAt: heartbeat?.at ?? null, loadSampledAt: heartbeat?.load?.sampledAt ?? null,
        ciRunners: ci?.state === 'active' ? heartbeatSafeRunners(ci.runners) ?? null : null,
        ...(slots === undefined ? {} : { agentSlots: slots }),
      }
    }),
    queue: input.queue.filter(ticket => !grantedTickets.has(ticket.ticketId)).sort(compareQueuedTickets).map((ticket, index) => ({
      ...ticket, position: index + 1, state: reasons.has(ticket.ticketId) ? 'unsatisfiable' : 'queued', reason: reasons.get(ticket.ticketId) ?? null,
    })),
    locks: input.decision.locks,
  }
}
