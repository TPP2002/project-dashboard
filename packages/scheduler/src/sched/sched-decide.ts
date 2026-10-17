import { HEAD_PROTECTION_MS, integer, isoTime, RESERVATION_LEVELS, segment, ticketId,
  type PauseReason, type TicketSnapshot, type TicketState } from './sched-contract'
import { elasticGrantCores } from './sched-elastic'
import { crowdFactor, etaMs } from './sched-eta'
import type { AgentJobClass } from '../bot/cluster-agent-job-class'

export interface MachineInput {
  name: string
  preference: number
  quotaCores: number
  grantedCores: number
  externalLoadCores: number
  /** 只给主机传此字段；机器角色由调用方提供，本模块不认任何硬编码主机名。 */
  reservation?: { requestedCores: typeof RESERVATION_LEVELS[number] }
  fresh: boolean
  ci: 'active' | 'idle' | 'unknown'
  ownerHold: boolean
  online: boolean
  /**
   * 本机要给 CI 留的核数(按在跑 runner 的车道余量表算,见 sched-ci-lanes.ts)。
   * CI 非 active 为 0;认不出 runner 时等于整机配额,等价于改前「有 CI 就不派」。
   */
  ciReserveCores: number
}
export interface QueuedTicket {
  ticketId: string
  requestedCores: number
  allowedMachines: string[]
  queuedAt: string
  band: 0 | 1
  /** 把暂不可满足的票也传入，条件变化时才能输出 cleared；省略表示普通排队。 */
  state?: 'queued' | 'unsatisfiable'
}
export interface AgentSlotInput {
  perMachine: Readonly<Record<string, { capacity: number; occupied: number; vitestActive?: boolean; soloActive?: boolean }>>
  clusterTicketIds: readonly string[]
  ticketClass?: Readonly<Record<string, AgentJobClass>>
  elasticTicketIds?: readonly string[]
}
export interface ManagedLoadInput {
  /**
   * creditCores 是实测退回(SCHED-ACTUAL-USAGE-ADMISSION-1010)的核数:开关关/未暖机/读数过期/
   * 常驻单一律不写这个键(账面形状与改前逐字节相同);写了就按 granted+overrun−credit 扣到 0 算在管。
   */
  perMachine: Readonly<Record<string, { measuredCores: number; overrunCores: number; creditCores?: number }>>
}
export interface PlacementTicketInput {
  origin: string; jobClass: AgentJobClass; elastic: boolean; runMs: number
  perMachine: Readonly<Record<string, { shipMs: number; warmupMs: number }>>
  preferredMachines?: readonly string[]
}
export interface PlacementInput { perTicket: Readonly<Record<string, PlacementTicketInput>> }
export interface CiBorrowAdmissionInput {
  perMachine: Readonly<Record<string, { lendableCores: number; borrowedCores: number }>>
  ticketIds: readonly string[]
}
/** 内存下限闸(SCHED-MR6-MEMORY-DIMENSION-0924)每台机器的三态结论;三态之外一律判输入不合法。 */
export type MemoryGateMode = 'open' | 'single' | 'blocked'
export interface MemoryGateInput {
  perMachine: Readonly<Record<string, { mode: MemoryGateMode }>>
}
export interface AdmissionDecision {
  grants: { ticketId: string; machine: string; cores: number }[]
  borrowGrants?: { ticketId: string; machine: string; cores: number }[]
  unsatisfiable: { ticketId: string; reason: string }[]
  cleared: string[]
  locks: { machine: string; byTicketId: string }[]
  machines: { name: string; availableCores: number; overCommitted: boolean; reservation: { requestedCores: number; fulfilledCores: number } }[]
}
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
/** 展示队列与准入共用同一顺序，不能在心跳或看板另定排序口径。 */
export function compareQueuedTickets(left: QueuedTicket, right: QueuedTicket): number {
  return left.band - right.band || compare(left.queuedAt, right.queuedAt) || compare(left.ticketId, right.ticketId)
}
function reservation(machine: MachineInput): number { return machine.reservation?.requestedCores ?? 0 }
/** CI 在跑不再一票否决;「未知」照旧不许当空闲。 */
function eligible(machine: MachineInput): boolean { return machine.fresh && machine.online && machine.ci !== 'unknown' && !machine.ownerHold }
/** CI 在跑时按车道余量留核,与实测外部负载取大者:两者都在占这台机器的核。 */
function reservedForCi(machine: MachineInput): number { return Math.max(machine.externalLoadCores, machine.ciReserveCores) }
function available(machine: MachineInput): number {
  return eligible(machine) ? Math.max(0, machine.quotaCores - (machine.grantedCores + reservedForCi(machine) + reservation(machine))) : 0
}
/** 新口径只从独立参数进入；MachineInput 的形状与心跳展开口保持冻结。 */
export function machineManagedLoad(machine: MachineInput, load: ManagedLoadInput): { managedCores: number; unmanagedCores: number } {
  const measured = load.perMachine[machine.name]?.measuredCores ?? 0
  const overrun = load.perMachine[machine.name]?.overrunCores ?? 0
  // 实测退回(SCHED-ACTUAL-USAGE-ADMISSION-1010):creditCores 是调用方按「授予−min(授予, max(1, ceilHalf(实测×1.3)))」
  // 算出的差额,只减在管不减未受管;没这个键(开关关)时与改前一字不差。
  const credit = load.perMachine[machine.name]?.creditCores ?? 0
  return { managedCores: Math.max(0, machine.grantedCores + overrun - credit),
    unmanagedCores: measured === 0 ? machine.externalLoadCores
      : Math.max(0, Math.round(machine.externalLoadCores * 10) - Math.round(measured * 10)) / 10 }
}
/**
 * 给了在管实测时全程按**十分位整数**算(SCHED-DAEMON-STOPS-ON-SNAPSHOT-WRITE-FAIL-0925 卡3):
 * 各项先 Math.round(x×10),整数相减后再除十。改前直接按浮点相减,配额 9 核 − 外部 3.3 核 − 预留 5 核
 * 会吐出 0.6999999999999993 这类尾巴(另两条实测尾巴 1.6999999999999993、2.8000000000000007)。
 * **没给实测时不走这里**:旧口径 `available(machine)` 一字不动(含它自己的浮点尾巴),对照测试钉住。
 */
