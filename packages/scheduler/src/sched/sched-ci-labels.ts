/**
 * CI 标签路由控制器(CI-RUNNER-LABEL-ROUTING-0924 §6.4/§7/§10)。
 *
 * 挂在派单员身边的车道标签边车:开关 off 时一粒灰都不扬(不碰 GitHub、不写盘、不log);
 * observe 只出计划不落笔;on 才真的摘/加标签,每笔写意图与结果审计,状态落盘可回放,
 * 五条不变量执行前独立复核,复核不过摘除全部作废。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import type { CiAvailabilityMemory, CiAvailabilityStep, CiAvailabilityVerdict, CiMachineObservation } from './sched-ci-availability'
import { initialAvailabilityMemory, stepAvailability } from './sched-ci-availability'
import { canonicalJson, schedPaths, utcDate } from './sched-contract'
import type { MachineInput } from './sched-decide'
import { GhApiError } from './sched-ci-labels-github'
import type { CiLabelGithubPort, GhErrorKind } from './sched-ci-labels-github'
import { MAX_OPS_PER_ROUND, CI_LABEL_PARAMS_DEFAULT, CI_MACHINE_POLICY_DEFAULT, CI_MANAGED_LANES,
  CI_RUNNER_BASELINE, checkPlanInvariants, emptyLabelMemory, laneStats, planCiLabels, reconcileMemory,
  restoreCommandsFor } from './sched-ci-labels-plan'
import type { CiDriftNote, CiLabelMemory, CiLabelOp, CiLane, CiLabelParams, CiRunnersSnapshot,
  CiStrippedEntry } from './sched-ci-labels-plan'

export const CI_LABEL_EVAL_INTERVAL_MS = 30_000
export const CI_LABEL_VIEW_REFRESH_MS = 60_000
export const CI_LABEL_VIEW_STALE_MS = 90_000
export const CI_LABEL_QUEUE_PROBE_MS = 180_000
export const CI_LABEL_RATE_CHECK_MS = 300_000
export const CI_LABEL_RATE_FLOOR = 500
export const CI_LABEL_SWITCH_TTL_MS = 5_000
export const CI_LABEL_RESUME_MAX_GAP_MS = 600_000
export const CI_LABEL_FAILURES_UNAVAILABLE = 3
export const CI_LABEL_AUTH_BACKOFF_MS = 600_000
export const CI_LABEL_LOG_REPEAT_MS = 3_600_000
export const CI_LABEL_AUDIT_REPLAY_DAYS = 14
export const CI_LABEL_STATE_HEARTBEAT_MS = 60_000
export const CI_LABEL_FALLBACK_RELEASE_MS = 600_000
export const CI_LABEL_MEMORY_LOAD_RETRY_MS = 30_000

export type CiLabelMode = 'off' | 'observe' | 'on'
export interface CiLabelSwitch {
  mode: CiLabelMode
  policies?: Record<string, 'dynamic' | 'pinned'>
  params?: Partial<CiLabelParams>
  note?: string
}
export type CiLabelSwitchStatus = 'missing' | 'ok' | 'stale-invalid' | 'stale-unreadable'

export const ciLabelSwitchPath = (share: string): string => join(share, 'sched', '_control', 'ci-labels.json')
export const ciLabelStateDir = (share: string): string => join(share, 'sched', 'ci-labels')

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
const machineNames = (): Set<string> => new Set(CI_RUNNER_BASELINE.map(runner => runner.machine))
const laneSet = (): ReadonlySet<string> => new Set<string>(CI_MANAGED_LANES)

const positiveInt = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`[ci-labels] 开关 params.${field} 必须是正整数`)
  }
  return value
}

/** 开关参数覆盖项的逐条校验;越界与未知字段一律拒绝,绝不带病上岗。 */
function validateParams(raw: unknown): Partial<CiLabelParams> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[ci-labels] 开关 params 必须是对象')
  }
  const node = raw as Record<string, unknown>
  const allowed = ['enterBusyRatio', 'exitBusyRatio', 'enterDwellSec', 'exitDwellSec', 'reservedGraceSec',
    'unknownRestoreSec', 'minHoldSec', 'maxChangesPerRunnerPerHour', 'starvationMinutes', 'driftBackoffSec',
    'stripOnBusy', 'stripOnReserved', 'keepIdle']
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw new Error(`[ci-labels] 开关 params 有未知字段:${key}`)
  }
  const params: Partial<CiLabelParams> = {}
  const ratio = (field: string): number => {
    const value = node[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`[ci-labels] 开关 params.${field} 必须落在 (0,1] 区间`)
    }
    return value
  }
  if (node.enterBusyRatio !== undefined) params.enterBusyRatio = ratio('enterBusyRatio')
  if (node.exitBusyRatio !== undefined) params.exitBusyRatio = ratio('exitBusyRatio')
  const enter = params.enterBusyRatio ?? CI_LABEL_PARAMS_DEFAULT.enterBusyRatio
  const exit = params.exitBusyRatio ?? CI_LABEL_PARAMS_DEFAULT.exitBusyRatio
  if (exit > enter - 0.1) throw new Error('[ci-labels] 开关 params.exitBusyRatio 必须不高于 enterBusyRatio 减 0.1')
  for (const field of ['enterDwellSec', 'exitDwellSec', 'reservedGraceSec', 'unknownRestoreSec', 'minHoldSec',
    'maxChangesPerRunnerPerHour', 'driftBackoffSec']) {
    if (node[field] !== undefined) (params as Record<string, unknown>)[field] = positiveInt(node[field], field)
  }
  if (node.starvationMinutes !== undefined && node.starvationMinutes !== null) {
    params.starvationMinutes = positiveInt(node.starvationMinutes, 'starvationMinutes')
  } else if (node.starvationMinutes === null) params.starvationMinutes = null
  for (const field of ['stripOnBusy', 'stripOnReserved'] as const) {
    const value = node[field]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.length === 0
      || !value.every(item => laneSet().has(item as string))
      || new Set(value as string[]).size !== value.length) {
      throw new Error(`[ci-labels] 开关 params.${field} 必须是受管车道的非空子集`)
    }
    params[field] = value as CiLane[]
  }
  if (node.keepIdle !== undefined) {
    if (typeof node.keepIdle !== 'boolean') throw new Error('[ci-labels] 开关 params.keepIdle 必须是布尔')
    params.keepIdle = node.keepIdle
  }
  return params
}

