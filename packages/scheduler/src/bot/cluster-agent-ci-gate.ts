import deployment from '../sched/client/deployment-config.cjs'
import {
  execFile, execFileSync, type ExecFileException, type ExecFileOptionsWithStringEncoding,
  type ExecFileSyncOptionsWithStringEncoding,
} from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type CiProbeExecutor = (
  command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding,
) => string

export interface CiActivityProbeResult {
  ciWorkers: number
  /** 失败仍按 0 放行,但不能将「探不到」误报为「确认没有」。 */
  failed: boolean
  /**
   * 正在跑的 Worker 对应的 runner 名,去重排序。**只在 `ciWorkers > 0` 且归属全部确认时给出**;
   * `undefined` = 认不出或零 Worker(零 Worker 不带该字段:观察器对 idle 同样不带名字,空数组没有任何读方),
   * 派单员按整机余量保守处理。
   */
  runners?: string[]
}

export type CiActivityProbe = () => CiActivityProbeResult

export interface CiActivityProbeOptions {
  platform?: NodeJS.Platform
  execFileSync?: CiProbeExecutor
  onWarning?: (message: string) => void
}

/** 无匹配提示会本地化;只认精确 CSV 首列,Listener 常驻不代表正在跑 job。 */
export function parseTasklistCsv(stdout: string): number {
  return stdout.split(/\r?\n/).filter(line => line.startsWith('"Runner.Worker.exe",')).length
}

/** 一次性 CI 工位的槽根。第 2 步 ciJitSlot 在这下面建槽;本模块据此排除受管的 Worker。 */
export const CI_JIT_SLOT_ROOT: string = deployment.getDeploymentConfig().ci.jitSlotRoot ?? ''

/** 反斜杠转正斜杠、不分大小写,path 以「root + /」开头为真;空串为假。root 缺省 CI_JIT_SLOT_ROOT。 */
export function isManagedJitWorkerPath(path: string, root: string = CI_JIT_SLOT_ROOT): boolean {
  if (path.length === 0 || root.length === 0) return false
  const base = root.replace(/\\/g, '/').toLowerCase()
  const prefix = base.endsWith('/') ? base : `${base}/`
  return path.replace(/\\/g, '/').toLowerCase().startsWith(prefix)
}

/** tasklist CSV:只认首列精确为 "Runner.Worker.exe" 的行,取第二列 pid(正整数),其余行忽略。 */
export function parseTasklistPids(stdout: string): number[] {
  const pids: number[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('"Runner.Worker.exe",')) continue
    const rest = line.slice('"Runner.Worker.exe",'.length)
    const stop = rest.indexOf(',')
    const cell = (stop === -1 ? rest : rest.slice(0, stop)).trim()
    if (!/^"\d+"$/.test(cell)) continue
    const pid = Number(cell.slice(1, -1))
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid)
  }
  return pids
}

/** 查「正在跑的 Worker 可执行路径」的端口;返回 undefined = 查不到(绝不当成「没有」)。 */
export type CiWorkerPathProbe = () => Promise<string[] | undefined>

/**
 * 每个 runner 各自装在独立目录,`<runner目录>\bin\Runner.Worker.exe` 上两级就是 runner 目录,
 * 里面的 `.runner`(JSON)的 `agentName` 才是 runner 名——目录名**不许写死**。
 */
const WORKER_PATH_SCRIPT =
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Runner.Worker.exe' } | Select-Object -ExpandProperty ExecutablePath"

function readUtf8File(path: string): string { return readFileSync(path, 'utf8') }

