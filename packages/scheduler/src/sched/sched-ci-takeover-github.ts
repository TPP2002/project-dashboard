import deployment from './client/deployment-config.cjs'
/**
 * CI-RUNNER-JIT-TAKEOVER-0924 第 0 步(只读影子)· GitHub 只读客户端。
 *
 * 只发 GET;ETag 条件请求省额度;错误分类、超时、令牌读取与脱敏都收在本文件,
 * 给影子运行器与后续步骤共用。不变量 S1(只发 GET,FetchLike 的 method 类型只许 GET)、
 * S3(令牌只在内存,不落盘、不进日志——凡外部文字进消息先过 redactGithubSecrets 再截 300 字)。
 */
import { execFile as execFileCallback } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { CI_TAKEOVER_REPO } from './sched-ci-takeover-contract'

const execFile = promisify(execFileCallback) as (
  file: string, args: readonly string[],
  options: { timeout: number; windowsHide: true; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>

export type GithubErrorKind = 'no-credential' | 'no-permission' | 'rate-limited' | 'not-found' | 'unavailable' | 'bad-response'

export class GithubError extends Error {
  constructor(readonly kind: GithubErrorKind, message: string, readonly httpStatus: number | null,
    options?: ErrorOptions) {
    // message 必须已由调用方脱敏;这里再兜一道,防新调用点忘了。options 只用来带 { cause }。
    super(redactGithubSecrets(truncate(message)), options)
    this.name = 'GithubError'
  }
}

export function redactGithubSecrets(text: string): string {
  return text.replace(/(gh[opsur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, '***')
}

/** 截到 300 字(按 Unicode 码点,不劈开代理对)。 */
function truncate(text: string): string {
  const chars = Array.from(text)
  return chars.length <= 300 ? text : chars.slice(0, 300).join('')
}

/** 外部文字进日志/影子行/错误消息的唯一通道:先脱敏再截断。 */
function sanitize(text: string): string { return truncate(redactGithubSecrets(text)) }

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ')
}

export interface GhRunView {
  runId: number; workflowName: string; event: string; status: string
  headSha: string; createdAt: string; runAttempt: number
}

export interface GhJobView {
  jobId: number; runId: number; name: string; workflowName: string | null
  status: string; conclusion: string | null; labels: string[]; createdAt: string
  startedAt: string | null; completedAt: string | null; runnerId: number | null; runnerName: string | null
}

export interface GhFetched<T> { value: T; notModified: boolean; fetchedAt: string }

export interface GithubReadClient {
  listRuns(status: 'queued' | 'in_progress'): Promise<GhFetched<GhRunView[]>>
  listRunJobs(runId: number): Promise<GhFetched<GhJobView[]>>
  /** 404 = 变量不存在,value 为 null,不抛。 */
  getVariable(name: string): Promise<GhFetched<string | null>>
  rateLimit(): Promise<{ remaining: number; limit: number; resetAt: string }>
  stats(): { requests: number; notModified: number; errors: number; nonNotModifiedAt: readonly string[] }
}

export interface FetchResponseLike {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponseLike>

interface CacheEntry { etag: string; value: unknown }

const API_VERSION = '2022-11-28'
const USER_AGENT = 'scheduler-ci-takeover'
const NON_304_WINDOW_MS = 3_600_000

export function createGithubReadClient(options: {
  token: () => Promise<string>
  /** 收到 401 时调一次,再重试一次(重试会重新调 token() 取新令牌)。 */
  invalidateToken?: () => void
  fetchImpl?: FetchLike
  now?: () => number
  timeoutMs?: number
  apiBase?: string
}): GithubReadClient {
  const fetchImpl = options.fetchImpl ?? ((url: string, init: Parameters<FetchLike>[1]) => fetch(url, init))
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 15_000
  const apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
  if (!CI_TAKEOVER_REPO) throw new Error('[ci-takeover] deployment takeover not configured')
  const repo = `repos/${CI_TAKEOVER_REPO}`
  const cache = new Map<string, CacheEntry>()
  const recent: string[] = []
  const counters = { requests: 0, notModified: 0, errors: 0 }
  const nowIso = (): string => new Date(now()).toISOString()

  const recordNon304 = (): void => { recent.push(nowIso()) }
  const recentLastHour = (): string[] => {
    const cutoff = now() - NON_304_WINDOW_MS
    while (recent.length > 0 && Date.parse(recent[0]!) < cutoff) recent.shift()
    return [...recent]
  }

  const buildHeaders = (tokenValue: string, cached: CacheEntry | undefined): Record<string, string> => ({
    Authorization: `Bearer ${tokenValue}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
    ...(cached === undefined ? {} : { 'If-None-Match': cached.etag }),
  })

  const fetchOnce = async (url: string, headers: Record<string, string>): Promise<FetchResponseLike> => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    try {
      return await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 发一个请求并按契约 §7.2 分类错误。counted=false 用于 rate_limit(不计入统计)。
   * 401 先 invalidateToken 再重试一次;304 命中缓存直接返回。
   */
  const requestRaw = async (url: string, counted: boolean):
  Promise<{ status: number; text: string; notModified: boolean; headers: FetchResponseLike['headers'] }> => {
    let attempt = 0
    while (true) {
      attempt += 1
      const cached = cache.get(url)
      const headers = buildHeaders(await options.token(), cached)
      if (counted) counters.requests += 1
      let response: FetchResponseLike
      try {
        response = await fetchOnce(url, headers)
      } catch (error) {
        if (counted) { counters.errors += 1; recordNon304() }
        throw new GithubError('unavailable', `GitHub 请求失败:${messageOf(error)}`, null, { cause: error })
      }
      if (response.status === 304) {
        if (cached === undefined) {
          if (counted) { counters.errors += 1; recordNon304() }
          throw new GithubError('bad-response', 'GitHub 返回 304 但本地没有缓存', 304)
        }
        if (counted) counters.notModified += 1
        return { status: 304, text: '', notModified: true, headers: response.headers }
      }
      if (counted) recordNon304()
      if (response.status === 401) {
        if (attempt === 1) { options.invalidateToken?.(); continue }
        if (counted) counters.errors += 1
        throw new GithubError('no-credential', 'GitHub 令牌被拒(401)', 401)
      }
      let body: string
      try {
        body = await response.text()
      } catch (error) {
        if (counted) counters.errors += 1
        throw new GithubError('unavailable', `GitHub 响应读不到:${messageOf(error)}`, response.status, { cause: error })
      }
      // 分类顺序按契约 §7.2 表:429 与「403 且限流特征」先于普通 403。
      if (response.status === 429
        || (response.status === 403
          && (response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(body)))) {
        if (counted) counters.errors += 1
        throw new GithubError('rate-limited', sanitize(`GitHub 限流:${response.status}:${body}`), response.status)
      }
      if (response.status === 403) {
        if (counted) counters.errors += 1
        throw new GithubError('no-permission', sanitize(`GitHub 拒绝访问(403):${body}`), 403)
      }
      if (response.status === 404) {
        if (counted) counters.errors += 1
        throw new GithubError('not-found', sanitize(`GitHub 资源不存在(404):${url}`), 404)
      }
      if (response.status >= 500) {
        if (counted) counters.errors += 1
        throw new GithubError('unavailable', sanitize(`GitHub 服务不可用(${response.status}):${body}`), response.status)
      }
      if (response.status < 200 || response.status >= 300) {
        if (counted) counters.errors += 1
        throw new GithubError('bad-response', sanitize(`GitHub 响应状态异常(${response.status}):${body}`), response.status)
      }
      return { status: response.status, text: body, notModified: false, headers: response.headers }
    }
  }

  const requestJson = async <T>(url: string, parse: (text: string) => T): Promise<GhFetched<T>> => {
    const raw = await requestRaw(url, true)
    if (raw.notModified) {
      const cached = cache.get(url)
      return { value: cached!.value as T, notModified: true, fetchedAt: nowIso() }
    }
    let value: T
    try {
      value = parse(raw.text)
    } catch (error) {
      counters.errors += 1
      throw new GithubError('bad-response', sanitize(`GitHub 响应正文不符合预期:${messageOf(error)}`), raw.status, { cause: error })
    }
    const etag = raw.headers.get('etag')
    if (etag !== null && etag !== '') cache.set(url, { etag, value })
    return { value, notModified: false, fetchedAt: nowIso() }
  }

  return {
    async listRuns(status) {
      return requestJson(`${apiBase}/${repo}/actions/runs?status=${status}&per_page=30`, parseRuns)
    },
    async listRunJobs(runId) {
      return requestJson(`${apiBase}/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`, parseJobs)
    },
    async getVariable(name) {
      const url = `${apiBase}/${repo}/actions/variables/${encodeURIComponent(name)}`
      try {
        return await requestJson<string>(url, text => {
          const parsed = JSON.parse(text) as { value?: unknown }
          if (typeof parsed?.value !== 'string') throw new Error('variable.value 缺失')
          return parsed.value
        })
      } catch (error) {
        if (error instanceof GithubError && error.kind === 'not-found') {
          return { value: null, notModified: false, fetchedAt: nowIso() }
        }
        throw error
      }
    },
    async rateLimit() {
      const raw = await requestRaw(`${apiBase}/rate_limit`, false)
      let parsed: { resources?: { core?: { remaining?: unknown; limit?: unknown; reset?: unknown } } }
      try {
        parsed = JSON.parse(raw.text)
      } catch (error) {
        throw new GithubError('bad-response', sanitize(`rate_limit 正文不是 JSON:${messageOf(error)}`), raw.status, { cause: error })
      }
      const core = parsed?.resources?.core
      if (typeof core?.remaining !== 'number' || typeof core?.limit !== 'number' || typeof core?.reset !== 'number') {
        throw new GithubError('bad-response', 'rate_limit 缺 resources.core', raw.status)
      }
      return { remaining: core.remaining, limit: core.limit, resetAt: new Date(core.reset * 1000).toISOString() }
    },
    stats: () => ({ requests: counters.requests, notModified: counters.notModified, errors: counters.errors, nonNotModifiedAt: recentLastHour() }),
  }
}

// ---------------------------------------------------------------------------
// 令牌读取(契约 §7.2 第 2 点):GH_TOKEN_FILE 优先,读不到绝不回落 gh;
// 否则 gh auth token。令牌不写盘、不打印、不进任何日志与影子行。
// ---------------------------------------------------------------------------

export type GhTokenExec = (file: string, args: readonly string[], options: {
  timeout: number; windowsHide: true; env: NodeJS.ProcessEnv
}) => Promise<{ stdout: string }>

export async function loadGithubToken(options: {
  env?: NodeJS.ProcessEnv
  readFile?: (path: string) => string
  exec?: GhTokenExec
  exists?: (path: string) => boolean
} = {}): Promise<string> {
  if (!deployment.getDeploymentConfig().ci.takeover) throw new Error('[ci-takeover] deployment takeover not configured')
  const env = options.env ?? process.env
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const exec = options.exec ?? execFile
  const exists = options.exists ?? existsSync
  const noCredential = (detail: string, cause?: unknown): GithubError =>
    new GithubError('no-credential', `GitHub 令牌读不到:${detail}`, null,
      cause === undefined ? undefined : { cause })
  const file = env.GH_TOKEN_FILE
  if (typeof file === 'string' && file !== '') {
    let raw: string
    try {
      raw = readFile(file)
    } catch (error) {
      // 配了专用令牌却悄悄用上高权限令牌,比报错更糟:不回落 gh,直接抛。
      throw noCredential(sanitize(`文件读不到:${messageOf(error)}`), error)
    }
    const token = raw.replace(/^\uFEFF/, '').trim()
    if (token === '') throw noCredential(sanitize(`文件是空的:${file}`))
    return token
  }
  const ghBin = typeof env.SCHED_GH_BIN === 'string' && env.SCHED_GH_BIN !== ''
    ? env.SCHED_GH_BIN
    : deployment.getDeploymentConfig().ci.ghPath
  let stdout: string
  try {
    const result = await exec(ghBin, ['auth', 'token'], {
      timeout: 15_000, windowsHide: true,
      env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', MSYS_NO_PATHCONV: '1' },
    })
    stdout = result.stdout
  } catch (error) {
    throw noCredential(sanitize(`gh auth token 失败:${messageOf(error)}`), error)
  }
  const token = stdout.trim()
  if (token === '') throw noCredential(sanitize('gh auth token 输出为空'))
  return token
}

// ---------------------------------------------------------------------------
// 解析:数组缺失或某项 id 不是正整数 → bad-response。
// ---------------------------------------------------------------------------

function requirePositiveId(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${what} 必须是正整数`)
  }
  return value
}

function stringOr(value: unknown, fallback: string): string { return typeof value === 'string' ? value : fallback }
function stringOrNull(value: unknown): string | null { return typeof value === 'string' ? value : null }
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }

function parseArray(body: string, key: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new Error(`正文不是 JSON:${messageOf(error)}`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('正文不是对象')
  const array = (parsed as Record<string, unknown>)[key]
  if (!Array.isArray(array)) throw new Error(`缺少 ${key} 数组`)
  return array
}

export function parseRuns(body: string): GhRunView[] {
  return parseArray(body, 'workflow_runs').map(item => {
    const record = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    return {
      runId: requirePositiveId(record.id, 'workflow_runs[].id'),
      workflowName: stringOr(record.name, ''),
      event: stringOr(record.event, ''),
      status: stringOr(record.status, ''),
      headSha: stringOr(record.head_sha, ''),
      createdAt: stringOr(record.created_at, ''),
      runAttempt: numberOrNull(record.run_attempt) ?? 0,
    }
  })
}

export function parseJobs(body: string): GhJobView[] {
  return parseArray(body, 'jobs').map(item => {
    const record = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    return {
      jobId: requirePositiveId(record.id, 'jobs[].id'),
      runId: numberOrNull(record.run_id) ?? 0,
      name: stringOr(record.name, ''),
      workflowName: stringOrNull(record.workflow_name),
      status: stringOr(record.status, ''),
      conclusion: stringOrNull(record.conclusion),
      labels: Array.isArray(record.labels) ? record.labels.filter((label): label is string => typeof label === 'string') : [],
      createdAt: stringOr(record.created_at, ''),
      startedAt: stringOrNull(record.started_at),
      completedAt: stringOrNull(record.completed_at),
      runnerId: numberOrNull(record.runner_id),
      runnerName: stringOrNull(record.runner_name),
    }
  })
}
