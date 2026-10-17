import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  LIFECYCLE_STATES, SHA256, assertSameIdentity, canonicalLifecycleJson, errorMessage,
  hasCode, identityFrom, lifecyclePayloadSha256, readJson, requireInteger,
  requireIsoTime, requireRecord, requireSafeSegment, requireText,
  type LifecycleIdentity, type LifecycleSources, type LifecycleState,
  type LifecycleStateRecord, type TransitionLifecycleJobOptions,
} from './cluster-lifecycle-contract'
import type { LifecyclePaths } from './cluster-lifecycle-control'
import { publishLifecycleFileAtomically } from './cluster-lifecycle-atomic-file'
import { moveLifecycleDirectoryNoReplace } from './cluster-lifecycle-atomic-move'

const LEASE_SCHEMA = 'cluster-transition-lease/v1' as const
const DEFAULT_LEASE_DURATION_MS = 30_000

declare module './cluster-lifecycle-contract' {
  interface LifecycleSources {
    /** 删除一个过期的退役转移锁目录;缺省是递归删除,测试注入它来模拟共享盘占用。 */
    removeRetiredTransitionLock?: (path: string) => void
  }
}

/**
 * 退役锁挪进的子目录(CLUSTER-CONTROL-DIR-UNBOUNDED-GROWTH G3)。
 *
 * 同层只放正在用的锁(.active / .takeover / .candidate.*),matchingTransientEntries 的整层枚举成本
 * 就只与正在迁移的工单数有关。2026-09-11 实测同层 326 个条目全是退役目录,--wait 每 50 毫秒就要翻一遍。
 * 退役锁不一退役就删:还原一张工单的迁移时间线全靠它们,所以在子目录里保留两周。
 * 挪动与清理只在写路径(真正迁移一张工单)里做;只读屏障对共享盘零写。
 */
export const RETIRED_TRANSITION_SUBDIR = 'retired'
/** 每次迁移顺手从同层挪走的老退役锁上限。 */
export const RETIRED_TRANSITION_MOVE_BATCH = 20
/** 退役锁在子目录里的保留时长。 */
export const RETIRED_TRANSITION_RETENTION_MS = 14 * 24 * 3600_000
/** 同一个转移锁目录两次过期清理之间的最小间隔(本进程内),以及每次最多删多少个。 */
export const RETIRED_TRANSITION_PRUNE_INTERVAL_MS = 3600_000
export const RETIRED_TRANSITION_PRUNE_BATCH = 50
const lastRetiredPruneMs = new Map<string, number>()
export interface TransitionLeasePlan {
  identity: LifecycleIdentity
  from: LifecycleState
  to: LifecycleState
  metadata?: Record<string, unknown>
  result?: Record<string, unknown>
  sourceRecordSha256: string
  destinationRecordSha256: string
}
export interface TransitionLeaseRecord extends TransitionLeasePlan {
  leaseSchema: typeof LEASE_SCHEMA
  status: 'ACTIVE'
  generation: number
  token: string
  acquiredAt: string
  expiresAt: string
  leaseDurationMs: number
  renewedUntil?: string
}
export interface TransitionLeaseHandle {
  lease: TransitionLeaseRecord
  retirementPath: string
  assertOwned: () => void
  renewLease: () => void
  release: () => void
}

