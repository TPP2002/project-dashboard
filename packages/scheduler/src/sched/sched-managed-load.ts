import type { LifecycleStatusSnapshot } from '../bot/cluster-lifecycle-status'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import { errorMessage } from '../bot/cluster-lifecycle-contract'
import { READING_FRESHNESS_MS, type TicketSnapshot } from './sched-contract'
import type { MachineInput, ManagedLoadInput } from './sched-decide'
import type { ProjectionState } from './sched-project'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  canonicalJson, OVERUSE_ALERT_AFTER_MS, OVERUSE_MARK_AFTER_MS, OVERUSE_RATIO, schedPaths, utcDate,
  validateTicketOveruse, type TicketOveruse,
} from './sched-contract'
import { machineAvailableCores, machineManagedLoad } from './sched-decide'

export interface ManagedAttempt {
  ticketId: string
  attemptId: string
  machine: string
  grantedCores: number
  category: TicketSnapshot['request']['category']
  workType: string
  /** 本次执行的开跑时刻,取自票据 attempts[].startedAt(当前执行);未开跑为 null。 */
  startedAt: string | null
  /** 常驻长期占用单不参与实测退回(SCHED-ACTUAL-USAGE-ADMISSION-1010),但它仍按 1137 口径计实测/超吃。 */
  resident: boolean
}

/** 与授予累计共用这一遍历口径；终结单和没有许可的执行不算在管。 */
export function managedAttempts(state: ProjectionState, residentActualUsage = false): ManagedAttempt[] {
  const attempts: ManagedAttempt[] = []
  for (const ticket of Object.values(state.tickets)) {
    // 实际用量开时常驻服务全额留在实测外部负载，不再作为托管实测抵扣；关时仍数全部许可。
    if (residentActualUsage === true && ticket.request.resident === true) continue
    if (!['granted', 'running', 'paused', 'slow'].includes(ticket.state)) continue
    const attempt = ticket.attempts.find(value => value.attemptId === ticket.currentAttemptId)
    if (!attempt?.permit) continue
    attempts.push({ ticketId: ticket.ticketId, attemptId: attempt.attemptId, machine: attempt.permit.machine,
      grantedCores: attempt.grantedCores, category: ticket.request.category, workType: ticket.request.work.type,
      startedAt: attempt.startedAt, resident: ticket.request.resident === true })
  }
  return attempts
}

/** 实测退回的暖机门槛与放大系数(SCHED-ACTUAL-USAGE-ADMISSION-1010,负责人 2026-10-10 拍板)。 */
export const ACTUAL_USAGE_WARMUP_MS = 180_000
export const ACTUAL_USAGE_RATIO = 1.3
/** 向上取到 0.5 核:7.865 → 8,6.5 → 6.5,0.26 → 0.5。 */
const ceilHalf = (value: number): number => Math.ceil(value * 2) / 2

/**
 * 实测退回(SCHED-ACTUAL-USAGE-ADMISSION-1010):一张在管、非常驻、已开跑满暖机且读数新鲜的执行,
 * 账面只记 effective = min(授予, max(1, ceilHalf(实测 × 1.3))),差额 credit = 授予 − effective(≥ 0)
 * 当拍退回可用核。未开跑(startedAt 为 null)、没跑满 180 秒暖机的执行 credit 恒为 0——刚放出去的
 * 单读不出真实用量,退回只会虚开。常驻单不进这里(调用方按 1137 口径先剔/resident 标跳过)。
 */
export function attemptCreditCores(input: {
  grantedCores: number; measuredCores: number; startedAt: string | null; now: string
  ratio?: number; warmupMs?: number
}): { effectiveCores: number; creditCores: number } {
  const ratio = input.ratio ?? ACTUAL_USAGE_RATIO
  const warmupMs = input.warmupMs ?? ACTUAL_USAGE_WARMUP_MS
  if (input.startedAt === null || !Number.isFinite(Date.parse(input.startedAt))
    || Date.parse(input.now) - Date.parse(input.startedAt) < warmupMs) {
    return { effectiveCores: input.grantedCores, creditCores: 0 }
  }
  const effectiveCores = Math.min(input.grantedCores, Math.max(1, ceilHalf(input.measuredCores * ratio)))
  return { effectiveCores, creditCores: Math.max(0, input.grantedCores - effectiveCores) }
}

