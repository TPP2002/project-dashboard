/**
 * 本机许可的只读归属证据。只在包装器/消费者调用，派单员不探进程、不起子进程。
 * Windows 出生身份沿用挂起层的 creationFileTime（UTC FILETIME 十进制字符串，不转 JS Number）；
 * POSIX 保留原生出生钟 createdAt。身份缺失、复用、断链或超过 128 跳均拒绝，不返回半截祖先链。
 * 这里只核验许可归属；挂起/恢复仍完全由作业对象完成，不用祖先链寻找受控成员。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { AttemptController } from './sched-contract'
import { authorityPermitProcesses } from './sched-permit-authority'

export const PERMIT_ANCESTOR_LIMIT = 128
export interface PermitProcess {
  pid: number; ppid: number; command: string
  creationFileTime?: string; createdAt?: string
}
type Birth = Pick<AttemptController, 'creationFileTime' | 'createdAt'>
type Controller = Birth & Pick<AttemptController, 'pid' | 'verifier'>
type ReadProcess = (pid: number) => PermitProcess | undefined

function birth(value: Birth): { identity: string; clock: string; order: bigint } {
  if (typeof value.creationFileTime === 'string' && value.createdAt === undefined
    && /^[1-9]\d*$/.test(value.creationFileTime)) {
    return { identity: value.creationFileTime, clock: 'filetime', order: BigInt(value.creationFileTime) }
  }
  if (value.creationFileTime === undefined && typeof value.createdAt === 'string') {
    const match = /^(linux:[0-9a-f-]+|posix):(\d+)$/.exec(value.createdAt)
    if (match) return { identity: value.createdAt, clock: match[1]!, order: BigInt(match[2]!) }
  }
  throw new Error('[sched] 许可进程创建时间不可读')
}
function same(left: PermitProcess, right: PermitProcess): boolean {
  return left.pid === right.pid && left.ppid === right.ppid && left.command === right.command
    && birth(left).identity === birth(right).identity && birth(left).clock === birth(right).clock
}
function requireProcess(read: ReadProcess, pid: number): PermitProcess {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('[sched] 许可祖先链已到顶')
  const row = read(pid)
  if (!row || row.pid !== pid || !Number.isSafeInteger(row.ppid) || row.ppid < 0 || typeof row.command !== 'string') {
    throw new Error('[sched] 许可祖先身份不可读')
  }
  birth(row)
  return row
}

/** 每条父子边核对出生先后及两端稳定身份，最后再核对完整链；包装器须匹配开跑时落盘的出生身份。 */
export function verifyPermitAncestry(read: ReadProcess, currentPid: number, controller: Controller): PermitProcess[] {
  const expected = birth(controller), rows = [requireProcess(read, currentPid)], seen = new Set([currentPid])
  for (let hops = 0; hops <= PERMIT_ANCESTOR_LIMIT; hops++) {
    const child = rows[rows.length - 1]!
    if (child.pid === controller.pid) {
      if (birth(child).identity !== expected.identity || birth(child).clock !== expected.clock) throw new Error('[sched] 包装器进程号已复用')
      for (const row of rows) if (!same(row, requireProcess(read, row.pid))) throw new Error('[sched] 许可祖先身份在核对期间变化')
      return rows.slice(1)
    }
    if (hops === PERMIT_ANCESTOR_LIMIT) throw new Error('[sched] 许可祖先链超过 128 跳')
    if (seen.has(child.ppid)) throw new Error('[sched] 许可祖先链成环')
    const parent = requireProcess(read, child.ppid), parentBirth = birth(parent), childBirth = birth(child)
    if (parentBirth.clock !== childBirth.clock || parentBirth.order > childBirth.order) throw new Error('[sched] 父进程创建时间晚于子进程，拒绝号码复用')
    if (!same(child, requireProcess(read, child.pid))) throw new Error('[sched] 许可子进程身份在核对期间变化')
    rows.push(parent); seen.add(parent.pid)
  }
  throw new Error('[sched] 许可祖先链未确认')
}

function powershell(script: string): unknown {
  const prelude = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);"
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(prelude + script, 'utf16le').toString('base64')],
  { encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 4 * 1024 * 1024 }))
}

/**
 * 首份 CIM 父号表仅用于定位；只对链上成员读取原始 FILETIME，再用第二份 CIM 核对父号/命令行，
 * 最后重新打开每个成员核对 FILETIME。两个身份读数包围第二份快照，禁止拼接号码复用前后的证据。
 * StartTime.ToFileTimeUtc 保留 GetProcessTimes 精度，不使用 CIM CreationDate 的微秒截断值。
 * 整次查询限 3 秒，须在 T5 的 3.5 秒读许可时限内返回明确拒绝；两份快照是核对步骤，不是重试。
 */
