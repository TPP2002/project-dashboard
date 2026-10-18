import deployment from './client/deployment-config.cjs'
/**
 * CI 标签路由的 GitHub 端口(CI-RUNNER-LABEL-ROUTING-0924 §6.3)。
 *
 * 全部走 gh 命令行:查清单、加/摘单个标签、查配额、查车道排队作业。
 * 写只允许 POST/DELETE 单标签,绝不整表覆盖;受管车道之外的标签在参数层直接拒绝,
 * 根本不会落命令。凭据一律来自 gh 自己的登录态,进程环境里绝不设置令牌变量。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { CiRunnersSnapshot } from './sched-ci-labels-plan'
import { CI_LABEL_REPO, CI_MANAGED_LANES } from './sched-ci-labels-plan'

export const GH_TIMEOUT_MS = 15_000
export const GH_MAX_BUFFER_BYTES = 4_194_304
const GH_DEFAULT_PATH = deployment.getDeploymentConfig().ci.ghPath
/** 匿名档配额正好是每小时 60 次;见到它就说明 gh 没登录管理账号。 */
const ANONYMOUS_RATE_LIMIT = 60

export type GhErrorKind = 'no-cli' | 'unavailable' | 'no-credential' | 'rate-limited'
  | 'no-permission' | 'not-found' | 'bad-response'

export class GhApiError extends Error {
  readonly kind: GhErrorKind
  readonly httpStatus: number | null
  constructor(kind: GhErrorKind, message: string, httpStatus?: number) {
    super(`[ci-labels][${kind}] ${message}`)
    this.name = 'GhApiError'
    this.kind = kind
    this.httpStatus = httpStatus ?? null
  }
}

export interface GhQueuedJob { runId: number; jobId: number; name: string; labels: string[]; createdAt: string }

export type GhRequest =
  | { kind: 'list-runners' }
  | { kind: 'add-label'; runnerId: number; label: string }
  | { kind: 'remove-label'; runnerId: number; label: string }
  | { kind: 'rate-limit' }
  | { kind: 'list-runs'; status: 'queued' | 'in_progress' }
  | { kind: 'list-jobs'; runId: number }

const assertLane = (label: string): void => {
  if (!(CI_MANAGED_LANES as readonly string[]).includes(label)) {
    throw new Error(`[ci-labels] 拒绝改受管车道以外的标签:${label}`)
  }
}
const assertRunnerId = (runnerId: number): void => {
  if (!Number.isInteger(runnerId) || runnerId <= 0) throw new Error(`[ci-labels] 工位编号不合法:${runnerId}`)
}

/** 命令行形状的单一事实来源;改这里之前先想清楚 gh 的旧行为。 */
export function ghArgs(request: GhRequest): string[] {
  if (!CI_LABEL_REPO) throw new Error('[ci-labels] deployment CI labels not configured')
  switch (request.kind) {
    case 'list-runners': return ['api', `repos/${CI_LABEL_REPO}/actions/runners?per_page=100`]
    case 'rate-limit': return ['api', 'rate_limit']
    case 'list-runs': return ['api', `repos/${CI_LABEL_REPO}/actions/runs?status=${request.status}&per_page=20`]
    case 'list-jobs':
      assertRunnerId(request.runId)
      return ['api', `repos/${CI_LABEL_REPO}/actions/runs/${request.runId}/jobs?per_page=100`]
    case 'add-label':
      assertLane(request.label)
      assertRunnerId(request.runnerId)
      return ['api', '--method', 'POST', `repos/${CI_LABEL_REPO}/actions/runners/${request.runnerId}/labels`,
        '-f', `labels[]=${request.label}`]
    case 'remove-label':
      assertLane(request.label)
      assertRunnerId(request.runnerId)
      return ['api', '--method', 'DELETE', `repos/${CI_LABEL_REPO}/actions/runners/${request.runnerId}/labels/${request.label}`]
  }
}

/**
 * 失败分级的九步顺序:ENOENT 没装 gh;被杀超时;401/退出码 4/提示登录都算没凭据;
 * 429 或带 rate limit 字样的 403 算限流;其余 403 算没权限;404;5xx;其余 4xx;兜底不可用。
 */
