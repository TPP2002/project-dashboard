import type { Session } from './types'
import { isOwnerOperation, operationKey, operationLedger } from './ownerOperations'

let context: Session | null = null
let generation = 0
const pending = new Set<AbortController>()
const expiredListeners = new Set<() => void>()
const responseGenerations = new WeakMap<Response, number>()
const responseOperations = new WeakMap<Response, () => void>()

export function setAuthContext(session: Session | null): void {
  if (context && (context.mode !== session?.mode || context.user?.id !== session?.user?.id || context.user?.role !== session?.user?.role)) cancelAuthRequests()
  context = session
}
export function onSessionExpired(listener: () => void): () => void {
  expiredListeners.add(listener)
  return () => expiredListeners.delete(listener)
}
/** Invalidates in-flight responses as well as requests; callers cannot repopulate old caches. */
export function clearAuthContext(): void {
  context = context?.mode === 'collaboration' ? { ok: true, mode: 'collaboration', user: null } : null
  cancelAuthRequests()
}
export function cancelAuthRequests(): void {
  generation++
  for (const controller of pending) controller.abort()
  pending.clear()
}
export function authRequestInit(session: Session | null, input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  if (session?.mode !== 'collaboration') return init
  const request = input instanceof Request ? input : null
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? request?.headers)
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('Content-Type', 'application/json')
    headers.set('X-Dashboard-Request', '1')
    headers.delete('X-Dashboard-CSRF')
    if (session.user && session.csrfToken) headers.set('X-Dashboard-CSRF', session.csrfToken)
  }
  return { ...init, headers, credentials: 'same-origin' }
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (context?.mode !== 'collaboration') return fetch(input, init)
  const request = input instanceof Request ? input : null
  const url = new URL(request?.url ?? String(input), window.location.href)
  // This helper carries credentials only to this deployment's API.
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
    throw new Error('协作请求必须使用本站接口')
  }
  if (!context.user && !['/api/auth/session', '/api/auth/login', '/api/auth/register', '/api/auth/device-login'].includes(url.pathname)) {
    throw new Error('请先登录')
  }
  const started = generation
  let completeOperation: (() => void) | undefined
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
  if (context.user?.role === 'owner' && isOwnerOperation(url.pathname, method)) {
    const userId = context.user.id
    const body = init?.body ?? (request ? await request.clone().text() : '')
    if (typeof body !== 'string') throw new Error('操作请求必须使用固定 JSON 内容')
    const key = await operationKey(userId, url.pathname + url.search, body)
    if (started !== generation) throw new DOMException('会话已改变', 'AbortError')
    const ledger = operationLedger(window.sessionStorage)
    const id = ledger.begin(key)
    const headers = new Headers(init?.headers ?? request?.headers)
    headers.set('X-Owner-Operation-Id', id)
    init = { ...init, headers }
    completeOperation = () => ledger.complete(key, id)
  }
  if (started !== generation) throw new DOMException('会话已改变', 'AbortError')
  const controller = new AbortController()
  const signal = init?.signal ?? request?.signal
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })
  pending.add(controller)
  try {
    const response = await fetch(input, { ...authRequestInit(context, input, init), signal: controller.signal })
    if (started !== generation) throw new DOMException('会话已改变', 'AbortError')
    if (response.status === 401 && context.user) {
      clearAuthContext()
      for (const listener of expiredListeners) listener()
    }
    if (response.ok) responseGenerations.set(response, started)
    if (completeOperation) responseOperations.set(response, completeOperation)
    return response
  } finally {
    pending.delete(controller)
    signal?.removeEventListener('abort', abort)
  }
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}
/** Called only after the caller has consumed and validated the business result. */
export function completeOwnerOperation(response: Response): void {
  const started = responseGenerations.get(response)
  if (started !== undefined && started !== generation) throw new DOMException('会话已改变', 'AbortError')
  if (response.ok) { responseOperations.get(response)?.(); responseOperations.delete(response) }
}
export async function responseText(response: Response): Promise<string> {
  const text = await response.text()
  if (!response.ok) {
    let reason = text || `请求失败（${response.status}）`
    try { reason = JSON.parse(text).error || reason } catch { /* Preserve non-JSON errors. */ }
    throw new ApiError(response.status, reason)
  }
  completeOwnerOperation(response)
  return text
}
export async function responseJson<T>(response: Response): Promise<T> {
  let data: { ok?: boolean; error?: string }
  try { data = await response.json() }
  catch { throw new ApiError(response.status, '服务器返回了无法读取的响应') }
  const started = responseGenerations.get(response)
  if (started !== undefined && started !== generation) throw new DOMException('会话已改变', 'AbortError')
  if (!data || typeof data !== 'object') throw new ApiError(response.status, '服务器响应缺少有效数据')
  if (!response.ok || data?.ok === false) throw new ApiError(response.status, data?.error || `请求失败（${response.status}）`)
  if (responseOperations.has(response) && data.ok !== true) throw new ApiError(response.status, '服务器未确认操作成功，请核对后重试')
  completeOwnerOperation(response)
  return data as T
}
export async function apiJson<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const data = await responseJson<T>(await authFetch(path, {
    credentials: 'same-origin', signal, cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Request': '1' }, body: JSON.stringify(body) }),
  }))
  if (body !== undefined && (data as { ok?: boolean }).ok !== true) throw new ApiError(200, '服务器未确认操作成功，请刷新核对')
  return data
}