/** `<runner目录>\bin\Runner.Worker.exe` → 上两级目录 → 读 `.runner` 的 agentName(带 BOM 的 UTF-8)。 */
export function runnerNameFromWorkerPath(
  path: string, readFile: (path: string) => string = readUtf8File,
): string | undefined {
  try {
    // `.runner` 是带 BOM 的 UTF-8:解析前按码点去掉首个 U+FEFF。
    const raw = readFile(join(dirname(dirname(path)), '.runner'))
    const text = raw.codePointAt(0) === 0xFEFF ? raw.slice(1) : raw
    const name = (JSON.parse(text) as { agentName?: unknown } | null)?.agentName
    return typeof name === 'string' && name.length > 0 ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * 路径数必须与 Worker 个数相等,且去重后仍相等才认;任何一条读不出名字、数目对不上,
 * 都整组判「认不出」——漏报一个 runner 就会少留核,宁可退回等价于否决的整机余量。
 */
export function runnerNamesFromWorkerPaths(
  paths: readonly string[] | undefined, ciWorkers: number,
  readFile: (path: string) => string = readUtf8File,
): string[] | undefined {
  if (paths === undefined || paths.length !== ciWorkers) return undefined
  const names: string[] = []
  for (const path of paths) {
    const name = runnerNameFromWorkerPath(path, readFile)
    if (name === undefined) return undefined
    names.push(name)
  }
  const unique = [...new Set(names)].sort()
  return unique.length === ciWorkers ? unique : undefined
}

/**
 * 仅在准备领单时调用。探测最多等 10 秒,异常 fail-open;同类连续失败仅回调一次,
 * 成功(含 pgrep 退出码 1)重置警告状态。执行器可注入,不经过 shell/PowerShell。
 */
export function createCiActivityProbe(options: CiActivityProbeOptions = {}): CiActivityProbe {
  const platform = options.platform ?? process.platform
  const execute: CiProbeExecutor = options.execFileSync ?? execFileSync
  let previousFailure: string | undefined

  return () => {
    let ciWorkers: number
    try {
      const stdout = execute(
        platform === 'win32' ? 'tasklist' : 'pgrep',
        platform === 'win32'
          ? ['/FI', 'IMAGENAME eq Runner.Worker.exe', '/FO', 'CSV', '/NH']
          : ['-x', 'Runner.Worker'],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: 'pipe' },
      )
      ciWorkers = platform === 'win32'
        ? parseTasklistCsv(stdout)
        : stdout.split(/\r?\n/).filter(line => /^\d+$/.test(line.trim())).length
    } catch (error) {
      const failure = error as { code?: string; status?: number; signal?: string } | null | undefined
      if (platform !== 'win32' && failure?.status === 1 && !failure.code && !failure.signal) {
        previousFailure = undefined
        return { ciWorkers: 0, failed: false }
      }
      const message = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ')
      // execFileSync 的 message 含 PID/本地化输出,同类错误按稳定 code/退出码限频。
      const signature = failure?.code
        ?? (failure?.signal ? `signal:${failure.signal}` : undefined)
        ?? (failure?.status != null ? `exit:${failure.status}` : message)
      if (signature !== previousFailure) {
        previousFailure = signature
        options.onWarning?.(`⚠ 本机 CI 探测失败,按 0 个 CI 照常领单:${message}`)
      }
      return { ciWorkers: 0, failed: true }
    }
    previousFailure = undefined
    return { ciWorkers, failed: false }
  }
}

export type AsyncCiProbeExecutor = (
  command: string, args: string[], options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void

export interface AsyncCiActivityProbeOptions {
  platform?: NodeJS.Platform
  execFile?: AsyncCiProbeExecutor
  /**
   * 查「正在跑的 Worker 可执行路径」的端口;缺省 = 认不出名字(runners 一律 undefined)。
   * 生产由 cluster-agent.ts 注入 Windows 实现,测试注入桩,热循环本身不起子进程。
   */
  listWorkerPaths?: CiWorkerPathProbe
  /** 槽根存在时用它查 pid 与路径;缺省 createWindowsWorkerProcessProbe({ platform, execFile })。 */
  listWorkerProcesses?: CiWorkerProcessProbe
  /**
   * 槽根是否存在。缺省:platform 为 win32、且调用方没有注入 execFile、且 CI_JIT_SLOT_ROOT.length > 0 && existsSync(CI_JIT_SLOT_ROOT)。
   * 注入了 execFile 的调用方(测试)缺省视为不存在,免得执行机上真实的 <configured slot root> 改变既有用例。
   */
  jitSlotRootExists?: () => boolean
}

/**
 * 作业期观察专用：不阻塞续租，十秒超时或执行失败均按 failed 放行，不经 shell。
 *
 * 名字只在 `ciWorkers` **相对上一拍变化**、或「上一拍认不出( runners===undefined 且
 * ciWorkers>0 )」时查一次(tasklist 不给路径,得另起一次 CIM 查询),其余拍复用上一拍的结果。
 * 认不出就下一拍重查(T4B-1 顺手补):CIM/读盘偶尔失败不该把整段 CI 都锁死在「认不出」,
 * 那会让派单员整段按整机余量保守留核——重查仍只在这个条件下起进程,不进无条件热循环;
 * 查成过一次(或零 Worker)就不再查。读不出名字一律 undefined,零 Worker 也一律不带该字段
 * (「确认没有」由 ciWorkers=0 本身表达,空数组没有任何读方)。
 */
export function createAsyncCiActivityProbe(
  options: AsyncCiActivityProbeOptions = {},
): () => Promise<CiActivityProbeResult> {
  const platform = options.platform ?? process.platform
  const execute: AsyncCiProbeExecutor = options.execFile ?? execFile
  // 槽根门控(CI-RUNNER-JIT-TAKEOVER-0924):注入了执行器的调用方(测试)缺省视为不存在,
  // 不读真实文件系统;生产(挂号端发行件)按本机是否存在 <configured slot root> 判定。
  const jitSlotRootExists = options.jitSlotRootExists
    ?? (options.execFile === undefined
      ? () => platform === 'win32' && CI_JIT_SLOT_ROOT.length > 0 && existsSync(CI_JIT_SLOT_ROOT)
      : () => false)
  let previousWorkers: number | undefined
  let runners: string[] | undefined
  // 槽根分支自己的状态;原逻辑的 previousWorkers/runners 在该分支里不读不写。
  let jitBranchLastRound = false
  let jitKnownPids: ReadonlySet<number> = new Set()
  let jitLastKey: string | undefined
  let jitLastQueryOk = false
  let jitLastWorkers = 0
  let jitLastRunners: string[] | undefined
  return () => new Promise(resolve => {
    const failed = (): void => resolve({ ciWorkers: 0, failed: true })
    const settled = (ciWorkers: number): void => {
      // 零 Worker 不带字段(与观察器对 idle 的处理一致);只有个数大于零且归属确认才带名字。
      resolve({ ciWorkers, failed: false, ...(ciWorkers === 0 || runners === undefined ? {} : { runners }) })
    }
    const settledFromSlot = (ciWorkers: number, names: string[] | undefined): void => {
      resolve({ ciWorkers, failed: false, ...(ciWorkers === 0 || names === undefined ? {} : { runners: names }) })
    }
    try {
      execute(
        platform === 'win32' ? 'tasklist' : 'pgrep',
        platform === 'win32'
          ? ['/FI', 'IMAGENAME eq Runner.Worker.exe', '/FO', 'CSV', '/NH']
          : ['-x', 'Runner.Worker'],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true },
        (error, stdout) => {
          try {
            if (error) {
              if (platform !== 'win32' && error.code === 1 && !error.killed && !error.signal) {
                // pgrep 退出码 1 = 确认没有匹配:零 Worker 照规矩不带名字。
                previousWorkers = 0
                settled(0)
              } else failed()
              return
            }
            if (platform === 'win32' && jitSlotRootExists()) {
              // 槽根分支:tasklist 只给 pid,路径另查一次 CIM;只有「确认路径在槽根下」的才排除,
              // 认不出的(查询结果里没有的、路径读空的、查询失败后不知情的)一律按常驻 CI 计。
              jitBranchLastRound = true
              const pids = parseTasklistPids(stdout)
              const key = [...pids].sort((a, b) => a - b).join(',')
              if (jitLastQueryOk && jitLastKey === key) {
                settledFromSlot(jitLastWorkers, jitLastRunners)
                return
              }
              jitLastKey = key
              const recallFailure = (): void => {
                // 失败拍:已确认的一次性 pid 只保留还活着的,其余按常驻计;下一拍一定重查。
                jitKnownPids = new Set([...jitKnownPids].filter(pid => pids.includes(pid)))
                jitLastQueryOk = false
                jitLastWorkers = 0
                jitLastRunners = undefined
                settledFromSlot(pids.filter(pid => !jitKnownPids.has(pid)).length, undefined)
              }
              const listProcesses = options.listWorkerProcesses
                ?? createWindowsWorkerProcessProbe({ platform, execFile: execute })
              void listProcesses().then(results => {
                if (results === undefined) { recallFailure(); return }
                const slot = new Set<number>()
                const pathByPid = new Map<number, string>()
                for (const item of results) {
                  if (!pids.includes(item.pid)) continue
                  if (isManagedJitWorkerPath(item.path)) slot.add(item.pid)
                  else if (item.path.length > 0) pathByPid.set(item.pid, item.path)
                }
                const resident = pids.filter(pid => !slot.has(pid))
                const residentPaths = resident.flatMap(pid => {
                  const path = pathByPid.get(pid)
                  return path === undefined ? [] : [path]
                })
                const names = runnerNamesFromWorkerPaths(residentPaths, resident.length)
                jitKnownPids = slot
                jitLastQueryOk = true
                jitLastWorkers = resident.length
                jitLastRunners = names
                settledFromSlot(resident.length, names)
              }, recallFailure)
              return
            }
            // 槽根分支之外:清空该分支状态;若上一拍走的槽根分支,强制原逻辑重查一次名字。
            if (jitBranchLastRound) {
              previousWorkers = undefined
              runners = undefined
              jitBranchLastRound = false
            }
            jitKnownPids = new Set(); jitLastKey = undefined; jitLastQueryOk = false
            jitLastWorkers = 0; jitLastRunners = undefined
            const ciWorkers = platform === 'win32'
              ? parseTasklistCsv(stdout)
              : stdout.split(/\r?\n/).filter(line => /^\d+$/.test(line.trim())).length
            // 个数没变且上一拍已认出(或零 Worker)⇒ 复用;认不出且仍有 Worker ⇒ 下一拍重查。
            if (ciWorkers !== previousWorkers || (runners === undefined && ciWorkers > 0)) {
              previousWorkers = ciWorkers
              const list = options.listWorkerPaths
              if (list === undefined) {
                runners = undefined
                settled(ciWorkers)
                return
              }
              void list().then(
                paths => { runners = runnerNamesFromWorkerPaths(paths, ciWorkers) },
                () => { runners = undefined },
              ).then(() => settled(ciWorkers))
              return
            }
            settled(ciWorkers)
          } catch { failed() }
        },
      )
    } catch { failed() }
  })
}

/**
 * Windows 专用:异步起 PowerShell 按 CIM 取路径,十秒超时;非 win32、超时或读失败一律 undefined。
 * 参数里一个双引号都不用(单引号字符串是字面量,少一层转义就少一处变形),只走 execFile 不经 shell。
 */
export function createWindowsWorkerPathProbe(options: {
  platform?: NodeJS.Platform
  execFile?: AsyncCiProbeExecutor
} = {}): CiWorkerPathProbe {
  const platform = options.platform ?? process.platform
  const execute: AsyncCiProbeExecutor = options.execFile ?? execFile
  return () => new Promise(resolve => {
    if (platform !== 'win32') { resolve(undefined); return }
    try {
      execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WORKER_PATH_SCRIPT],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true }, (error, stdout) => {
          if (error) { resolve(undefined); return }
          try {
            resolve(stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0))
          } catch { resolve(undefined) }
        })
    } catch { resolve(undefined) }
  })
}