export function classifyGhFailure(error: unknown): { kind: GhErrorKind; httpStatus?: number } {
  const candidate = error as { code?: unknown; killed?: unknown; exitCode?: unknown; stderr?: unknown; message?: unknown } | null
  if (candidate !== null && typeof candidate === 'object') {
    if (candidate.code === 'ENOENT') return { kind: 'no-cli' }
    if (candidate.killed === true) return { kind: 'unavailable' }
  }
  const rawStderr = candidate?.stderr
  const text = typeof rawStderr === 'string' ? rawStderr : ''
  const statusMatch = /\(HTTP (\d{3})\)/.exec(text)
  const status = statusMatch === null ? undefined : Number(statusMatch[1])
  const withStatus = (kind: GhErrorKind): { kind: GhErrorKind; httpStatus?: number } =>
    status === undefined ? { kind } : { kind, httpStatus: status }
  if (status === 401 || candidate?.exitCode === 4 || text.includes('gh auth login')) return withStatus('no-credential')
  if (status === 429 || (status === 403 && /rate limit/i.test(text))) return withStatus('rate-limited')
  if (status === 403) return withStatus('no-permission')
  if (status === 404) return withStatus('not-found')
  if (status !== undefined && status >= 500) return withStatus('unavailable')
  if (status !== undefined && status >= 400) return withStatus('bad-response')
  return { kind: 'unavailable' }
}

/** 日志与审计里绝不出现令牌;超长消息截到 300 字。 */
const SECRET_PATTERN = /(gh[opsur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g
export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '***').slice(0, 300)
}

/** GitHub 的标签是 { name, type } 对象;只留 type 为 custom 的名字(清单与写应答同口径)。 */
function customLabelNames(labels: unknown[]): string[] {
  return labels.flatMap(label => {
    const node = label as { name?: unknown; type?: unknown }
    return node?.type === 'custom' && typeof node.name === 'string' ? [node.name] : []
  })
}

/** 只收自定义标签;系统只读标签原样略过。形状不对按坏应答报,不猜。 */
export function parseRunners(payload: unknown): CiRunnersSnapshot {
  const root = payload as { runners?: unknown } | null
  if (root === null || typeof root !== 'object' || !Array.isArray(root.runners)) {
    throw new GhApiError('bad-response', 'runner 清单不是预期形状')
  }
  const runners: CiRunnersSnapshot = []
  for (const item of root.runners) {
    const entry = item as { id?: unknown; name?: unknown; status?: unknown; busy?: unknown; labels?: unknown }
    if (typeof entry.id !== 'number' || !Number.isInteger(entry.id) || typeof entry.name !== 'string'
      || typeof entry.busy !== 'boolean' || !Array.isArray(entry.labels)) {
      throw new GhApiError('bad-response', `runner 条目缺字段:${JSON.stringify(entry)?.slice(0, 120)}`)
    }
    const labels = customLabelNames(entry.labels)
    runners.push({ id: entry.id, name: entry.name, online: entry.status === 'online', busy: entry.busy, labels })
  }
  return runners
}

export type GhExecutor = (file: string, args: string[], options: Record<string, unknown>,
  callback: (error: { code?: string; killed?: boolean; exitCode?: number; stderr?: string; message?: string } | null,
    stdout: string, stderr: string) => void) => void

export interface CiLabelGithubPort {
  listRunners(): Promise<CiRunnersSnapshot>
  addLabel(runnerId: number, label: string): Promise<{ labels: string[] }>
  removeLabel(runnerId: number, label: string): Promise<{ labels: string[] }>
  rateLimit(): Promise<{ remaining: number; limit: number; resetAt: string }>
  queuedLaneJobs(lane: string): Promise<GhQueuedJob[]>
  close(): void
}