/**
 * 只读屏障撞上一把仍挂着的 transition lease 时抛的**可分类**错误。
 *
 * 【为什么必须是独立类型而不是普通 Error(CLUSTER-WAIT-ACTIVE-LEASE-RACE,2026-08-30 拍板)】
 * 屏障对**所有**调用方的语义都不变:看见锁就抛、绝不放行读取。但"看见锁"对不同调用方意味着
 * 两件不同的事——`readLifecycleStateRecord` 是一次性读取,撞锁只能失败关闭;而 `--wait` 是
 * **每 50ms 探一次的轮询**,执行机做迁移时必然短暂持锁,"看见锁"恰恰说明对面正常在干活。
 * 旧规矩让二者共用"见锁即败",于是轮询与迁移必然有概率相撞:实测 canary 三台机器里前两台已成功、
 * 只有最后一台撞进窗口,报错原文 `[cluster-lifecycle] ACTIVE transition lease:<submissionId>:<token>`,
 * 一天之内咬红 6 个 PR 与 main 自身的 CI。
 *
 * 治法是**把判断权交给调用方**:屏障照旧抛,但把 lease 一并带出来,让 wait 能区分
 * 活锁(有效期内 ⇒ 对面真在搬 ⇒ 继续等)与过期死锁(持锁方卡死/崩了 ⇒ 判失败)。
 * 抛错这一侧零行为变化,所以一次性读取方(readLifecycleStateRecord 及其全部调用方)不受影响。
 */
export abstract class TransitionLeaseBarrierError extends Error {
  /** 本屏障"还算对面正在干活"的截止时刻(毫秒)。 */
  abstract expiresAtMs(): number

  /** 判活与接管方逐字同构:`now <= 有效期截止` 即"尚未过期",持锁方仍被认为活着。 */
  isLiveAt(nowMs: number): boolean {
    return nowMs <= this.expiresAtMs()
  }
}

/**
 * 锁目录已经出现、但提交标记 `lease.json` 还读不出来 —— 这把锁**正在被建/被拆**。
 *
 * 【为什么这是"正常并发"而不是故障(CLUSTER-DISPATCH-LEASE-ENOENT-FALSE-RED,2026-09-02)】
 * `.active` / `.takeover` 不是 rename 出来的:`moveLifecycleDirectoryNoReplace` 的次序是
 * mkdir 目标 → 逐个 copy 非提交文件 → **最后写 `lease.json` 当提交标记** → 删源。
 * 所以每一次 acquire / takeover 都真实存在一个"目录已在、提交标记还没到位"的窗口,
 * 实测三种表现:`ENOENT` / 半截 JSON / Windows 上目录正被替换时的 `EPERM`。
 * 它恰恰是"对面确定在搬"的铁证,旧代码却让它抛普通 `Error`,于是 `readClusterWaitVerdict`
 * 的"活锁 ⇒ 继续等"豁免够不着,合法工单被判 ✖、派活器退 1。
 * 根因链与 43.0% / 48.5% 复现见 `notes/debug/DBG-CLUSTER-CANARY-LEASE-FALSE-RED.md`。
 *
 * 判活锚**目录 mtime + 一个租期的宽限**:搬运方卡死/崩了留下的半截目录会老化到宽限之外,
 * 照旧失败关闭 —— 对"真残骸"一个字没放宽。
 */
export class NascentTransitionLeaseError extends TransitionLeaseBarrierError {
  readonly observedAtMs: number
  readonly graceMs: number

  constructor(message: string, observedAtMs: number, graceMs: number) {
    super(message)
    this.name = 'NascentTransitionLeaseError'
    this.observedAtMs = observedAtMs
    this.graceMs = graceMs
  }

  expiresAtMs(): number {
    return this.observedAtMs + this.graceMs
  }
}

export class ActiveTransitionLeaseError extends TransitionLeaseBarrierError {
  readonly lease: TransitionLeaseRecord

  constructor(message: string, lease: TransitionLeaseRecord) {
    super(message)
    this.name = 'ActiveTransitionLeaseError'
    this.lease = lease
  }

  /**
   * 本锁的有效期截止时刻(毫秒)。
   *
   * 口径锚 = lease 自带的 `renewedUntil ?? expiresAt`,与 `acquireTransitionLease` 判
   * "ACTIVE transition lease 尚未过期"、`renewLease` 判"已过期 token 不得续租"所用的
   * **同一个表达式**。不另立门户定义"过期多久算卡死":过期口径只有 lease 自己说了算,
   * 只读 `expiresAt` 会把续租中的长迁移误判成死锁。
   */
  expiresAtMs(): number {
    return timeMs(this.lease.renewedUntil ?? this.lease.expiresAt, 'lease expiresAt')
  }

}
export function timeMs(value: unknown, label: string): number {
  return Date.parse(requireIsoTime(value, label))
}
function sha256(value: unknown, label: string): string {
  const text = requireText(value, label)
  if (!SHA256.test(text)) throw new Error(`[cluster-lifecycle] ${label} 非 64 位小写摘要`)
  return text
}
function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  return value === null || value === undefined ? undefined : requireRecord(value, label)
}

