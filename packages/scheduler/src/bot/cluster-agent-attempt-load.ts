import { execFile as nodeExecFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { readFile as nodeReadFile } from 'node:fs/promises'
import { join } from 'node:path'
import { READING_FRESHNESS_MS, schedPaths, validateAttemptBeat } from '../sched/sched-contract'

export const ATTEMPT_LOAD_INTERVAL_MS = 10_000
export const ATTEMPT_LOAD_TIMEOUT_MS = 8_000
const WINDOW_MS = READING_FRESHNESS_MS
const BEAT_SCAN_MS = 60_000
const MAX_BEAT_BYTES = 64 * 1024

export interface AgentAttemptLoad {
  schema: 1
  sampledAt: string
  windowSec: 30
  attempts: { ticketId: string; attemptId: string; cores: number }[]
}
export interface AgentCiTreeLoad { schema: 1; sampledAt: string; windowSec: 30; cores: number; workers: number }
export interface ProcessCpuRow {
  pid: number; parentPid: number; createdAt: string; kernel100ns: number; user100ns: number; name?: string
}
export interface ProcessSnapshot {
  qpc: number; frequency: number; wallAt: string; processes: readonly ProcessCpuRow[]
}
export interface AttemptRoot { key: string; pid: number; notAfter: string }

/** 两份同机进程快照按最近在管根划分树;上一拍之后出生的后代按自创建以来的累计 CPU 计入。
 * 返回 undefined 表示该根本段尚无可用基线。 */
export function calculateAttemptTreeCores(
  before: ProcessSnapshot | undefined, after: ProcessSnapshot, roots: readonly AttemptRoot[],
): Readonly<Record<string, number | undefined>> {
  const result: Record<string, number | undefined> = {}
  const current = new Map(after.processes.map(row => [row.pid, row]))
  const previous = new Map(before?.processes.map(row => [row.pid, row]) ?? [])
  const rootPids = new Set(roots.map(root => root.pid))
  const elapsed = before && after.frequency > 0 && before.frequency === after.frequency
    ? (after.qpc - before.qpc) / after.frequency : 0
  // 窗口起点取上一拍的墙钟时刻;采样脚本先枚举进程后取墙钟,恰在枚举与墙钟之间出生的按旧账处理(宁可少记)。
  const windowStartAt = before ? Date.parse(before.wallAt) : Number.POSITIVE_INFINITY
  const children = new Map<number, ProcessCpuRow[]>()
  for (const row of after.processes) {
    const parent = current.get(row.parentPid)
    if (!parent || Date.parse(row.createdAt) < Date.parse(parent.createdAt)) continue
    const list = children.get(row.parentPid) ?? []
    list.push(row); children.set(row.parentPid, list)
  }
  for (const root of roots) {
    const row = current.get(root.pid)
    if (!row || Date.parse(row.createdAt) > Date.parse(root.notAfter) + 2_000
      || !before || elapsed <= 0 || !Number.isFinite(elapsed)
      || previous.get(root.pid)?.createdAt !== row.createdAt) { result[root.key] = undefined; continue }
    let cores = 0
    const pending = [row]
    const seen = new Set<number>()
    while (pending.length) {
      const item = pending.pop()!
      if (seen.has(item.pid)) continue
      seen.add(item.pid)
      if (item.pid !== root.pid && rootPids.has(item.pid)) continue
      const old = previous.get(item.pid)
      if (old?.createdAt === item.createdAt) {
        const delta = item.kernel100ns + item.user100ns - old.kernel100ns - old.user100ns
        if (Number.isFinite(delta) && delta >= 0) cores += delta / 10_000_000 / elapsed
      } else if (Date.parse(item.createdAt) > windowStartAt) {
        // 上一拍之后才出生的后代上一拍必然采不到：按自创建以来的累计 CPU 计入本段，窗口中途
        // 新生的长命子进程与生灭之间恰被本拍逮到的短命子进程都由此记上；更早出生、只是上轮
        // 漏采的仅立基线，不追认旧账（在管实测只增不减）。生灭都落在两次采样之间的短命子进程
        // 进程快照里没有，仍记不到，归作业对象累计口径（见本卡施工记录待定点）。
        const total = item.kernel100ns + item.user100ns
        if (Number.isFinite(total) && total >= 0) cores += total / 10_000_000 / elapsed
      }
      pending.push(...(children.get(item.pid) ?? []))
    }
    result[root.key] = cores
  }
  return result
}

/**
 * 沿父链往上找受管根。判据与 calculateAttemptTreeCores 的父子判据同源:
 * 子进程 createdAt 早于父进程的视为 pid 复用,链在此断开。最多 maxDepth 层,遇环即停。
 */
export function hasManagedAncestor(row: ProcessCpuRow, byPid: ReadonlyMap<number, ProcessCpuRow>,
  managedPids: ReadonlySet<number>, maxDepth = 32): boolean {
  const seen = new Set<number>([row.pid])
  let child = row
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const parent = byPid.get(child.parentPid)
    if (parent === undefined || Date.parse(child.createdAt) < Date.parse(parent.createdAt)) return false
    if (managedPids.has(parent.pid)) return true
    if (seen.has(parent.pid)) return false
    seen.add(parent.pid)
    child = parent
  }
  return false
}

