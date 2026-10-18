import deployment from './client/deployment-config.cjs'
/**
 * CI-RUNNER-JIT-TAKEOVER-0924 第 0 步(只读影子)· 纯函数:排队快照、前置判定、开跑记录、
 * 心跳换算、挂单估算。不碰网络、不碰磁盘、不碰时钟——时刻一律由调用方传入。
 */
import { READING_FRESHNESS_MS } from './sched-contract'
import {
  CI_JOB_PREREQUISITES, CI_TAKEOVER_LANE_ORDER, type CiTakeoverLane, laneOfLabels,
} from './sched-ci-takeover-contract'
import type { GhJobView } from './sched-ci-takeover-github'

export interface LaneQueue { queued: GhJobView[]; inProgress: GhJobView[] }

export interface QueueSnapshot {
  at: string
  lanes: Record<CiTakeoverLane, LaneQueue>
  /** 标签认不出、且 status 为 queued 的作业。 */
  unknown: GhJobView[]
  unmanagedQueued: number
  hostedQueued: number
  /** 全部作业按 status 计数。 */
  statusCounts: Record<string, number>
}

const byCreatedAsc = (a: GhJobView, b: GhJobView): number =>
  a.createdAt === b.createdAt ? a.jobId - b.jobId : Date.parse(a.createdAt) - Date.parse(b.createdAt)

/** 排队快照(契约 §7.4):逐作业判车道分桶;unmanaged、hosted 只数 queued 个数;statusCounts 数全部。 */
export function queueSnapshot(at: string, jobs: readonly GhJobView[]): QueueSnapshot {
  const lanes: Record<CiTakeoverLane, LaneQueue> = {
    fast: { queued: [], inProgress: [] },
    main: { queued: [], inProgress: [] },
    e2e: { queued: [], inProgress: [] },
  }
  const unknown: GhJobView[] = []
  let unmanagedQueued = 0
  let hostedQueued = 0
  const statusCounts: Record<string, number> = {}
  for (const jobView of jobs) {
    statusCounts[jobView.status] = (statusCounts[jobView.status] ?? 0) + 1
    const verdict = laneOfLabels(jobView.labels)
    if (verdict === 'fast' || verdict === 'main' || verdict === 'e2e') {
      if (jobView.status === 'queued') lanes[verdict].queued.push(jobView)
      else if (jobView.status === 'in_progress') lanes[verdict].inProgress.push(jobView)
    } else if (verdict === 'unknown' && jobView.status === 'queued') unknown.push(jobView)
    else if (verdict === 'unmanaged' && jobView.status === 'queued') unmanagedQueued += 1
    else if (verdict === 'hosted' && jobView.status === 'queued') hostedQueued += 1
  }
  for (const lane of CI_TAKEOVER_LANE_ORDER) {
    lanes[lane].queued.sort(byCreatedAsc)
    lanes[lane].inProgress.sort(byCreatedAsc)
  }
  unknown.sort(byCreatedAsc)
  return { at, lanes, unknown, unmanagedQueued, hostedQueued, statusCounts }
}

/** 前置判定:同 run 里每个前置名找到了就要求 completed,找不到忽略;不在表里的作业名恒真。 */
export function prerequisitesMet(job: GhJobView, sameRun: readonly GhJobView[],
  table: Readonly<Record<string, readonly string[]>> = CI_JOB_PREREQUISITES): boolean {
  const names = table[job.name]
  if (names === undefined) return true
  return names.every(name => {
    const prerequisite = sameRun.find(candidate => candidate.name === name)
    return prerequisite === undefined || prerequisite.status === 'completed'
  })
}

export interface JobTransition {
  jobId: number; runId: number; lane: CiTakeoverLane; name: string
  createdAt: string; startedAt: string; waitSec: number; runnerName: string | null; queuedBeforePrereq: boolean
}

/**
 * 开跑记录:上一轮某车道 queued 里的作业,本轮已不在 queued 且 startedAt 非空 → 记一条。
 * queuedBeforePrereq = 上一轮时它的前置还没齐(排队排在了前置前面,接管后要防的形状)。
 */
export function jobTransitions(previous: { snapshot: QueueSnapshot; jobs: readonly GhJobView[] } | null,
  jobs: readonly GhJobView[]): JobTransition[] {
  if (previous === null) return []
  const currentById = new Map(jobs.map(jobView => [jobView.jobId, jobView]))
  const transitions: JobTransition[] = []
  for (const lane of CI_TAKEOVER_LANE_ORDER) {
    for (const previousJob of previous.snapshot.lanes[lane].queued) {
      const nowJob = currentById.get(previousJob.jobId)
      if (nowJob === undefined) continue
      if (nowJob.startedAt === null || nowJob.status === 'queued') continue
      const sameRun = previous.jobs.filter(candidate => candidate.runId === previousJob.runId)
      transitions.push({
        jobId: previousJob.jobId, runId: previousJob.runId, lane, name: nowJob.name,
        createdAt: nowJob.createdAt, startedAt: nowJob.startedAt,
        waitSec: Math.round((Date.parse(nowJob.startedAt) - Date.parse(nowJob.createdAt)) / 1000),
        runnerName: nowJob.runnerName,
        queuedBeforePrereq: !prerequisitesMet(previousJob, sameRun),
      })
    }
  }
  return transitions
}