export function createGhCliPort(options: { executor?: GhExecutor; env?: Record<string, string | undefined>;
  ghPath?: string; exists?: (path: string) => boolean } = {}): CiLabelGithubPort {
  // 令牌变量一律剔除:凭据只从 gh 自己的登录态来。
  const { GH_TOKEN: _token, GITHUB_TOKEN: _githubToken, ...restEnv } = options.env ?? process.env
  const exists = options.exists ?? (path => existsSync(path))
  const ghPath = options.ghPath
    ?? (restEnv.SCHED_GH_BIN !== undefined && restEnv.SCHED_GH_BIN !== '' ? restEnv.SCHED_GH_BIN
      : GH_DEFAULT_PATH)
  const baseOptions = (): Record<string, unknown> => ({
    encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER_BYTES, windowsHide: true,
    env: { ...restEnv, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', MSYS_NO_PATHCONV: '1' },
  })
  const exec: GhExecutor = options.executor ?? ((file, args, opts, callback) => {
    execFile(file, args, { ...opts, windowsHide: true } as never, (error, stdout, stderr) =>
      callback(error as never, typeof stdout === 'string' ? stdout : String(stdout), typeof stderr === 'string' ? stderr : String(stderr)))
  })

  let closed = false
  const inflight = new Set<() => void>()
  let chain: Promise<unknown> = Promise.resolve()
  /** 同一时刻只跑一个 gh 子进程;前一个没完,后一个排队。 */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(() => work(), () => work())
    chain = run.then(() => undefined, () => undefined)
    return run
  }
  const call = (args: string[]): Promise<string> => new Promise<string>((resolve, reject) => {
    if (closed) { reject(new GhApiError('unavailable', 'gh 端口已关闭')); return }
    let settled = false
    const cancel = (): void => {
      if (settled) return
      settled = true
      reject(new GhApiError('unavailable', 'gh 端口已关闭,在途调用作废'))
    }
    inflight.add(cancel)
    try {
      exec(ghPath, args, baseOptions(), (error, stdout, stderr) => {
        if (settled) return
        settled = true
        inflight.delete(cancel)
        if (error === null) { resolve(stdout); return }
        const verdict = classifyGhFailure({ ...error, stderr: error.stderr ?? stderr })
        reject(new GhApiError(verdict.kind, redactSecrets(stderr || error.message || 'gh 调用失败'), verdict.httpStatus))
      })
    } catch (error) {
      if (settled) return
      settled = true
      inflight.delete(cancel)
      const verdict = classifyGhFailure(error)
      reject(new GhApiError(verdict.kind, redactSecrets(error instanceof Error ? error.message : String(error)), verdict.httpStatus))
    }
  })
  const safeJson = (raw: string): unknown => {
    try { return JSON.parse(raw) } catch { throw new GhApiError('bad-response', '应答不是 JSON') }
  }
  const extractLabels = (payload: unknown): string[] => {
    const node = payload as { labels?: unknown } | null
    if (node === null || typeof node !== 'object' || !Array.isArray(node.labels)) {
      throw new GhApiError('bad-response', '标签应答不是预期形状')
    }
    return customLabelNames(node.labels)
  }
  /** 不排队版本的清单读取,专供写后复核在串行回合内复用。 */
  const rawList = (): Promise<CiRunnersSnapshot> =>
    call(ghArgs({ kind: 'list-runners' })).then(raw => parseRunners(safeJson(raw)))
  const relistedLabels = async (runnerId: number): Promise<string[]> =>
    (await rawList()).find(runner => runner.id === runnerId)?.labels ?? []
  const isKind = (error: unknown, kind: GhErrorKind): boolean => error instanceof GhApiError && error.kind === kind

  return {
    listRunners: (): Promise<CiRunnersSnapshot> => serial(rawList),
    addLabel: async (runnerId, label): Promise<{ labels: string[] }> => {
      // async 方法体:ghArgs 对非法入参的同步抛错按契约 §6.3 变成被拒绝的 Promise,不炸调用方。
      const args = ghArgs({ kind: 'add-label', runnerId, label })
      return serial(async () => {
        try {
          return { labels: extractLabels(safeJson(await call(args))) }
        } catch (error) {
          if (!isKind(error, 'not-found') && !isKind(error, 'bad-response')) throw error
          const labels = await relistedLabels(runnerId)
          if (labels.includes(label)) return { labels }
          throw new GhApiError('bad-response', `给工位 ${runnerId} 加 ${label} 后复核仍不见标签`)
        }
      })
    },
    removeLabel: async (runnerId, label): Promise<{ labels: string[] }> => {
      const args = ghArgs({ kind: 'remove-label', runnerId, label })
      return serial(async () => {
        try {
          return { labels: extractLabels(safeJson(await call(args))) }
        } catch (error) {
          if (!isKind(error, 'not-found')) throw error
          const labels = await relistedLabels(runnerId)
          if (!labels.includes(label)) return { labels }
          throw new GhApiError('bad-response', `从工位 ${runnerId} 摘 ${label} 后复核仍见标签`)
        }
      })
    },
    rateLimit: (): Promise<{ remaining: number; limit: number; resetAt: string }> => serial(async () => {
      const core = (safeJson(await call(ghArgs({ kind: 'rate-limit' }))) as
        { resources?: { core?: { remaining?: unknown; limit?: unknown; reset?: unknown } } } | null)
        ?.resources?.core
      if (core === undefined || typeof core.remaining !== 'number' || typeof core.limit !== 'number'
        || typeof core.reset !== 'number') throw new GhApiError('bad-response', '配额应答不是预期形状')
      if (core.limit === ANONYMOUS_RATE_LIMIT) {
        throw new GhApiError('no-credential', 'GitHub 配额是匿名档,gh 没有登录管理账号')
      }
      return { remaining: core.remaining, limit: core.limit, resetAt: new Date(core.reset * 1000).toISOString() }
    }),
    queuedLaneJobs: (lane): Promise<GhQueuedJob[]> => serial(async () => {
      assertLane(lane)
      const runs: { id: number; createdAt: string }[] = []
      for (const status of ['queued', 'in_progress'] as const) {
        const payload = safeJson(await call(ghArgs({ kind: 'list-runs', status }))) as { workflow_runs?: unknown }
        if (!Array.isArray(payload.workflow_runs)) throw new GhApiError('bad-response', '作业清单不是预期形状')
        for (const item of payload.workflow_runs) {
          const run = item as { id?: unknown; created_at?: unknown }
          if (typeof run.id !== 'number' || typeof run.created_at !== 'string'
            || !Number.isFinite(Date.parse(run.created_at))) {
            throw new GhApiError('bad-response', '作业条目缺字段')
          }
          if (!runs.some(existing => existing.id === run.id)) runs.push({ id: run.id, createdAt: run.created_at })
        }
      }
      const newest = runs.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 10)
      const jobs: GhQueuedJob[] = []
      for (const run of newest) {
        const payload = safeJson(await call(ghArgs({ kind: 'list-jobs', runId: run.id }))) as { jobs?: unknown }
        if (!Array.isArray(payload.jobs)) throw new GhApiError('bad-response', '作业明细不是预期形状')
        for (const item of payload.jobs) {
          const job = item as { id?: unknown; name?: unknown; status?: unknown; labels?: unknown; created_at?: unknown }
          if (typeof job.id !== 'number' || typeof job.name !== 'string' || job.status !== 'queued'
            || !Array.isArray(job.labels) || !job.labels.every(label => typeof label === 'string')
            || typeof job.created_at !== 'string' || !Number.isFinite(Date.parse(job.created_at))) continue
          if (!job.labels.includes(lane)) continue
          jobs.push({ runId: run.id, jobId: job.id, name: job.name, labels: job.labels,
            createdAt: new Date(job.created_at).toISOString() })
        }
      }
      return jobs.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    }),
    close(): void {
      closed = true
      for (const cancel of [...inflight]) cancel()
    },
  }
}

/**
 * 生产入口的端口工厂(CI-RUNNER-LABEL-ROUTING-PORT-WIRING-0925):派单员独立进程入口与
 * 命令行入口统一用它接线。内部就是 createGhCliPort(),不带参数;创建本身不起 gh 子进程,
 * 第一次调用才落命令。库函数(createCiLabelRouter / ensurePort / startSchedulerDaemon)刻意
 * 不设缺省——单测起派单员或路由时,开关若恰好是 on,缺省就会去碰真 GitHub、真摘生产工位的
 * 牌子;生产端口只靠入口显式注入。
 */
export const productionCiLabelsGithub = (): CiLabelGithubPort => createGhCliPort()