export type AttemptLoadExecutor = (command: string, args: string[], options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => void
interface DirectoryEntry { name: string; modifiedAt: string; length: number }
interface ProbeOutput extends ProcessSnapshot { files: DirectoryEntry[] }

/** 单次目录枚举随目录项带回修改时间；与 Win32_Process 共用一个 PowerShell 冷启动。脚本无双引号。
 *
 * 逐任务采样 metadata 预裁(AD-20261017-ATTEMPTLOAD-METADATA-PREFILTER):共享 beats 目录会累积大量陈旧历史心跳,
 * 全量 files 的 JSON 可超过 execFile 默认 stdout buffer(Node 24 为 1 MiB),整次采样随即失败。
 * 因此在 $wall 已生成之后、ConvertTo-Json 之前,按下方 JS guard 的同一判据把 files 精确预裁:
 * |wall−modifiedAt| 先各自截到毫秒(DateTimeOffset.ToUnixTimeMilliseconds,与 JS Date.parse 对七位小数的截断同口径,
 * 不比较带 100ns 余数的 TotalMilliseconds)后 ≤ BEAT_SCAN_MS,且 length ≤ MAX_BEAT_BYTES。
 * 保留的目录项字段、顺序、0/1/多项数组形状与 wallAt/qpc/frequency/processes 都与预裁前一致;
 * 被裁掉的项在下方 JS guard 里本来也会被 continue。JS 侧 guard、身份/归属/PID-birth 校验与全部预算、buffer、隐藏窗口均不动。 */
const SNAPSHOT_SCRIPT = [
  '$ErrorActionPreference = \'Stop\'',
  '$dir = $env:SCHED_BEATS_DIR',
  '$files = @(Get-ChildItem -LiteralPath $dir -Filter \'*.json\' -File -ErrorAction Stop | ForEach-Object { [ordered]@{ name=$_.Name; modifiedAt=$_.LastWriteTimeUtc.ToString(\'o\'); length=[int64]$_.Length } })',
  '$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object { [ordered]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; createdAt=$_.CreationDate.ToUniversalTime().ToString(\'o\'); kernel100ns=[double]$_.KernelModeTime; user100ns=[double]$_.UserModeTime; name=[string]$_.Name } })',
  '$tick = [System.Diagnostics.Stopwatch]::GetTimestamp()',
  '$frequency = [System.Diagnostics.Stopwatch]::Frequency',
  '$wall = [DateTime]::UtcNow.ToString(\'o\')',
  '$wallMs = [System.DateTimeOffset]::Parse($wall, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal).ToUnixTimeMilliseconds()',
  `$files = @(foreach ($f in $files) { if ($f['length'] -le ${MAX_BEAT_BYTES} -and [Math]::Abs($wallMs - [System.DateTimeOffset]::Parse($f['modifiedAt'], [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal).ToUnixTimeMilliseconds()) -le ${BEAT_SCAN_MS}) { $f } })`,
  '[ordered]@{ qpc=$tick; frequency=$frequency; wallAt=$wall; files=$files; processes=$rows } | ConvertTo-Json -Compress -Depth 5',
].join(';')

function parseProbe(raw: string): ProbeOutput {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object') throw new Error('采样输出不是对象')
  const item = value as Record<string, unknown>
  if (!Number.isFinite(item.qpc) || !Number.isFinite(item.frequency) || (item.frequency as number) <= 0
    || typeof item.wallAt !== 'string' || !Number.isFinite(Date.parse(item.wallAt))
    || !Array.isArray(item.files) || !Array.isArray(item.processes)) throw new Error('采样输出形状不合法')
  for (const file of item.files) {
    if (!file || typeof file.name !== 'string' || typeof file.modifiedAt !== 'string'
      || !Number.isFinite(Date.parse(file.modifiedAt)) || !Number.isSafeInteger(file.length) || file.length < 0) throw new Error('目录项不合法')
  }
  for (const row of item.processes) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid < 1 || !Number.isSafeInteger(row.parentPid)
      || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
      || !Number.isFinite(row.kernel100ns) || row.kernel100ns < 0
      || !Number.isFinite(row.user100ns) || row.user100ns < 0) throw new Error('进程快照不合法')
    if (typeof row.name !== 'string' || row.name.length > 260) delete row.name
  }
  return item as unknown as ProbeOutput
}

