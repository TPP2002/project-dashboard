/**
 * CI-RUNNER-JIT-TAKEOVER-0924 第 0 步(只读影子)· 影子运行器与命令行。
 *
 * 按「接管以后」的节奏轮询 GitHub 排队作业、读调度台心跳,只记账不动手:
 * 唯一写口是 `<share>/sched/ci-takeover/shadow/`(S2);对 GitHub 只发 GET(S1);
 * 令牌只在内存(S3);GitHub 或心跳读失败不退出(S4);非 304 每小时超 600 条自动降到 60 秒一轮(S5)。
 *
 * 命令行:
 *   node node_modules/tsx/dist/cli.mjs scripts/sched/sched-ci-takeover-shadow.ts run --share <data-directory> --hours 48
 *   node node_modules/tsx/dist/cli.mjs scripts/sched/sched-ci-takeover-shadow.ts summary --share <data-directory> [--from 2026-09-25] [--to 2026-09-27] [--json]
 * 退出码:0 正常;2 参数错;3 共享盘不可写;4 令牌读不到。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  GithubError, createGithubReadClient, loadGithubToken, redactGithubSecrets,
} from './sched-ci-takeover-github'
import type { GhJobView, GithubErrorKind, GithubReadClient } from './sched-ci-takeover-github'
import {
  CI_TAKEOVER_LANE_ORDER, type CiTakeoverLane, ciTakeoverShadowDir, shadowLogPath,
} from './sched-ci-takeover-contract'
import {
  jobTransitions, prerequisitesMet, queueSnapshot, shadowEstimate, shadowMachines,
} from './sched-ci-takeover-plan'
import type { QueueSnapshot, ShadowMachine } from './sched-ci-takeover-plan'
import { schedControlPaths } from './sched-contract'
import { ciPolicyPath, createCiPolicyReader } from './sched-ci-policy'
import { createHubSwitchReader } from './sched-hub-switch-reader'

// ---------------------------------------------------------------------------
// 影子行(契约 §6.2):字段一个都不省,不适用填 null;时刻一律 ISO(带 Z 的 UTC)。
// ---------------------------------------------------------------------------

export interface ShadowRoundRow {
  schema: 1
  kind: 'round'
  at: string
  round: number
  nextIntervalSec: number
  github: { requests: number; notModified: number; errors: number; nonNotModifiedLastHour: number; rateRemaining: number | null }
  ciRunsOn: string | null
  ciRunsOnAt: string | null
  ciPolicy: { mode: 'coexist' | 'freeze'; fileExists: boolean }
  managedLoad: boolean | null
  dispatcher: { fresh: boolean; at: string | null; error: string | null }
  machines: ShadowMachine[]
  lanes: Record<CiTakeoverLane, {
    queued: { jobId: number; runId: number; name: string; createdAt: string; ready: boolean }[]
    inProgress: number
    queuedReady: number
    queuedNotReady: number
    wouldSubmit: number
    oldestQueuedAt: string | null
    admissibleNow: string[]
  }>
  unknown: { jobId: number; runId: number; name: string; labels: string[] }[]
  unmanagedQueued: number
  hostedQueued: number
  statusCounts: Record<string, number>
  transitions: ReturnType<typeof jobTransitions>
}

export interface ShadowErrorRow {
  schema: 1
  kind: 'error'
  at: string
  round: number
  nextIntervalSec: number
  error: { source: 'github' | 'internal'; kind: GithubErrorKind | 'internal'; httpStatus: number | null; message: string }
}

export interface ShadowStartRow {
  schema: 1
  kind: 'start'
  at: string
  hours: number
  pid: number
  machine: string
}

export interface ShadowStopRow {
  schema: 1
  kind: 'stop'
  at: string
  rounds: number
  reason: 'hours-elapsed' | 'signal'
}

export type ShadowRow = ShadowRoundRow | ShadowErrorRow | ShadowStartRow | ShadowStopRow

const VARIABLE_REFRESH_MS = 600_000
const RATE_REFRESH_MS = 600_000
const BUSY_INTERVAL_SEC = 15
const IDLE_INTERVAL_SEC = 60
/** 非 304 请求最近一小时超过这个数,强制降到 60 秒一轮(S5)。 */
const NON_304_HOURLY_LIMIT = 600

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ')
}