function leaseFrom(raw: Record<string, unknown>, label: string): TransitionLeaseRecord {
  if (raw.leaseSchema !== LEASE_SCHEMA || raw.status !== 'ACTIVE') {
    throw new Error(`[cluster-lifecycle] ${label} schema/status 非 ${LEASE_SCHEMA}/ACTIVE`)
  }
  const generation = requireInteger(raw.generation, `${label}.generation`)
  const leaseDurationMs = requireInteger(raw.leaseDurationMs, `${label}.leaseDurationMs`)
  if (generation < 1 || leaseDurationMs < 1) throw new Error(`[cluster-lifecycle] ${label} generation/duration 非正整数`)
  const acquiredAt = requireIsoTime(raw.acquiredAt, `${label}.acquiredAt`)
  const expiresAt = requireIsoTime(raw.expiresAt, `${label}.expiresAt`)
  if (Date.parse(expiresAt) - Date.parse(acquiredAt) !== leaseDurationMs) {
    throw new Error(`[cluster-lifecycle] ${label} expiresAt 与 duration 不一致`)
  }
  const from = requireText(raw.from, `${label}.from`) as LifecycleState
  const to = requireText(raw.to, `${label}.to`) as LifecycleState
  if (!LIFECYCLE_STATES.includes(from) || !LIFECYCLE_STATES.includes(to) || from === to) {
    throw new Error(`[cluster-lifecycle] ${label} 生命周期状态未知或相同:${from}->${to}`)
  }
  return {
    leaseSchema: LEASE_SCHEMA,
    status: 'ACTIVE',
    generation,
    token: requireSafeSegment(raw.token, `${label}.token`),
    identity: identityFrom(raw.identity, `${label}.identity`),
    from,
    to,
    metadata: optionalRecord(raw.metadata, `${label}.metadata`),
    result: optionalRecord(raw.result, `${label}.result`),
    sourceRecordSha256: sha256(raw.sourceRecordSha256, `${label}.sourceRecordSha256`),
    destinationRecordSha256: sha256(raw.destinationRecordSha256, `${label}.destinationRecordSha256`),
    acquiredAt,
    expiresAt,
    leaseDurationMs,
  }
}
/**
 * 只读屏障 / 迁移方巡检专用:**仅当 lease 目录本身已不在**时返回 `undefined`,其余一律照旧抛错。
 *
 * 【为什么需要它(2026-08-30,MAIN-CI-BASELINE-RED-FIX 实测)】屏障与巡检都是典型的
 * check-then-read:先 `directoryExists`/`readdirSync` 看到 lease 还在,再去读它的内容;而持锁方
 * 在这两步之间完成迁移并释放锁是**完全正常**的时序,此时读取必然 ENOENT。语义上"lease 目录
 * 已消失" ≡ "检查那一刻它就不在" ⇒ 该走放行分支,而不是把一次正常的并发释放报成故障。
 * 取证:clusterDispatchCanary 在高负载下偶发 exit 1,CLI stderr =
 * `读取 ACTIVE transition lease 目录失败:…\_transition-locks\…active:ENOENT`,
 * 三台机器中前两台已成功、只有最后一台撞进这个窗口。
 *
 * 【容忍面必须收得极窄——只认目录本身这一次 stat】目录还在、但里面的 `lease.json` 缺失,那是
 * **不完整/损坏的事务**,不是"已释放",必须继续失败关闭(clusterLifecycleAtomicMove 的
 * 「不完整 ACTIVE 事务让 wait 失败关闭」正是守这条;首版把两种 ENOENT 混为一谈,当场被它抓红)。
 * 同理,权限错误、非目录、schema/时间漂移也一律照旧抛出。
 *
 * ⚠ 持锁方的 `assertToken` 走严格版 `readLeaseDirectory`,**不得**改用本函数:
 * 那里 lease 消失意味着自己的锁已被新 owner fencing 掉,必须失败关闭。
 */
