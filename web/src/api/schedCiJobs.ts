/** 独立只读窗口；失败由机器卡保留旧拍，不进入调度快照的整页错误通道。所有时长单位为毫秒。 */
export interface CiJob {
  repository?: string; updatedAt?: string | null; staleSince?: string | null
  id: number; workflow: string; job: string; title: string; branch: string; cardTitle: string | null
  runner: string | null; machine: string | null; project: string | null; startedAt: string | null
  elapsedMs: number | null; expectedMs: number | null; remainingMs: number | null
}
export interface CiMachineJobs { machine: string | null; jobs: CiJob[] }
export interface CiRepositoryStatus { repository: string; updatedAt: string | null; staleSince: string | null }
export interface CiJobsData {
  machines: CiMachineJobs[]; updatedAt: string | null; staleSince: string | null; error?: string
  repositories?: CiRepositoryStatus[]
}
export type CiJobsSnapshot = CiJobsData | { unavailable: string }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nullableText = (value: unknown) => value === null || typeof value === 'string'
const nullableTime = (value: unknown) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
const nullableMs = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value))
function validJob(value: unknown, machine: unknown): boolean {
  if (!record(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0 || value.machine !== machine) return false
  return ['workflow', 'job', 'title', 'branch'].every(key => typeof value[key] === 'string')
    && ['cardTitle', 'runner', 'machine', 'project'].every(key => nullableText(value[key])) && nullableTime(value.startedAt)
    && ['elapsedMs', 'expectedMs'].every(key => nullableMs(value[key]) && (value[key] === null || (value[key] as number) >= 0))
    && nullableMs(value.remainingMs)
    && (value.repository === undefined || typeof value.repository === 'string')
    && ['updatedAt', 'staleSince'].every(key => value[key] === undefined || nullableTime(value[key]))
}
export function isCiJobsSnapshot(value: unknown): value is CiJobsSnapshot {
  if (!record(value)) return false
  if ('unavailable' in value) return typeof value.unavailable === 'string' && value.unavailable.length > 0
  return nullableTime(value.updatedAt) && nullableTime(value.staleSince) && (value.error === undefined || typeof value.error === 'string')
    && (value.repositories === undefined || (Array.isArray(value.repositories) && value.repositories.every(item => record(item)
      && typeof item.repository === 'string' && nullableTime(item.updatedAt) && nullableTime(item.staleSince))))
    && Array.isArray(value.machines) && value.machines.every(group => record(group) && nullableText(group.machine)
      && Array.isArray(group.jobs) && group.jobs.every(job => validJob(job, group.machine)))
}
export async function fetchCiJobs(signal?: AbortSignal): Promise<CiJobsSnapshot> {
  const response = await fetch('/api/sched/ci-jobs', { signal, cache: 'no-store' })
  const value: unknown = await response.json()
  if (!response.ok || !isCiJobsSnapshot(value)) throw new Error('暂时读不到检查作业')
  return value
}
