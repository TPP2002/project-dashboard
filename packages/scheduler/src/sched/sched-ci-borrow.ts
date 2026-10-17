import projects from './client/sched-projects.cjs'
import type { MenuItem } from './client/sched-projects.cjs'
import { READING_FRESHNESS_MS } from './sched-contract'
import { machineManagedLoad, type CiBorrowAdmissionInput, type MachineInput, type ManagedLoadInput, type QueuedTicket } from './sched-decide'
import { managedAttempts, matchedManagedReadings, type ManagedAttempt } from './sched-managed-load'
import { submissionKey, type ProjectionState } from './sched-project'
import type { LifecycleStatusSnapshot } from '../bot/cluster-lifecycle-status'

export const CI_BORROW_BUFFER_CORES = 2
export const CI_BORROW_RECOVER_MS = 60_000
export const CI_BORROW_MAX_ETA_MS = 300_000
export const CI_BORROW_MIN_SAMPLES = 3
export const CI_BORROW_ETA_WINDOW = 20
export const CI_BORROW_RAMP_MS = 300_000
/** 执行侧 CI 空闲去抖 60 秒加实测窗口 30 秒；本模块不导入挂起链路。 */
export const CI_BORROW_IDLE_SETTLE_MS = 90_000
const CI_BORROW_UNKNOWN_GRACE_MS = 30_000
export const CI_BORROW_TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

type Mode = 'off' | 'ci-active' | 'ci-idle'
const tenths = (value: number): number => Math.round(value * 10)
const cores = (value: number): number => value / 10
const safe = (value: number): number => Number.isSafeInteger(value) && value >= 0 ? value : 0
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

export interface CiBorrowAction { machine: string; ticketId: string; attemptId: string; action: 'hold' | 'release'; reason: string }
interface Borrowed { ticketId: string; attemptId: string; machine: string; lentAt: string; heldAt: string | null; grantedCores: number }
interface MachineView {
  mode: Mode; capCores: number; runningBorrowCores: number; heldBorrowCores: number; lendableCores: number
  ciTreeCores: number | null; unmanagedCores: number; effectiveManagedCores: number; busyCores: number
  idleSince: string | null; recoverSince: string | null
}
interface WindowRow { at: string; machine: string; mode: Mode; capCores: number; runningBorrowCores: number; borrowableQueuedCores: number }
export interface CiBorrowController {
  plan(input: { at: string; enabled: boolean; state: ProjectionState; snapshot: LifecycleStatusSnapshot;
    machines: readonly MachineInput[]; managedLoad?: ManagedLoadInput; queue: readonly QueuedTicket[] }): {
      admission?: CiBorrowAdmissionInput; actions: CiBorrowAction[]; lentReasons: Readonly<Record<string, string>>
    }
  snapshot(): { at: string; enabled: boolean; machines: Readonly<Record<string, MachineView>>;
    borrowed: readonly Borrowed[]; window: readonly WindowRow[] }
}

export function estimateRunningMs(state: ProjectionState, project: string, workType: string): { medianMs: number; samples: number } | undefined {
  const normalized = projects.normalizeProjectId(project).id
  const times = Object.values(state.tickets)
    .filter(ticket => projects.normalizeProjectId(ticket.request.project).id === normalized
      && ticket.request.work.type === workType && ticket.state === 'passed'
      && (ticket.attempts.at(-1)?.timing.runningMs ?? 0) > 0)
    .sort((a, b) => compare(b.endedAt ?? '', a.endedAt ?? ''))
    .slice(0, CI_BORROW_ETA_WINDOW)
    .map(ticket => ticket.attempts.at(-1)!.timing.runningMs)
    .sort((a, b) => a - b)
  if (!times.length) return undefined
  const middle = Math.floor(times.length / 2)
  return { medianMs: times.length % 2 === 1 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2, samples: times.length }
}

export function isCiBorrowable(state: ProjectionState, ticketId: string,
  estimate = estimateRunningMs(state, state.tickets[ticketId]?.request.project ?? '', state.tickets[ticketId]?.request.work.type ?? '')): boolean {
  const ticket = state.tickets[ticketId]
  if (!ticket || ticket.state !== 'queued' || ticket.request.resources.exclusive.length > 0) return false
  const item: MenuItem | null = projects.getMenuItem(ticket.request.project, ticket.request.work.type)
  if (!item || item.ciBorrowable === 'never') return false
  if (item.ciBorrowable === 'targeted' && !ticket.request.work.targetPaths.every(path => CI_BORROW_TEST_FILE.test(path))) return false
  return estimate !== undefined && estimate.samples >= CI_BORROW_MIN_SAMPLES && estimate.medianMs <= CI_BORROW_MAX_ETA_MS
}

