import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  LIFECYCLE_NAMESPACE, LIFECYCLE_SCHEMA, canonicalLifecycleJson, errorMessage, hasCode,
  productionSources, requireAgentProtocol, requireInteger, requireIsoTime, requireRecord,
  requireSafeSegment, requireSha1, requireText, type LifecycleSources,
} from './cluster-lifecycle-contract'
import { sameValue, timeMs } from './cluster-lifecycle-lease'
import { ownerGuardPath, ownerLeasePath, pathExistsFailClosed, writeOwnerJsonExclusive } from './cluster-lifecycle-state'
import { publishLifecycleFileAtomically } from './cluster-lifecycle-atomic-file'
export { upgradeVerdict } from './cluster-agent-contract'
export type { UpgradeVerdict, UpgradeVerdictKind } from './cluster-agent-contract'

/**
 * CLUSTER-LEGACY-HANDOFF-OWNER-TORN-READ 写侧普查：
 * 已原子：cluster-lifecycle-state.writeOwnerJsonExclusive 的 guard 创建、candidate、audit（含 release）。
 * 本次补齐：本文件 ACTIVE 的 exclusive copy → 原子 create-only；poisoned 就地覆写 → 原子 replace；
 * poisoned 替换失败时改写 create-only 兜底告示 <machine>.guard.poisoned.json，替换与告示两样皆
 * 写不上抛硬错（不再只打日志；开锁/撬锁都先看告示，失败关闭）；
 * cluster-agent-runtime.beat 的心跳就地覆写 → 原子 replace（包含 beatBestEffort 收尾）。
 * cluster-agent-lifecycle 仅转调 owner/state API，生命周期状态发布也已走原子工具，无独立裸写。
 */

// owner 专用探针在使用处扩展共享 sources，原有只传 now/nonce 的调用方保持兼容。
declare module './cluster-lifecycle-contract' {
  interface LifecycleSources {
    isProcessAlive?: (pid: number) => boolean
    /** 进程「出生身份」探针(SCHED-HANDOFF-TEST-EEXIST-FLAKY):pid 撞活时核对占用者是否还是原来那个进程。
     * SCHED-OWNER-GUARD-PROBE-GONE-YIELD 起返回三态 ProcessBornProbeResult;旧的 string|undefined 注入写法仍兼容。 */
    processBornAt?: (pid: number) => ProcessBornProbeResult
    unlinkRenewedAudit?: (path: string) => void
    ownerAuditRetention?: number
    ownerAuditCheckLimit?: number
    ownerAuditDeleteLimit?: number
    unlinkOwnerAudit?: (path: string) => void
    /** 删除挂起退避用的同步等待;生产缺省 Atomics.wait,测试注入假实现(不真睡)。 */
    sleepMs?: (milliseconds: number) => void
  }
}

/** 旧纯判据的兼容输入；生产 agent 已改用下方持久 lease API。 */
export interface OwnerRecord { name?: string; pid?: number; host?: string; at?: string }
export type OwnerVerdictKind = 'empty' | 'stale' | 'self' | 'same-host' | 'cross-host'
export interface OwnerVerdict { claim: boolean; kind: OwnerVerdictKind; reason?: string }
export const OWNER_STALE_MS = 90_000
/** 成功领租后分批清理，每台机器每类最终保留 20 份；数量与单次处理上限可由 sources 注入。 */
export const OWNER_AUDIT_RETENTION = 20
export const OWNER_AUDIT_CHECK_LIMIT = 200
export const OWNER_AUDIT_DELETE_LIMIT = 200
// 正常 guard 持有期仅秒级；owner lease 为 90 秒，15 分钟 = 10 个 lease 周期，
// 远超正常持有期，不会误回收正常工作的持有者；此兜底防止 pid 被复用后永久误判活。
export const GUARD_STALE_MS = 900_000

/**
 * SMB 共享盘「删除挂起」退避参数(CLUSTER-OWNER-RENEW-DELETE-PENDING,2026-09-18):
 * Windows/SMB 上 `unlinkSync` 成功返回 ≠ 文件名已从目录消失——别的进程(主机派单员/`--status`/
 * 调度台)还开着句柄时,删除只是挂起,几百毫秒的窗口内对同名 create-only 发布报 EEXIST。
 * 250ms 起逐次翻倍、单次上限 4s、累计等待上限 20s(满序列 8 次重试共 19.75s),远小于 90s 的
 * owner lease(OWNER_STALE_MS),重试期间租约不会过期。预算按「累计已睡时长」判定,不读墙钟。
 */
export const OWNER_DELETE_PENDING_RETRY_BASE_MS = 250
export const OWNER_DELETE_PENDING_RETRY_SINGLE_CAP_MS = 4_000
export const OWNER_DELETE_PENDING_RETRY_BUDGET_MS = 20_000

export interface OwnerLeaseIdentity {
  name: string
  machine: string
  pid: number
  host: string
  protocol: number
  namespace: typeof LIFECYCLE_NAMESPACE
  lifecycleSchema: typeof LIFECYCLE_SCHEMA
  epoch: string
}
export interface OwnerLeaseRecord extends OwnerLeaseIdentity {
  state: 'ACTIVE'
  token: string
  head: string
  acquiredAt: string
  renewedAt: string
  expiresAt: string
  at: string
  leaseDurationMs: number
  revision: number
}
export interface OwnerLeaseHandle {
  ownersDir: string
  token: string
  identity: OwnerLeaseIdentity
  leaseDurationMs: number
}
export interface ClaimOwnerLeaseOptions {
  ownersDir: string
  identity: OwnerLeaseIdentity
  head: string
  leaseDurationMs?: number
  sources?: LifecycleSources
}

export class OwnerLeaseOccupiedError extends Error {}