export function machineAvailableCores(machine: MachineInput, load?: ManagedLoadInput): number {
  if (load === undefined) return available(machine)
  if (!eligible(machine)) return 0
  const { managedCores, unmanagedCores } = machineManagedLoad(machine, load)
  const tenths = Math.round(machine.quotaCores * 10) - Math.round(managedCores * 10)
    - Math.round(Math.max(unmanagedCores, machine.ciReserveCores) * 10) - Math.round(reservation(machine) * 10)
  return Math.max(0, tenths / 10)
}
/** 卡2 的让路事实由调用方从投影里取;这里不认任何投影形状,机器字段一律用 MachineInput 逐项对齐。 */
export interface PausedCiTicketFact { state: TicketState; pauseReasons: readonly PauseReason[]; machine: string; grantedCores: number }
/**
 * SCHED-DAEMON-STOPS-ON-SNAPSHOT-WRITE-FAIL-0925 卡2:算出这拍「可以让路的核」。
 * 三条同时成立才算:状态是 paused、暂停原因**只有** ci、该机 CI 正在跑。
 * 少一条都不让——CI 一停(或状态未知),执行侧 60 秒后就会自己恢复这张单,那时它的核必须照旧
 * 算在占用上,让出去的核由借核控制器的同一套冻结先收回(见 sched-ci-borrow.ts)。
 */
export function pausedCiFrozenCores(tickets: readonly PausedCiTicketFact[], machines: readonly MachineInput[]): Record<string, number> {
  const ciActive = new Set(machines.filter(machine => machine.ci === 'active').map(machine => machine.name))
  const frozen: Record<string, number> = {}
  for (const ticket of tickets) {
    if (ticket.state !== 'paused' || ticket.pauseReasons.length !== 1 || ticket.pauseReasons[0] !== 'ci') continue
    if (!ciActive.has(ticket.machine)) continue
    frozen[ticket.machine] = (frozen[ticket.machine] ?? 0) + ticket.grantedCores
  }
  return frozen
}
/**
 * 让路核只从**借核规划**的输入里扣掉(扣到不低于 0),不让路的机器原对象原样返回。
 * 准入口径、心跳展开、许可形状一律不碰:扣在别处会把 CI 冻着的核当真空闲派出去(超卖),
 * 或让看板与流水对不上。
 */