function readLeaseDirectoryIfPresent(path: string, label: string): TransitionLeaseRecord | undefined {
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(path) } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw new Error(`[cluster-lifecycle] 读取 ${label} 目录失败:${path}:${errorMessage(error)}`, { cause: error })
  }
  if (!stat.isDirectory()) throw new Error(`[cluster-lifecycle] ${label} 不是目录:${path}`)
  let raw: Record<string, unknown>
  try {
    raw = readJson(join(path, 'lease.json'), `${label} lease`)
  } catch (error) {
    /**
     * ⚠ 只兜 `readJson`(I/O + 解析)这一步。JSON 完整但 schema 不合法的,交给下面的
     * `leaseFrom` 照旧硬失败 —— 那是"真写坏了",不是"还没写完",两者必须分开。
     */
    throw new NascentTransitionLeaseError(
      `[cluster-lifecycle] ${label} 正在被建(提交标记 lease.json 未就位):${path}:${errorMessage(error)}`,
      stat.mtimeMs, DEFAULT_LEASE_DURATION_MS)
  }
  const lease = leaseFrom(raw, `${label} lease`)
  const renewalPath = join(path, `renewal.${lease.token}.json`)
  try {
    const renewalStat = statSync(renewalPath)
    if (!renewalStat.isFile()) throw new Error(`[cluster-lifecycle] lease renewal 不是普通文件:${renewalPath}`)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return lease
    throw new Error(`[cluster-lifecycle] 检查 lease renewal 失败:${renewalPath}:${errorMessage(error)}`, { cause: error })
  }
  const renewal = readJson(renewalPath, 'transition lease renewal')
  if (renewal.leaseSchema !== 'cluster-transition-renewal/v1' || renewal.status !== 'ACTIVE'
    || renewal.token !== lease.token || renewal.generation !== lease.generation) {
    throw new Error('[cluster-lifecycle] transition lease renewal schema/token/generation 漂移')
  }
  assertSameIdentity(identityFrom(renewal.identity, 'lease renewal identity'), lease.identity, 'lease renewal')
  const renewedAt = timeMs(renewal.renewedAt, 'lease renewedAt')
  const renewedUntil = requireIsoTime(renewal.renewedUntil, 'lease renewedUntil')
  if (renewedAt < timeMs(lease.acquiredAt, 'lease acquiredAt')
    || renewedAt > timeMs(lease.expiresAt, 'lease expiresAt')
    || timeMs(renewedUntil, 'lease renewedUntil') - renewedAt !== lease.leaseDurationMs
    || timeMs(renewedUntil, 'lease renewedUntil') <= timeMs(lease.expiresAt, 'lease expiresAt')) {
    throw new Error('[cluster-lifecycle] transition lease renewal 时间非法')
  }
  return { ...lease, renewedUntil }
}

/** 严格版:lease 必须在。持锁方(assertToken)用它——目录消失意味着锁已被 fencing,必须失败关闭。 */
function readLeaseDirectory(path: string, label: string): TransitionLeaseRecord {
  const lease = readLeaseDirectoryIfPresent(path, label)
  if (lease === undefined) {
    throw new Error(`[cluster-lifecycle] 读取 ${label} 目录失败:${path}:ENOENT`)
  }
  return lease
}

