import type { RemoteHost, RemoteMemory, RemoteProcess, RemoteTask } from '@/api/remoteHosts'

export function cardConclusion(host: RemoteHost): { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted'; capacity: 'available' | 'full' | 'offline' } {
  if (host.status === 'online' && !host.stale) {
    if (!host.capacity) return { text: '已连上,等第一笔读数', tone: 'muted', capacity: 'offline' }
    const { freeCores, logicalCores, memAvailMb } = host.capacity
    if (freeCores == null || logicalCores == null || memAvailMb == null) return { text: '', tone: 'muted', capacity: 'offline' }
    const full = freeCores < 1 || freeCores < logicalCores * 0.125
    return { text: `${freeCores < 1 ? '已满载' : `空闲 ${freeCores} 核`} · 内存剩 ${fmtGb(memAvailMb)}`, tone: full ? 'warn' : 'ok', capacity: full ? 'full' : 'available' }
  }
  if (host.status === 'connecting' && !host.latest && !host.stale) return { text: '正在连接', tone: 'muted', capacity: 'offline' }
  return { text: '连不上,正在重连', tone: 'bad', capacity: 'offline' }
}
export function freshnessText(ageMs: number | null, stale: boolean): string {
  if (ageMs === null) return '还没收到数据'
  const time = ageMs < 60000 ? `${Math.max(1, Math.round(ageMs / 1000))} 秒` : `${Math.floor(ageMs / 60000)} 分钟`
  return stale ? `${time}没收到数据 · 数据过期` : `数据更新于 ${time}前`
}
export function offlineBannerText(ageMs: number | null, error: string | null): string {
  const time = freshnessText(ageMs, true).replace(' · 数据过期', '')
  return `${time},正在重连。${error ? `${error}。` : ''}下面是断线前的最后数据。`
}
export const fmtGb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`
export const fmtSize = (mb: number) => mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${Math.round(mb)} MB`
export const fmtRss = (mb: number) => mb >= 1024 ? fmtGb(mb) : `${Math.round(mb)} MB`
export const fmtRate = (bps: number) => bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`
export function runningFor(startedAt: string | null, now: number): string | null {
  if (startedAt === null) return null
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60000))
  if (minutes < 1) return '不到 1 分'
  if (minutes < 60) return `${minutes} 分`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
  return `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小时`
}
export function uptimeText(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds)), days = Math.floor(n / 86400), h = Math.floor(n % 86400 / 3600), m = Math.floor(n % 3600 / 60), s = n % 60
  return `${days ? `${days} 天 ` : ''}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
export function cacheText(value: string | null): string | null {
  if (value === null) return null
  const match = /^(\d+)K$/i.exec(value)
  if (!match) return value
  const n = Number(match[1]); return n >= 1024 && n % 1024 === 0 ? `${n / 1024} MB` : `${n} KB`
}
export function sparkPath(values: number[], w: number, h: number, max: number): string {
  if (!values.length) return ''
  const points = values.length === 1 ? [values[0]!, values[0]!] : values
  return points.map((v, i) => `${i ? 'L' : 'M'}${(i * w / (points.length - 1)).toFixed(2)},${(h - Math.max(0, Math.min(max, v)) / max * h).toFixed(2)}`).join(' ')
}
export function sparkArea(values: number[], w: number, h: number, max: number): string {
  const path = sparkPath(values, w, h, max); return path ? `M0.00,${h.toFixed(2)} L${path.slice(1)} L${w.toFixed(2)},${h.toFixed(2)} Z` : ''
}
export function mergePoints<T extends { t: number }>(existing: T[], incoming: T[], limit: number): T[] {
  const result = existing.slice(); let last = result.at(-1)?.t ?? -Infinity
  for (const point of incoming) if (point.t > last) { result.push(point); last = point.t }
  return result.slice(-limit)
}
export function memMix(mem: Pick<RemoteMemory, 'usedMb' | 'cachedMb'>, total: number) {
  if (total <= 0) return { usedPct: 0, cachePct: 0, freePct: 100 }
  const used = Math.max(0, Math.min(total, mem.usedMb)), cache = Math.max(0, Math.min(total - used, mem.cachedMb))
  return { usedPct: used / total * 100, cachePct: cache / total * 100, freePct: (total - used - cache) / total * 100 }
}
export function niceMax(values: number[], floor: number): number {
  const max = Math.max(floor, ...values); if (max <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(max)), unit = max / magnitude
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * magnitude
}
export function filterProcesses(list: RemoteProcess[], q: string): RemoteProcess[] {
  const query = q.trim().toLowerCase(); return query ? list.filter(p => [p.name, p.command, p.user, String(p.pid)].some(v => v.toLowerCase().includes(query))) : list
}
export function sortProcesses(list: RemoteProcess[], key: 'name' | 'pid' | 'cpuPct' | 'rssMb', dir: 'asc' | 'desc'): RemoteProcess[] {
  return [...list].sort((a, b) => (typeof a[key] === 'string' ? String(a[key]).localeCompare(String(b[key])) : Number(a[key]) - Number(b[key])) * (dir === 'asc' ? 1 : -1))
}
export function cardTaskMeta(task: RemoteTask, now: number): string {
  const duration = runningFor(task.startedAt, now); return `内存 ${fmtRss(task.rssMb)} · ${task.pids} 个进程${duration === null ? '' : ` · 已跑 ${duration}`}`
}