export interface CiWorkerProcess { pid: number; path: string }

/** 返回 undefined = 查不到(绝不当成「没有」)。 */
export type CiWorkerProcessProbe = () => Promise<CiWorkerProcess[] | undefined>

/** Windows 专用 CIM 脚本:一次查询同时带回 pid 与路径;整段不含双引号,只走 execFile 不经 shell。 */
const WORKER_PROCESS_SCRIPT =
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Runner.Worker.exe' } | ForEach-Object { [string]$_.ProcessId + '|' + [string]$_.ExecutablePath }"

/** Windows 专用:异步起 PowerShell 按 CIM 取 pid 与路径,十秒超时;非 win32、超时、出错一律 undefined。 */
export function createWindowsWorkerProcessProbe(options: {
  platform?: NodeJS.Platform
  execFile?: AsyncCiProbeExecutor
} = {}): CiWorkerProcessProbe {
  const platform = options.platform ?? process.platform
  const execute: AsyncCiProbeExecutor = options.execFile ?? execFile
  return () => new Promise(resolve => {
    if (platform !== 'win32') { resolve(undefined); return }
    try {
      execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WORKER_PROCESS_SCRIPT],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true }, (error, stdout) => {
          if (error) { resolve(undefined); return }
          try {
            const found: CiWorkerProcess[] = []
            for (const line of stdout.split(/\r?\n/)) {
              const text = line.trim()
              if (text.length === 0) continue
              const cut = text.indexOf('|')
              if (cut === -1) continue
              const pid = Number(text.slice(0, cut))
              if (!Number.isSafeInteger(pid) || pid <= 0) continue
              found.push({ pid, path: text.slice(cut + 1) })
            }
            resolve(found)
          } catch { resolve(undefined) }
        })
    } catch { resolve(undefined) }
  })
}