function directoryExists(path: string): boolean {
  try {
    const stat = statSync(path)
    if (!stat.isDirectory()) throw new Error(`[cluster-lifecycle] transition lease 路径不是目录:${path}`)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw new Error(`[cluster-lifecycle] 检查 transition lease 失败:${path}:${errorMessage(error)}`, { cause: error })
  }
}
function activePath(paths: LifecyclePaths, submissionId: string): string {
  return join(paths.transitionLocks, `${requireSafeSegment(submissionId, 'submissionId')}.active`)
}
function matchingTransientEntries(paths: LifecyclePaths, submissionId: string): string[] {
  const prefix = `${requireSafeSegment(submissionId, 'submissionId')}.`
  let entries: string[]
  try {
    entries = readdirSync(paths.transitionLocks)
  } catch (error) {
    // 新纪元尚未建过锁父目录等价于没有锁；只放行这一次父目录枚举的 ENOENT，锁内容损坏等错误仍失败关闭。
    if (hasCode(error, 'ENOENT')) return []
    throw new Error(`[cluster-lifecycle] 扫描 transition lease 失败:${errorMessage(error)}`, { cause: error })
  }
  return entries.filter(entry =>
    entry === `${submissionId}.takeover` || entry.startsWith(`${prefix}candidate.`))
}

/**
 * wait/read 只读屏障：ACTIVE/takeover 拒绝；未赢槽的 candidate 只是惰性暂存。
 *
 * 撞上仍挂着的锁一律抛 `ActiveTransitionLeaseError`(见该类注释):抛不抛、什么时候抛都不变,
 * 变的只是**错误里多带了那把锁**,好让轮询型调用方自己判活/判死。损坏事务(目录在、lease.json
 * 缺失)、权限错误、schema/时间漂移仍走普通 Error 一路失败关闭——那些不是"对面正在搬",
 * 不许被任何调用方当活锁等下去。
 */
export function assertNoActiveTransitionLease(paths: LifecyclePaths, submissionId: string): void {
  for (const entry of matchingTransientEntries(paths, submissionId)) {
    if (entry !== `${submissionId}.takeover`) continue
    // 列举之后才被释放掉的 takeover 不再构成屏障(理由见 readLeaseIfStillPresent)。
    const takeover = readLeaseDirectoryIfPresent(join(paths.transitionLocks, entry), '未完成 transition lease')
    if (takeover === undefined) continue
    throw new ActiveTransitionLeaseError(`[cluster-lifecycle] 未完成 transition lease:${entry}`, takeover)
  }
  const path = activePath(paths, submissionId)
  if (!directoryExists(path)) return
  const lease = readLeaseDirectoryIfPresent(path, 'ACTIVE transition lease')
  if (lease === undefined) return
  throw new ActiveTransitionLeaseError(
    `[cluster-lifecycle] ACTIVE transition lease:${lease.identity.submissionId}:${lease.token}`, lease)
}

/** 迁移方读取当前 lease；存在即返回，时间倒退或损坏都失败关闭。 */
export function inspectTransitionLease(
  paths: LifecyclePaths,
  submissionId: string,
  now: string,
): TransitionLeaseRecord | undefined {
  const nowMs = timeMs(now, 'transition now')
  const transient = matchingTransientEntries(paths, submissionId)
  if (transient.length !== 0
    && readLeaseDirectoryIfPresent(join(paths.transitionLocks, transient[0]!), '未完成 transition lease') !== undefined) {
    throw new Error(`[cluster-lifecycle] 未完成 transition lease:${transient.join(',')}`)
  }
  const path = activePath(paths, submissionId)
  if (!directoryExists(path)) return undefined
  const lease = readLeaseDirectoryIfPresent(path, 'ACTIVE transition lease')
  if (lease === undefined) return undefined
  if (lease.identity.submissionId !== submissionId) throw new Error('[cluster-lifecycle] lease submissionId 与路径漂移')
  if (nowMs < timeMs(lease.acquiredAt, 'lease acquiredAt')) throw new Error('[cluster-lifecycle] transition 时钟倒退')
  return lease
}

export function sameValue(left: unknown, right: unknown): boolean {
  return canonicalLifecycleJson(left ?? null) === canonicalLifecycleJson(right ?? null)
}

