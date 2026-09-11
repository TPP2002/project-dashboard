import type { AuditionBatchResult, AuditionIndexResult, AuditionMutation, AuditionOperations, AuditionState } from '@/types/audition'
import { normalizeBatch } from '@/utils/audition/manifest'

const API = '/api/audition'
async function json<T>(response: Response): Promise<T> {
  const body = await response.json()
  if (!response.ok || body.ok !== true) throw new Error(typeof body.error === 'string' ? body.error : '试听台暂时无法读取，请稍后重试')
  return body as T
}
export const auditionFileUrl = (project: string, path: string) => `${API}/file?${new URLSearchParams({ project, path })}`
export async function fetchAuditionIndex(project: string): Promise<AuditionIndexResult> {
  return json(await fetch(`${API}/index?${new URLSearchParams({ project })}`))
}
export async function fetchAuditionBatch(project: string, key: string): Promise<AuditionBatchResult> {
  const result = await json<AuditionBatchResult>(await fetch(`${API}/batch?${new URLSearchParams({ project, key })}`))
  return { ...result, batch: normalizeBatch(result.batch) }
}
export async function fetchAuditionState(project: string, key: string): Promise<AuditionState> {
  return (await json<{ ok: boolean; state: AuditionState }>(await fetch(`${API}/state?${new URLSearchParams({ project, key })}`))).state
}
async function post<T>(action: string, project: string, key: string, body: object): Promise<T> {
  return json(await fetch(`${API}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, project, key }) }))
}
export function mutateAudition<K extends keyof AuditionOperations>(action: K, project: string, key: string, body: AuditionOperations[K]): Promise<AuditionMutation> {
  return post(action, project, key, body)
}
export function exportAudition(project: string, key: string): Promise<{ ok: boolean; path: string }> { return post('export', project, key, {}) }