/** 开关文件解析:BOM 容忍;mode、policies、params、note 之外的字段一律拒绝。 */
export function parseCiLabelSwitch(raw: string): CiLabelSwitch {
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
  let payload: unknown
  try { payload = JSON.parse(text) } catch { throw new Error('[ci-labels] 开关文件不是 JSON') }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('[ci-labels] 开关文件不是对象')
  }
  const node = payload as Record<string, unknown>
  for (const key of Object.keys(node)) {
    if (!['formatVersion', 'mode', 'policies', 'params', 'note'].includes(key)) {
      throw new Error(`[ci-labels] 开关文件有未知字段:${key}`)
    }
  }
  if (node.formatVersion !== 1) throw new Error('[ci-labels] 开关文件 formatVersion 必须是 1')
  if (node.mode !== 'off' && node.mode !== 'observe' && node.mode !== 'on') {
    throw new Error('[ci-labels] 开关 mode 必须是 off、observe 或 on')
  }
  let policies: Record<string, 'dynamic' | 'pinned'> | undefined
  if (node.policies !== undefined) {
    if (node.policies === null || typeof node.policies !== 'object' || Array.isArray(node.policies)) {
      throw new Error('[ci-labels] 开关 policies 必须是对象')
    }
    policies = {}
    for (const [machine, policy] of Object.entries(node.policies as Record<string, unknown>)) {
      if (!machineNames().has(machine)) throw new Error(`[ci-labels] 开关 policies 里出现台账之外的机器:${machine}`)
      if (policy !== 'dynamic' && policy !== 'pinned') {
        throw new Error(`[ci-labels] 开关 policies 的值只能是 dynamic 或 pinned:${machine}`)
      }
      policies[machine] = policy
    }
  }
  const params = node.params === undefined ? undefined : validateParams(node.params)
  if (node.note !== undefined && typeof node.note !== 'string') {
    throw new Error('[ci-labels] 开关 note 必须是字符串')
  }
  return { mode: node.mode, ...(policies !== undefined ? { policies } : {}),
    ...(params !== undefined ? { params } : {}), ...(node.note !== undefined ? { note: node.note as string } : {}) }
}

/** 开关读取器:五秒缓存,坏文件告警限频一次,模式切换播通知;从未读到有效文件按 off。 */
export function createCiLabelSwitchReader(options: { share: string; now: () => number;
  warn?: (message: string) => void; notice?: (message: string) => void }): { read(): CiLabelSwitch | null; status(): CiLabelSwitchStatus } {
  let cachedAt = Number.NEGATIVE_INFINITY
  let parsed: CiLabelSwitch | null = null
  let status: CiLabelSwitchStatus = 'missing'
  let warned: string | null = null
  let lastMode: CiLabelMode | null = null
  const warnOnce = (message: string): void => {
    if (warned === message) return
    warned = message
    try { options.warn?.(message) } catch { /* 告警不影响开关读取 */ }
  }
  const refresh = (): void => {
    const path = ciLabelSwitchPath(options.share)
    let raw: string | null = null
    let unreadable = false
    try { raw = readFileSync(path, 'utf8') } catch (error) { if (!isEnoent(error)) unreadable = true }
    if (unreadable) { parsed = null; status = 'stale-unreadable'; return }
    if (raw === null) { parsed = null; status = 'missing'; return }
    try {
      parsed = parseCiLabelSwitch(raw)
      status = 'ok'
      warned = null
      if (parsed.mode !== lastMode) {
        const previous = lastMode
        lastMode = parsed.mode
        try { options.notice?.(`CI 标签路由开关:${previous === null ? '读到' : `由 ${previous} 切到`}${parsed.mode} 模式`) } catch { /* 通知不影响读取 */ }
      }
    } catch (error) {
      parsed = null
      status = 'stale-invalid'
      warnOnce(`CI 标签路由开关文件无效,按 off 处理:${messageOf(error)}`)
    }
  }
  return {
    read(): CiLabelSwitch | null {
      const nowMs = options.now()
      if (nowMs - cachedAt >= CI_LABEL_SWITCH_TTL_MS) { refresh(); cachedAt = nowMs }
      return parsed
    },
    status(): CiLabelSwitchStatus {
      const nowMs = options.now()
      if (nowMs - cachedAt >= CI_LABEL_SWITCH_TTL_MS) { refresh(); cachedAt = nowMs }
      return status
    },
  }
}