export function ciBorrowEffectiveCores(input: { at: string; state: ProjectionState; attempts: readonly ManagedAttempt[];
  readings: ReadonlyMap<string, { cores: number }>; machine: string; borrowed: ReadonlySet<string> }): number {
  let total = 0
  for (const attempt of input.attempts) {
    if (attempt.machine !== input.machine) continue
    const key = `${attempt.ticketId}--${attempt.attemptId}`
    const reading = input.readings.get(key)?.cores
    const granted = tenths(attempt.grantedCores)
    if (input.borrowed.has(key)) {
      const held = input.state.ciBorrows?.[submissionKey(attempt.ticketId)]?.heldAt !== null
      if (!held && reading !== undefined) total += Math.max(0, tenths(reading) - granted)
      continue
    }
    const ticket = input.state.tickets[attempt.ticketId]
    const startedAt = ticket?.attempts.find(value => value.attemptId === attempt.attemptId)?.startedAt
    const protectedAttempt = ticket?.state === 'granted' || startedAt === null || startedAt === undefined
      || Date.parse(input.at) - Date.parse(startedAt) < CI_BORROW_RAMP_MS || reading === undefined
    total += protectedAttempt ? Math.max(granted, tenths(reading ?? 0)) : tenths(reading)
  }
  return cores(total)
}

export function ciBorrowCap(input: { mode: Mode; quotaCores: number; reservationCores: number; unmanagedCores: number;
  effectiveManagedCores: number; managedWithoutBorrowCores: number; ciReserveCores: number; ciTreeCores: number | null }): number {
  if (input.mode === 'off') return 0
  const quota = tenths(input.quotaCores); const reserved = tenths(input.reservationCores)
  const unmanaged = tenths(input.unmanagedCores); const buffer = CI_BORROW_BUFFER_CORES * 10
  if (input.mode === 'ci-idle') return Math.max(0, Math.floor((quota - reserved - buffer - unmanaged - tenths(input.effectiveManagedCores)) / 10))
  if (input.ciTreeCores === null) return 0
  const demand = Math.max(unmanaged, tenths(input.ciTreeCores))
  const bound = Math.min(tenths(input.ciReserveCores) - demand,
    quota - tenths(input.managedWithoutBorrowCores) - reserved - demand) - buffer
  return Math.max(0, Math.floor(bound / 10))
}

function blockedMailbox(state: ProjectionState, machine: string): boolean {
  return Object.values(state.tickets).some(ticket => {
    if (ticket.request.execution !== 'cluster' || ticket.endedAt !== null || ticket.state !== 'granted') return false
    const attempt = ticket.attempts.at(-1)
    return attempt?.attemptId === ticket.currentAttemptId && attempt.permit?.machine === machine
      && attempt.permit.ciAware !== true
  })
}