function requireIdentity(value: unknown, label: string): OwnerLeaseIdentity {
  const raw = requireRecord(value, label)
  const identity = {
    name: requireSafeSegment(raw.name, `${label}.name`),
    machine: requireSafeSegment(raw.machine, `${label}.machine`),
    pid: requireInteger(raw.pid, `${label}.pid`),
    host: requireSafeSegment(raw.host, `${label}.host`),
    protocol: requireAgentProtocol(raw.protocol, `${label}.protocol`),
    namespace: requireText(raw.namespace, `${label}.namespace`),
    lifecycleSchema: requireInteger(raw.lifecycleSchema, `${label}.lifecycleSchema`),
    epoch: requireSafeSegment(raw.epoch, `${label}.epoch`),
  }
  if (identity.name !== identity.machine) throw new Error('[cluster-owner] owner name/machine 漂移')
  // 协议号已由 requireAgentProtocol 按下限判过(见 cluster-lifecycle-contract.ts);
  // 这里只留其余身份字段,别再逐字比数字,否则下次 bump 会让新代理拿不到 owner lease。
  if (identity.pid <= 0
    || identity.namespace !== LIFECYCLE_NAMESPACE || identity.lifecycleSchema !== LIFECYCLE_SCHEMA) {
    throw new Error('[cluster-owner] owner 身份字段非法')
  }
  return identity as OwnerLeaseIdentity
}
function requireLease(value: unknown, label: string): OwnerLeaseRecord {
  const raw = requireRecord(value, label)
  if (raw.state !== 'ACTIVE') throw new Error(`[cluster-owner] ${label}.state 必须为 ACTIVE`)
  const identity = requireIdentity(raw, label)
  const acquiredAt = requireIsoTime(raw.acquiredAt, `${label}.acquiredAt`)
  const renewedAt = requireIsoTime(raw.renewedAt, `${label}.renewedAt`)
  const expiresAt = requireIsoTime(raw.expiresAt, `${label}.expiresAt`)
  const leaseDurationMs = requireInteger(raw.leaseDurationMs, `${label}.leaseDurationMs`)
  const revision = requireInteger(raw.revision, `${label}.revision`)
  if (leaseDurationMs <= 0 || revision < 0
    || timeMs(renewedAt, 'owner renewedAt') < timeMs(acquiredAt, 'owner acquiredAt')
    || timeMs(expiresAt, 'owner expiresAt') - timeMs(renewedAt, 'owner renewedAt') !== leaseDurationMs
    || raw.at !== renewedAt) throw new Error(`[cluster-owner] ${label} 租期字段矛盾`)
  return {
    ...identity, state: 'ACTIVE', token: requireSafeSegment(raw.token, `${label}.token`),
    head: requireSha1(raw.head, `${label}.head`), acquiredAt, renewedAt, expiresAt, at: renewedAt,
    leaseDurationMs, revision,
  }
}
function readLease(path: string, optional = false): OwnerLeaseRecord | undefined {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch (error) {
    if (optional && hasCode(error, 'ENOENT')) return undefined
    throw new Error(`[cluster-owner] 读取 owner lease 失败:${path}:${errorMessage(error)}`, { cause: error })
  }
  try { return requireLease(JSON.parse(text), `owner lease ${path}`) } catch (error) {
    throw new Error(`[cluster-owner] owner lease 非法:${path}:${errorMessage(error)}`, { cause: error })
  }
}
function ownerCandidatePath(dir: string, machine: string): string {
  return join(dir, `${requireSafeSegment(machine, 'owner machine')}.candidate.json`)
}
function assertNoCandidate(dir: string, machine: string): void {
  const candidate = ownerCandidatePath(dir, machine)
  if (pathExistsFailClosed(candidate)) throw new Error(`[cluster-owner] owner 存在未完成 candidate:${candidate}`)
}
function assertNoLegacyCandidate(dir: string, machine: string): void {
  // 旧代理崩溃可能留下带 token/revision 的旧文件名；仅低频 claim 扫描，迁移窗口仍失败关闭。
  const prefix = `${requireSafeSegment(machine, 'owner machine')}.candidate.`
  let found: string[]
  try { found = readdirSync(dir).filter(name => name.startsWith(prefix) && name !== `${machine}.candidate.json`) } catch (error) {
    throw new Error(`[cluster-owner] 扫描 owner 暂存失败:${errorMessage(error)}`, { cause: error })
  }
  if (found.length !== 0) throw new Error(`[cluster-owner] owner 存在未完成 candidate:${found.join(',')}`)
}

/**
 * poisoned 替换失败时的 create-only 兜底告示(CLUSTER-OWNER-POISON-GUARD-FLAKY-0926):文件名
 * 独立于 guard.json,写入不受「guard.json 正被杀毒/索引器占用」的 rename EPERM 影响;guard 上的
 * poisoned 保护没写成时,它是唯一的失败关闭手段。
 */
export function ownerGuardPoisonMarkerPath(ownersDir: string, machine: string): string {
  return join(ownersDir, `${requireSafeSegment(machine, 'owner machine')}.guard.poisoned.json`)
}
/** 开锁/撬锁前先看告示:有告示 = 半完成控制面可能没有任何保护,人工确认前绝不自动接管。 */
function assertNoOwnerGuardPoisonMarker(dir: string, machine: string): void {
  const markerPath = ownerGuardPoisonMarkerPath(dir, machine)
  if (pathExistsFailClosed(markerPath)) {
    throw new Error(`[cluster-owner] owner guard 是有意保留的半完成保护(兜底告示 ${markerPath}),需要人工确认数据一致后再清理(guard 与告示一并清理)`)
  }
}

interface OwnerAuditEntry { name: string; token: string; stamp: string; revision: number; ambiguous: boolean }