/** 空闲循环领单前,一次 CI 探测最多等这么久(墙钟);到点按「探不到」放行,与探测失败同一口径。 */
export const CI_PROBE_WALL_CAP_MS = 15_000

/** 主循环的探针端口:测试可注入同步桩,生产用 createBoundedCiActivityProbe。 */
export type LoopCiProbe = () => CiActivityProbeResult | Promise<CiActivityProbeResult>

export interface BoundedCiActivityProbeOptions extends AsyncCiActivityProbeOptions {
  capMs?: number
  onWarning?: (message: string) => void
}

/**
 * 空闲循环领单前用的 CI 探测(CLUSTER-OWNER-LEASE-EXPIRY-ROOT-CAUSE,2026-09-11 现场)。
 *
 * 原先在主循环里同步起 tasklist、限时 10 秒。主机满载那天它把整个代理冻住 37.5 秒 ——
 * 限时没兜住,满载下子进程连被杀掉都要排队;续租跟着断档,随后对齐代码时租约过期,代理崩溃。
 * 现在:异步起进程,事件循环不停;墙钟最多等 capMs,到点按「探不到」放行;
 * 上一次还没回来就不再起新进程,满载时探测进程不会越堆越多,直接共用那一次的结果。
 * 同类警告只记一行;探测恢复正常后重置,下次再出事照样提醒。
 */