export function createCiBorrowController(options: { warn?: (message: string) => void }): CiBorrowController {
  const idleSince = new Map<string, number>()
  const recoverSince = new Map<string, number>()
  const unknownSince = new Map<string, number>()
  const cache = new Map<string, { medianMs: number; samples: number } | undefined>()
  let cacheSeq = -1
  let warnedAt = -Infinity
  let view: ReturnType<CiBorrowController['snapshot']> = { at: '', enabled: false, machines: {}, borrowed: [], window: [] }
  return {
    snapshot: () => structuredClone(view),
    plan(input) {
      try {
        const atMs = Date.parse(input.at)
        if (!Number.isFinite(atMs)) throw new Error('借核时刻不合法')
        const enabled = input.enabled && input.managedLoad !== undefined
        if (cacheSeq !== input.state.cursor.seq) { cache.clear(); cacheSeq = input.state.cursor.seq }
        const attempts = managedAttempts(input.state)
        const readings = matchedManagedReadings({ now: input.at, snapshot: input.snapshot, machines: input.machines, attempts })
        const borrowed: Borrowed[] = attempts.flatMap(attempt => {
          const entry = input.state.ciBorrows?.[submissionKey(attempt.ticketId)]
          return entry?.attemptId === attempt.attemptId && entry.machine === attempt.machine
            ? [{ ...entry, grantedCores: attempt.grantedCores }] : []
        })
        const borrowedKeys = new Set(borrowed.map(entry => `${entry.ticketId}--${entry.attemptId}`))
        const actions: CiBorrowAction[] = []
        const perMachine: Record<string, { lendableCores: number; borrowedCores: number }> = {}
        const lentReasons: Record<string, string> = {}
        const views: Record<string, MachineView> = {}
        const rows: WindowRow[] = []
        const ticketIds: string[] = []
        const seen = new Set<string>()
        if (enabled) for (const queued of input.queue) {
          if (seen.has(queued.ticketId)) continue
          seen.add(queued.ticketId)
          const ticket = input.state.tickets[queued.ticketId]
          if (!ticket) continue
          const key = `${projects.normalizeProjectId(ticket.request.project).id}\0${ticket.request.work.type}`
          if (!cache.has(key)) cache.set(key, estimateRunningMs(input.state, ticket.request.project, ticket.request.work.type))
          if (isCiBorrowable(input.state, queued.ticketId, cache.get(key))) ticketIds.push(queued.ticketId)
        }
        const borrowable = new Set(ticketIds)
        for (const machine of input.machines) {
          const relevant = borrowed.filter(entry => entry.machine === machine.name)
          const running = relevant.filter(entry => entry.heldAt === null)
          const held = relevant.filter(entry => entry.heldAt !== null)
          const allCores = relevant.reduce((sum, entry) => sum + entry.grantedCores, 0)
          const runningCores = running.reduce((sum, entry) => sum + entry.grantedCores, 0)
          const heldCores = held.reduce((sum, entry) => sum + entry.grantedCores, 0)
          const mode: Mode = machine.fresh && machine.online && !machine.ownerHold && machine.ci !== 'unknown'
            ? machine.ci === 'active' ? 'ci-active' : 'ci-idle' : 'off'
          const unknownOnly = machine.fresh && machine.online && !machine.ownerHold && machine.ci === 'unknown'
          if (!enabled || !unknownOnly) unknownSince.delete(machine.name)
          else if (!unknownSince.has(machine.name)) unknownSince.set(machine.name, atMs)
          if (!enabled || mode !== 'ci-idle') idleSince.delete(machine.name)
          else if (!idleSince.has(machine.name)) idleSince.set(machine.name, atMs)
          const settled = mode === 'ci-idle' && atMs - (idleSince.get(machine.name) ?? atMs) >= CI_BORROW_IDLE_SETTLE_MS
          const ciReading = input.snapshot.machines.find(value => value.machine === machine.name)?.heartbeat?.ciTreeLoad
          const ciTree = machine.fresh && ciReading && Number.isFinite(Date.parse(ciReading.sampledAt))
            && Math.abs(atMs - Date.parse(ciReading.sampledAt)) <= READING_FRESHNESS_MS
            && Number.isFinite(ciReading.cores) && ciReading.cores >= 0 && ciReading.cores <= 1024 ? ciReading.cores : null
          const { managedCores, unmanagedCores } = machineManagedLoad(machine, input.managedLoad ?? { perMachine: {} })
          const effective = ciBorrowEffectiveCores({ at: input.at, state: input.state, attempts, readings,
            machine: machine.name, borrowed: borrowedKeys })
          const cap = enabled ? ciBorrowCap({ mode, quotaCores: machine.quotaCores,
            reservationCores: machine.reservation?.requestedCores ?? 0, unmanagedCores,
            effectiveManagedCores: effective, managedWithoutBorrowCores: cores(tenths(managedCores) - tenths(allCores)),
            ciReserveCores: machine.ciReserveCores, ciTreeCores: ciTree }) : 0
          const shouldFreeze = mode === 'ci-idle'
            ? settled && tenths(unmanagedCores) + tenths(effective) + tenths(runningCores)
              > tenths(machine.quotaCores) - tenths(machine.reservation?.requestedCores ?? 0)
            : tenths(runningCores) > tenths(cap)
              && (!unknownOnly || atMs - (unknownSince.get(machine.name) ?? atMs) >= CI_BORROW_UNKNOWN_GRACE_MS)
          let froze = false
          if (!enabled) {
            recoverSince.delete(machine.name)
            for (const entry of held) actions.push({ machine: machine.name, ticketId: entry.ticketId,
              attemptId: entry.attemptId, action: 'release', reason: '借核开关关闭,释放冻结' })
          } else if (shouldFreeze) {
            const entry = [...running].sort((a, b) => compare(b.lentAt, a.lentAt) || compare(b.ticketId, a.ticketId))[0]
            if (entry) {
              const detail = mode === 'ci-active'
                ? `借核收回(CI 在跑):可借上限 ${cap} 核 < 运行中借用 ${runningCores} 核(CI 树 ${ciTree ?? '量不到'} 核,未受管 ${unmanagedCores} 核)`
                : mode === 'ci-idle'
                  ? `借核收回(CI 空闲):可借上限 ${cap} 核 < 运行中借用 ${runningCores} 核(整机忙碌 ${machine.externalLoadCores} 核,未受管 ${unmanagedCores} 核,在管有效占用 ${effective} 核)`
                  : `借核收回:机器不合格或 CI 状态未知,运行中借用 ${runningCores} 核`
              actions.push({ machine: machine.name, ticketId: entry.ticketId, attemptId: entry.attemptId, action: 'hold', reason: detail })
              froze = true
            }
            recoverSince.delete(machine.name)
          } else if (held.length > 0) {
            const entry = [...held].sort((a, b) => compare(a.lentAt, b.lentAt) || compare(a.ticketId, b.ticketId))[0]!
            const grant = entry.grantedCores
            const ok = mode !== 'off' && tenths(machine.externalLoadCores) + tenths(grant) <= tenths(machine.quotaCores - CI_BORROW_BUFFER_CORES)
              && (mode === 'ci-active' && ciTree !== null || mode === 'ci-idle' && settled)
              && tenths(runningCores) + tenths(grant) <= tenths(cap)
            if (!ok) recoverSince.delete(machine.name)
            else if (!recoverSince.has(machine.name)) recoverSince.set(machine.name, atMs)
            else if (atMs - recoverSince.get(machine.name)! >= CI_BORROW_RECOVER_MS) {
              actions.push({ machine: machine.name, ticketId: entry.ticketId, attemptId: entry.attemptId,
                action: 'release', reason: '借核回落满 60 秒,按先借先恢复' })
              recoverSince.set(machine.name, atMs)
            }
          } else recoverSince.delete(machine.name)
          const lendable = enabled && mode !== 'off' && held.length === 0 && !froze
            && (mode === 'ci-active' ? ciTree !== null && !blockedMailbox(input.state, machine.name) : settled)
            ? Math.max(0, cap - runningCores) : 0
          perMachine[machine.name] = { lendableCores: safe(Math.floor(lendable)), borrowedCores: safe(Math.floor(allCores)) }
          if (lendable > 0) lentReasons[machine.name] = mode === 'ci-active'
            ? `借核:CI 在跑,留核闲置(可借上限 ${cap} 核)`
            : `借核:CI 空闲,在管单批了没用满(可借上限 ${cap} 核,整机忙碌 ${machine.externalLoadCores} 核)`
          views[machine.name] = { mode, capCores: cap, runningBorrowCores: runningCores, heldBorrowCores: heldCores,
            lendableCores: perMachine[machine.name]!.lendableCores, ciTreeCores: ciTree,
            unmanagedCores, effectiveManagedCores: effective, busyCores: machine.externalLoadCores,
            idleSince: idleSince.has(machine.name) ? new Date(idleSince.get(machine.name)!).toISOString() : null,
            recoverSince: recoverSince.has(machine.name) ? new Date(recoverSince.get(machine.name)!).toISOString() : null }
          rows.push({ at: input.at, machine: machine.name, mode, capCores: cap, runningBorrowCores: runningCores,
            borrowableQueuedCores: input.queue.filter(ticket => borrowable.has(ticket.ticketId)
              && ticket.allowedMachines.includes(machine.name)).reduce((sum, ticket) => sum + ticket.requestedCores, 0) })
        }
        if (!enabled) for (const entry of borrowed) {
          if (entry.heldAt !== null && !Object.hasOwn(perMachine, entry.machine)) {
            actions.push({ machine: entry.machine, ticketId: entry.ticketId, attemptId: entry.attemptId,
              action: 'release', reason: '借核开关关闭,释放冻结' })
          }
        }
        if (!enabled) { idleSince.clear(); recoverSince.clear(); unknownSince.clear() }
        view = { at: input.at, enabled, machines: views, borrowed, window: [...view.window, ...rows]
          .filter(row => atMs - Date.parse(row.at) < 60_000 && Date.parse(row.at) <= atMs) }
        return { ...(enabled ? { admission: { perMachine, ticketIds } } : {}), actions, lentReasons }
      } catch (error) {
        const now = Date.parse(input.at)
        if (Number.isFinite(now) && now - warnedAt >= 60_000) {
          warnedAt = now
          try { options.warn?.(`[sched] 借核规划失败:${error instanceof Error ? error.message : String(error)}`) } catch { /* 告警不影响派单 */ }
        }
        return { admission: undefined, actions: [], lentReasons: {} }
      }
    },
  }
}
