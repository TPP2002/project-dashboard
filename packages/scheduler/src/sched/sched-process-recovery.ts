/** 执行机侧的旧树确认端口。派单员不调用本模块；T3 探测根 PID，根不在即判终止；根仍在且记录带出生时刻时再读一次进程表核出生时刻（只在此时起一次 PowerShell/读 /proc），PID 已被出生时刻不同的进程占用即判复用、旧树已终止。 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { hasCode } from '../bot/cluster-lifecycle-contract'

export interface ExecutionProcess { pid: number; createdAt: string }
export interface ProcessReading extends ExecutionProcess { parentPid: number }
export interface RecoveryPorts {
  /** false 只表示根进程不存在；权限不足或未知故障必须抛出，不能冒充不存在。 */
  rootExists?: (pid: number) => boolean
  /** 缺省用本文件的 readExecutionProcesses；只在根 PID 存在且记录带出生时刻时才调用。 */
  readProcesses?: () => ProcessReading[]
  log?: (line: string) => void
}

/** 创建时刻原样保留 OS 精度；Linux 用本次启动标识 + 内核出生 tick，避免 PID 复用。 */
export function readExecutionProcesses(): ProcessReading[] {
  if (process.platform === 'win32') {
    const script = '@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object {'
      + '$born=if ($null -eq $_.CreationDate) { "" } else { $_.CreationDate.ToUniversalTime().ToString("o") };'
      + '[ordered]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;createdAt=$born}'
      + '}) | ConvertTo-Json -Compress'
    const rows: unknown = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
    }))
    if (!Array.isArray(rows)) throw new Error('进程表不是数组')
    return rows.map(row => {
      if (!row || !Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.parentPid)
        || typeof row.createdAt !== 'string') throw new Error('进程出生身份不可读')
      return row as ProcessReading
    })
  }
  if (process.platform === 'linux') {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const rows: ProcessReading[] = []
    for (const name of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        const raw = readFileSync(`/proc/${name}/stat`, 'utf8')
        const values = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/)
        if (!values[19]) throw new Error('进程出生 tick 不可读')
        rows.push({ pid: Number(name), parentPid: Number(values[1]), createdAt: `${boot}:${values[19]}` })
      } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
    }
    return rows
  }
  const raw = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart='], {
    encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' }, windowsHide: true,
  })
  return raw.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!match) throw new Error('进程出生身份不可读')
    return { pid: Number(match[1]), parentPid: Number(match[2]), createdAt: match[3]!.trim() }
  })
}

/** 领单时登记树根（代理），作业及其后代都从这个根产生；没有身份不伪造一个。 */
export function captureExecutionProcess(): ExecutionProcess {
  const row = readExecutionProcesses().find(row => row.pid === process.pid)
  if (!row?.createdAt) throw new Error('当前代理出生身份不可读')
  return { pid: row.pid, createdAt: row.createdAt }
}

function rootProcessExists(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { if (hasCode(error, 'ESRCH')) return false; throw error }
}

/**
 * T3 启动恢复判据（0912 Windows 实测勘定）：记录的根是旧代理，作业及其子进程同属作业对象，
 * 根退出时系统结束整组，因此根 PID 不存在即可按判据②确认终止。完整执行树身份证据（判据①）
 * 和脱钩后代归 T4；不在这里重新枚举、杀树或等待。根 PID 仍在时不直接按③收场：记录带出生
 * 时刻就再读一次进程表（起一次 PowerShell/读 /proc，只在根 PID 存在时发生）逐字核对出生
 * 时刻——不同即 PID 已被别的进程复用、原根已退出，按②判旧树已终止；一致按③跳过。
 * 记录没带出生时刻（老记录）按③跳过；读表失败、表里已没有这个 PID 或出生时刻读不到按④
 * 跳过。跳过类判据都只保留这一张 running，调用方必须继续主循环，下一拍再查。
 * 原生零信号探测不发信号、不起子进程；只有 ESRCH 才能被解释成「不存在」。
 */
export async function confirmExecutionTreeStopped(identity: unknown, ports: RecoveryPorts = {}): Promise<boolean> {
  if (!identity || typeof identity !== 'object' || !('pid' in identity)
    || !Number.isSafeInteger(identity.pid) || (identity.pid as number) < 1) {
    ports.log?.('旧执行恢复判据④：缺有效根 PID，保持 running，本拍跳过')
    return false
  }
  const pid = identity.pid as number
  let exists: boolean
  try {
    exists = (ports.rootExists ?? rootProcessExists)(pid)
  } catch (error) {
    ports.log?.(`旧执行恢复判据④：根 PID ${pid} 探测失败，保持 running，本拍跳过:${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  if (!exists) {
    ports.log?.(`旧执行恢复判据②：根 PID ${pid} 不存在，按作业对象同组退出判定旧树已终止`)
    return true
  }
  const recordedAt = (identity as { createdAt?: unknown }).createdAt
  if (typeof recordedAt !== 'string' || recordedAt === '') {
    ports.log?.(`旧执行恢复判据③：根 PID ${pid} 仍存在（旧代理存活或 PID 复用），保持 running，本拍跳过`)
    return false
  }
  let rows: ProcessReading[]
  try {
    rows = (ports.readProcesses ?? readExecutionProcesses)()
  } catch (error) {
    ports.log?.(`旧执行恢复判据④：根 PID ${pid} 出生时刻核对失败，保持 running，本拍跳过:${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  const row = rows.find(row => row.pid === pid)
  if (!row) {
    ports.log?.(`旧执行恢复判据④：根 PID ${pid} 探测仍在但进程表里查无此 PID，出生时刻核对不了，保持 running，本拍跳过`)
    return false
  }
  if (row.createdAt === '') {
    ports.log?.(`旧执行恢复判据④：根 PID ${pid} 的进程出生时刻读不到，无法核对是否 PID 复用，保持 running，本拍跳过`)
    return false
  }
  if (row.createdAt === recordedAt) {
    ports.log?.(pid === process.pid
      ? `旧执行恢复判据③：根 PID ${pid} 是本代理进程自身（出生时刻一致），保持 running，本拍跳过`
      : `旧执行恢复判据③：根 PID ${pid} 仍存在且出生时刻一致（旧代理存活），保持 running，本拍跳过`)
    return false
  }
  ports.log?.(`旧执行恢复判据②：根 PID ${pid} 已被出生时刻不同的进程占用（PID 复用；记录 ${recordedAt}，现 ${row.createdAt}），按根已退出、作业对象同组退出判定旧树已终止`)
  return true
}