/** 接线层喂给路由的一拍观察:租约后的机器表加执行心跳快照。 */
export interface CiLabelObservationBatch {
  at: string
  machines: readonly MachineInput[]
  /** 心跳形状对齐 AgentLoad(scripts/bot/cluster-agent-load.ts):ci 嵌在 load 里,ciTreeLoad 与 load 同级。 */
  snapshot: { machines: { machine: string; heartbeat?: {
    load?: { busyCores?: number | null; sampledAt?: string; ci?: { state?: string; runners?: string[] } }
    ciTreeLoad?: { cores?: number; sampledAt?: string } } }[] }
}

/** 只观察台账内的两台机器;心跳缺字段一律记 null,交给可用性判定按拿不准处理。 */
export function ciLabelObservations(batch: CiLabelObservationBatch): CiMachineObservation[] {
  const beats = new Map(batch.snapshot.machines.map(status => [status.machine, status.heartbeat]))
  const observations: CiMachineObservation[] = []
  for (const machine of batch.machines) {
    if (!machineNames().has(machine.name)) continue
    const heartbeat = beats.get(machine.name)
    observations.push({
      machine: machine.name, at: batch.at, online: machine.online, fresh: machine.fresh,
      quotaCores: machine.quotaCores, grantedCores: machine.grantedCores,
      busyCores: heartbeat?.load?.busyCores ?? null,
      loadSampledAt: heartbeat?.load?.sampledAt ?? null,
      ci: machine.ci,
      ciRunners: heartbeat?.load?.ci?.runners ?? null,
      ciTreeCores: heartbeat?.ciTreeLoad?.cores ?? null,
      ciTreeSampledAt: heartbeat?.ciTreeLoad?.sampledAt ?? null,
      reservationCores: machine.reservation?.requestedCores ?? 0,
      ownerHold: machine.ownerHold,
    })
  }
  return observations
}

export interface CiLabelMachineView {
  verdict: CiAvailabilityVerdict
  certain: boolean
  since: string
  pressureCores: number | null
  ratio: number | null
  reason: string
  memory: CiAvailabilityMemory
}
export interface CiLabelRunnerView {
  baseline: CiLane[]
  live: string[] | null
  desired: CiLane[]
  stripped: Partial<Record<CiLane, CiStrippedEntry>>
  drift?: string
}
export interface CiLabelGithubView {
  status: 'idle' | 'ok' | 'thrifty' | GhErrorKind
  lastOkAt: string | null
  lastError: string | null
  rateRemaining: number | null
  rateResetAt: string | null
  viewFetchedAt: string | null
}
export interface CiLabelState {
  schema: 1
  writer: { machine: string; pid: number; protocol: number; head: string; startedAt: string }
  updatedAt: string
  mode: CiLabelMode
  switchStatus: CiLabelSwitchStatus
  switchNote?: string
  github: CiLabelGithubView
  machines: Record<string, CiLabelMachineView>
  runners: Record<string, CiLabelRunnerView>
  lanes: Record<CiLane, { onlineLabeled: number; idleLabeled: number; saturated: boolean; fallback: boolean;
    fallbackReason: 'starvation' | 'lane-busy' | null; oldestQueuedAt: string | null }>
  driftBackoff: Record<string, string>
  restoreCommands: string[]
  lastEvaluationAt: string | null
  lastInvariantViolation: { code: string; detail: string; at: string } | null
}

export interface CiLabelRouter {
  /** 每拍喂一次;绝不抛错、绝不阻塞,内部最多一轮在飞。 */
  pump(batch: { at: string; machines: readonly CiMachineObservation[] }): void
  status(): CiLabelState | null
  whenIdle(): boolean
  close(): void
}

interface SwitchReading { mode: CiLabelMode; status: CiLabelSwitchStatus; parsed: CiLabelSwitch | null }

