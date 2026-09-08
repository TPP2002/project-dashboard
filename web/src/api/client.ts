// REST 客户端：严格按 API 契约。dev 由 vite proxy 转发 /api → 真 server；
// mock 模式由内置 mock 中间件应答（业务代码无 mock 分支）。
import type { ActivityPage, Board, DecisionInfoField, ProjectSummary, Status } from '@/types'

const API = '/api'

/** 项目参数必须由调用方显式提供，续聊回包后也不能改投到新选中的项目。 */
export function codexUrl(endpoint: string, projectId: string | null): string {
  if (!projectId) throw new Error('先在顶栏选一个项目')
  return `${API}/codex/${endpoint}${endpoint.includes('?') ? '&' : '?'}project=${encodeURIComponent(projectId)}`
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body && typeof body.error === 'string') msg = body.error
    } catch {
      /* 忽略非 JSON 错误体 */
    }
    throw new Error(msg)
  }
  return (await res.json()) as T
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  // 兼容两种契约：真 server 返回 { ok, projects: [...] } 信封；dev:mock 返回裸数组。二者皆归一为数组。
  const data = await asJson<ProjectSummary[] | { projects?: ProjectSummary[] }>(
    await fetch(`${API}/projects`),
  )
  return Array.isArray(data) ? data : data.projects ?? []
}

/** 304 没有 JSON 响应体；ETag 由调用方按项目和查询模式分别保存。 */
export async function fetchBoard(id: string, opts: {
  fields?: 'tasks' | 'activity' | 'all'
  activityLimit?: number
  etag?: string | null
} = {}): Promise<{ board: Board | null; etag: string | null; notModified: boolean }> {
  const params = new URLSearchParams()
  if (opts.fields) params.set('fields', opts.fields)
  if (opts.activityLimit !== undefined) params.set('activityLimit', String(opts.activityLimit))
  const query = params.size ? `?${params}` : ''
  const res = await fetch(`${API}/board/${encodeURIComponent(id)}${query}`, {
    headers: opts.etag ? { 'If-None-Match': opts.etag } : {},
  })
  const etag = res.headers.get('ETag')
  if (res.status === 304) return { board: null, etag, notModified: true }
  return { board: await asJson<Board>(res), etag, notModified: false }
}

export async function fetchActivity(id: string, opts: { before?: string; limit?: number } = {}): Promise<ActivityPage> {
  const params = new URLSearchParams()
  if (opts.before !== undefined) params.set('before', opts.before)
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  const query = params.size ? `?${params}` : ''
  return asJson<ActivityPage>(await fetch(`${API}/activity/${encodeURIComponent(id)}${query}`))
}

export type WebhookEvents = Record<'done' | 'pending' | 'block', boolean>
export type ModuleId = 'codex' | 'cost' | 'cpu' | 'reader'
export type Modules = Record<ModuleId, boolean>

export interface HealthInfo {
  ok: boolean
  mode?: 'release' | 'dev' | 'installed'
  releaseCommit?: string | null
  releaseBehind?: boolean
  latestReleaseCommit?: string | null
  launchHint?: string
  webhook?: { configured: boolean; events: WebhookEvents }
  modules?: Modules
}

export async function fetchHealth(): Promise<HealthInfo> {
  return asJson<HealthInfo>(await fetch(`${API}/health`))
}

export async function postSettings(body: { webhookEvents?: Partial<WebhookEvents>; modules?: Partial<Modules> }): Promise<{
  ok: boolean; settings: { webhookEvents: WebhookEvents; modules: Modules }
}> {
  return asJson(await fetch(`${API}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

export interface DecidePayload {
  did: string
  answer: string
  author?: string
}

export interface DecideResult {
  ok: boolean
  task?: unknown
  error?: string
}

export async function postDecide(
  pid: string,
  taskId: string,
  body: DecidePayload,
): Promise<DecideResult> {
  const res = await fetch(
    `${API}/decide/${encodeURIComponent(pid)}/${encodeURIComponent(taskId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  return asJson<DecideResult>(res)
}

export interface TaskActionPayloads {
  note: { text: string }
  park: { reason: string; note?: string }
  unpark: { reason: string }
  cancel: { reason: string }
  reopen: { reason: string }
  'request-info': { did: string; missing: DecisionInfoField[] }
}
export type TaskAction = keyof TaskActionPayloads
export interface TaskActionResult {
  ok: boolean
  id?: string
  taskId?: string | null
  status?: Status
  percent?: number
  changed?: string[]
}

export async function postUndecide(pid: string, tid: string, body: { did: string; author?: string }): Promise<TaskActionResult> {
  return asJson<TaskActionResult>(await fetch(
    `${API}/undecide/${encodeURIComponent(pid)}/${encodeURIComponent(tid)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  ))
}

/** 治理操作经服务端转发 CLI；失败时抛出服务端保留的 CLI 错误文案。 */
export async function postTaskAction<A extends TaskAction>(
  pid: string, tid: string, action: A, body: TaskActionPayloads[A],
): Promise<TaskActionResult> {
  return asJson<TaskActionResult>(await fetch(
    `${API}/task/${encodeURIComponent(pid)}/${encodeURIComponent(tid)}/${action}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  ))
}

export function docUrl(projectId: string, path: string): string {
  return `${API}/doc?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`
}

export async function fetchDoc(projectId: string, path: string): Promise<string> {
  const res = await fetch(docUrl(projectId, path))
  if (!res.ok) throw new Error(`${res.status} 文档读取失败`)
  return res.text()
}