export function createAgentAttemptLoadSampler(options: {
  share: string; machine: string; intervalMs?: number; timeoutMs?: number; platform?: NodeJS.Platform;
  execFile?: AttemptLoadExecutor; readFile?: (path: string) => Promise<string | Uint8Array>;
  now?: () => number; monotonicNow?: () => number
}): { start(): void; stop(): void; read(): AgentAttemptLoad | undefined; readCiTree(): AgentCiTreeLoad | undefined } {
  const platform = options.platform ?? process.platform
  const intervalMs = options.intervalMs ?? ATTEMPT_LOAD_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? ATTEMPT_LOAD_TIMEOUT_MS
  const execute: AttemptLoadExecutor = options.execFile ?? nodeExecFile
  const now = options.now ?? (() => new Date().getTime())
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const beats = schedPaths(options.share).beats
  let timer: ReturnType<typeof setInterval> | undefined
  let activeAbort: AbortController | undefined
  let busy = false
  let stopped = true
  let previous: ProcessSnapshot | undefined
  let lastSuccessfulMono: number | undefined
  let latest: AgentAttemptLoad | undefined
  let latestCiTree: AgentCiTreeLoad | undefined
  const rootBirth = new Map<string, string>()
  const rejected = new Set<string>()
  const intervals = new Map<string, { start: number; end: number; cores: number }[]>()

  const fail = (): void => { previous = undefined; latest = undefined; latestCiTree = undefined; lastSuccessfulMono = undefined; intervals.clear() }
  const probe = (signal: AbortSignal): Promise<ProbeOutput> => new Promise((resolve, reject) => {
    try {
      execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SNAPSHOT_SCRIPT],
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, signal, env: { ...process.env, SCHED_BEATS_DIR: beats } },
        (error, stdout) => { try { if (error) reject(error); else resolve(parseProbe(stdout)) } catch (parseError) { reject(parseError) } })
    } catch (error) { reject(error) }
  })
  const round = async (): Promise<void> => {
    if (busy || stopped || platform !== 'win32') return
    busy = true
    const abort = new AbortController()
    activeAbort = abort
    let timeout: ReturnType<typeof setTimeout> | undefined
    let workDone = false
    let timedOut = false
    try {
      const work = (async () => {
        const snapshot = await probe(abort.signal)
        const roots: AttemptRoot[] = []
        const seenPids = new Map<number, string[]>()
        for (const file of snapshot.files) {
          if (!file.name.endsWith('.json') || file.length > MAX_BEAT_BYTES
            || Math.abs(Date.parse(snapshot.wallAt) - Date.parse(file.modifiedAt)) > BEAT_SCAN_MS) continue
          try {
            const raw = await (options.readFile ?? ((path: string) => nodeReadFile(path, { signal: abort.signal })))(join(beats, file.name))
            if (raw.length > MAX_BEAT_BYTES) continue
            const beat = validateAttemptBeat(JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')))
            if (file.name !== `${beat.ticketId}--${beat.attemptId}.json` || beat.machine !== options.machine
              || beat.childPid === undefined || Math.abs(Date.parse(snapshot.wallAt) - Date.parse(beat.at)) > WINDOW_MS) continue
            const key = `${beat.ticketId}--${beat.attemptId}`
            roots.push({ key, pid: beat.childPid, notAfter: beat.at })
            seenPids.set(beat.childPid, [...(seenPids.get(beat.childPid) ?? []), key])
          } catch { /* 只有这一张执行心跳测不到 */ }
        }
        const valid = roots.filter(root => seenPids.get(root.pid)?.length === 1)
        const current: ProcessSnapshot = { qpc: snapshot.qpc, frequency: snapshot.frequency,
          wallAt: snapshot.wallAt, processes: snapshot.processes }
        return { current, valid }
      })()
      void work.then(() => { workDone = true; if (timedOut) busy = false }, () => { workDone = true; if (timedOut) busy = false })
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { abort.abort(); reject(new Error('采样超时')) }, timeoutMs)
        timeout.unref()
      })
      const { current, valid } = await Promise.race([work, deadline])
      if (stopped) return
      const byPid = new Map(current.processes.map(row => [row.pid, row]))
      for (const root of valid) {
        if (rejected.has(root.key)) continue
        const birth = byPid.get(root.pid)?.createdAt
        if (!birth) continue
        if (Date.parse(birth) > Date.parse(root.notAfter) + 2_000
          || (rootBirth.has(root.key) && rootBirth.get(root.key) !== birth)) rejected.add(root.key)
        else rootBirth.set(root.key, birth)
      }
      const distinct = valid.filter(root => !rejected.has(root.key))
      const managedPids = new Set(distinct.map(root => root.pid))
      const ciRoots: AttemptRoot[] = current.processes.filter(row => row.name?.toLowerCase() === 'runner.worker.exe'
        && !managedPids.has(row.pid) && !hasManagedAncestor(row, byPid, managedPids))
        .map(row => ({ key: `ci:${row.pid}:${row.createdAt}`, pid: row.pid, notAfter: current.wallAt }))
      const allRoots = [...distinct, ...ciRoots]
      const calculated = calculateAttemptTreeCores(previous, current, allRoots)
      const live = new Set(allRoots.map(root => root.key))
      for (const key of intervals.keys()) if (!live.has(key)) intervals.delete(key)
      for (const root of allRoots) {
        const cores = calculated[root.key]
        if (cores === undefined || previous === undefined) continue
        const entries = intervals.get(root.key) ?? []
        entries.push({ start: previous.qpc / previous.frequency * 1000, end: current.qpc / current.frequency * 1000, cores })
        const edge = current.qpc / current.frequency * 1000 - WINDOW_MS
        intervals.set(root.key, entries.filter(entry => entry.end > edge))
      }
      previous = current
      lastSuccessfulMono = monotonicNow()
      const attempts: AgentAttemptLoad['attempts'] = []
      const latestEnd = current.qpc / current.frequency * 1000
      for (const root of distinct) {
        if (calculated[root.key] === undefined) continue
        const entries = intervals.get(root.key) ?? []
        let sum = 0; let weight = 0
        for (const entry of entries) {
          const span = Math.max(0, Math.min(entry.end, latestEnd) - Math.max(entry.start, latestEnd - WINDOW_MS))
          sum += entry.cores * span; weight += span
        }
        if (weight === 0) continue
        const [ticketId, attemptId] = root.key.split('--')
        attempts.push({ ticketId: ticketId!, attemptId: attemptId!, cores: Math.round(sum / weight * 10) / 10 })
      }
      attempts.sort((a, b) => a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1
        : a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0)
      const sampledAt = new Date(now()).toISOString()
      latest = { schema: 1, sampledAt, windowSec: 30, attempts: attempts.slice(0, 64) }
      let ciCores = 0
      for (const root of ciRoots) {
        if (calculated[root.key] === undefined) continue
        const entries = intervals.get(root.key) ?? []
        let sum = 0; let weight = 0
        for (const entry of entries) {
          const span = Math.max(0, Math.min(entry.end, latestEnd) - Math.max(entry.start, latestEnd - WINDOW_MS))
          sum += entry.cores * span; weight += span
        }
        if (weight > 0) ciCores += sum / weight
      }
      latestCiTree = { schema: 1, sampledAt, windowSec: 30, cores: Math.round(ciCores * 10) / 10,
        workers: Math.min(64, ciRoots.length) }
    } catch { fail() } finally {
      clearTimeout(timeout)
      if (activeAbort === abort) activeAbort = undefined
      if (workDone) busy = false; else timedOut = true
    }
  }

  return {
    start(): void {
      if (platform !== 'win32' || timer !== undefined) return
      stopped = false; fail(); rootBirth.clear(); rejected.clear()
      void round().catch(fail)
      timer = setInterval(() => { void round().catch(fail) }, intervalMs)
      timer.unref()
    },
    stop(): void { stopped = true; clearInterval(timer); timer = undefined; activeAbort?.abort(); fail() },
    read(): AgentAttemptLoad | undefined {
      if (platform !== 'win32' || stopped || lastSuccessfulMono === undefined
        || monotonicNow() - lastSuccessfulMono > WINDOW_MS) return undefined
      return latest
    },
    readCiTree(): AgentCiTreeLoad | undefined {
      if (platform !== 'win32' || stopped || lastSuccessfulMono === undefined
        || monotonicNow() - lastSuccessfulMono > WINDOW_MS) return undefined
      return latestCiTree
    },
  }
}