export function createCiLabelRouter(options: {
  share: string
  host: { machine: string; pid: number; protocol: number; head: string }
  now: () => string
  github?: () => CiLabelGithubPort | null
  switchReader?: { read(): CiLabelSwitch | null; status(): CiLabelSwitchStatus }
  writeState?: (state: CiLabelState) => void
  appendAudit?: (entry: Record<string, unknown>) => void
  log?: (message: string) => void
}): CiLabelRouter {
  const now = options.now
  const startedAt = now()
  let stopped = false
  let flying = false
  let memory: CiLabelMemory | null = null
  let memoryFailedAt = Number.NEGATIVE_INFINITY
  const avail = new Map<string, CiAvailabilityMemory>()
  let port: CiLabelGithubPort | null = null
  let portFailed = false
  let authBackoffUntil = Number.NEGATIVE_INFINITY
  let lastRateCheckAt = Number.NEGATIVE_INFINITY
  let rateRemaining: number | null = null
  let rateResetAt: string | null = null
  let failStreak = 0
  let view: CiRunnersSnapshot | null = null
  let viewFetchedAt = Number.NEGATIVE_INFINITY
  let lastProbeAt = Number.NEGATIVE_INFINITY
  let oldestQueued: Partial<Record<CiLane, string | null>> = {}
  let lastSignature = ''
  let lastRoundAt = Number.NEGATIVE_INFINITY
  let lastObserveKey = ''
  let lastDrift: CiDriftNote[] = []
  let lastInvariantViolation: CiLabelState['lastInvariantViolation'] = null
  let lastDesired: { runner: string; labels: CiLane[] }[] = CI_RUNNER_BASELINE.map(runner =>
    ({ runner: runner.name, labels: [...runner.labels] }))
  let lastState: CiLabelState | null = null
  let lastStateKey = ''
  let lastStateWriteAt = Number.NEGATIVE_INFINITY
  let ghStatus: CiLabelGithubView['status'] = 'idle'
  let ghLastOkAt: string | null = null
  let ghLastError: string | null = null
  let ghViewFetchedAt: string | null = null
  const logged = new Map<string, number>()

  const logThrottled = (message: string, atMs: number): void => {
    for (const [key, at] of logged) if (atMs - at >= CI_LABEL_LOG_REPEAT_MS) logged.delete(key)
    const last = logged.get(message)
    if (last !== undefined && atMs - last < CI_LABEL_LOG_REPEAT_MS) return
    logged.set(message, atMs)
    try { options.log?.(`[ci-labels] ${message}`) } catch { /* 日志不得停路由 */ }
  }
  const switchReader = options.switchReader ?? createCiLabelSwitchReader({ share: options.share,
    now: () => Date.parse(now()), warn: message => logThrottled(message, Date.parse(now())),
    notice: message => logThrottled(message, Date.parse(now())) })
  const writeState = options.writeState ?? ((state: CiLabelState): void => {
    const dir = ciLabelStateDir(options.share)
    mkdirSync(dir, { recursive: true })
    mkdirSync(schedPaths(options.share).staging, { recursive: true })
    publishLifecycleFileAtomically(join(dir, 'state.json'), canonicalJson(state), 'replace', schedPaths(options.share).staging)
  })
  const appendAudit = options.appendAudit ?? ((entry: Record<string, unknown>): void => {
    const dir = join(ciLabelStateDir(options.share), 'audit')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${utcDate(String(entry.at))}--router.jsonl`), `${canonicalJson(entry)}\n`)
  })
  const redact = (text: string): string => text.slice(0, 300)

  const currentParams = (parsed: CiLabelSwitch | null): CiLabelParams =>
    parsed?.params === undefined ? CI_LABEL_PARAMS_DEFAULT : { ...CI_LABEL_PARAMS_DEFAULT, ...parsed.params }
  const currentPolicies = (parsed: CiLabelSwitch | null): Readonly<Record<string, 'dynamic' | 'pinned'>> =>
    parsed?.policies ?? CI_MACHINE_POLICY_DEFAULT
  const readSwitch = (): SwitchReading => {
    const parsed = switchReader.read()
    return { mode: parsed?.mode ?? 'off', status: switchReader.status(), parsed }
  }
  const ensurePort = (): CiLabelGithubPort | null => {
    if (port !== null) return port
    if (portFailed) return null
    try { port = options.github?.() ?? null } catch (error) {
      portFailed = true
      logThrottled(`GitHub 端口创建失败:${messageOf(error)}`, Date.parse(now()))
      return null
    }
    if (port === null) portFailed = true
    return port
  }
  const memoryEmpty = (): boolean =>
    memory === null || (Object.keys(memory.stripped).length === 0 && Object.keys(memory.fallback).length === 0)

  /** 台账载入:先信状态文件(五分钟内的判定可续),没有就回放十四天内的审计账。 */
  const tryLoadMemory = (at: string): boolean => {
    try {
      const statePath = join(ciLabelStateDir(options.share), 'state.json')
      if (existsSync(statePath)) {
        const raw = JSON.parse(readFileSync(statePath, 'utf8')) as CiLabelState & { memory?: CiLabelMemory }
        // 状态文件里没有摘挂台账(只有展示层)时退回留痕回放,不能带着空台账忘掉自己摘过的牌子(契约 §6.4 第 2 步)。
        memory = raw.memory !== undefined ? structuredClone(raw.memory) : replayAudits(at)
        const gap = Date.parse(at) - Date.parse(raw.updatedAt)
        if (Number.isFinite(gap) && gap >= 0 && gap <= CI_LABEL_RESUME_MAX_GAP_MS) {
          for (const [machine, machineView] of Object.entries(raw.machines)) avail.set(machine, structuredClone(machineView.memory))
        }
        return true
      }
      memory = replayAudits(at)
      return true
    } catch (error) {
      memoryFailedAt = Date.parse(at)
      logThrottled(`台账载入失败,${CI_LABEL_MEMORY_LOAD_RETRY_MS / 1000} 秒后重试:${messageOf(error)}`, Date.parse(at))
      return false
    }
  }

  const replayAudits = (at: string): CiLabelMemory => {
    const memory: CiLabelMemory = emptyLabelMemory()
    const dir = join(ciLabelStateDir(options.share), 'audit')
    if (!existsSync(dir)) return memory
    const cutoff = Date.parse(at) - CI_LABEL_AUDIT_REPLAY_DAYS * 86_400_000
    const setEntry = (runner: string, label: CiLane, entry: CiStrippedEntry): void => {
      memory.stripped[runner] = { ...memory.stripped[runner], [label]: entry }
    }
    const dropEntry = (runner: string, label: CiLane): void => {
      const lanes = { ...memory.stripped[runner] }
      delete lanes[label]
      if (Object.keys(lanes).length === 0) delete memory.stripped[runner]
      else memory.stripped[runner] = lanes
    }
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('--router.jsonl')) continue
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        if (!line.trim()) continue
        let entry: { at?: unknown; kind?: unknown; outcome?: unknown; op?: unknown }
        try { entry = JSON.parse(line) as typeof entry } catch { continue }
        if (typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))) continue
        if (Date.parse(entry.at) < cutoff || Date.parse(entry.at) > Date.parse(at)) continue
        const op = entry.op as { kind?: unknown; runner?: unknown; label?: unknown; reason?: unknown } | null
        if (entry.kind !== 'intent' && entry.kind !== 'result') continue
        if (op === null || typeof op !== 'object' || (op.kind !== 'add' && op.kind !== 'remove')
          || typeof op.runner !== 'string' || typeof op.label !== 'string' || !laneSet().has(op.label)) continue
        const label = op.label as CiLane
        if (op.kind === 'remove') {
          if (entry.kind === 'intent') setEntry(op.runner, label, { at: entry.at,
            reason: op.reason === 'reserved' ? 'reserved' : 'busy', state: 'removing' })
          else if (entry.outcome === 'done') setEntry(op.runner, label, { at: entry.at,
            reason: op.reason === 'reserved' ? 'reserved' : 'busy', state: 'stripped' })
          else if (entry.outcome !== 'uncertain') dropEntry(op.runner, label)
        } else {
          if (entry.kind === 'intent') setEntry(op.runner, label, { at: entry.at,
            reason: op.reason === 'reserved' ? 'reserved' : 'busy', state: 'adding' })
          else if (entry.outcome === 'uncertain') continue
          else dropEntry(op.runner, label)
        }
      }
    }
    return memory
  }

  const stepAll = (batch: { at: string; machines: readonly CiMachineObservation[] }, params: CiLabelParams):
    { verdicts: Record<string, { verdict: CiAvailabilityVerdict; certain: boolean }>; steps: Record<string, CiAvailabilityStep> } => {
    const known = new Set(CI_RUNNER_BASELINE.map(runner => runner.name))
    const verdicts: Record<string, { verdict: CiAvailabilityVerdict; certain: boolean }> = {}
    const steps: Record<string, CiAvailabilityStep> = {}
    for (const observation of batch.machines) {
      const step = stepAvailability(observation, avail.get(observation.machine) ?? initialAvailabilityMemory(observation.at),
        params, known)
      avail.set(observation.machine, step.memory)
      verdicts[observation.machine] = { verdict: step.verdict, certain: step.certain }
      steps[observation.machine] = step
    }
    return { verdicts, steps }
  }

  const buildState = (at: string, reading: SwitchReading, verdicts: Record<string, { verdict: CiAvailabilityVerdict; certain: boolean }>,
    steps: Record<string, CiAvailabilityStep>): CiLabelState => {
    const stats = laneStats(view ?? [])
    const lanes = {} as Record<CiLane, { onlineLabeled: number; idleLabeled: number; saturated: boolean; fallback: boolean;
      fallbackReason: 'starvation' | 'lane-busy' | null; oldestQueuedAt: string | null }>
    for (const lane of CI_MANAGED_LANES) {
      const fallbackEntry = memory?.fallback[lane]
      lanes[lane] = { onlineLabeled: stats[lane].onlineLabeled, idleLabeled: stats[lane].idleLabeled,
        saturated: stats[lane].saturated, fallback: fallbackEntry !== undefined,
        // 旧台账里的回退条目没有 reason 字段,一律按饿死回退展示(1010 追加式兼容)。
        fallbackReason: fallbackEntry === undefined ? null : fallbackEntry.reason ?? 'starvation',
        oldestQueuedAt: oldestQueued[lane] ?? null }
    }
    return {
      schema: 1,
      writer: { ...options.host, startedAt },
      updatedAt: at,
      mode: reading.mode,
      switchStatus: reading.status,
      ...(reading.parsed?.note !== undefined ? { switchNote: reading.parsed.note } : {}),
      github: { status: ghStatus, lastOkAt: ghLastOkAt, lastError: ghLastError, rateRemaining, rateResetAt, viewFetchedAt: ghViewFetchedAt },
      machines: Object.fromEntries(Object.entries(verdicts).map(([machine, verdict]) => [machine, {
        verdict: verdict.verdict, certain: verdict.certain,
        since: avail.get(machine)?.since ?? at,
        pressureCores: steps[machine]?.pressureCores ?? null, ratio: steps[machine]?.ratio ?? null,
        reason: steps[machine]?.reason ?? '', memory: avail.get(machine) ?? initialAvailabilityMemory(at) }])),
      runners: Object.fromEntries(CI_RUNNER_BASELINE.map(base => {
        const live = view?.find(candidate => candidate.name === base.name)
        const driftNote = lastDrift.find(note => note.runner === base.name)
        return [base.name, {
          baseline: [...base.labels],
          live: live ? live.labels : null,
          desired: lastDesired.find(row => row.runner === base.name)?.labels ?? [...base.labels],
          stripped: { ...(memory?.stripped[base.name] ?? {}) },
          ...(driftNote !== undefined ? { drift: `${driftNote.kind}:${driftNote.label}` } : {}) }]
      })),
      lanes,
      driftBackoff: { ...(memory?.driftBackoffUntil ?? {}) },
      restoreCommands: restoreCommandsFor(view ?? []),
      lastEvaluationAt: at,
      lastInvariantViolation,
    } satisfies CiLabelState
  }

  /** 变更指纹:updatedAt / lastEvaluationAt 是每次都走的表针,不算「有变化」(契约 §6.4 第 9 步)。 */
  const stateFingerprint = (state: CiLabelState): string => {
    const { updatedAt: _updatedAt, lastEvaluationAt: _lastEvaluationAt, ...rest } = state
    return canonicalJson(rest)
  }
  const considerWrite = (state: CiLabelState, atMs: number): void => {
    const key = stateFingerprint(state)
    const changed = key !== lastStateKey
    // 关闸且台账干净:只在状态翻面或刚切到 off 那一轮落一次终态,之后彻底安静。
    if (state.mode === 'off' && memoryEmpty() && !changed
      && !(lastState !== null && lastState.mode !== 'off')) return
    if (!changed && atMs - lastStateWriteAt < CI_LABEL_STATE_HEARTBEAT_MS) return
    try { writeState(state) } catch (error) { logThrottled(`状态写盘失败:${messageOf(error)}`, atMs) }
    lastState = state
    lastStateKey = key
    lastStateWriteAt = atMs
  }

  const dropEntry = (op: CiLabelOp): void => {
    if (memory === null) return
    const lanes = { ...memory.stripped[op.runner] }
    delete lanes[op.label]
    if (Object.keys(lanes).length === 0) delete memory.stripped[op.runner]
    else memory.stripped[op.runner] = lanes
  }
  const markEntry = (op: CiLabelOp, at: string, state: CiStrippedEntry['state']): void => {
    if (memory === null) return
    memory.stripped[op.runner] = { ...memory.stripped[op.runner], [op.label]:
      { at, reason: op.reason === 'reserved' ? 'reserved' : 'busy', state } }
  }

  const runRound = async (batch: { at: string; machines: readonly CiMachineObservation[] }, reading: SwitchReading,
    atMs: number): Promise<void> => {
    const at = batch.at
    const params = currentParams(reading.parsed)
    if (memory === null) return
    // 关闸且台账干净:一粒灰都不扬,GitHub 端口都不许创建,连收尾写盘都不许碰(契约 §6.4 第 3 步)。
    if (reading.mode === 'off' && memoryEmpty()) return
    try {
      const port = ensurePort()
      if (port === null) {
        // 空转要看得见(CI-RUNNER-LABEL-ROUTING-PORT-WIRING-0925):端口没接上不是安静跳过,
        // 状态与日志都说明白,提示去查派单员入口有没有注入端口工厂;finally 照常落状态文件。
        ghStatus = 'unavailable'
        ghLastError = 'GitHub 端口没接上(入口没注入工厂,或工厂返回空)'
        logThrottled(`GitHub 端口没接上,当前档位 ${reading.mode},本轮不动标签;`
          + '检查派单员入口是否注入了端口工厂', atMs)
        return
      }
      if (atMs < authBackoffUntil) return
      if (atMs - lastRateCheckAt >= CI_LABEL_RATE_CHECK_MS || rateRemaining === null) {
        try {
          const rate = await port.rateLimit()
          rateRemaining = rate.remaining
          rateResetAt = rate.resetAt
          lastRateCheckAt = atMs
          ghStatus = rate.remaining < CI_LABEL_RATE_FLOOR ? 'thrifty' : 'ok'
          ghLastOkAt = at
          ghLastError = null
        } catch (error) {
          ghStatus = error instanceof GhApiError ? error.kind : 'unavailable'
          ghLastError = redact(messageOf(error))
          if (ghStatus === 'no-cli' || ghStatus === 'no-credential' || ghStatus === 'no-permission') {
            authBackoffUntil = atMs + CI_LABEL_AUTH_BACKOFF_MS
          }
          logThrottled(`GitHub 配额查询失败(${ghStatus}),本轮不动标签:${redact(messageOf(error))}`, atMs)
          return
        }
      }
      const thrifty = rateRemaining !== null && rateRemaining < CI_LABEL_RATE_FLOOR
      if (view === null || atMs - viewFetchedAt >= CI_LABEL_VIEW_REFRESH_MS) {
        try {
          view = await port.listRunners()
          viewFetchedAt = atMs
          ghViewFetchedAt = at
          failStreak = 0
          ghStatus = thrifty ? 'thrifty' : 'ok'
          ghLastOkAt = at
        } catch (error) {
          failStreak += 1
          ghStatus = error instanceof GhApiError ? error.kind : 'unavailable'
          ghLastError = redact(messageOf(error))
          logThrottled(`GitHub 清单拉取失败(${ghStatus})第 ${failStreak} 次,本轮不动标签:${redact(messageOf(error))}`, atMs)
          return
        }
      }
      if (view === null || atMs - viewFetchedAt > CI_LABEL_VIEW_STALE_MS) return
      const reconciled = reconcileMemory(memory, view, at, params)
      memory = reconciled.memory
      // 闭包里 narrowing 会失效,先钉一个非空局部量给回退恢复用。
      const labelMemory: CiLabelMemory = memory
      lastDrift = reconciled.drift
      if (reconciled.drift.length > 0) {
        logThrottled(`台账与 GitHub 对出漂移:${reconciled.drift.map(note =>
          `${note.runner}:${note.label}:${note.kind}`).join('、')},相关组合进退避`, atMs)
      }
      const { verdicts, steps } = stepAll(batch, params)
      const planInput = { at, mode: reading.mode, view, verdicts, policies: currentPolicies(reading.parsed), params, memory }
      const plan = planCiLabels(planInput)
      lastDesired = plan.desired
      // §10 车道饿死回退:摘除期间定期探排队,等太久就停摘加回,空一阵再退出。
      if (reading.mode === 'on' && params.starvationMinutes !== null && !thrifty
        && atMs - lastProbeAt >= CI_LABEL_QUEUE_PROBE_MS && !memoryEmpty()) {
        lastProbeAt = atMs
        oldestQueued = {}
        for (const lane of CI_MANAGED_LANES) {
          try {
            const jobs = await port.queuedLaneJobs(lane)
            oldestQueued[lane] = jobs[0]?.createdAt ?? null
          } catch (error) {
            oldestQueued[lane] = null
            logThrottled(`车道 ${lane} 排队探测失败,本轮当空处理:${redact(messageOf(error))}`, atMs)
          }
        }
      }
      for (const lane of CI_MANAGED_LANES) {
        const entry = memory.fallback[lane]
        const oldest = oldestQueued[lane]
        if (entry === undefined) {
          // 1010 快速路(keepIdle 默认开):车道已打满且有人排队,不等饿死阈值立刻回退把已摘的加回;
          // keepIdle=false 时这层整体不生效,只有下面那条 20 分钟饿死老路。
          if (reading.mode === 'on' && params.keepIdle && oldest !== undefined && oldest !== null
            && laneStats(view)[lane].saturated) {
            memory.fallback[lane] = { since: at, emptySince: null, reason: 'lane-busy' }
            logThrottled(`车道 ${lane} 已打满且有人排队,立即回退把已摘的加回`, atMs)
          } else if (reading.mode === 'on' && params.starvationMinutes !== null && oldest !== undefined && oldest !== null
            && atMs - Date.parse(oldest) >= params.starvationMinutes * 60_000) {
            memory.fallback[lane] = { since: at, emptySince: null }
            logThrottled(`车道 ${lane} 排队最老已等 ${params.starvationMinutes} 分钟,进入回退:停摘并把已摘的加回`, atMs)
          }
          continue
        }
        if (oldest === null || oldest === undefined) {
          if (entry.emptySince === null) memory.fallback[lane] = { ...entry, emptySince: at }
          else if (atMs - Date.parse(entry.emptySince) >= CI_LABEL_FALLBACK_RELEASE_MS) {
            delete memory.fallback[lane]
            logThrottled(`车道 ${lane} 已空满 ${CI_LABEL_FALLBACK_RELEASE_MS / 1000} 秒,退出回退`, atMs)
          }
        } else memory.fallback[lane] = { ...entry, emptySince: null }
      }
      let ops = plan.ops
      const fallbackLanes = CI_MANAGED_LANES.filter(lane => labelMemory.fallback[lane] !== undefined)
      if (reading.mode === 'on' && fallbackLanes.length > 0) {
        const recovery = fallbackLanes.flatMap(lane => CI_RUNNER_BASELINE.filter(base => {
          const entry = labelMemory.stripped[base.name]?.[lane]
          return entry !== undefined && entry.state !== 'adding'
        })
          .map(base => ({ kind: 'add' as const, runner: base.name, runnerId: base.id, machine: base.machine,
            // 恢复理由跟回退条目走:lane-busy 快速路写 lane-busy,饿死老路与旧台账(无 reason)都是 starvation。
            label: lane, reason: labelMemory.fallback[lane]?.reason ?? 'starvation' })))
        ops = [...recovery, ...ops.filter(op => op.kind === 'add' || !fallbackLanes.includes(op.label))]
          .slice(0, MAX_OPS_PER_ROUND)
      }
      if (reading.mode === 'observe') {
        const opsKey = canonicalJson(ops)
        if (opsKey !== lastObserveKey) {
          lastObserveKey = opsKey
          try { appendAudit({ at, kind: 'dry-run', ops, drift: lastDrift, writer: options.host }) } catch (error) {
            logThrottled(`dry-run 审计写失败:${messageOf(error)}`, atMs)
          }
        }
        return
      }
      const violations = checkPlanInvariants(planInput, ops)
      if (violations.length > 0) {
        lastInvariantViolation = { code: violations[0]!.code, detail: violations[0]!.detail, at }
        logThrottled(`[报警] 计划未过不变量复核:${violations.map(item => `${item.code}:${item.detail}`).join(';')};本轮摘除全部作废`, atMs)
        ops = ops.filter(op => op.kind === 'add' && (!thrifty || op.reason === 'floor-repair')
          && checkPlanInvariants(planInput, [op]).length === 0)
      } else lastInvariantViolation = null
      for (const op of ops) {
        markEntry(op, at, op.kind === 'remove' ? 'removing' : 'adding')
        try { appendAudit({ at, kind: 'intent', op, writer: options.host }) } catch (error) {
          logThrottled(`意图审计写失败:${messageOf(error)}`, atMs)
        }
        considerWrite(buildState(at, reading, verdicts, steps), atMs)
        try {
          const outcome = op.kind === 'remove' ? await port.removeLabel(op.runnerId, op.label)
            : await port.addLabel(op.runnerId, op.label)
          // 写后把结果合回本地清单快照:下一轮对账才不会被旧快照误报「摘了又出现」(契约 §6.3 写后核对)。
          view = view.map(candidate => candidate.id === op.runnerId ? { ...candidate, labels: outcome.labels } : candidate)
          if (op.kind === 'remove') markEntry(op, at, 'stripped')
          else dropEntry(op)
          memory.changes[op.runner] = [...(memory.changes[op.runner] ?? []), at].slice(-8)
          memory.lastChangeAt = at
          try { appendAudit({ at, kind: 'result', op, outcome: 'done', labels: outcome.labels, writer: options.host }) } catch { /* 审计失败不停轮 */ }
        } catch (error) {
          const kind = error instanceof GhApiError ? error.kind : 'unavailable'
          const detail = redact(messageOf(error))
          ghStatus = kind
          ghLastError = detail
          if (kind === 'bad-response') {
            try { appendAudit({ at, kind: 'result', op, outcome: 'uncertain', error: detail, writer: options.host }) } catch { /* 同上 */ }
            logThrottled(`标签写入结果拿不准(${op.kind} ${op.runner} ${op.label}),本轮就此打住:${detail}`, atMs)
            break
          }
          if (kind === 'not-found') {
            dropEntry(op)
            view = view.filter(candidate => candidate.id !== op.runnerId)
            try { appendAudit({ at, kind: 'result', op, outcome: 'runner-gone', writer: options.host }) } catch { /* 同上 */ }
            continue
          }
          if (op.kind === 'remove') markEntry(op, at, 'removing')
          try { appendAudit({ at, kind: 'result', op, outcome: 'failed', error: detail, writer: options.host }) } catch { /* 同上 */ }
          if (kind === 'no-cli' || kind === 'no-credential' || kind === 'no-permission') {
            authBackoffUntil = atMs + CI_LABEL_AUTH_BACKOFF_MS
          }
          if (kind === 'rate-limited') { rateRemaining = 0 }
          logThrottled(`标签写入失败(${op.kind} ${op.runner} ${op.label}:${kind}),本轮就此打住:${detail}`, atMs)
          break
        }
      }
    } catch (error) {
      logThrottled(`评估轮失败:${messageOf(error)}`, atMs)
    } finally {
      try { considerWrite(buildState(at, reading, availableVerdicts(), availableSteps()), atMs) }
      catch { /* 收尾写盘不得炸轮 */ }
    }
  }
  const availableVerdicts = (): Record<string, { verdict: CiAvailabilityVerdict; certain: boolean }> =>
    Object.fromEntries([...avail.entries()].map(([machine, machineMemory]) =>
      [machine, { verdict: machineMemory.verdict, certain: machineMemory.verdict !== 'reserved' }]))
  const availableSteps = (): Record<string, CiAvailabilityStep> => {
    const steps: Record<string, CiAvailabilityStep> = {}
    for (const [machine, machineMemory] of avail) {
      steps[machine] = { verdict: machineMemory.verdict, memory: machineMemory, certain: true,
        pressureCores: null, ratio: null, reason: '' }
    }
    return steps
  }

  return {
    pump(batch): void {
      if (stopped || flying) return
      try {
        const atMs = Date.parse(batch.at)
        if (!Number.isFinite(atMs)) return
        if (memory === null && atMs - memoryFailedAt < CI_LABEL_MEMORY_LOAD_RETRY_MS) return
        if (memory === null && !tryLoadMemory(batch.at)) return
        const reading = readSwitch()
        stepAll(batch, currentParams(reading.parsed))
        const signature = `${reading.mode}|${[...avail.entries()].map(([machine, machineMemory]) =>
          `${machine}:${machineMemory.verdict}`).sort().join(',')}`
        if (signature === lastSignature && atMs - lastRoundAt < CI_LABEL_EVAL_INTERVAL_MS) return
        lastSignature = signature
        // 记下本轮起点:签名没变也要按评估间隔(默认 30 秒)节流,不是每拍都跑(契约 §6.4 第 5 步)。
        lastRoundAt = atMs
        flying = true
        void runRound(batch, reading, atMs).catch(() => { /* pump 不抛 */ }).finally(() => { flying = false })
      } catch { /* pump 不抛 */ }
    },
    status: () => lastState === null ? null : structuredClone(lastState),
    whenIdle: () => !flying,
    close(): void {
      stopped = true
      try { port?.close() } catch { /* 关端口失败不拦收尾 */ }
    },
  }
}