export function matchedManagedReadings(input: {
  now: string; snapshot: LifecycleStatusSnapshot; machines: readonly MachineInput[]; attempts: readonly ManagedAttempt[]
}): Map<string, { attempt: ManagedAttempt; cores: number; sampledAt: string }> {
  const matched = new Map<string, { attempt: ManagedAttempt; cores: number; sampledAt: string }>()
  const fresh = new Map(input.machines.map(machine => [machine.name, machine.fresh]))
  const readings = new Map(input.snapshot.machines.map(machine => [machine.machine, machine.heartbeat?.attemptLoad]))
  for (const attempt of input.attempts) {
    if (!fresh.get(attempt.machine)) continue
    const load = readings.get(attempt.machine)
    if (!load || !Number.isFinite(Date.parse(load.sampledAt))
      || Math.abs(Date.parse(input.now) - Date.parse(load.sampledAt)) > READING_FRESHNESS_MS) continue
    const entry = load.attempts.find(value => value.ticketId === attempt.ticketId && value.attemptId === attempt.attemptId)
    if (entry) matched.set(`${attempt.ticketId}--${attempt.attemptId}`, { attempt, cores: entry.cores, sampledAt: load.sampledAt })
  }
  return matched
}

export function managedLoadInput(input: {
  now: string; snapshot: LifecycleStatusSnapshot; machines: readonly MachineInput[]; attempts: readonly ManagedAttempt[]
  /** 实测退回开关(SCHED-ACTUAL-USAGE-ADMISSION-1010);缺省/false 时 creditCores 键一律不出现,账面与改前逐字节相同。 */
  actualUsageAdmission?: boolean
}): ManagedLoadInput {
  const matched = matchedManagedReadings(input)
  const perMachine: Record<string, { measuredCores: number; overrunCores: number; creditCores?: number }> = {}
  for (const machine of input.machines) {
    let measuredTenths = 0; let overrunTenths = 0; let creditTenths = 0
    for (const { attempt, cores } of matched.values()) {
      if (attempt.machine !== machine.name) continue
      const tenths = Math.round(cores * 10)
      measuredTenths += tenths
      overrunTenths += Math.max(0, tenths - attempt.grantedCores * 10)
      // 实测退回只认开关开、非常驻、在 matchedManagedReadings 里匹配上新鲜读数的执行;
      // 没匹配上的读数本来就不进这圈循环,账面回到改前。
      if (input.actualUsageAdmission !== true || attempt.resident) continue
      creditTenths += Math.round(attemptCreditCores({ grantedCores: attempt.grantedCores, measuredCores: cores,
        startedAt: attempt.startedAt, now: input.now }).creditCores * 10)
    }
    // creditCores 只在有退回时写键:恒写 0 会改掉开关关时的逐字节现状,旧调用方按形状比对会红。
    perMachine[machine.name] = creditTenths > 0
      ? { measuredCores: measuredTenths / 10, overrunCores: overrunTenths / 10, creditCores: creditTenths / 10 }
      : { measuredCores: measuredTenths / 10, overrunCores: overrunTenths / 10 }
  }
  return { perMachine }
}

export interface ManagedLoadOverrun {
  at: string; machine: string; ticketId: string; attemptId: string; since: string;
  grantedCores: number; measuredCores: number
}
export interface ManagedLoadTrackerSnapshot {
  readonly overruns: readonly ManagedLoadOverrun[]
  readonly machines: Readonly<Record<string, { managedCores: number; unmanagedCores: number; newAvailableCores: number; oldAvailableCores: number }>>
}

/** 一条在管执行的连续超吃账;超用标记(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925)也从这里投。 */
interface OverrunState {
  machine: string; grantedCores: number; measuredCores: number
  since?: string; last?: string; logged: boolean; count: number; alertedAt?: string
}
export interface ManagedLoadTracker {
  warnFailure(error: unknown): void
  snapshot(): ManagedLoadTrackerSnapshot
  /** 以下状态仅由 recordManagedLoadTick 更改。 */
  readonly state: Map<string, OverrunState>
  readonly summaryAt: Map<string, number>
  readonly overruns: ManagedLoadOverrun[]
  readonly machines: Record<string, { managedCores: number; unmanagedCores: number; newAvailableCores: number; oldAvailableCores: number }>
  clear(): void
}