function windowsProcesses(controllerPid: number): ReadProcess {
  if (!Number.isSafeInteger(controllerPid) || controllerPid < 1) throw new Error('[sched] 包装器进程号非法')
  const value = powershell(`
$table = @{}
foreach ($item in @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId -ErrorAction Stop)) { $table[[int]$item.ProcessId] = $item }
$rows = New-Object 'System.Collections.Generic.List[object]'
$seen = @{}
$cursor = ${process.pid}
$found = $false
for ($hop = 0; $hop -le ${PERMIT_ANCESTOR_LIMIT}; $hop++) {
  if ($cursor -le 0 -or $seen.ContainsKey($cursor)) { throw 'Permit ancestor root/cycle' }
  if (!$table.ContainsKey($cursor)) { throw 'Permit ancestor missing' }
  $item = [Diagnostics.Process]::GetProcessById($cursor)
  try {
    if ($item.HasExited) { throw 'Permit ancestor exited' }
    $rows.Add(@{ pid = $cursor; ppid = [int]$table[$cursor].ParentProcessId; creationFileTime = $item.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() })
  } finally { $item.Dispose() }
  if ($cursor -eq ${controllerPid}) { $found = $true; break }
  $seen[$cursor] = $true
  $cursor = [int]$table[$cursor].ParentProcessId
}
if (!$found) { throw 'Permit ancestor limit' }
$filter = ($rows | ForEach-Object { 'ProcessId = ' + $_.pid }) -join ' OR '
$table = @{}
foreach ($item in @(Get-CimInstance Win32_Process -Filter $filter -Property ProcessId,ParentProcessId,CommandLine -ErrorAction Stop)) { $table[[int]$item.ProcessId] = $item }
foreach ($row in $rows) {
  if (!$table.ContainsKey($row.pid) -or [int]$table[$row.pid].ParentProcessId -ne $row.ppid) { throw 'Permit ancestor missing/changed' }
  $item = [Diagnostics.Process]::GetProcessById($row.pid)
  try {
    if ($item.HasExited -or $item.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $row.creationFileTime) { throw 'Permit ancestor identity changed' }
  } finally { $item.Dispose() }
  $row['command'] = [string]$table[$row.pid].CommandLine
}
ConvertTo-Json -InputObject @($rows.ToArray()) -Compress
`)
  if (!Array.isArray(value)) throw new Error('[sched] 许可进程表非法')
  const rows = value as PermitProcess[]
  return pid => rows.find(row => row.pid === pid)
}

function posixProcess(pid: number): PermitProcess {
  if (process.platform === 'linux') {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const read = (): PermitProcess => {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), values = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)
      if (!/^\d+$/.test(values[19] ?? '')) throw new Error('[sched] 许可进程出生 tick 不可读')
      return { pid, ppid: Number(values[1]), command: '', createdAt: `linux:${boot}:${values[19]}` }
    }
    const before = read(), command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '), after = read()
    if (!same(before, after)) throw new Error('[sched] 许可进程身份在读取命令行期间变化')
    return { ...after, command }
  }
  const raw = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,lstart=,args='],
    { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, windowsHide: true })
  const match = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(raw.trim())
  if (!match) throw new Error('[sched] 许可进程创建时间不可读')
  const start = Date.parse(match[3]! + ' UTC')
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('[sched] 许可进程创建时间非法')
  return { pid: Number(match[1]), ppid: Number(match[2]), command: match[4]!, createdAt: `posix:${start}` }
}

/** 只在整组验收的 run 开跑回报前采集；旧记录由客户端按旧契约过渡，本模块绝不倒填出生身份。 */
export function capturePermitController(): Birth {
  if (process.platform === 'win32') {
    const value = powershell(`$item=[Diagnostics.Process]::GetProcessById(${process.pid});try {
      @{creationFileTime=$item.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()} | ConvertTo-Json -Compress
    } finally {$item.Dispose()}`) as Birth
    birth(value)
    return value
  }
  const row = posixProcess(process.pid)
  birth(row)
  return { createdAt: row.createdAt! }
}

export function acceptancePermitAncestors(controller: Controller): PermitProcess[] {
  birth(controller)
  if (process.platform === 'win32' && controller.verifier) {
    const rows = authorityPermitProcesses(controller)
    return verifyPermitAncestry(pid => rows.find(row => row.pid === pid), process.pid, controller)
  }
  return verifyPermitAncestry(process.platform === 'win32' ? windowsProcesses(controller.pid) : posixProcess, process.pid, controller)
}