function pruneOwnerAudits(dir: string, machine: string, sources: LifecycleSources): void {
  // 已核对全仓读侧：handoff/status/cutover 读当前 <machine>.json，wait/canary receipt 不读此历史。
  // claim 返回前尚未启动续租：目录只列文件名，读/stat 与删除均受单次预算约束，存量分多次换代收敛。
  try {
    const keep = sources.ownerAuditRetention ?? OWNER_AUDIT_RETENTION
    const checkLimit = sources.ownerAuditCheckLimit ?? OWNER_AUDIT_CHECK_LIMIT
    const deleteLimit = sources.ownerAuditDeleteLimit ?? OWNER_AUDIT_DELETE_LIMIT
    if ([keep, checkLimit, deleteLimit].some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error('owner 审计保留数量与单次处理上限必须为正整数')
    }
    let checks = 0
    let deletes = 0
    const takeCheck = (): boolean => {
      if (checks >= checkLimit) return false
      checks++
      return true
    }
    const names = readdirSync(dir)
    // 从非审计/guard/candidate 的 <name>.json 推出同前缀机器；只对归属有歧义的候选读内容。
    // 【SCHED-DISPATCHER-RESILIENCE-1009】审计 kind 新增 dead-local-owner(同主机旧持有者进程已不
    // 存在、未到期提前接管的换代审计):不补进这两条正则的话,新审计既不被清理(永久留存),又会
    // 被误认成「其他机器」的 <name>.json 候选。
    const otherMachines = names.filter(name => name.endsWith('.json')
      && !/\.(?:claim|expired|released|renewed|dead-local-owner)\..+\.\d+\.json$/.test(name)
      && !/\.guard(?:\.retired-[\dTZ-]+|\.poisoned)?\.json$/.test(name)
      && !/\.candidate(?:\..+)?\.json$/.test(name))
      .map(name => name.slice(0, -5)).filter(name => name.startsWith(`${machine}.`))
    const groups = new Map<string, OwnerAuditEntry[]>()
    const prefix = `${machine}.`
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const suffix = name.slice(prefix.length)
      const audit = /^(claim|expired|released|renewed|dead-local-owner)\.(.+)\.(\d+)\.json$/.exec(suffix)
      const retired = /^guard\.retired-(\d{4}-\d{2}-\d{2}T\d{9}Z)\.json$/.exec(suffix)
      if (audit === null && retired === null) continue
      const revision = audit === null ? 0 : Number(audit[3])
      if (!Number.isSafeInteger(revision)) continue
      const kind = audit === null ? 'guard.retired' : audit[1]!
      const group = groups.get(kind) ?? []
      group.push({ name, token: audit?.[2] ?? '', stamp: retired?.[1] ?? '', revision,
        ambiguous: otherMachines.some(other => name.startsWith(`${other}.`)) })
      groups.set(kind, group)
    }
    const byFilename = (left: OwnerAuditEntry, right: OwnerAuditEntry): number =>
      (left.stamp < right.stamp ? 1 : left.stamp > right.stamp ? -1 : 0)
      || (left.token < right.token ? -1 : left.token > right.token ? 1 : 0)
      || right.revision - left.revision || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const group of groups.values()) {
      if (checks >= checkLimit || deletes >= deleteLimit) break
      if (group.length <= keep) continue
      group.sort(byFilename)
      // 同 token 的 revision、guard 的退休 stamp 已能确定先后，无须读取内容或 stat。
      const filenameOrder = group.every(entry => entry.token === group[0]!.token)
      const filenameOnly = filenameOrder && group.every(entry => !entry.ambiguous)
      let obsolete: OwnerAuditEntry[]
      if (filenameOnly) obsolete = group.slice(keep)
      else {
        const compared: (OwnerAuditEntry & { modifiedAt: number })[] = []
        for (const entry of group) {
          if (checks >= checkLimit) break
          try {
            const path = join(dir, entry.name)
            if (entry.ambiguous) {
              if (!takeCheck()) break
              const raw = requireRecord(JSON.parse(readFileSync(path, 'utf8')), 'owner audit')
              if (raw.machine !== machine) continue
            }
            let modifiedAt = 0
            if (!filenameOrder) {
              if (!takeCheck()) break
              const stat = statSync(path)
              if (!stat.isFile() || !Number.isFinite(stat.mtimeMs)) throw new Error('owner audit 文件状态非法')
              modifiedAt = stat.mtimeMs
            } else if (!entry.ambiguous && !takeCheck()) break
            compared.push({ ...entry, modifiedAt })
          } catch (error) {
            console.warn(`[cluster-owner] owner 审计核对失败，保留原件:${join(dir, entry.name)}:${errorMessage(error)}`)
          }
        }
        compared.sort((left, right) => right.modifiedAt - left.modifiedAt || byFilename(left, right))
        // 只删除已确认比同类至少 keep 份更旧的记录，未检查者原样保留；后续 claim 继续归并。
        obsolete = compared.slice(keep)
      }
      for (const entry of obsolete) {
        if (deletes >= deleteLimit || (filenameOnly && !takeCheck())) return
        deletes++ // 删除失败同样消耗预算，不能在共享盘故障时无界尝试。
        const path = join(dir, entry.name)
        try { (sources.unlinkOwnerAudit ?? unlinkSync)(path) } catch (error) {
          console.warn(`[cluster-owner] owner 历史审计清理失败:${path}:${errorMessage(error)}`)
        }
      }
    }
  } catch (error) {
    // 已取得的租约不能因低频目录清理失败而被报告为失败。
    console.warn(`[cluster-owner] owner 历史审计清理失败:machine=${machine}:${errorMessage(error)}`)
  }
}
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if (hasCode(error, 'ESRCH')) return false
    if (hasCode(error, 'EPERM')) return true
    throw new Error(`[cluster-owner] owner guard 进程判活失败:pid ${pid}:${errorMessage(error)}`, { cause: error })
  }
}

/** Windows CreationDate(ToString('o') 的 UTC 形态,秒的小数最多 7 位):对不上就按探不到处理。 */
const WIN32_BORN_AT = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/

/**
 * 【SCHED-OWNER-GUARD-PROBE-GONE-YIELD】出生身份探针的三态结论:
 * - string:探到了,原样返回(只用于相等比较);
 * - { gone: true }:确认进程已不存在(Windows CIM 查无此 pid / Linux /proc 条目消失)——读侧据此
 *   走既有「pid 不存在」的归档回收,不必再傻等 15 分钟兜底;
 * - undefined:超时、权限、输出格式对不上等一切「探不到」——读侧保守让位,绝不当成已消失。
 * 旧的 string | undefined 注入写法仍兼容:undefined 依旧按 unknown 保守让位。
 */
export type ProcessBornProbeResult = string | { readonly gone: true } | undefined

/**
 * Windows 探针的固定哨兵:Get-CimInstance 查无此 pid 时由 PowerShell 打出来,是输出里唯一
 * 表示「进程确认已消失」的记号。空输出/报错都不算——那可能是别的失败,一律按探不到保守让位。
 */
export const WIN32_PROCESS_GONE_OUTPUT = 'CLUSTER-OWNER-PROCESS-GONE'

/** Windows 探针输出的唯一解析口:哨兵 ⇒ gone;ISO 时刻 ⇒ 探到;空串与其他任何输出 ⇒ unknown。 */
export function parseWin32BornAtOutput(raw: string): ProcessBornProbeResult {
  const text = raw.trim()
  if (text === WIN32_PROCESS_GONE_OUTPUT) return { gone: true }
  return WIN32_BORN_AT.test(text) ? text : undefined
}

/**
 * 【SCHED-HANDOFF-TEST-EEXIST-FLAKY】进程「出生身份」探针:取某个 pid 当前这一次进程实例的
 * OS 出生标识,原样字符串,只用于相等比较,不解析、不换算。同一个 pid 换一代进程(重启或被
 * 复用)后身份必然不同,这是它区别于 pid 本身的全部价值。
 *
 * 为什么需要它:guard 判活原先只剩 isProcessAlive(pid) 一条判据,而操作系统的 pid 会被很快
 * 复用——CI 满载实测被强杀的 pid 25% 在 1.5 秒内已被别的进程占用,process.kill(pid, 0) 全部
 * 判活;CI runner 以低权账户跑时,pid 复用给别的账户的进程还会让探测报 EPERM,isProcessAlive
 * 按「EPERM 当活」的既有语义同样误判。两种形态的结局一样:上一代被 SIGKILL 留下的 guard 被
 * 当成「持有者还活着」,下一代(代理看护 5 分钟内就拉起 / 测试里下一秒就起)只能白等到
 * 15 分钟超时兜底——schedHandoff 强杀用例时红时绿的根因。
 *
 * 一切失败绝不抛:确认进程已消失收敛 { gone: true },其余(权限 / 输出格式对不上 / 超时)一律
 * 收敛成 undefined;调用方据此保守让位,绝不把「探不到」当成「已复用」。
 *
 * 为什么 win32 用 Get-CimInstance 而不是 Get-Process:CIM/WMI 读得到其他账户进程的创建时刻,
 * Get-Process 对别人的进程会因权限失败——那正是上面 EPERM 形态要覆盖的场景。命令行里一个
 * 双引号都不用:参数直接交给 powershell.exe,少一层引号转义就少一处「本机跑得通、换台机器
 * 就变形」的坑。为什么超时给 20 秒不是 5 秒:这是冷路径(只在「pid 撞活」时才走),CI 满载时
 * PowerShell 冷启动可能好几秒,给短了会把「保守让位」变成新的时红时绿。
 *
 * 三态(SCHED-OWNER-GUARD-PROBE-GONE-YIELD):确认进程已消失(win32 CIM 查无此 pid ⇒ 哨兵输出,
 * linux /proc 条目 ENOENT)收敛成 { gone: true },读侧据此走既有「pid 不存在」回收;其余一切
 * 失败(权限 / 输出格式对不上 / 超时)仍收敛成 undefined,绝不抛,读侧保守让位。
 */
