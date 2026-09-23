/** 只读进程身份探针。PID 会复用，不能用“这个编号仍存在”推断旧监工仍在跑。 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { REPO_ROOT } from './codex-paths'
import type { JobState } from './codex-runner'

export interface ProcessIdentity {
  pid: number
  startedAt: string
  commandLine: string | null
  executablePath?: string | null
}
export type SupervisorLiveness = 'running' | 'exited' | 'reused' | 'unknown' | 'finished'

const validPid = (pid: unknown): pid is number => Number.isSafeInteger(pid) && (pid as number) > 0
const scriptPath = join(REPO_ROOT, 'scripts', 'codex', 'codex-dispatch.ts')
const normalized = (value: string): string => value.replace(/\\/g, '/').toLowerCase()
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const argumentPair = (command: string, flag: string, value: string): boolean =>
  new RegExp(`(?:^|\\s)["']?${escaped(flag)}["']?\\s+["']?${escaped(value)}["']?(?:\\s|$)`, 'i').test(command)

/** 一次查所有未完成工单的 PID，避免 status 列表每行都冷启动一次 PowerShell。null = 探针故障。 */
export function inspectProcesses(pids: number[]): Map<number, ProcessIdentity> | null {
  const unique = [...new Set(pids.filter(validPid))]
  if (!unique.length) return new Map()
  if (process.platform === 'win32') {
    const filter = unique.map(pid => `ProcessId = ${pid}`).join(' OR ')
    const script = `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { ` +
      `[pscustomobject]@{ pid=[int]$_.ProcessId; startedAt=$_.CreationDate.ToUniversalTime().ToString('o'); commandLine=$_.CommandLine; executablePath=$_.ExecutablePath } }); ` +
      `ConvertTo-Json -InputObject $rows -Compress`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
    })
    if (result.status !== 0 || result.error) return null
    try {
      const rows: unknown = JSON.parse(result.stdout.trim())
      if (!Array.isArray(rows)) return null
      const found = new Map<number, ProcessIdentity>()
      for (const row of rows) {
        if (!row || typeof row !== 'object') return null
        const item = row as Partial<ProcessIdentity>
        if (!validPid(item.pid) || typeof item.startedAt !== 'string'
          || !(item.commandLine === null || typeof item.commandLine === 'string')
          || !(item.executablePath === null || typeof item.executablePath === 'string')) return null
        found.set(item.pid, item as ProcessIdentity)
      }
      return found
    } catch { return null }
  }

  const result = spawnSync('ps', ['-p', unique.join(','), '-o', 'pid=', '-o', 'lstart=', '-o', 'args='], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
  })
  if (result.error || (result.status !== 0 && !(result.status === 1 && !result.stdout.trim()))) return null
  const found = new Map<number, ProcessIdentity>()
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const match = /^\s*(\d+)\s+(.{24})\s+(.+)$/.exec(line)
    if (!match) return null
    found.set(Number(match[1]), { pid: Number(match[1]), startedAt: match[2], commandLine: match[3] })
  }
  return found
}

/** undefined = 探针失败；null = PID 不存在。旧单靠脚本/slug/启动时间，新单另核一次性令牌。 */
export function supervisorLiveness(state: JobState | null, slug: string,
  observed: ProcessIdentity | null | undefined): SupervisorLiveness {
  if (state?.finishedAt) return 'finished'
  if (!validPid(state?.pid)) return 'exited'
  if (observed === undefined) return 'unknown'
  if (observed === null) return 'exited'
  if (observed.pid !== state.pid) return 'reused'
  if (observed.executablePath && !/\/(?:node|node\.exe)$/i.test(normalized(observed.executablePath))) return 'reused'
  if (typeof observed.commandLine !== 'string' || !observed.commandLine) return 'unknown'
  const started = Date.parse(state.startedAt), actual = Date.parse(observed.startedAt)
  if (!Number.isFinite(started) || !Number.isFinite(actual)) return 'unknown'
  // state.startedAt 在 spawn 返回后立即写；旧单没有 OS 创建时刻，容忍两侧时钟/写盘小抖动。
  if (Math.abs(actual - started) > 10_000) return 'reused'
  const command = normalized(observed.commandLine)
  if (!command.includes(normalized(scriptPath)) || !argumentPair(command, '_supervise', slug)) return 'reused'
  if (state.identityToken && !argumentPair(command, '--identity', state.identityToken)) return 'reused'
  return 'running'
}