export function createBoundedCiActivityProbe(
  options: BoundedCiActivityProbeOptions = {},
): () => Promise<CiActivityProbeResult> {
  const probe = createAsyncCiActivityProbe(options)
  const capMs = options.capMs ?? CI_PROBE_WALL_CAP_MS
  let inFlight: Promise<CiActivityProbeResult> | undefined
  let lastWarning: 'cap' | 'failed' | undefined
  const warn = (kind: 'cap' | 'failed', message: string): void => {
    if (lastWarning === kind) return
    lastWarning = kind
    options.onWarning?.(message)
  }
  const startProbe = (): Promise<CiActivityProbeResult> => {
    const started = probe()
    inFlight = started
    void started.then(() => { if (inFlight === started) inFlight = undefined })
    return started
  }
  return async () => {
    const current = inFlight ?? startProbe()
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), capMs) })
    try {
      const outcome = await Promise.race([current, capped])
      if (outcome === undefined) {
        warn('cap', `⚠ 本机 CI 探测 ${Math.round(capMs / 1000)} 秒没回来(机器多半满载),按 0 个 CI 照常领单;那个探测进程留着自己结束,不再叠加新的`)
        return { ciWorkers: 0, failed: true }
      }
      if (outcome.failed) warn('failed', '⚠ 本机 CI 探测失败,按 0 个 CI 照常领单')
      else lastWarning = undefined
      return outcome
    } finally {
      clearTimeout(timer)
    }
  }
}

export type CiYieldState =
  | { yieldingToCi: false }
  | { yieldingToCi: true; yieldingSince: string }

export interface CiYieldDecision {
  yieldNow: boolean
  state: CiYieldState
  logLines: string[]
  heartbeat: { yieldingToCi?: true; ciWorkers?: number; yieldingSince?: string }
}

export const CI_YIELD_CAP_MS = 20 * 60_000

/**
 * now 为调用方提供的毫秒时间戳;空信箱不读取 ciWorkers,日志仅在开始/结束让路时产生。
 * 满上限只放行本拍,清空状态使下一拍重新计时;capMs 可注入毫秒上限供测试使用。
 */
export function decideCiYield(input: {
  inboxHasJobs: boolean
  ciWorkers?: number
  previous?: CiYieldState
  capMs?: number
  now: number
}): CiYieldDecision {
  const previous: CiYieldState = input.previous ?? { yieldingToCi: false }
  if (input.inboxHasJobs && (input.ciWorkers ?? 0) > 0) {
    if (previous.yieldingToCi) {
      const elapsedMs = input.now - Date.parse(previous.yieldingSince)
      if (elapsedMs >= (input.capMs ?? CI_YIELD_CAP_MS)) {
        return {
          yieldNow: false,
          state: { yieldingToCi: false },
          logLines: [
            `⚠ 已连续给本机 CI 让路 ${Math.floor(elapsedMs / 60_000)} 分钟,达到 ${Math.floor((input.capMs ?? CI_YIELD_CAP_MS) / 60_000)} 分钟上限,本拍照常领单;本机仍有 ${input.ciWorkers} 个 CI job 在跑,作业结果里会注明`,
          ],
          heartbeat: {},
        }
      }
    }
    const yieldingSince = previous.yieldingToCi ? previous.yieldingSince : new Date(input.now).toISOString()
    return {
      yieldNow: true,
      state: { yieldingToCi: true, yieldingSince },
      logLines: previous.yieldingToCi ? [] : [
        `本机当前有 ${input.ciWorkers} 个 CI job 在跑,让路:信箱里的工单排队,等 CI 跑完再领`,
      ],
      heartbeat: { yieldingToCi: true, ciWorkers: input.ciWorkers, yieldingSince },
    }
  }
  const logLines = previous.yieldingToCi
    ? [`已让路 ${Math.max(0, Math.floor((input.now - Date.parse(previous.yieldingSince)) / 1000))} 秒,恢复领单`]
    : []
  return { yieldNow: false, state: { yieldingToCi: false }, logLines, heartbeat: {} }
}