export function assertLeaseMatchesPlan(lease: TransitionLeaseRecord, plan: TransitionLeasePlan): void {
  assertSameIdentity(lease.identity, plan.identity, 'transition lease')
  if (lease.from !== plan.from || lease.to !== plan.to
    || !sameValue(lease.metadata, plan.metadata) || !sameValue(lease.result, plan.result)
    || lease.sourceRecordSha256 !== plan.sourceRecordSha256
    || lease.destinationRecordSha256 !== plan.destinationRecordSha256) {
    throw new Error('[cluster-lifecycle] transition lease 与本次迁移计划漂移')
  }
}

export function createTransitionLeasePlan(current: LifecycleStateRecord, next: LifecycleStateRecord,
  options: TransitionLifecycleJobOptions): TransitionLeasePlan {
  return {
    identity: current, from: options.from, to: options.to,
    metadata: options.metadata, result: options.result,
    sourceRecordSha256: lifecyclePayloadSha256(current),
    destinationRecordSha256: lifecyclePayloadSha256(next),
  }
}

function retiredTransitionDir(paths: LifecyclePaths): string {
  return join(paths.transitionLocks, RETIRED_TRANSITION_SUBDIR)
}

/**
 * 把同层一个已退役的锁目录挪进子目录。退役锁已完成使命,没有任何读路径依赖它的位置。
 * 用普通 rename 而不走搬运原语:原语只允许同一父目录内迁移,那条约束保护的是活锁,这里不放宽它。
 * 挪不动(共享盘占用等)只提醒,留在原处,下次迁移时再挪。
 */
function shelveRetiredTransitionLock(paths: LifecyclePaths, name: string): void {
  try {
    mkdirSync(retiredTransitionDir(paths), { recursive: true })
    renameSync(join(paths.transitionLocks, name), join(retiredTransitionDir(paths), name))
  } catch (error) {
    console.warn(`[cluster-lifecycle] 退役转移锁挪入子目录失败,留在原处下次再挪:${name}:${errorMessage(error)}`)
  }
}

/** 退役锁的时间:优先取锁里记的领取时间,读不到就用目录修改时间;都拿不到就不判,不删。 */
function retiredTransitionLockAtMs(path: string): number | undefined {
  try {
    const at = Date.parse(String(readJson(join(path, 'lease.json'), 'retired transition lease').acquiredAt))
    if (Number.isFinite(at)) return at
  } catch { /* 退回目录修改时间 */ }
  try { return statSync(path).mtimeMs } catch { return undefined }
}

/**
 * 写路径顺手整理退役锁。任何一步失败都只提醒,绝不影响本次迁移:
 * - 同层老退役锁每次最多挪 RETIRED_TRANSITION_MOVE_BATCH 个进子目录;
 * - 子目录里超过保留期的,同一目录每小时最多清理一次,每次最多删 RETIRED_TRANSITION_PRUNE_BATCH 个。
 */
function tidyRetiredTransitionLocks(paths: LifecyclePaths, nowMs: number, sources: LifecycleSources): void {
  try {
    const legacy = readdirSync(paths.transitionLocks).filter(name => name.includes('.retired.'))
    for (const name of legacy.slice(0, RETIRED_TRANSITION_MOVE_BATCH)) shelveRetiredTransitionLock(paths, name)
  } catch (error) {
    console.warn(`[cluster-lifecycle] 扫描同层退役转移锁失败:${errorMessage(error)}`)
  }
  const last = lastRetiredPruneMs.get(paths.transitionLocks)
  if (last !== undefined && nowMs >= last && nowMs - last < RETIRED_TRANSITION_PRUNE_INTERVAL_MS) return
  lastRetiredPruneMs.set(paths.transitionLocks, nowMs)
  const dir = retiredTransitionDir(paths)
  let names: string[]
  try { names = existsSync(dir) ? readdirSync(dir) : [] } catch (error) {
    console.warn(`[cluster-lifecycle] 扫描退役转移锁子目录失败:${errorMessage(error)}`)
    return
  }
  const remove = sources.removeRetiredTransitionLock ?? ((path: string) => rmSync(path, { recursive: true, force: true }))
  let removed = 0
  for (const name of names) {
    if (removed >= RETIRED_TRANSITION_PRUNE_BATCH) break
    const path = join(dir, name)
    const at = retiredTransitionLockAtMs(path)
    if (at === undefined || nowMs - at <= RETIRED_TRANSITION_RETENTION_MS) continue
    try {
      remove(path)
      removed++
    } catch (error) {
      console.warn(`[cluster-lifecycle] 清理过期退役转移锁失败,保留原处:${name}:${errorMessage(error)}`)
    }
  }
}