export function createManagedLoadTracker(options: { warn?: (message: string) => void }): ManagedLoadTracker {
  const state = new Map<string, OverrunState>()
  const summaryAt = new Map<string, number>()
  const overruns: ManagedLoadOverrun[] = []
  const machines: ManagedLoadTracker['machines'] = {}
  let warned: string | undefined
  return {
    state, summaryAt, overruns, machines,
    warnFailure(error): void {
      const code = (error as { code?: string } | null)?.code ?? (error instanceof Error ? error.name : 'unknown')
      if (code === warned) return
      warned = code
      try { options.warn?.(`[sched] 在管负载记录失败:${code}`) } catch { /* 告警端口不可影响心跳 */ }
    },
    snapshot(): ManagedLoadTrackerSnapshot {
      return { overruns: overruns.map(value => ({ ...value })), machines: Object.fromEntries(Object.entries(machines)
        .map(([name, value]) => [name, { ...value }])) }
    },
    clear(): void { state.clear(); summaryAt.clear(); overruns.length = 0; for (const key of Object.keys(machines)) delete machines[key] },
  }
}

export function recordManagedLoadTick(tracker: ManagedLoadTracker, input: {
  share: string; at: string; enabled: boolean; snapshot: LifecycleStatusSnapshot; state: ProjectionState;
  machines: readonly MachineInput[]; managedLoad?: ManagedLoadInput; log?: (message: string) => void
  residentActualUsage?: boolean
}): void {
  if (!input.enabled) { tracker.clear(); return }
  try {
    const attempts = managedAttempts(input.state, input.residentActualUsage)
    const active = new Set(attempts.map(attempt => `${attempt.ticketId}--${attempt.attemptId}`))
    for (const key of tracker.state.keys()) if (!active.has(key)) tracker.state.delete(key)
    const readings = matchedManagedReadings({ now: input.at, snapshot: input.snapshot, machines: input.machines, attempts })
    for (const [key, reading] of readings) {
      const { attempt, cores, sampledAt } = reading
      const previous = tracker.state.get(key) ?? { machine: attempt.machine, grantedCores: attempt.grantedCores,
        measuredCores: cores, logged: false, count: 0 }
      if (previous.last !== undefined && sampledAt <= previous.last) continue
      if (cores <= attempt.grantedCores * OVERUSE_RATIO) {
        // 回落:持续窗口清零重算;已告警的事实跨窗口保留,同一执行绝不告警第二次。
        tracker.state.set(key, { machine: attempt.machine, grantedCores: attempt.grantedCores, measuredCores: cores,
          logged: false, count: previous.count, last: sampledAt,
          ...(previous.alertedAt === undefined ? {} : { alertedAt: previous.alertedAt }) })
        continue
      }
      const since = previous.since === undefined || previous.last === undefined
        || Date.parse(sampledAt) - Date.parse(previous.last) > READING_FRESHNESS_MS ? sampledAt : previous.since
      const logged = previous.since === since ? previous.logged : false
      // 超用告警(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925):持续满 5 分钟的那一拍告警,
      // 同一执行只一次(alertedAt 跨回落保留);行文与 jsonl kind:'alert' 行都落在派单员日志目录。
      const alertDue = previous.alertedAt === undefined
        && Date.parse(sampledAt) - Date.parse(since) >= OVERUSE_ALERT_AFTER_MS
      const alertedAt = alertDue ? sampledAt : previous.alertedAt
      const next = { machine: attempt.machine, grantedCores: attempt.grantedCores, measuredCores: cores,
        since, last: sampledAt, logged, count: previous.count,
        ...(alertedAt === undefined ? {} : { alertedAt }) }
      if (!logged && next.count < 3 && Date.parse(sampledAt) - Date.parse(since) >= 60_000) {
        next.logged = true; next.count += 1
        const line = { schema: 1, at: input.at, machine: attempt.machine, ticketId: attempt.ticketId,
          attemptId: attempt.attemptId, category: attempt.category, workType: attempt.workType,
          grantedCores: attempt.grantedCores, measuredCores: cores, since }
        try { input.log?.(`[sched] 超吃:${attempt.machine} ${attempt.ticketId} 授予 ${attempt.grantedCores} 核、实测 ${cores} 核、自 ${since} 起持续满 60 秒`) }
        catch (error) { tracker.warnFailure(error) }
        try {
          const directory = join(schedPaths(input.share).logs, utcDate(input.at))
          mkdirSync(directory, { recursive: true })
          appendFileSync(join(directory, 'managed-load-overrun.jsonl'), `${JSON.stringify(line)}\n`)
        } catch (error) { tracker.warnFailure(error) }
        tracker.overruns.push({ at: input.at, machine: attempt.machine, ticketId: attempt.ticketId,
          attemptId: attempt.attemptId, since, grantedCores: attempt.grantedCores, measuredCores: cores })
        if (tracker.overruns.length > 64) tracker.overruns.shift()
      }
      if (alertDue) {
        const line = { schema: 1, kind: 'alert' as const, at: input.at, machine: attempt.machine,
          ticketId: attempt.ticketId, attemptId: attempt.attemptId, category: attempt.category,
          workType: attempt.workType, grantedCores: attempt.grantedCores, measuredCores: cores, since }
        try { input.log?.(`[sched] 超用告警:${attempt.machine} ${attempt.ticketId} 授予 ${attempt.grantedCores} 核、实测 ${cores} 核、已持续 ${Math.floor((Date.parse(sampledAt) - Date.parse(since)) / 60_000)} 分钟,已告知挂号终端`) }
        catch (error) { tracker.warnFailure(error) }
        try {
          const directory = join(schedPaths(input.share).logs, utcDate(input.at))
          mkdirSync(directory, { recursive: true })
          appendFileSync(join(directory, 'managed-load-overrun.jsonl'), `${JSON.stringify(line)}\n`)
        } catch (error) { tracker.warnFailure(error) }
      }
      tracker.state.set(key, next)
    }
    if (!input.managedLoad) return
    const visibleMachines = new Set(input.machines.map(machine => machine.name))
    for (const name of Object.keys(tracker.machines)) if (!visibleMachines.has(name)) delete tracker.machines[name]
    for (const name of tracker.summaryAt.keys()) if (!visibleMachines.has(name)) tracker.summaryAt.delete(name)
    for (const machine of input.machines) {
      const { managedCores, unmanagedCores } = machineManagedLoad(machine, input.managedLoad)
      const newAvailableCores = machineAvailableCores(machine, input.managedLoad)
      const oldAvailableCores = machineAvailableCores(machine)
      tracker.machines[machine.name] = { managedCores, unmanagedCores, newAvailableCores, oldAvailableCores }
      const last = tracker.summaryAt.get(machine.name)
      if (newAvailableCores === oldAvailableCores || (last !== undefined && Date.parse(input.at) - last < 60_000)) continue
      tracker.summaryAt.set(machine.name, Date.parse(input.at))
      // 实测退回(SCHED-ACTUAL-USAGE-ADMISSION-1010):退回 >0 时把数字带进决策日志;status 的机器
      // 原因文案在 sched.cjs(禁区),那边对退回是天然的「可派变多」,这里只补派单员侧的账目说明。
      const creditCores = input.managedLoad.perMachine[machine.name]?.creditCores ?? 0
      try { input.log?.(`[sched] 在管负载:${machine.name} 配额 ${machine.quotaCores} 已授予 ${machine.grantedCores}`
        + ` 超吃 ${input.managedLoad.perMachine[machine.name]?.overrunCores ?? 0} 整机忙碌 ${machine.externalLoadCores}`
        + ` 实测 ${input.managedLoad.perMachine[machine.name]?.measuredCores ?? 0} 未受管 ${unmanagedCores}`
        + ` CI 留核 ${machine.ciReserveCores} 预留 ${machine.reservation?.requestedCores ?? 0}`
        + ` 新可派 ${newAvailableCores} 旧可派 ${oldAvailableCores}`
        + (creditCores > 0 ? ` (实测退回 ${creditCores} 核)` : '')) } catch (error) { tracker.warnFailure(error) }
    }
  } catch (error) { tracker.warnFailure(error) }
}