export function machineLendView(machines: readonly MachineInput[], frozen: Readonly<Record<string, number>>): MachineInput[] {
  return machines.map(machine => {
    const lend = Math.min(machine.grantedCores, frozen[machine.name] ?? 0)
    return lend === 0 ? machine : { ...machine, grantedCores: machine.grantedCores - lend }
  })
}
export function fitsCores(machine: MachineInput, cores: number, managed?: ManagedLoadInput): boolean {
  return machineAvailableCores(machine, managed) >= cores
    && (managed === undefined
      ? machine.grantedCores + cores + machine.externalLoadCores + reservation(machine) <= machine.quotaCores
      : machineManagedLoad(machine, managed).managedCores + cores
        + machineManagedLoad(machine, managed).unmanagedCores + reservation(machine) <= machine.quotaCores)
}
function validateInputs(machines: readonly MachineInput[], queue: readonly QueuedTicket[]): void {
  if (new Set(machines.map(machine => machine.name)).size !== machines.length) throw new Error('[sched] 机器重名')
  if (new Set(queue.map(ticket => ticket.ticketId)).size !== queue.length) throw new Error('[sched] 队列单号重复')
  for (const machine of machines) {
    segment(machine.name); integer(machine.quotaCores); integer(machine.grantedCores); integer(machine.ciReserveCores)
    if (!Number.isFinite(machine.preference) || !Number.isFinite(machine.externalLoadCores) || machine.externalLoadCores < 0) throw new Error('[sched] 机器偏好或负载不合法')
    if (!RESERVATION_LEVELS.includes(reservation(machine) as typeof RESERVATION_LEVELS[number])) throw new Error('[sched] 预留档位不合法')
    if (!['active', 'idle', 'unknown'].includes(machine.ci)
      || [machine.fresh, machine.ownerHold, machine.online].some(value => typeof value !== 'boolean')) throw new Error('[sched] 机器状态不合法')
  }
  for (const ticket of queue) {
    ticketId(ticket.ticketId); integer(ticket.requestedCores, 1); isoTime(ticket.queuedAt)
    if (![0, 1].includes(ticket.band) || (ticket.state !== undefined && !['queued', 'unsatisfiable'].includes(ticket.state))) throw new Error('[sched] 排队状态不合法')
    if (!Array.isArray(ticket.allowedMachines) || !ticket.allowedMachines.length
      || new Set(ticket.allowedMachines).size !== ticket.allowedMachines.length) throw new Error('[sched] 允许机器列表不合法')
    ticket.allowedMachines.forEach(segment)
  }
}

/**
 * 长期占用单(SCHED-MR5-RESIDENT-LEASE-0924)的账：按机器汇总常驻服务已登记的核数。
 * 只数「已授予、未终结」的长期占用单——它们已经通过许可计入心跳的 grantedCores，
 * 再从外部负载里减掉同一批核，就是「从外部负载剔除」那一步(见 applyResidentLeases)。
 */
export function residentLeaseCores(tickets: readonly TicketSnapshot[]): Map<string, number> {
  const cores = new Map<string, number>()
  for (const ticket of tickets) {
    if (ticket.request.resident !== true || ticket.endedAt !== null) continue
    if (!['granted', 'running', 'paused', 'slow'].includes(ticket.state)) continue
    const attempt = ticket.attempts.find(value => value.attemptId === ticket.currentAttemptId)
    if (!attempt?.permit) continue
    cores.set(attempt.permit.machine, (cores.get(attempt.permit.machine) ?? 0) + attempt.grantedCores)
  }
  return cores
}
/**
 * 把常驻服务占的核从机器读数的外部负载里减掉：同一批核已经算进了 grantedCores，
 * 而服务自己的 CPU 又一定出现在心跳的忙碌核数里——不减就是一台机器扣两遍，
 * 那台机器会永远少派活。减到 0 为止，绝不为负；没有长期占用单的机器原样返回(逐字节不变)。
 */