/** 外部文字进影子行/日志的唯一通道:先脱敏再截 300 字。 */
function sanitize(text: string): string {
  const chars = Array.from(redactGithubSecrets(text))
  return chars.length <= 300 ? chars.join('') : chars.slice(0, 300).join('')
}

export interface ShadowRunner {
  runOnce(): Promise<ShadowRow>
  run(options: { hours: number; sleep?: (ms: number) => Promise<void> }): Promise<number>
}

export function createShadowRunner(options: {
  share: string
  github: GithubReadClient
  now: () => number
  readFile?: (path: string) => string
  /** 缺省:建好目录后 appendFileSync 追加。 */
  appendLine?: (path: string, line: string) => void
  exists?: (path: string) => boolean
  policyReader?: { mode(): 'coexist' | 'freeze' }
  hubReader?: { read(): { managedLoad: boolean } }
  log?: (message: string) => void
}): ShadowRunner {
  const share = options.share
  const github = options.github
  const now = options.now
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const exists = options.exists ?? existsSync
  const appendLine = options.appendLine ?? ((path: string, line: string): void => {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${line}\n`)
  })
  const policyReader = options.policyReader ?? createCiPolicyReader({ share })
  const hubReader = options.hubReader ?? createHubSwitchReader({ share })
  const log = options.log
  const heartbeatPath = schedControlPaths(share).heartbeat

  let round = 0
  let previous: { snapshot: QueueSnapshot; jobs: readonly GhJobView[] } | null = null
  let ciRunsOn: string | null = null
  let ciRunsOnAt: string | null = null
  let rateRemaining: number | null = null
  let lastVariableCheckMs = Number.NEGATIVE_INFINITY
  let lastRateCheckMs = Number.NEGATIVE_INFINITY

  const isoNow = (): string => new Date(now()).toISOString()

  /** listRuns(queued) ∪ listRuns(in_progress) 按 runId 去重,createdAt 从新到旧取前 20,逐个取 jobs。 */
  async function collectJobs(): Promise<GhJobView[]> {
    const queuedRuns = await github.listRuns('queued')
    const progressRuns = await github.listRuns('in_progress')
    const runs = new Map<number, { createdAt: string }>()
    for (const runView of [...queuedRuns.value, ...progressRuns.value]) {
      if (!runs.has(runView.runId)) runs.set(runView.runId, { createdAt: runView.createdAt })
    }
    const ordered = [...runs.entries()]
      .sort(([, a], [, b]) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 20)
      .map(([runId]) => runId)
    const jobs: GhJobView[] = []
    const seen = new Set<number>()
    for (const runId of ordered) {
      const fetched = await github.listRunJobs(runId)
      for (const jobView of fetched.value) {
        if (seen.has(jobView.jobId)) continue
        seen.add(jobView.jobId)
        jobs.push(jobView)
      }
    }
    return jobs
  }

  const nextIntervalSec = (snapshot: QueueSnapshot | null): number => {
    const recent = github.stats().nonNotModifiedAt.length
    if (recent > NON_304_HOURLY_LIMIT) return IDLE_INTERVAL_SEC
    if (snapshot === null) return IDLE_INTERVAL_SEC
    const hasActivity = CI_TAKEOVER_LANE_ORDER.some(lane =>
      snapshot.lanes[lane].queued.length > 0 || snapshot.lanes[lane].inProgress.length > 0)
    return hasActivity ? BUSY_INTERVAL_SEC : IDLE_INTERVAL_SEC
  }

  const writeRow = (row: ShadowRow): void => {
    appendLine(shadowLogPath(share, row.at), JSON.stringify(row))
  }

  return {
    async runOnce(): Promise<ShadowRow> {
      round += 1
      const at = isoNow()
      const ciPolicyMode = policyReader.mode()
      const ciPolicyFileExists = exists(ciPolicyPath(share))
      let managedLoad: boolean | null
      try {
        managedLoad = hubReader.read().managedLoad
      } catch {
        managedLoad = null
      }
      let heartbeatRaw: unknown = null
      let dispatcherError: string | null = null
      try {
        heartbeatRaw = JSON.parse(readFile(heartbeatPath)) as unknown
      } catch (error) {
        dispatcherError = sanitize(messageOf(error))
      }
      const heartbeat = shadowMachines(heartbeatRaw, at)
      try {
        const jobs = await collectJobs()
        // CI_RUNS_ON 与额度都是 10 分钟一查;失败沿用旧值,不影响本轮。
        if (now() - lastVariableCheckMs >= VARIABLE_REFRESH_MS) {
          lastVariableCheckMs = now()
          try {
            const variable = await github.getVariable('CI_RUNS_ON')
            if (variable.value !== null) {
              ciRunsOn = variable.value
              ciRunsOnAt = isoNow()
            }
          } catch { /* 沿用旧值 */ }
        }
        if (now() - lastRateCheckMs >= RATE_REFRESH_MS) {
          lastRateCheckMs = now()
          try {
            rateRemaining = (await github.rateLimit()).remaining
          } catch { /* 沿用旧值 */ }
        }
        const snapshot = queueSnapshot(at, jobs)
        const transitions = jobTransitions(previous, jobs)
        const estimates = shadowEstimate(snapshot, jobs, heartbeat.machines)
        const stats = github.stats()
        const isReady = (jobView: GhJobView): boolean =>
          prerequisitesMet(jobView, jobs.filter(candidate => candidate.runId === jobView.runId))
        const lanes = {} as ShadowRoundRow['lanes']
        for (const lane of CI_TAKEOVER_LANE_ORDER) {
          const estimate = estimates.find(candidate => candidate.lane === lane)!
          const queuedJobs = snapshot.lanes[lane].queued
          lanes[lane] = {
            queued: queuedJobs.map(jobView => ({
              jobId: jobView.jobId, runId: jobView.runId, name: jobView.name,
              createdAt: jobView.createdAt, ready: isReady(jobView),
            })),
            inProgress: snapshot.lanes[lane].inProgress.length,
            queuedReady: estimate.queuedReady,
            queuedNotReady: estimate.queuedNotReady,
            wouldSubmit: estimate.wouldSubmit,
            oldestQueuedAt: estimate.oldestQueuedAt,
            admissibleNow: estimate.admissibleNow,
          }
        }
        const row: ShadowRoundRow = {
          schema: 1, kind: 'round', at, round, nextIntervalSec: nextIntervalSec(snapshot),
          github: {
            requests: stats.requests, notModified: stats.notModified, errors: stats.errors,
            nonNotModifiedLastHour: stats.nonNotModifiedAt.length, rateRemaining,
          },
          ciRunsOn, ciRunsOnAt,
          ciPolicy: { mode: ciPolicyMode, fileExists: ciPolicyFileExists },
          managedLoad,
          dispatcher: { fresh: heartbeat.fresh, at: heartbeat.at, error: dispatcherError },
          machines: heartbeat.machines,
          lanes,
          unknown: snapshot.unknown.map(jobView => ({
            jobId: jobView.jobId, runId: jobView.runId, name: jobView.name, labels: [...jobView.labels],
          })),
          unmanagedQueued: snapshot.unmanagedQueued,
          hostedQueued: snapshot.hostedQueued,
          statusCounts: snapshot.statusCounts,
          transitions,
        }
        previous = { snapshot, jobs }
        writeRow(row)
        log?.(`[ci-takeover] 第 ${round} 轮(${at}):` +
          CI_TAKEOVER_LANE_ORDER.map(lane => `${lane} 排队 ${lanes[lane].queued.length}/在跑 ${lanes[lane].inProgress}`).join(','))
        return row
      } catch (error) {
        if (error instanceof GithubError) {
          const row: ShadowErrorRow = {
            schema: 1, kind: 'error', at, round, nextIntervalSec: IDLE_INTERVAL_SEC,
            error: { source: 'github', kind: error.kind, httpStatus: error.httpStatus, message: error.message },
          }
          writeRow(row)
          log?.(`[ci-takeover] 第 ${round} 轮 GitHub 读失败(${error.kind}),本轮只记账: ${row.error.message}`)
          return row
        }
        const row: ShadowErrorRow = {
          schema: 1, kind: 'error', at, round, nextIntervalSec: IDLE_INTERVAL_SEC,
          error: { source: 'internal', kind: 'internal', httpStatus: null, message: sanitize(messageOf(error)) },
        }
        writeRow(row)
        log?.(`[ci-takeover] 第 ${round} 轮内部异常,本轮只记账: ${row.error.message}`)
        return row
      }
    },

    async run({ hours, sleep = defaultSleep }): Promise<number> {
      const startedAt = isoNow()
      const startRow: ShadowStartRow = {
        schema: 1, kind: 'start', at: startedAt, hours, pid: process.pid, machine: hostname(),
      }
      writeRow(startRow)
      log?.(`[ci-takeover] 影子开始:${startRow.at} hours=${hours} pid=${startRow.pid} machine=${startRow.machine}`)
      const deadlineMs = now() + hours * 3_600_000
      let signalled = false
      const onSignal = (): void => { signalled = true }
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)
      let rounds = 0
      try {
        while (now() < deadlineMs && !signalled) {
          const row = await this.runOnce()
          if (row.kind === 'round') rounds += 1
          // runOnce 只回 round/error 两种行,都带 nextIntervalSec;按 kind 收窄取值,其余行型退回闲时间隔。
          const intervalSec = row.kind === 'round' || row.kind === 'error' ? row.nextIntervalSec : IDLE_INTERVAL_SEC
          await sleep(intervalSec * 1000)
        }
      } finally {
        process.removeListener('SIGINT', onSignal)
        process.removeListener('SIGTERM', onSignal)
      }
      const stoppedAt = isoNow()
      const stopRow: ShadowStopRow = {
        schema: 1, kind: 'stop', at: stoppedAt, rounds, reason: signalled ? 'signal' : 'hours-elapsed',
      }
      writeRow(stopRow)
      log?.(`[ci-takeover] 影子结束:${stopRow.at} rounds=${rounds} reason=${stopRow.reason}`)
      return 0
    },
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

// ---------------------------------------------------------------------------
// 汇总(契约 §6.3)。
// ---------------------------------------------------------------------------

export interface ShadowLaneSummary {
  transitions: number
  waitSec: { p50: number | null; p90: number | null; max: number | null }
  maxConcurrentQueued: number
  roundsWithQueue: number
  roundsBlockedByCores: number
}

export interface ShadowSummary {
  from: string | null
  to: string | null
  rounds: number
  errorRounds: number
  lanes: Record<CiTakeoverLane, ShadowLaneSummary>
  prereq: { queuedNotReadyRounds: number; transitionsQueuedBeforePrereq: number; examples: { runId: number; name: string; at: string }[] }
  unknownLabelSets: { labels: string[]; count: number }[]
  github: { requests: number; notModified: number; notModifiedRatio: number | null; peakNonNotModifiedPerHour: number }
  ciRunsOnValues: string[]
  ciPolicyModes: { coexist: number; freeze: number }
  managedLoad: { on: number; off: number; unknown: number }
  runnersTaking: Record<string, number>
}

/** 最近秩法百分位:升序第 ceil(p/100 × n) 个;没有样本为 null。 */
function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null
  const rank = Math.ceil((p / 100) * sortedAsc.length)
  return sortedAsc[Math.min(rank, sortedAsc.length) - 1]!
}

export function summarizeShadow(rows: readonly ShadowRow[]): ShadowSummary {
  const roundRows = rows.filter((row): row is ShadowRoundRow => row.kind === 'round')
  const errorRows = rows.filter((row): row is ShadowErrorRow => row.kind === 'error')
  const stamps = rows.map(row => row.at).filter(at => Number.isFinite(Date.parse(at))).sort()
  const transitions = roundRows.flatMap(row => row.transitions)

  const lanes = {} as Record<CiTakeoverLane, ShadowLaneSummary>
  for (const lane of CI_TAKEOVER_LANE_ORDER) {
    const laneTransitions = transitions.filter(transition => transition.lane === lane)
    const waits = laneTransitions.map(transition => transition.waitSec).sort((a, b) => a - b)
    lanes[lane] = {
      transitions: laneTransitions.length,
      waitSec: { p50: percentile(waits, 50), p90: percentile(waits, 90), max: waits.length > 0 ? waits[waits.length - 1]! : null },
      maxConcurrentQueued: roundRows.reduce((max, row) => Math.max(max, row.lanes[lane].queued.length), 0),
      roundsWithQueue: roundRows.filter(row => row.lanes[lane].queued.length > 0).length,
      roundsBlockedByCores: roundRows.filter(row => row.lanes[lane].wouldSubmit > 0 && row.lanes[lane].admissibleNow.length === 0).length,
    }
  }

  const labelKey = (labels: readonly string[]): string => JSON.stringify([...labels])
  const unknownCounts = new Map<string, { labels: string[]; count: number }>()
  for (const row of roundRows) {
    for (const entry of row.unknown) {
      const key = labelKey(entry.labels)
      const current = unknownCounts.get(key)
      if (current === undefined) unknownCounts.set(key, { labels: [...entry.labels], count: 1 })
      else current.count += 1
    }
  }

  const runnersTaking: Record<string, number> = {}
  for (const transition of transitions) {
    if (transition.runnerName === null) continue
    runnersTaking[transition.runnerName] = (runnersTaking[transition.runnerName] ?? 0) + 1
  }

  const requests = roundRows.reduce((sum, row) => sum + row.github.requests, 0)
  const notModified = roundRows.reduce((sum, row) => sum + row.github.notModified, 0)
  const ciPolicyModes = { coexist: 0, freeze: 0 }
  for (const row of roundRows) ciPolicyModes[row.ciPolicy.mode] += 1
  const managedLoad = { on: 0, off: 0, unknown: 0 }
  for (const row of roundRows) {
    if (row.managedLoad === true) managedLoad.on += 1
    else if (row.managedLoad === false) managedLoad.off += 1
    else managedLoad.unknown += 1
  }
  const ciRunsOnValues: string[] = []
  for (const row of roundRows) {
    if (row.ciRunsOn !== null && !ciRunsOnValues.includes(row.ciRunsOn)) ciRunsOnValues.push(row.ciRunsOn)
  }

  const beforePrereq = transitions.filter(transition => transition.queuedBeforePrereq)
  return {
    from: stamps.length > 0 ? stamps[0]!.slice(0, 10) : null,
    to: stamps.length > 0 ? stamps[stamps.length - 1]!.slice(0, 10) : null,
    rounds: roundRows.length,
    errorRounds: errorRows.length,
    lanes,
    prereq: {
      queuedNotReadyRounds: roundRows.filter(row =>
        CI_TAKEOVER_LANE_ORDER.some(lane => row.lanes[lane].queuedNotReady > 0)).length,
      transitionsQueuedBeforePrereq: beforePrereq.length,
      examples: beforePrereq.slice(0, 5).map(transition => ({
        runId: transition.runId, name: transition.name, at: transition.startedAt,
      })),
    },
    unknownLabelSets: [...unknownCounts.values()].sort((a, b) =>
      b.count - a.count || labelKey(a.labels).localeCompare(labelKey(b.labels))),
    github: {
      requests,
      notModified,
      notModifiedRatio: requests > 0 ? notModified / requests : null,
      peakNonNotModifiedPerHour: roundRows.reduce((max, row) => Math.max(max, row.github.nonNotModifiedLastHour), 0),
    },
    ciRunsOnValues,
    ciPolicyModes,
    managedLoad,
    runnersTaking,
  }
}

// ---------------------------------------------------------------------------
// 命令行。
// ---------------------------------------------------------------------------

/** 给人看的时刻换成北京时间(UTC+8),落盘仍是 UTC ISO。 */
function beijingTime(at: string): string {
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return at
  return `${new Date(ms + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19)} 北京时间`
}

function printSummary(summary: ShadowSummary): void {
  const lines: string[] = []
  lines.push(`观测窗口:${summary.from ?? '-'} ~ ${summary.to ?? '-'}(UTC 日期)`)
  lines.push(`轮次:${summary.rounds} 轮,其中出错 ${summary.errorRounds} 轮`)
  for (const lane of CI_TAKEOVER_LANE_ORDER) {
    const laneSummary = summary.lanes[lane]
    const wait = laneSummary.waitSec
    const format = (value: number | null): string => (value === null ? '-' : `${value} 秒`)
    lines.push(`车道 ${lane}:开跑 ${laneSummary.transitions} 次,等待 p50=${format(wait.p50)} / p90=${format(wait.p90)} / 最多=${format(wait.max)},`
      + `同时在排最多 ${laneSummary.maxConcurrentQueued} 条,有排队的轮次 ${laneSummary.roundsWithQueue},有单挂不上(没核)的轮次 ${laneSummary.roundsBlockedByCores}`)
  }
  lines.push(`前置没齐就排队:出现过 ${summary.prereq.queuedNotReadyRounds} 轮;开跑记录里前置没齐的 ${summary.prereq.transitionsQueuedBeforePrereq} 次`)
  for (const example of summary.prereq.examples) {
    lines.push(`  例:run ${example.runId} 的 ${example.name} 于 ${beijingTime(example.at)} 开跑`)
  }
  const unknownText = summary.unknownLabelSets
    .map(set => `[${set.labels.join(' ')}] × ${set.count}`)
    .join(';')
  lines.push(`认不出的标签组合:${unknownText === '' ? '无' : unknownText}`)
  lines.push(`GitHub:请求 ${summary.github.requests} 次,304 命中 ${summary.github.notModified} 次`
    + `(占比 ${summary.github.notModifiedRatio === null ? '-' : (summary.github.notModifiedRatio * 100).toFixed(1)}%),`
    + `每小时非 304 峰值 ${summary.github.peakNonNotModifiedPerHour} 次`)
  lines.push(`CI_RUNS_ON 取值:${summary.ciRunsOnValues.length > 0 ? summary.ciRunsOnValues.join(', ') : '没读到'}`
    + `;相处方式:共存 ${summary.ciPolicyModes.coexist} 轮 / 让路 ${summary.ciPolicyModes.freeze} 轮`
    + `;managedLoad:开 ${summary.managedLoad.on} / 关 ${summary.managedLoad.off} / 没读到 ${summary.managedLoad.unknown}`)
  const runners = Object.entries(summary.runnersTaking)
  lines.push(`领走作业的 runner:${runners.length > 0 ? runners.map(([name, count]) => `${name} × ${count}`).join(', ') : '无'}`
    + `(粗估口径:不含 vitest 同机互斥,未调派单员准入)`)
  for (const line of lines) console.log(line)
}

/** 读 shadow 目录下的 jsonl(按 UTC 日期文件名与行内 at 双重过滤),坏文件坏行跳过。 */
function readShadowRows(share: string, from: string | null, to: string | null): ShadowRow[] {
  const dir = ciTakeoverShadowDir(share)
  let files: string[]
  try {
    files = readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()
  } catch {
    return []
  }
  const rows: ShadowRow[] = []
  for (const name of files) {
    const fileDate = name.slice(0, 10)
    if ((from !== null && fileDate < from) || (to !== null && fileDate > to)) continue
    let text: string
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const row = JSON.parse(line) as ShadowRow
        const rowDate = typeof row.at === 'string' ? row.at.slice(0, 10) : fileDate
        if ((from !== null && rowDate < from) || (to !== null && rowDate > to)) continue
        rows.push(row)
      } catch { /* 坏行跳过 */ }
    }
  }
  return rows
}

export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0]
  const flag = (name: string): string | null => {
    const index = argv.indexOf(name)
    return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null
  }
  if (command === 'run') {
    const share = flag('--share')
    const hoursRaw = flag('--hours')
    if (share === null || share === '' || hoursRaw === null) return 2
    const hours = Number(hoursRaw)
    if (!Number.isFinite(hours) || hours <= 0) return 2
    // 共享盘不可写 → 退出码 3:写探针文件即删,不留给任何别的目录。
    try {
      const dir = ciTakeoverShadowDir(share)
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, `.write-probe-${process.pid}`)
      writeFileSync(probe, '')
      rmSync(probe, { force: true })
    } catch {
      return 3
    }
    // 令牌读不到 → 退出码 4。
    let currentToken: string
    try {
      currentToken = await loadGithubToken()
    } catch {
      return 4
    }
    const github = createGithubReadClient({
      token: async () => currentToken,
      invalidateToken: () => {
        void loadGithubToken().then(fresh => { currentToken = fresh }).catch(() => { /* 换不出来沿用旧令牌 */ })
      },
    })
    const runner = createShadowRunner({ share, github, now: Date.now, log: message => console.log(message) })
    return runner.run({ hours })
  }
  if (command === 'summary') {
    const share = flag('--share')
    if (share === null || share === '') return 2
    const from = flag('--from')
    const to = flag('--to')
    const dateFormat = /^\d{4}-\d{2}-\d{2}$/
    if ((from !== null && !dateFormat.test(from)) || (to !== null && !dateFormat.test(to))) return 2
    const summary = summarizeShadow(readShadowRows(share, from, to))
    if (argv.includes('--json')) console.log(JSON.stringify(summary, null, 2))
    else printSummary(summary)
    return 0
  }
  return 2
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main(process.argv.slice(2)).then(code => { process.exitCode = code })
}
