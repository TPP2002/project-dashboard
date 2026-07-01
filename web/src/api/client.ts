// REST 客户端：严格按 API 契约。dev 由 vite proxy 转发 /api → 真 server；
// mock 模式由内置 mock 中间件应答（业务代码无 mock 分支）。
import type { Board, ProjectSummary } from '@/types'

const API = '/api'

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

export async function fetchBoard(id: string): Promise<Board> {
  return asJson<Board>(await fetch(`${API}/board/${encodeURIComponent(id)}`))
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

export function docUrl(projectId: string, path: string): string {
  return `${API}/doc?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`
}

export async function fetchDoc(projectId: string, path: string): Promise<string> {
  const res = await fetch(docUrl(projectId, path))
  if (!res.ok) throw new Error(`${res.status} 文档读取失败`)
  return res.text()
}