export function processBornAt(pid: number): ProcessBornProbeResult {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    if (process.platform === 'win32') {
      // 先判 Get-CimInstance 结果是否为空:空 ⇒ 打固定哨兵(确认消失);非空 ⇒ 取出生时刻。
      const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=" + String(pid) + "' -ErrorAction Stop; "
        + `if ($null -eq $p) { '${WIN32_PROCESS_GONE_OUTPUT}' } else { $p.CreationDate.ToUniversalTime().ToString('o') }`],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true })
      return parseWin32BornAtOutput(raw)
    }
    if (process.platform === 'linux') {
      // /proc/<pid>/stat 去掉(可能带空格/括号的)comm 之后按空格分的第 20 个字段(下标 19)是
      // starttime(本次开机起的 tick),配 boot_id 跨重启也唯一。ENOENT = 进程确认已消失 ⇒ gone;
      // 其他读错误与字段缺失 ⇒ unknown。boot_id 读不到 ⇒ unknown(外层 catch 收敛)。
      let stat: string
      try {
        stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      } catch (error) {
        if (hasCode(error, 'ENOENT')) return { gone: true }
        return undefined
      }
      const starttime = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]
      if (starttime === undefined || starttime === '') return undefined
      return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${starttime}`
    }
    const raw = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, LC_ALL: 'C' }, windowsHide: true,
    }).trim()
    return raw === '' ? undefined : raw
  } catch {
    return undefined
  }
}

/**
 * 自身出生身份的进程内缓存。为什么缓存:withGuard 是热路径(claim/renew/commit/release 每次
 * 都走 acquireGuard),每次都真起一个 PowerShell 探针不可接受——冷启动秒级,满载时还会拖成
 * 超时;而自身身份在本进程生命周期内不变,算一次就够。成功值与「已探测但失败」都缓存:
 * 失败态缓存住之后只警告一次,之后各代 guard 退回旧格式(无 bornAt),与旧代理行为一致。
 * 缓存只对生产探针生效;通过 sources 注入的探针每次直接调用,便于测试。
 */
let selfBornAtCache: { value: string | undefined } | undefined

function warnSelfBornAtMissing(): void {
  console.warn(`[cluster-owner] owner guard 取不到本进程出生身份(pid=${process.pid}),本代 guard 退回旧格式(不带 bornAt);pid 被复用时只能等 ${Math.round(GUARD_STALE_MS / 60_000)} 分钟超时兜底接管`)
}

/** 写侧用:取本进程出生身份记进 guard;探不到就不写这个键并警告(生产路径只警告一次,见上)。 */
function guardSelfBornAt(sources: LifecycleSources): string | undefined {
  if (sources.processBornAt !== undefined) {
    const injected = sources.processBornAt(process.pid)
    // 自身进程不会「已消失」;探针返回 gone 与 unknown 同样按探不到处理,退回旧格式。
    if (typeof injected !== 'string') warnSelfBornAtMissing()
    return typeof injected === 'string' ? injected : undefined
  }
  if (selfBornAtCache === undefined) {
    const value = processBornAt(process.pid)
    selfBornAtCache = { value: typeof value === 'string' ? value : undefined }
    if (typeof value !== 'string') warnSelfBornAtMissing()
  }
  return selfBornAtCache.value
}

/** 读侧用:生产判读出生身份。自己的 pid 走上面的缓存(读到的必然还是本进程);别人的 pid 是冷路径,每次真探。 */
function productionProcessBornAt(pid: number): ProcessBornProbeResult {
  if (pid === process.pid && selfBornAtCache !== undefined) return selfBornAtCache.value
  return processBornAt(pid)
}
function guardCreateAlreadyExists(error: unknown): boolean {
  // 排他发布与 owner 写入各包了一层 cause；只认底层 EEXIST，不按错误文案猜测。
  const seen = new Set<unknown>()
  let current = error
  while (current !== undefined && !seen.has(current)) {
    if (hasCode(current, 'EEXIST')) return true
    seen.add(current)
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}
/** 同步阻塞若干毫秒,写法照抄 cluster-dispatch.ts 的 sleepSyncMs:publishReplacement 整条链是同步的,
 * 不能中途把控制权交出去;测试经 sources.sleepMs 注入假实现,生产才真睡。 */
function sleepSyncMs(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}
/** 第 retryIndex 次重试(0 起)前的退避时长:base 起逐次翻倍,单次封顶 SINGLE_CAP。 */
function deletePendingBackoffMs(retryIndex: number): number {
  return Math.min(OWNER_DELETE_PENDING_RETRY_BASE_MS * 2 ** retryIndex, OWNER_DELETE_PENDING_RETRY_SINGLE_CAP_MS)
}
function retireStaleGuard(dir: string, machine: string, path: string, now: string, sources: LifecycleSources): boolean {
  // 先于读快照查兜底告示:guard 上的 poisoned 可能没写成(告示才是唯一保护),绝不按僵尸锁自动回收。
  assertNoOwnerGuardPoisonMarker(dir, machine)
  let snapshot: Buffer
  let token: string
  let createdAt: string
  let pid: number | undefined
  let bornAt: string | undefined
  try {
    snapshot = readFileSync(path)
    const raw = requireRecord(JSON.parse(snapshot.toString('utf8')), 'owner guard')
    // 必须先于判活/超时：半完成的控制面需要人工确认，时间再久也不能自动接管。
    if (raw.poisoned === true) {
      throw new Error('[cluster-owner] owner guard 是有意保留的半完成保护，需要人工确认数据一致后再清理')
    }
    if (raw.poisoned !== undefined && typeof raw.poisoned !== 'boolean') throw new Error('owner guard poisoned 非法')
    if (requireSafeSegment(raw.machine, 'owner guard machine') !== machine) throw new Error('owner guard machine 漂移')
    token = requireSafeSegment(raw.token, 'owner guard token')
    createdAt = requireIsoTime(raw.createdAt, 'owner guard createdAt')
    // 仅缺失 pid 的旧格式获准退回纯超时；null、字符串、零值等仍失败关闭。
    pid = raw.pid === undefined ? undefined : requireInteger(raw.pid, 'owner guard pid')
    if (pid !== undefined && pid <= 0) throw new Error('owner guard pid 必须为正整数')
    // bornAt(持有者出生身份)与 pid 同口径：缺失(旧格式)允许；一旦存在就必须是非空字符串，
    // 123 / null / '' 一律失败关闭，不猜。
    bornAt = raw.bornAt === undefined ? undefined : requireText(raw.bornAt, 'owner guard bornAt')
  } catch (error) {
    throw new Error(`[cluster-owner] owner guard 读取/校验失败:${path}:${errorMessage(error)}`, { cause: error })
  }
  const expired = timeMs(now, 'owner guard now') - timeMs(createdAt, 'owner guard createdAt') > GUARD_STALE_MS
  // 判定顺序(每层先于下层短路，与历史一致)：poisoned(上方) → 超时 → pid 未定义 → pid 不存在
  // → 旧格式无 bornAt → 出生身份不符。旧格式(无 bornAt)绝不调探针：判活开销与旧行为一字
  // 不变，旧代理留下的 guard 不会被多花一次子进程探测。
  let pidReused = false
  let pidGone = false
  if (!expired && (pid === undefined || (sources.isProcessAlive ?? isProcessAlive)(pid))) {
    if (pid === undefined || bornAt === undefined) return false
    // pid 撞活(含 EPERM 当活那种形态)时核对当前占用者的出生身份,三态(ProcessBornProbeResult):
    // 探到且相符 ⇒ 持有者还是原来那个进程,让位;探到但不符 ⇒ pid 已被复用、僵尸 guard,按既有
    // 动作归档回收;确认进程已消失(gone)⇒ 与「pid 不存在」同口径,归档回收,不再傻等 15 分钟
    // 兜底;探不到(unknown)⇒ 保守让位(挡一次接管只是多等一轮,误回收会在持有者真活着时抢走锁)。
    const current = (sources.processBornAt ?? productionProcessBornAt)(pid)
    if (current === undefined) return false
    if (typeof current === 'string') {
      if (current === bornAt) return false
      pidReused = true
    } else {
      pidGone = true
    }
  }
  const reason = expired ? `超时(超过 ${GUARD_STALE_MS}ms)`
    : pidReused ? `pid ${pid} 已被复用(出生身份不符)`
    : pidGone ? `pid ${pid} 已不存在(出生身份探针确认进程消失)` : `pid ${pid} 不存在`
  const stamp = new Date(timeMs(now, 'owner guard retirement time')).toISOString().replace(/[:.]/g, '')
  const retiredPath = join(dir, `${machine}.guard.retired-${stamp}.json`)
  try {
    if (pathExistsFailClosed(retiredPath)) throw new Error(`owner guard 归档目标已存在:${retiredPath}`)
    // 判活期间若换过持有者或补了 poisoned，不得把新内容按旧快照回收。
    if (!readFileSync(path).equals(snapshot)) throw new Error('owner guard 归档前内容漂移')
    // 第二次查告示(紧挨 renameSync):判活/读快照期间持有者进程可能刚把兜底告示落盘,堵住竞态窗口。
    // 文案与开锁检查一致;此处会被下方「归档失败」包装,仍可按 /有意保留.*人工.*数据一致/ 识别。
    assertNoOwnerGuardPoisonMarker(dir, machine)
    renameSync(path, retiredPath)
  } catch (error) {
    const message = `[cluster-owner] owner guard 归档失败，原 guard 保留，未取得写入权:${path}:${errorMessage(error)}`
    if (hasCode(error, 'EPERM') || hasCode(error, 'EBUSY') || hasCode(error, 'EACCES')) {
      // 共享盘暂时占用沿 agent 已有的占用分支干净退出，绝不继续无锁写控制面。
      throw new OwnerLeaseOccupiedError(`${message}；共享盘占用或权限受限，请稍后重试`, { cause: error })
    }
    throw new Error(message, { cause: error })
  }
  console.warn(`[cluster-owner] 回收僵尸 owner guard:machine=${machine}, token=${token}, pid=${pid ?? '<legacy>'}, createdAt=${createdAt}, 依据=${reason}, 归档=${retiredPath}`)
  return true
}
function acquireGuard(dir: string, machine: string, sources: LifecycleSources): { path: string; token: string } {
  try { mkdirSync(dir, { recursive: true }) } catch (error) {
    throw new Error(`[cluster-owner] 创建 owner 目录失败:${errorMessage(error)}`, { cause: error })
  }
  // 兜底告示在场 = 上一次 poisoned 替换失败过:guard 可能是半完成保护,人工确认前拒绝开锁。
  assertNoOwnerGuardPoisonMarker(dir, machine)
  const token = requireSafeSegment(sources.nonce(), 'owner guard token')
  const path = ownerGuardPath(dir, machine)
  // 记录本进程的 OS 出生身份：pid 被复用时，读侧靠它区分「持有者还活着」与「pid 已被别人
  // 占用」。探不到就不写这个键(退回旧格式)，旧代理读写两侧都不受影响(读侧只取用到的键)。
  const bornAt = guardSelfBornAt(sources)
  const record = { machine, token, createdAt: requireIsoTime(sources.now(), 'owner guard time'), pid: process.pid,
    ...(bornAt === undefined ? {} : { bornAt }) }
  try { writeOwnerJsonExclusive(path, record, 'owner guard') } catch (error) {
    if (!guardCreateAlreadyExists(error)) throw error
    if (!retireStaleGuard(dir, machine, path, record.createdAt, sources)) {
      throw new OwnerLeaseOccupiedError(
        `[cluster-owner] owner guard 正被另一个活着的进程占用,本次让位,稍后重试:${path}:${errorMessage(error)}`,
        { cause: error },
      )
    }
    // 只归档一次、再排他创建一次；第二次失败原样上抛，不递归、不循环。
    writeOwnerJsonExclusive(path, record, 'owner guard')
  }
  return { path, token }
}
function releaseGuard(guard: { path: string; token: string }): void {
  let raw: Record<string, unknown>
  try { raw = requireRecord(JSON.parse(readFileSync(guard.path, 'utf8')), 'owner guard') } catch (error) {
    throw new Error(`[cluster-owner] owner guard 读取失败:${errorMessage(error)}`, { cause: error })
  }
  if (requireSafeSegment(raw.token, 'owner guard token') !== guard.token) throw new Error('[cluster-owner] owner guard token 漂移')
  try { unlinkSync(guard.path) } catch (error) {
    throw new Error(`[cluster-owner] owner guard 释放失败:${errorMessage(error)}`, { cause: error })
  }
}
function withGuard<T>(dir: string, machine: string, sources: LifecycleSources,
  operation: (markDirty: () => void) => T): T {
  const guard = acquireGuard(dir, machine, sources)
  let dirty = false
  let result: T
  try { result = operation(() => { dirty = true }) } catch (error) {
    if (!dirty) releaseGuard(guard)
    else {
      const poisonReason = `控制面可能只改了一半，需要人工确认数据一致：${errorMessage(error)}`
      // 两段失败都收进普通变量、不在嵌套 catch 里抛硬错:cause 按设计挂「原始异常」而非最近一跳
      // 的写入失败,放在 catch(poisonError/markerError) 里抛会被 preserve-caught-error 判成挂错;
      // 抛出点留在本层 catch(error) 内,cause 引用的正是本层捕获的原始异常,两个口径同时满足。
      let poisonError: unknown
      try {
        const raw = requireRecord(JSON.parse(readFileSync(guard.path, 'utf8')), 'owner guard')
        if (requireSafeSegment(raw.token, 'owner guard token') !== guard.token) throw new Error('owner guard token 漂移', { cause: error })
        // 原子替换同 token 的保护标记，不释放/重建锁；退避睡眠经 sources.sleepMs 注入
        // (生产传 undefined 走工具缺省真睡,行为不变;测试注入假实现,不真等)。
        publishLifecycleFileAtomically(guard.path, `${canonicalLifecycleJson({ ...raw, poisoned: true,
          poisonReason })}\n`, 'replace', undefined, sources.sleepMs)
      } catch (caught) {
        poisonError = caught
      }
      if (poisonError !== undefined) {
        // 主路径(读/token 核对/替换)任一步失败 ⇒ 改写 create-only 兜底告示:告示文件名独立,
        // 不与 guard.json 抢同一个被占用的目标,之后开锁/撬锁都先看告示,保护仍然失败关闭。
        const markerPath = ownerGuardPoisonMarkerPath(dir, machine)
        let markerFailure: unknown
        try {
          writeOwnerJsonExclusive(markerPath, { machine, token: guard.token, poisoned: true, poisonReason,
            guardPoisonError: errorMessage(poisonError) }, 'owner guard poison marker')
          console.error(`[cluster-owner] owner guard 替换失败,已改写兜底告示:${markerPath}`)
        } catch (caught) {
          if (guardCreateAlreadyExists(caught)) {
            console.error(`[cluster-owner] owner guard 替换失败,兜底告示已存在(视同已毒化):${markerPath}:${errorMessage(caught)}`)
          } else {
            markerFailure = caught
          }
        }
        if (markerFailure !== undefined) {
          // 两样都写不上 ⇒ 不再吞:半完成控制面毫无保护,之后会被当僵尸锁自动回收并在脏数据上
          // 开工,必须人工处理;原始异常挂在 cause 上(抛出的是新错,按类型判的调用方会落到通用错误分支,这正是要的:必须人工处理)。
          throw new Error(`[cluster-owner] owner guard poisoned 标记与兜底告示均写入失败,控制面可能只改了一半且未加保护,必须人工处理:guard=${guard.path},告示=${markerPath},标记失败=${errorMessage(poisonError)},告示失败=${errorMessage(markerFailure)},原始异常=${errorMessage(error)}`, { cause: error })
        }
      }
    }
    throw error
  }
  releaseGuard(guard)
  return result
}
function assertCurrent(current: OwnerLeaseRecord, handle: OwnerLeaseHandle, now: string): void {
  if (current.token !== handle.token || !sameValue(requireIdentity(current, 'current owner'), handle.identity)
    || current.leaseDurationMs !== handle.leaseDurationMs) throw new Error('[cluster-owner] owner token/身份不匹配')
  const nowMs = timeMs(now, 'owner now')
  if (nowMs < timeMs(current.renewedAt, 'owner renewedAt')) throw new Error('[cluster-owner] owner 时钟倒退')
  if (nowMs >= timeMs(current.expiresAt, 'owner expiresAt')) throw new Error('[cluster-owner] owner lease 已过期')
}
function publishReplacement(dir: string, next: OwnerLeaseRecord, current: OwnerLeaseRecord | undefined,
  // reason 直拼进换代审计文件名 `<machine>.<reason>.<token>.<revision>.json` 并被 pruneOwnerAudits
  // 的两条文件名正则按枚举读取。dead-local-owner =【SCHED-DISPATCHER-RESILIENCE-1009】同主机旧持有者
  // 进程已不存在而「未到期提前接管」;到期接管(含墙钟倒退路径)仍用 expired,两类审计可区分。
  reason: 'claim' | 'expired' | 'renewed' | 'dead-local-owner', markDirty: () => void,
  sources: LifecycleSources = productionSources): OwnerLeaseRecord {
  const active = ownerLeasePath(dir, next.machine)
  // 同机 guard 串行化且最多一个候选；固定名仍用 create-only（等价 wx）互斥，token/revision 留在内容中。
  // CAS 与发布顺序不变；失败仍保留候选及 poisoned guard，下一次检查只需 stat 即可失败关闭。
  const candidate = ownerCandidatePath(dir, next.machine)
  markDirty()
  writeOwnerJsonExclusive(candidate, next, 'owner candidate')
  if (current !== undefined) {
    const audit = join(dir, `${next.machine}.${reason}.${current.token}.${current.revision}.json`)
    writeOwnerJsonExclusive(audit, current, 'owner audit')
    const observed = readLease(active)
    if (!sameValue(observed, current)) throw new Error('[cluster-owner] owner CAS 前记录漂移')
    try { unlinkSync(active) } catch (error) {
      throw new Error(`[cluster-owner] owner CAS 移除旧记录失败:${errorMessage(error)}`, { cause: error })
    }
  }
  // copyFileSync 的排他只防覆盖，不保证内容一次出现。create-only 保留排他/CAS/候选现场语义。
  // 【CLUSTER-OWNER-RENEW-DELETE-PENDING】SMB 共享盘上 unlinkSync 成功返回 ≠ 文件名已从目录消失:
  // 别的进程还开着句柄时删除只是「挂起」,窗口内对同名 create-only link 报 EEXIST。EEXIST 在这里
  // 唯一合理的来源是「本进程持有 guard、刚刚亲手 unlink 过这份 ACTIVE」(current !== undefined)——
  // guard 是同机排他锁,别人此刻不可能在建同名文件,等一下名字就会空出来。所以仅对这一种情形按
  // 有界退避重试;首次领取撞 EEXIST 是真冲突、非 EEXIST 错误不会自愈,一律照旧立即抛;
  // 退避耗尽也照旧抛 → withGuard 走 poisoned 失败关闭,一个字不放松。
  let payload: Buffer
  try { payload = readFileSync(candidate) } catch (error) {
    throw new Error(`[cluster-owner] owner ACTIVE 排他发布失败:${errorMessage(error)}`, { cause: error })
  }
  const sleep = sources.sleepMs ?? sleepSyncMs
  let deletePendingRetries = 0
  let deletePendingWaitedMs = 0
  for (;;) {
    try { publishLifecycleFileAtomically(active, payload, 'create-only'); break } catch (error) {
      if (current === undefined || !guardCreateAlreadyExists(error)) {
        throw new Error(`[cluster-owner] owner ACTIVE 排他发布失败:${errorMessage(error)}`, { cause: error })
      }
      const backoffMs = deletePendingBackoffMs(deletePendingRetries)
      if (deletePendingWaitedMs + backoffMs > OWNER_DELETE_PENDING_RETRY_BUDGET_MS) {
        throw new Error(
          `[cluster-owner] owner ACTIVE 排他发布失败:疑似删除挂起退避 ${deletePendingRetries} 次、累计等待 ${deletePendingWaitedMs}ms 仍 EEXIST,按控制面半完成失败关闭:${errorMessage(error)}`,
          { cause: error },
        )
      }
      // 重发前确认 candidate 仍是我们刚写的那份;被挪走/改写就停手,不盲目重发(场景本身不该发生,
      // 真发生了说明控制面被人动过,继续重发只会把现场搅浑)。
      let probe: Buffer
      try { probe = readFileSync(candidate) } catch (probeError) {
        throw new Error(
          `[cluster-owner] owner 删除挂起重试前读取 candidate 失败:${candidate}:${errorMessage(probeError)}`,
          { cause: probeError },
        )
      }
      if (!probe.equals(payload)) {
        throw new Error(`[cluster-owner] owner 删除挂起重试前 candidate 漂移,停止重发:${candidate}`, { cause: error })
      }
      deletePendingRetries += 1
      console.warn(`[cluster-owner] owner ACTIVE 发布撞 EEXIST,按 SMB 删除挂起退避重试:第 ${deletePendingRetries} 次,本次等 ${backoffMs}ms,累计将等待 ${deletePendingWaitedMs + backoffMs}ms:${active}`)
      sleep(backoffMs)
      deletePendingWaitedMs += backoffMs
    }
  }
  if (deletePendingRetries > 0) {
    console.warn(`[cluster-owner] 删除挂起已消失,续租发布成功(第 ${deletePendingRetries} 次重试后):${active}`)
  }
  try { unlinkSync(candidate) } catch (error) {
    throw new Error(`[cluster-owner] owner candidate 清理失败:${errorMessage(error)}`, { cause: error })
  }
  const observed = readLease(active)
  if (observed === undefined || !sameValue(observed, next)) throw new Error('[cluster-owner] owner ACTIVE 发布后漂移')
  if (reason === 'renewed' && current !== undefined) {
    const audit = join(dir, `${next.machine}.${reason}.${current.token}.${current.revision}.json`)
    // 新记录确认发布后旧续租副本才可丢弃；清理失败不能让已成功的续租变成失败。
    try { (sources.unlinkRenewedAudit ?? unlinkSync)(audit) } catch (error) {
      console.warn(`[cluster-owner] owner renewed 审计清理失败:${audit}:${errorMessage(error)}`)
    }
  }
  return observed
}
function handleOf(dir: string, record: OwnerLeaseRecord): OwnerLeaseHandle {
  return { ownersDir: dir, token: record.token, identity: requireIdentity(record, 'owner handle'),
    leaseDurationMs: record.leaseDurationMs }
}

/**
 * 【SCHED-DISPATCHER-RESILIENCE-1009】取租约侧的旧持有者判活:探针抛错一律按活着算(让位/等到期),
 * 不让探测故障把「确认不了」变成「已不存在」。注意 guard 归档路径(retireStaleGuard)不走这里——
 * 那里的判活失败仍原样上抛(既有用例 clusterOwnerGuardStale「判活探针失败不等于进程消失」钉着)。
 */
function probeOwnerAliveOrDefaultAlive(sources: LifecycleSources, pid: number): boolean {
  try { return (sources.isProcessAlive ?? isProcessAlive)(pid) } catch { return true }
}

/** 原子领取：guard `wx` 串行化，ACTIVE 用原子 create-only 发布，绝不覆盖。 */
export function claimOwnerLease(options: ClaimOwnerLeaseOptions): OwnerLeaseHandle {
  const sources = options.sources ?? productionSources
  const identity = requireIdentity(options.identity, 'owner identity')
  const duration = options.leaseDurationMs ?? OWNER_STALE_MS
  if (!Number.isInteger(duration) || duration <= 0) throw new Error('[cluster-owner] owner leaseDurationMs 非法')
  const acquiredAt = requireIsoTime(sources.now(), 'owner acquiredAt')
  const acquiredMs = timeMs(acquiredAt, 'owner acquiredAt')
  const handle = withGuard(options.ownersDir, identity.machine, sources, markDirty => {
    assertNoCandidate(options.ownersDir, identity.machine)
    assertNoLegacyCandidate(options.ownersDir, identity.machine)
    const active = ownerLeasePath(options.ownersDir, identity.machine)
    const current = readLease(active, true)
    // 旧持有者进程已确认不存在(同主机 + 明确 ESRCH)⇒ 允许未到期提前接管;Premature 专指
    // 「未到期却接管」,用于把换代审计原因与「过期接管」区分开(见下方 publishReplacement)。
    let deadLocalOwnerPremature = false
    if (current !== undefined) {
      // 协议号**不进漂移体检**,只按下限判(已由 requireIdentity → requireAgentProtocol 判过)。
      // 【为什么(2026-09-02 真机两次)】协议号是每台代理各自的属性,而执行机的磁盘代码由「谁派活」决定:
      // 两个对话各持一个号(14 与未合并分支上的 15)先后派活,机器磁盘就在两号之间翻转。逐字比的话,
      // 新起的代理读到上一代留下的、号不同的 lease 就抛本行的硬异常 —— 而这是在**取得 token 之前**抛的,
      // 代理据此拒绝无 token 自愈 ⇒ 退出 ⇒ 看护拉起 ⇒ 再崩,无限崩溃循环、机器静默离队,
      // 只能靠人工归档 `_owners/<机器>.json` 救回(实测两次,均为副机 <executor>)。
      // 号不同的旧 lease 该走的是下面那条正常路:**过期就接管,没过期就让位**(软 OwnerLeaseOccupiedError,
      // 代理干净退出),不是崩溃。判据与 cluster-lifecycle-status 的心跳校验、
      // verifyLifecycleReceiptMachine 的回执校验一致 —— 那两处早已改成下限判。
      // ⚠️ 其余身份字段仍逐字比:它们与「哪一代代理」无关,对不上就是信箱/命名空间/epoch 真的串了。
      if (current.name !== identity.name || current.machine !== identity.machine
        || current.namespace !== identity.namespace
        || current.lifecycleSchema !== identity.lifecycleSchema || current.epoch !== identity.epoch) {
        throw new Error('[cluster-owner] owner ACTIVE 路径身份漂移')
      }
      const clockRegressed = acquiredMs < timeMs(current.renewedAt, 'owner renewedAt')
      // 【SCHED-DISPATCHER-RESILIENCE-1009】同主机且「明确无此进程」(isProcessAlive 判定口径不变:
      // 只有明确 ESRCH 才算不存在)即可提前接管未过期租约,不再干等 90 秒——派单员/集群代理在本机
      // 死掉后,新实例恢复只差一次进程探测。方向安全(凡确认不了一律退回等到期):
      // - pid 被别的进程复用 ⇒ 探测为活,照旧让位;权限不足(EPERM 当活)与探测抛错(下方 helper
      //   按活着算)同样让位,不让异常改变让位/抛错语义;
      // - 异机持有 ⇒ host 不同直接短路,绝不跨机抢租约(另一台机器可能只是暂时探测不到);
      // - 墙钟倒退仍只认原来的换代路径:倒退而活着/异机照旧抛「时钟倒退」,倒退且明确不存在照旧
      //   当场换代,审计原因不变。
      // 另:旧持有者 pid 与自己相同 ⇒ 探测目标就是本进程,生产判活必为真,不把它算进「旧持有者已
      // 不存在」——自己不可能是已消失的旧持有者,pid 复用恰好撞上自己时也与真实探针结论恒一致;
      // 「同一身份未过期重复 claim 仍让位」的既有语义因此不动。
      const deadLocalOwner = current.host === identity.host && current.pid !== identity.pid
        && !probeOwnerAliveOrDefaultAlive(sources, current.pid)
      if (clockRegressed && !deadLocalOwner) throw new Error('[cluster-owner] owner 时钟倒退')
      if (acquiredMs < timeMs(current.expiresAt, 'owner expiresAt') && !deadLocalOwner) {
        throw new OwnerLeaseOccupiedError(`[cluster-owner] owner lease 未过期，信箱仍被占用:${current.host}/${current.pid}`)
      }
      // 「未过期却因旧持有者进程已不存在而提前接管」才记新审计原因;到期接管与墙钟倒退接管都仍用
      // expired,与既有审计口径一字不差(倒退场景 acquiredMs < renewedAt ≤ expiresAt,被 !clockRegressed
      // 显式排除,不许混进新原因)。
      deadLocalOwnerPremature = deadLocalOwner && !clockRegressed
        && acquiredMs < timeMs(current.expiresAt, 'owner expiresAt')
    }
    const token = requireSafeSegment(sources.nonce(), 'owner token')
    const record: OwnerLeaseRecord = {
      ...identity, state: 'ACTIVE', token, head: requireSha1(options.head, 'owner head'),
      acquiredAt, renewedAt: acquiredAt, expiresAt: new Date(acquiredMs + duration).toISOString(),
      at: acquiredAt, leaseDurationMs: duration, revision: 0,
    }
    return handleOf(options.ownersDir,
      publishReplacement(options.ownersDir, record, current,
        current === undefined ? 'claim' : deadLocalOwnerPremature ? 'dead-local-owner' : 'expired',
        markDirty, sources))
  })
  pruneOwnerAudits(options.ownersDir, identity.machine, sources)
  return handle
}

export function renewOwnerLease(options: { handle: OwnerLeaseHandle; head: string; sources?: LifecycleSources }): OwnerLeaseRecord {
  const sources = options.sources ?? productionSources
  const now = requireIsoTime(sources.now(), 'owner renewedAt')
  return withGuard(options.handle.ownersDir, options.handle.identity.machine, sources, markDirty => {
    assertNoCandidate(options.handle.ownersDir, options.handle.identity.machine)
    const current = readLease(ownerLeasePath(options.handle.ownersDir, options.handle.identity.machine))!
    assertCurrent(current, options.handle, now)
    const expiry = new Date(timeMs(now, 'owner renewedAt') + current.leaseDurationMs).toISOString()
    if (timeMs(expiry, 'owner expiresAt') <= timeMs(current.expiresAt, 'owner expiresAt')) {
      throw new Error('[cluster-owner] owner 续租必须延长租期')
    }
    const next = { ...current, head: requireSha1(options.head, 'owner head'), renewedAt: now,
      expiresAt: expiry, at: now, revision: current.revision + 1 }
    return publishReplacement(options.handle.ownersDir, next, current, 'renewed', markDirty, sources)
  })
}

/** 持有 guard 完成一次生产提交；旧 token 在回调前即被 fencing。 */
export function commitOwnerLease<T>(options: { handle: OwnerLeaseHandle; sources?: LifecycleSources }, commit: () => T): T {
  const sources = options.sources ?? productionSources
  const now = requireIsoTime(sources.now(), 'owner commit time')
  return withGuard(options.handle.ownersDir, options.handle.identity.machine, sources, () => {
    assertNoCandidate(options.handle.ownersDir, options.handle.identity.machine)
    const current = readLease(ownerLeasePath(options.handle.ownersDir, options.handle.identity.machine))!
    assertCurrent(current, options.handle, now)
    return commit()
  })
}

export function releaseOwnerLease(options: { handle: OwnerLeaseHandle; sources?: LifecycleSources }): OwnerLeaseRecord {
  const sources = options.sources ?? productionSources
  const now = requireIsoTime(sources.now(), 'owner release time')
  return withGuard(options.handle.ownersDir, options.handle.identity.machine, sources, markDirty => {
    assertNoCandidate(options.handle.ownersDir, options.handle.identity.machine)
    const active = ownerLeasePath(options.handle.ownersDir, options.handle.identity.machine)
    const current = readLease(active)!
    assertCurrent(current, options.handle, now)
    markDirty()
    writeOwnerJsonExclusive(join(options.handle.ownersDir,
      `${current.machine}.released.${current.token}.${current.revision}.json`), current, 'owner release audit')
    if (!sameValue(readLease(active), current)) throw new Error('[cluster-owner] owner release CAS 前记录漂移')
    try { unlinkSync(active) } catch (error) {
      throw new Error(`[cluster-owner] owner release 失败:${errorMessage(error)}`, { cause: error })
    }
    return current
  })
}

/** 旧兼容纯判据，不再参与 protocol13 生产 claim。 */
export function ownerVerdict(prev: OwnerRecord | undefined, self: { pid: number; host: string }, nowMs: number,
  isPidAlive: (pid: number) => boolean, staleMs: number = OWNER_STALE_MS): OwnerVerdict {
  if (prev === undefined) return { claim: true, kind: 'empty' }
  const stamped = prev.at === undefined ? Number.NaN : Date.parse(prev.at)
  if (!Number.isFinite(stamped)) return { claim: true, kind: 'empty' }
  const ageMs = nowMs - stamped
  if (ageMs >= staleMs) return { claim: true, kind: 'stale' }
  const sameHost = prev.host === self.host
  if (sameHost && prev.pid === self.pid) return { claim: true, kind: 'self' }
  if (sameHost && prev.pid !== undefined && !isPidAlive(prev.pid)) return { claim: true, kind: 'stale' }
  return sameHost
    ? { claim: false, kind: 'same-host', reason: `本机已有代理在用这个信箱(pid ${String(prev.pid)},${Math.round(ageMs / 1000)}s 前还在报到)。两个代理抢同一个信箱会漏跑或重复跑;要在同机再起一个,必须用不同的 --name(它会有自己的信箱)。` }
    : { claim: false, kind: 'cross-host', reason: `另一台机器(${String(prev.host)})正在用这个信箱,${Math.round(ageMs / 1000)}s 前还在报到。重名会让两台抢同一个信箱 ⇒ 分片漏跑,而 --status 看起来一切正常。处置:给其中一台加 --name <别的名字>,并用真实名字派活。` }
}

export const CRASH_RELAUNCH_MAX_GEN = 5
export const CRASH_SHORT_LIVED_SEC = 60
export interface CrashRelaunchVerdict { relaunch: boolean; nextGen: number; reason?: string }
export function crashRelaunchVerdict(input: { aliveSec: number; generation: number }): CrashRelaunchVerdict {
  const { aliveSec, generation } = input
  if (aliveSec >= CRASH_SHORT_LIVED_SEC) return { relaunch: true, nextGen: 0 }
  if (generation >= CRASH_RELAUNCH_MAX_GEN) return { relaunch: false, nextGen: generation,
    reason: `连续第 ${generation} 代都在 ${CRASH_SHORT_LIVED_SEC}s 内崩溃(本次活了 ${aliveSec}s)——停止自愈,让它明确地死着;无限重启只会刷屏烧机时并埋掉真实原因。` }
  return { relaunch: true, nextGen: generation + 1 }
}