export interface ShadowMachine {
  name: string; online: boolean; fresh: boolean; quotaCores: number
  grantedCores: number; externalLoadCores: number; ci: string; availableCores: number
}

export interface ShadowHeartbeat { fresh: boolean; at: string | null; machines: ShadowMachine[] }

/**
 * 心跳换算(契约 §7.4):不是对象或没有 machines 数组 → fresh 假、机器空;
 * 心跳 at 距 now 超过 READING_FRESHNESS_MS → 整体 fresh 假(各机照常列出);
 * 每台机器缺数值字段按 0 且该机 fresh 记假;availableCores 取现成字段,没有就按公式夹到 ≥0。
 */
export function shadowMachines(heartbeat: unknown, now: string): ShadowHeartbeat {
  if (typeof heartbeat !== 'object' || heartbeat === null || Array.isArray(heartbeat)) {
    return { fresh: false, at: null, machines: [] }
  }
  const record = heartbeat as Record<string, unknown>
  if (!Array.isArray(record.machines)) return { fresh: false, at: null, machines: [] }
  const at = typeof record.at === 'string' ? record.at : null
  const atMs = at === null ? Number.NaN : Date.parse(at)
  // 契约字面口径:心跳 at 距 now 超过新鲜度门槛才记假;at 读不出时刻也算假。
  const fresh = at !== null && Number.isFinite(atMs) && Date.parse(now) - atMs <= READING_FRESHNESS_MS
  const machines: ShadowMachine[] = []
  for (const entry of record.machines) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      machines.push({ name: '', online: false, fresh: false, quotaCores: 0, grantedCores: 0, externalLoadCores: 0, ci: 'unknown', availableCores: 0 })
      continue
    }
    const machine = entry as Record<string, unknown>
    const numberField = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null
    const quota = numberField(machine.quotaCores)
    const granted = numberField(machine.grantedCores)
    const external = numberField(machine.externalLoadCores)
    const degraded = quota === null || granted === null || external === null
    const name = typeof machine.name === 'string' ? machine.name : null
    const available = numberField(machine.availableCores)
    const quotaValue = quota ?? 0
    const grantedValue = granted ?? 0
    const externalValue = external ?? 0
    machines.push({
      name: name ?? '',
      online: machine.online === true,
      fresh: !degraded && name !== null && machine.fresh === true,
      quotaCores: quotaValue,
      grantedCores: grantedValue,
      externalLoadCores: externalValue,
      ci: typeof machine.ci === 'string' ? machine.ci : 'unknown',
      availableCores: available ?? Math.max(0, quotaValue - grantedValue - externalValue),
    })
  }
  return { fresh, at, machines }
}

export interface ShadowParams {
  perLaneMaxOpen: number
  globalMaxOpen: number
  laneCores: Readonly<Record<CiTakeoverLane, number>>
  executors: readonly string[]
}

export const SHADOW_DEFAULTS: Readonly<ShadowParams> = {
  perLaneMaxOpen: 6,
  globalMaxOpen: 10,
  laneCores: { fast: 4, main: 4, e2e: 4 },
  executors: deployment.getDeploymentConfig().ci.takeover?.executors ?? [],
}

export interface ShadowLaneEstimate {
  lane: CiTakeoverLane
  queued: number
  queuedReady: number
  queuedNotReady: number
  wouldSubmit: number
  oldestQueuedAt: string | null
  admissibleNow: string[]
}

/**
 * 挂单估算(粗估,契约 §7.4):wouldSubmit = min(就绪数, 车道上限),再按车道序累加、
 * 超过全局上限截掉;admissibleNow = 执行机名单里在线、新鲜、可用核 ≥ 该车道核数的机器。
 * 不调派单员的准入函数,也不考虑 vitest 同机互斥——汇总里要注明。
 */
export function shadowEstimate(snapshot: QueueSnapshot, jobs: readonly GhJobView[],
  machines: readonly ShadowMachine[], params: ShadowParams = SHADOW_DEFAULTS): ShadowLaneEstimate[] {
  const executorSet = new Set(params.executors)
  const admissible = machines
    .filter(machine => executorSet.has(machine.name) && machine.online && machine.fresh)
  const estimates: ShadowLaneEstimate[] = []
  let globalRemaining = params.globalMaxOpen
  for (const lane of CI_TAKEOVER_LANE_ORDER) {
    const queued = snapshot.lanes[lane].queued
    const ready = queued.filter(jobView =>
      prerequisitesMet(jobView, jobs.filter(candidate => candidate.runId === jobView.runId)))
    const wouldSubmit = Math.max(0, Math.min(ready.length, params.perLaneMaxOpen, globalRemaining))
    globalRemaining -= wouldSubmit
    const cores = params.laneCores[lane]
    estimates.push({
      lane,
      queued: queued.length,
      queuedReady: ready.length,
      queuedNotReady: queued.length - ready.length,
      wouldSubmit,
      oldestQueuedAt: queued.length > 0 ? queued[0]!.createdAt : null,
      admissibleNow: admissible.filter(machine => machine.availableCores >= cores).map(machine => machine.name),
    })
  }
  return estimates
}