/**
 * 超用标记(SCHED-GRANTED-CORES-OVERUSE-NOT-ENFORCED-0925):把记账表里「实测超过授予 1.5 倍
 * 持续满 60 秒」的当前读数投成按单号的展示标记;最新读数超过 READING_FRESHNESS_MS 没续上就不再标。
 * 派单员每个节拍调用,结果进票据快照与 managed-load/overuse.json 边车;不改变记账表本身。
 */
export function managedLoadMarks(tracker: ManagedLoadTracker, at: string): Map<string, TicketOveruse> {
  const marks = new Map<string, TicketOveruse>()
  const nowMs = Date.parse(at)
  for (const [key, entry] of tracker.state) {
    if (entry.since === undefined || entry.last === undefined) continue
    if (Date.parse(entry.last) - Date.parse(entry.since) < OVERUSE_MARK_AFTER_MS) continue
    if (nowMs - Date.parse(entry.last) > READING_FRESHNESS_MS) continue
    const [ticket, attempt] = key.split('--')
    if (ticket === undefined || attempt === undefined) continue
    marks.set(ticket, { attemptId: attempt, machine: entry.machine, grantedCores: entry.grantedCores,
      measuredCores: entry.measuredCores, since: entry.since, sampledAt: entry.last,
      // alertedAt 跨回落保留只为「同一执行只告警一次」;只有落在本段持续窗口里的才投进标记,
      // 否则新一段 since 晚于旧告警时刻,标记过不了 validateTicketOveruse(PR #1105 审查 P1)。
      ...(entry.alertedAt === undefined || Date.parse(entry.alertedAt) < Date.parse(entry.since) ? {} : { alertedAt: entry.alertedAt }) })
  }
  return marks
}