function writeCandidate(path: string, lease: TransitionLeaseRecord): void {
  try {
    mkdirSync(path)
    // 缺省暂存面 = candidate 的父目录 `_transition-locks`；那一层只被 matchingTransientEntries
    // 按前缀**过滤**（不是 fail-closed），临时文件不会被误当成锁。
    publishLifecycleFileAtomically(join(path, 'lease.json'), `${canonicalLifecycleJson(lease)}\n`, 'create-only')
  } catch (error) {
    throw new Error(`[cluster-lifecycle] transition lease candidate 发布失败:${path}:${errorMessage(error)}`, { cause: error })
  }
}

function assertToken(path: string, expected: TransitionLeaseRecord): void {
  const current = readLeaseDirectory(path, 'ACTIVE transition lease')
  assertSameIdentity(current.identity, expected.identity, 'ACTIVE transition lease')
  if (current.generation !== expected.generation || current.token !== expected.token) {
    throw new Error('[cluster-lifecycle] transition lease token 已被新 owner fencing')
  }
}

export function acquireTransitionLease(options: {
  paths: LifecyclePaths
  plan: TransitionLeasePlan
  observed?: TransitionLeaseRecord
  sources: LifecycleSources
  leaseDurationMs?: number
}): TransitionLeaseHandle {
  const { paths, plan, observed, sources } = options
  const duration = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS
  if (!Number.isInteger(duration) || duration < 1) throw new Error('[cluster-lifecycle] leaseDurationMs 必须是正整数')
  const acquiredAt = requireIsoTime(sources.now(), 'lease acquiredAt')
  const acquiredMs = timeMs(acquiredAt, 'lease acquiredAt')
  const token = requireSafeSegment(sources.nonce(), 'lease token')
  const current = inspectTransitionLease(paths, plan.identity.submissionId, acquiredAt)
  if (observed === undefined ? current !== undefined : current === undefined) {
    throw new Error('[cluster-lifecycle] transition lease 在获取前发生变化')
  }
  if (observed !== undefined && current !== undefined) {
    assertLeaseMatchesPlan(current, observed)
    if (current.token !== observed.token || current.generation !== observed.generation) {
      throw new Error('[cluster-lifecycle] stale lease 已被其他 owner 接管')
    }
    if (acquiredMs <= timeMs(current.renewedUntil ?? current.expiresAt, 'lease expiresAt')) {
      throw new Error('[cluster-lifecycle] ACTIVE transition lease 尚未过期')
    }
  }
  tidyRetiredTransitionLocks(paths, acquiredMs, sources)
  const lease: TransitionLeaseRecord = {
    leaseSchema: LEASE_SCHEMA, status: 'ACTIVE', generation: (observed?.generation ?? 0) + 1,
    token, identity: plan.identity, from: plan.from, to: plan.to,
    metadata: plan.metadata, result: plan.result,
    sourceRecordSha256: plan.sourceRecordSha256,
    destinationRecordSha256: plan.destinationRecordSha256,
    acquiredAt, expiresAt: new Date(acquiredMs + duration).toISOString(), leaseDurationMs: duration,
  }
  const active = activePath(paths, plan.identity.submissionId)
  const candidate = join(paths.transitionLocks, `${plan.identity.submissionId}.candidate.${token}`)
  const takeover = join(paths.transitionLocks, `${plan.identity.submissionId}.takeover`)
  const retirementPath = join(paths.transitionLocks, `${plan.identity.submissionId}.retired.${lease.generation}.${token}`)
  const observedRetirement = observed === undefined ? undefined : join(paths.transitionLocks,
    `${plan.identity.submissionId}.retired.${observed.generation}.${observed.token}`)
  writeCandidate(candidate, lease)
  try {
    if (observedRetirement === undefined) {
      moveLifecycleDirectoryNoReplace(candidate, active, 'transition candidate -> active')
    } else {
      moveLifecycleDirectoryNoReplace(candidate, takeover, 'transition candidate -> takeover')
      assertToken(takeover, lease)
      moveLifecycleDirectoryNoReplace(active, observedRetirement, 'transition active -> retired')
      assertToken(takeover, lease)
      moveLifecycleDirectoryNoReplace(takeover, active, 'transition takeover -> active')
    }
  } catch (error) {
    throw new Error(`[cluster-lifecycle] transition lease 原子获取失败:${errorMessage(error)}`, { cause: error })
  }
  // 接管的原子序列全部走完,才把被接管的那把旧锁挪进子目录,不打断上面那一串必须一气呵成的搬运。
  if (observedRetirement !== undefined) shelveRetiredTransitionLock(paths, basename(observedRetirement))
  const assertOwned = () => assertToken(active, lease)
  const renewLease = () => {
    assertOwned()
    const renewedAt = requireIsoTime(sources.now(), 'lease renewedAt')
    const current = readLeaseDirectory(active, 'ACTIVE transition lease')
    const currentExpiry = timeMs(current.renewedUntil ?? current.expiresAt, 'lease expiresAt')
    if (timeMs(renewedAt, 'lease renewedAt') < timeMs(lease.acquiredAt, 'lease acquiredAt')) {
      throw new Error('[cluster-lifecycle] transition 续租时钟倒退')
    }
    if (timeMs(renewedAt, 'lease renewedAt') > currentExpiry) {
      throw new Error('[cluster-lifecycle] 已过期 token 不得续租')
    }
    const renewedUntil = new Date(timeMs(renewedAt, 'lease renewedAt') + duration).toISOString()
    if (timeMs(renewedUntil, 'lease renewedUntil') <= currentExpiry) throw new Error('[cluster-lifecycle] 续租必须延长有效期')
    /**
     * 【为什么不再是裸 writeFileSync(CLUSTER-CONTROL-ATOMIC-PUBLISH,2026-09-02)】
     * 续租凭据是**塞进一个已经发布出去的 lease 目录**的,绕过了本模块"最后写 lease.json 当提交
     * 标记、读侧看不到它就整体不认"的约定。而 `flag:'wx'` 只保证"不覆盖",不保证"要么看不见、
     * 要么是完整的":它先创建空文件再写内容,读者(readLeaseDirectoryIfPresent 先 statSync
     * 再 readJson)正好卡在中间就会读到空串并解析失败。改走原子发布,`create-only` 用硬链接
     * 逐字保住 wx 那条"目标已存在则 EEXIST"的语义,而目标一出现就是完整内容。
     */
    publishLifecycleFileAtomically(join(active, `renewal.${lease.token}.json`), `${canonicalLifecycleJson({
      leaseSchema: 'cluster-transition-renewal/v1', status: 'ACTIVE', generation: lease.generation,
      token: lease.token, identity: lease.identity, renewedAt, renewedUntil,
    })}\n`, 'create-only')
    assertOwned()
  }
  const release = () => {
    assertOwned()
    moveLifecycleDirectoryNoReplace(active, retirementPath, 'transition active -> retirement')
    shelveRetiredTransitionLock(paths, basename(retirementPath))
  }
  return { lease, retirementPath, assertOwned, renewLease, release }
}
