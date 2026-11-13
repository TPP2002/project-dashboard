import { authFetch } from '../collaboration/http'

export type RemoteStatus = 'connecting' | 'online' | 'offline'
export type RemoteRange = '60s' | '10m' | '24h'
export interface RemoteHostSpec { hostname: string; os: string; kernel: string; virt: string | null; cpuModel: string; sockets: number; physicalCores: number; logicalCores: number; memTotalMb: number; swapTotalMb: number; bootAt: string; cache: { l1d: string | null; l1i: string | null; l2: string | null; l3: string | null } }
export interface RemoteMemory { usedMb: number; availMb: number; cachedMb: number; freeMb: number; swapUsedMb: number; commitMb: number; commitLimitMb: number }
export interface RemoteDisk { readBps: number; writeBps: number; busyPct: number; latencyMs: number }
export interface RemoteNet { rxBps: number; txBps: number }
export interface RemoteSecondPoint { t: number; cpu: number; iowait: number; steal: number; cores: number[]; busyCores: number; mhz: number | null; load: number[]; mem: RemoteMemory; disk: RemoteDisk; disks: { name: string; readBps: number; writeBps: number; busyPct: number }[]; net: RemoteNet; nets: { name: string; rxBps: number; txBps: number }[]; procs: number; threads: number; uptimeSec: number; src: string }
export interface RemoteMinutePoint { t: number; cpu: number; cpuMax: number; busyCores: number; iowait: number; steal: number; mem: Pick<RemoteMemory, 'usedMb' | 'availMb'>; disk: Omit<RemoteDisk, 'latencyMs'>; net: RemoteNet; load: number[]; samples: number }
export type RemotePoint = RemoteSecondPoint | RemoteMinutePoint
export interface RemoteTask { id: string; kind: 'job' | 'service' | 'system'; label: string; command: string; cwd: string | null; user: string; unit: string; rootPid: number; startedAt: string | null; pids: number; threads: number; cpuPct: number; cores: number; rssMb: number; top: { pid: number; name: string; cpuPct: number; rssMb: number }[] }
export interface RemoteProcess { pid: number; ppid: number; name: string; user: string; state: string; cpuPct: number; rssMb: number; threads: number; startedAt: string | null; command: string; taskId: string | null }
export interface RemoteFs { mount: string; device: string; fsType: string; totalMb: number; usedMb: number; availMb: number }
export interface RemoteHost { name: string; label: string; status: RemoteStatus; target: string; ageMs: number | null; stale: boolean; error: string | null; notice: { code: string; message: string; at: string } | null; agentVersion: string | null; daemon: unknown; host: RemoteHostSpec | null; latest: RemoteSecondPoint | null; capacity: { logicalCores: number; busyCores: number; freeCores: number; cpuPct: number; memTotalMb: number; memUsedMb: number; memAvailMb: number } | null; spark: { stepMs: number; cpu: number[]; mem: number[] }; tasks: RemoteTask[]; taskCount: number; totals: { processes: number; threads: number } | null; procsAt: string | null; disk: Pick<RemoteFs, 'mount' | 'totalMb' | 'usedMb' | 'availMb'> | null }
export interface RemoteHostsResponse { ok: boolean; disabled?: boolean; configError: string | null; hosts: RemoteHost[] }
export interface RemotePerfResponse { ok: boolean; name: string; range: RemoteRange; resolution: '1s' | '1m'; points: RemotePoint[]; host: RemoteHostSpec | null; latest: RemoteSecondPoint | null; status: RemoteStatus; stale: boolean }
export interface RemoteProcessesResponse { ok: boolean; name: string; at: string; totals: { processes: number; threads: number }; tasks: RemoteTask[]; processes: RemoteProcess[]; omitted: number; fs: RemoteFs[] }
export function remoteHostsPath(name?: string, kind?: 'perf' | 'processes', range?: RemoteRange): string {
  let path = '/api/sched/remote-hosts'
  if (name !== undefined) path += `/${encodeURIComponent(name)}`
  if (kind) path += `/${kind}`
  if (range) path += `?range=${range}`
  return path
}
async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await authFetch(path, { signal })
  const value = await response.json()
  if (!response.ok || value.ok === false) throw new Error(value.error || '调度请求失败')
  return value as T
}
export const fetchRemoteHosts = (signal?: AbortSignal) => request<RemoteHostsResponse>(remoteHostsPath(), signal)
export const fetchRemotePerf = (name: string, range: RemoteRange, signal?: AbortSignal) => request<RemotePerfResponse>(remoteHostsPath(name, 'perf', range), signal)
export const fetchRemoteProcesses = (name: string, signal?: AbortSignal) => request<RemoteProcessesResponse>(remoteHostsPath(name, 'processes'), signal)