export function applyResidentLeases(machines: readonly MachineInput[], residentCores: ReadonlyMap<string, number>, residentActualUsage = false): MachineInput[] {
  // 实际用量开时只剔除常驻授予核，实测外部负载不抵扣；关时下面的原租约口径一字不动。
  if (residentActualUsage === true) return machines.map(machine => {
    const cores = residentCores.get(machine.name) ?? 0
    return cores <= 0 ? machine : { ...machine, grantedCores: Math.max(0, machine.grantedCores - cores) }
  })
  return machines.map(machine => {
    const cores = residentCores.get(machine.name) ?? 0
    if (cores <= 0) return machine
    return { ...machine, externalLoadCores: Math.max(0, machine.externalLoadCores - cores) }
  })
}

/**
 * 只做准入/选机，绝不暂停、释放或重排执行。输入 grantedCores 包含暂停和已授予未启动的核数。
 * 申请中的预留一次扣足，因此当前未兑现时不会被持续到来的新单抢走。
 * grants/unsatisfiable/cleared 按票据的队列顺序；机器和锁按名字。排序不用宿主区域设置。
 */
export function decideAdmission(input: { now: string; machines: readonly MachineInput[]; queue: readonly QueuedTicket[]; agentSlots?: AgentSlotInput; managedLoad?: ManagedLoadInput; placement?: PlacementInput; ciBorrow?: CiBorrowAdmissionInput; memory?: MemoryGateInput }): AdmissionDecision {
  const now = Date.parse(isoTime(input.now))
  validateInputs(input.machines, input.queue)
  for (const value of Object.values(input.agentSlots?.perMachine ?? {})) {
    if (value === null || typeof value !== 'object' || !Number.isInteger(value.capacity) || value.capacity < 1
      || !Number.isInteger(value.occupied) || value.occupied < 0) {
      throw new Error('[sched] 执行端件数不合法')
    }
  }
  for (const value of Object.values(input.managedLoad?.perMachine ?? {})) {
    if (value === null || typeof value !== 'object' || !Number.isFinite(value.measuredCores) || value.measuredCores < 0
      || !Number.isFinite(value.overrunCores) || value.overrunCores < 0
      || (value.creditCores !== undefined && (!Number.isFinite(value.creditCores) || value.creditCores < 0))) {
      throw new Error('[sched] 在管实测不合法')
    }
  }
  if (input.placement !== undefined) {
    if (input.placement === null || !input.placement.perTicket || typeof input.placement.perTicket !== 'object'
      || Array.isArray(input.placement.perTicket)) throw new Error('[sched] 选机输入不合法')
    const ids = new Map(input.queue.map(ticket => [ticket.ticketId, ticket]))
    for (const [id, value] of Object.entries(input.placement.perTicket)) {
      const ticket = ids.get(id)
      if (!ticket || input.agentSlots?.clusterTicketIds.includes(id) || !value
        || !ticket.allowedMachines.includes(value.origin)
        || (value.preferredMachines !== undefined && (!Array.isArray(value.preferredMachines)
          || new Set(value.preferredMachines).size !== value.preferredMachines.length
          || value.preferredMachines.some(name => !ticket.allowedMachines.includes(name))))
        || !['shared', 'vitest', 'solo'].includes(value.jobClass)
        || typeof value.elastic !== 'boolean' || !Number.isSafeInteger(value.runMs) || value.runMs < 0
        || ticket.allowedMachines.some(name => {
          const timing = value.perMachine?.[name]
          return !timing || !Number.isSafeInteger(timing.shipMs) || timing.shipMs < 0
            || !Number.isSafeInteger(timing.warmupMs) || timing.warmupMs < 0
        })) throw new Error('[sched] 选机输入不合法')
    }
  }
  for (const value of Object.values(input.ciBorrow?.perMachine ?? {})) {
    if (value === null || typeof value !== 'object' || !Number.isSafeInteger(value.lendableCores)
      || value.lendableCores < 0 || !Number.isSafeInteger(value.borrowedCores) || value.borrowedCores < 0) {
      throw new Error('[sched] 借核准入不合法')
    }
  }
  if (input.ciBorrow && new Set(input.ciBorrow.ticketIds).size !== input.ciBorrow.ticketIds.length) {
    throw new Error('[sched] 借核单号重复')
  }
  // 内存闸(SCHED-MR6-MEMORY-DIMENSION-0924):blocked 机一拍绝不放新活(普通、自动与借核一样);
  // single 机一份读数只放一张——本拍已在它上面授予过的,后面(含借核)都不再去。不传 memory 就完全没有闸。
  let memoryModeOf: ((name: string) => MemoryGateMode | undefined) | undefined
  if (input.memory !== undefined) {
    const perMachine = (input.memory as MemoryGateInput | null)?.perMachine
    if (perMachine === undefined || typeof perMachine !== 'object' || Array.isArray(perMachine)) {
      throw new Error('[sched] 内存闸输入不合法')
    }
    const modes = new Map<string, MemoryGateMode>()
    for (const [name, entry] of Object.entries(perMachine)) {
      segment(name)
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('[sched] 内存闸输入不合法')
      const mode = (entry as { mode?: unknown }).mode
      if (mode !== 'open' && mode !== 'single' && mode !== 'blocked') throw new Error('[sched] 内存闸输入不合法')
      modes.set(name, mode)
    }
    memoryModeOf = (name) => modes.get(name)
  }
  const slots = input.agentSlots === undefined ? undefined : new Map(input.machines.map(machine => {
    const value = input.agentSlots!.perMachine[machine.name] ?? { capacity: 1, occupied: 0 }
    return [machine.name, { ...value }] as [string, { capacity: number; occupied: number; vitestActive?: boolean; soloActive?: boolean }]
  }))
  const clusterTickets = input.agentSlots === undefined ? undefined : new Set(input.agentSlots.clusterTicketIds)
  const elasticTickets = input.agentSlots === undefined ? undefined : new Set(input.agentSlots.elasticTicketIds ?? [])
  const classOf = (id: string): AgentJobClass => input.agentSlots?.ticketClass?.[id] ?? 'shared'
  const slotAvailable = (machineName: string): boolean => {
    const state = slots!.get(machineName)!
    return state.soloActive !== true && state.capacity - state.occupied >= 1
  }
  const machines = input.machines.map(machine => ({ ...machine })).sort((a, b) => a.preference - b.preference || compare(a.name, b.name))
  const queue = [...input.queue].sort(compareQueuedTickets)
  const result: AdmissionDecision = { grants: [], unsatisfiable: [], cleared: [], locks: [], machines: [],
    ...(input.ciBorrow === undefined ? {} : { borrowGrants: [] }) }
  const locked = new Set<string>()
  const memorySingleGranted = new Set<string>()
  const memoryAllows = (name: string): boolean => {
    const mode = memoryModeOf?.(name)
    if (mode === 'blocked') return false
    if (mode === 'single' && memorySingleGranted.has(name)) return false
    return true
  }
  let headSeen = false
  for (const ticket of queue) {
    const auto = input.placement && Object.hasOwn(input.placement.perTicket, ticket.ticketId)
      ? input.placement.perTicket[ticket.ticketId] : undefined
    const needsSlot = clusterTickets?.has(ticket.ticketId) === true
    const allowed = machines.filter(machine => ticket.allowedMachines.includes(machine.name))
    if (!allowed.some(machine => ticket.requestedCores <= Math.max(0, machine.quotaCores - reservation(machine)))) {
      result.unsatisfiable.push({ ticketId: ticket.ticketId, reason: `申请 ${ticket.requestedCores} 核超过所有允许机器扣除申请预留后的容量；请减少并发、撤单或调低预留` })
      continue
    }
    if (ticket.state === 'unsatisfiable') result.cleared.push(ticket.ticketId)
    const isHead = !headSeen
    headSeen = true
    const jobClass = auto?.jobClass ?? (needsSlot ? classOf(ticket.ticketId) : 'shared')
    const chosen = auto ? allowed.filter(machine => !locked.has(machine.name) && memoryAllows(machine.name)
      && (machine.name === auto.origin || (slots !== undefined && slotAvailable(machine.name)
        && (jobClass !== 'solo' || slots.get(machine.name)!.occupied === 0)
        && (jobClass !== 'vitest' || slots.get(machine.name)!.vitestActive !== true)))
      && fitsCores(machine, ticket.requestedCores, input.managedLoad))
      .map(machine => ({ machine, eta: etaMs({ ...auto.perMachine[machine.name]!, runMs: auto.runMs,
        crowd: crowdFactor({ quotaCores: machine.quotaCores,
          availableCores: machineAvailableCores(machine, input.managedLoad), requestedCores: ticket.requestedCores }) }) }))
      .sort((a, b) => {
        const preferred = auto.preferredMachines
        if (preferred?.length) {
          const left = preferred.indexOf(a.machine.name), right = preferred.indexOf(b.machine.name)
          const rank = (left < 0 ? preferred.length : left) - (right < 0 ? preferred.length : right)
          if (rank !== 0) return rank
        }
        return a.eta - b.eta || (a.machine.name === auto.origin ? -1 : b.machine.name === auto.origin ? 1
          : compare(a.machine.name, b.machine.name))
      })[0]?.machine
      : allowed.find(machine => !locked.has(machine.name) && memoryAllows(machine.name)
      && (!needsSlot || (slotAvailable(machine.name)
        && (jobClass !== 'solo' || slots!.get(machine.name)!.occupied === 0)
        && (jobClass !== 'vitest' || slots!.get(machine.name)!.vitestActive !== true)))
      && fitsCores(machine, ticket.requestedCores, input.managedLoad))
    if (chosen) {
      let cores = ticket.requestedCores
      if (auto?.elastic === true || (needsSlot && elasticTickets?.has(ticket.ticketId) === true)) {
        const state = slots?.get(chosen.name)
        const localAuto = auto !== undefined && chosen.name === auto.origin
        const freeSlotsAfter = localAuto ? Math.max(1, (state?.capacity ?? 1) - (state?.occupied ?? 0))
          : Math.max(0, (state?.capacity ?? 1) - ((state?.occupied ?? 0) + 1))
        const waitingSlots = localAuto ? (state === undefined ? 0 : state.capacity - state.occupied) : freeSlotsAfter
        const grantedIds = new Set(result.grants.map(grant => grant.ticketId))
        let waitingCores = 0
        let clusterWaiting = 0
        for (const waiting of queue) {
          if (waiting.ticketId === ticket.ticketId || grantedIds.has(waiting.ticketId)
            || !waiting.allowedMachines.includes(chosen.name)
            || waiting.requestedCores > Math.max(0, chosen.quotaCores - reservation(chosen))) continue
          if (!clusterTickets?.has(waiting.ticketId)) waitingCores += waiting.requestedCores
          else if (classOf(waiting.ticketId) === 'shared' && clusterWaiting < waitingSlots) {
            waitingCores += waiting.requestedCores
            clusterWaiting += 1
          }
        }
        cores = elasticGrantCores({ requestedCores: ticket.requestedCores, quotaCores: chosen.quotaCores,
          availableCores: machineAvailableCores(chosen, input.managedLoad), freeSlotsAfter, waitingCores })
      }
      chosen.grantedCores += cores
      if (needsSlot || (auto !== undefined && chosen.name !== auto.origin)) {
        const state = slots!.get(chosen.name)!
        state.occupied += 1
        if (jobClass === 'solo') state.soloActive = true
        if (jobClass === 'vitest') state.vitestActive = true
      }
      result.grants.push({ ticketId: ticket.ticketId, machine: chosen.name, cores })
      if (memoryModeOf?.(chosen.name) === 'single') memorySingleGranted.add(chosen.name)
    } else if (isHead && now - Date.parse(ticket.queuedAt) >= HEAD_PROTECTION_MS) {
      for (const machine of auto === undefined ? allowed : allowed.filter(value => value.name === auto.origin)) {
        // 件数满只能等在跑集群单结束；空出后队首自然先挑，锁机会误挡本机单子。
        if (needsSlot && !slotAvailable(machine.name)) continue
        // 只锁「当下真放得下」队首的机器(SCHED-HEAD-LOCK-BACKFILL-STARVATION,负责人 0914 拍板 B):
        // 配额 − 当下外部占用(与 available 同口径,externalLoadCores 与 ciReserveCores 取大者)− 预留 ≥ 申请才锁。
        // 不扣 grantedCores——已授予的核会随小单结束释放,那正是队首在等的东西,扣掉会变成永远锁不上;
        // 当下放不下的机器不锁,后面的小单照常插空,某台机器腾出足够的核后锁按同一判据自然恢复。
        if (ticket.requestedCores > Math.max(0, machine.quotaCores - (reservedForCi(machine) + reservation(machine)))) continue
        locked.add(machine.name)
        result.locks.push({ machine: machine.name, byTicketId: ticket.ticketId })
      }
    }
  }
  if (input.ciBorrow) {
    const ordinaryMachines = new Set(result.grants.map(grant => grant.machine))
    const grantedIds = new Set(result.grants.map(grant => grant.ticketId))
    const impossibleIds = new Set(result.unsatisfiable.map(value => value.ticketId))
    const borrowIds = new Set(input.ciBorrow.ticketIds)
    const usedMachines = new Set<string>()
    for (const ticket of queue) {
      if (!borrowIds.has(ticket.ticketId) || grantedIds.has(ticket.ticketId) || impossibleIds.has(ticket.ticketId)) continue
      const needsSlot = clusterTickets?.has(ticket.ticketId) === true
      const jobClass = needsSlot ? classOf(ticket.ticketId) : 'shared'
      const chosen = machines.find(machine => ticket.allowedMachines.includes(machine.name)
        && !ordinaryMachines.has(machine.name) && !usedMachines.has(machine.name) && memoryAllows(machine.name) && eligible(machine)
        && (input.ciBorrow!.perMachine[machine.name]?.lendableCores ?? 0) >= ticket.requestedCores
        && (!needsSlot || (slotAvailable(machine.name)
          && (jobClass !== 'solo' || slots!.get(machine.name)!.occupied === 0)
          && (jobClass !== 'vitest' || slots!.get(machine.name)!.vitestActive !== true)))
        && result.locks.filter(lock => lock.machine === machine.name).every(lock => {
          if (lock.byTicketId === ticket.ticketId) return true
          const head = queue.find(candidate => candidate.ticketId === lock.byTicketId)
          if (!head) return false
          const borrowed = input.ciBorrow!.perMachine[machine.name]?.borrowedCores ?? 0
          return machineAvailableCores({ ...machine, grantedCores: machine.grantedCores - borrowed }, input.managedLoad)
            < head.requestedCores
        }))
      if (!chosen) continue
      chosen.grantedCores += ticket.requestedCores
      if (needsSlot) {
        const state = slots!.get(chosen.name)!
        state.occupied += 1
        if (jobClass === 'solo') state.soloActive = true
        if (jobClass === 'vitest') state.vitestActive = true
      }
      const grant = { ticketId: ticket.ticketId, machine: chosen.name, cores: ticket.requestedCores }
      result.grants.push(grant)
      result.borrowGrants!.push(grant)
      grantedIds.add(ticket.ticketId)
      usedMachines.add(chosen.name)
      if (memoryModeOf?.(chosen.name) === 'single') memorySingleGranted.add(chosen.name)
    }
  }
  result.locks.sort((a, b) => compare(a.machine, b.machine))
  result.machines = [...machines].sort((a, b) => compare(a.name, b.name)).map(machine => ({
    name: machine.name, availableCores: machineAvailableCores(machine, input.managedLoad),
    overCommitted: input.managedLoad === undefined
      ? machine.grantedCores + machine.externalLoadCores + reservation(machine) > machine.quotaCores
      : machineManagedLoad(machine, input.managedLoad).managedCores
        + machineManagedLoad(machine, input.managedLoad).unmanagedCores + reservation(machine) > machine.quotaCores,
    reservation: {
      requestedCores: reservation(machine),
      fulfilledCores: input.managedLoad === undefined
        ? Math.min(reservation(machine), Math.max(0, machine.quotaCores - machine.grantedCores - machine.externalLoadCores))
        : Math.min(reservation(machine), Math.max(0, machine.quotaCores
          - machineManagedLoad(machine, input.managedLoad).managedCores
          - machineManagedLoad(machine, input.managedLoad).unmanagedCores)),
    },
  }))
  return result
}
