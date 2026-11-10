import { authFetch } from '@/collaboration/http'

/**
 * 账号与额度页只经 /api/resources 两个端点取数、写操作。
 * 服务端读成功会删掉账号里的 home 与 keyFile,所以这里不声明这两个字段 ——
 * 页面从头到尾拿不到密钥文件路径,也就不可能把它显示或回传出去。
 */
export type LoginStatus = 'ok' | 'broken' | 'unknown'
export type QuotaSource = 'api' | 'estimate' | 'unknown'

export interface ResourceLogin {
  status: LoginStatus
  checkedAt: string | null
  reason: string | null
}
export interface ResourceQuota {
  remaining: number | null
  unit: string
  usedPercent: number | null
  resetAt: string | null
  readAt: string
  source: QuotaSource
}
export interface ResourceLimit {
  model: string
  until: string
  kind: string
  source: string
  reason: string
}
export interface ResourceAccount {
  id: string
  provider: string
  providerName: string
  label: string
  enabled: boolean
  login: ResourceLogin | null
  quota: ResourceQuota | null
  limits: ResourceLimit[] | null
  lastUsedAt: string | null
  running: number | null
}
export interface ResourceGate {
  open: boolean | null
  reason: string | null
  reopensAt?: string | null
}
export interface ResourceProvider {
  provider: string
  providerName: string
  accountCount: number
  enabledCount: number
  gate: ResourceGate | null
}
export interface ResourceLadderCell {
  provider: string
  model: string
}
export interface ResourceLadders {
  light: ResourceLadderCell[]
  standard: ResourceLadderCell[]
  hard: ResourceLadderCell[]
}
export interface ResourceSnapshot {
  formatVersion: number
  generatedAt: string
  accounts: ResourceAccount[]
  providers: ResourceProvider[]
  ladders: ResourceLadders
}

export type ResourceActionName = 'add' | 'login' | 'enable' | 'disable' | 'remove' | 'refresh' | 'clear-limit'
export interface ResourceAction {
  action: ResourceActionName
  id?: string
  provider?: string
  label?: string
  keyFile?: string
  model?: string
}
export interface ResourceActionResult {
  ok: boolean
  code?: number
  lastLine?: string
  pending?: boolean
  error?: string
}

/** 某账号一行的操作状态,供纯展示组件读取,不存任何账号数据。 */
export interface ResourceRowState {
  busy: string | null
  line: string
  error: boolean
  notice: boolean
}
/** 某平台分组头下方的提示条状态。 */
export interface ResourceGroupState {
  busy: boolean
  line: string
  error: boolean
  notice: boolean
}

/** 读列表:非 ok 抛 Error,用响应里的 error,没有就写「读取失败」。 */
export async function fetchResources(signal?: AbortSignal): Promise<ResourceSnapshot> {
  const res = await authFetch('/api/resources', { signal })
  let body: { ok?: boolean; data?: ResourceSnapshot; error?: string } | null = null
  try { body = await res.json() } catch { /* 下面按读取失败处理 */ }
  if (!res.ok || !body || body.ok === false) {
    throw new Error(body?.error || '读取失败')
  }
  return body.data as ResourceSnapshot
}

/** 写操作:一律不抛,HTTP 失败也转成 ok:false 加 error。 */
export async function postResourceAction(body: ResourceAction): Promise<ResourceActionResult> {
  try {
    const res = await authFetch('/api/resources/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let parsed: ResourceActionResult | null = null
    try { parsed = await res.json() } catch { /* 下面按操作失败处理 */ }
    if (!res.ok) {
      return { ok: false, error: parsed?.error || '操作失败' }
    }
    if (!parsed) return { ok: false, error: '操作失败' }
    return {
      ok: parsed.ok !== false,
      code: parsed.code,
      lastLine: parsed.lastLine,
      pending: parsed.pending,
      error: parsed.error,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '操作失败' }
  }
}