/** 超用边车内容不变 15 秒内不重写,变化立即写;写失败只告警绝不上抛——边车不能反过来卡住派单。 */
export const OVERUSE_SIDECAR_INTERVAL_MS = 15_000
export interface OveruseReporter {
  report(input: { at: string; marks: ReadonlyMap<string, TicketOveruse> }): void
}
/** `sched/managed-load/overuse.json`:按单号升序的当前超用标记,给 status 总览与挂号端看的展示缓存。 */
export function createOveruseReporter(options: { share: string; warn?: (message: string) => void }): OveruseReporter {
  const dir = join(schedPaths(options.share).root, 'managed-load')
  const staging = schedPaths(options.share).staging
  let lastTickets: string | undefined
  let lastWriteAt: number | null = null
  // 写失败自己去重:错误在这里吞掉,派单员外层看不见,不去重就每拍刷一行(PR #1105 审查 P2)。
  let failing = false
  return {
    report(input: { at: string; marks: ReadonlyMap<string, TicketOveruse> }): void {
      try {
        const tickets = [...input.marks.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([id, mark]) => {
            validateTicketOveruse(mark)
            return { ticketId: id, ...mark }
          })
        const encoded = canonicalJson(tickets)
        if (encoded === lastTickets && lastWriteAt !== null && Date.parse(input.at) - lastWriteAt < OVERUSE_SIDECAR_INTERVAL_MS) return
        mkdirSync(dir, { recursive: true }); mkdirSync(staging, { recursive: true })
        publishLifecycleFileAtomically(join(dir, 'overuse.json'),
          canonicalJson({ formatVersion: 1 as const, at: input.at, tickets }), 'replace', staging)
        lastTickets = encoded; lastWriteAt = Date.parse(input.at); failing = false
      } catch (error) {
        if (!failing) {
          try { options.warn?.(`[sched] 超用边车写失败,写成功前不再重复告警:${errorMessage(error)}`) } catch { /* 告警不得停派单员 */ }
        }
        failing = true
      }
    },
  }
}
