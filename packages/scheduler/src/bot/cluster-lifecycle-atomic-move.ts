import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { publishLifecycleFileAtomically } from './cluster-lifecycle-atomic-file'
import {
  LIFECYCLE_NAMESPACE,
  canonicalLifecycleJson,
  productionSources,
  readJson,
  requireIsoTime,
  requireRecord,
  requireSafeSegment,
  requireText,
  type LifecycleSources,
} from './cluster-lifecycle-contract'

const COMMIT_FILE = 'lease.json'
const LOCK_SCHEMA = 'cluster-lifecycle-operator-lock/v1' as const

/**
 * 锁的默认存活时长(CLUSTER-OPERATOR-LOCK-STARVE-AND-LEAK,2026-09-02 拍板 5 分钟)。
 *
 * 超过它仍未释放即视为僵尸,后来者可原子回收。没有这道过期,持锁进程一崩/被 Ctrl+C/被计划任务
 * 强杀,锁就永远留在共享盘上,**谁都再也派不了活,只能人工去删目录**(0902 现场:一把锁被攥了
 * 45 分钟,而当时的代码无从判断它是活的还是僵尸)。5 分钟是「正常临界区只有几秒」的 60 倍余量。
 */
export const DEFAULT_OPERATOR_LOCK_LEASE_MS = 5 * 60_000
/** 抢不到锁时的默认等待上限:到点才失败,不是当场硬失败(skill 8.G:超配额的申请排队等而非失败)。 */
export const DEFAULT_OPERATOR_LOCK_WAIT_MS = 90_000
/** 两次重试之间的默认间隔。 */
export const DEFAULT_OPERATOR_LOCK_POLL_MS = 1_000

export interface LifecycleOperatorLock {
  share: string
  token: string
  owner: string
  acquiredAt: string
  expiresAt: string
}

export interface OperatorLockOptions {
  readonly leaseMs?: number
  readonly waitMs?: number
  readonly pollMs?: number
  readonly sources?: LifecycleSources
  /** 同步睡眠;默认走 Atomics.wait,测试注入以免真等。 */
  readonly sleep?: (ms: number) => void
  /** 本次持锁干什么(如 `--job test` / `--round blowup-recheck`),写进 lease 供撞锁方判断。 */
  readonly purpose?: string
  /**
   * 回收锁目录的改名动作;默认 `renameSync`。**只为测试留的窄口**:
   * 共享盘上的 EPERM 只能靠「另一个进程攥着 lease.json」才复现得出来(2026-09-05 真机实测),
   * 单测里造不出这个条件,而「回收失败怎么对人说话」恰恰是本模块最要紧的一段。
   */
  readonly renameDirectory?: (source: string, destination: string) => void
  /** 读 lease.json;默认 `readJson`。同上,测试注入以模拟共享盘上的占用型读失败。 */
  readonly readLeaseJson?: (path: string, label: string) => Record<string, unknown>
}

interface DirectoryEntrySnapshot {
  name: string
  bytes: Buffer
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function comparablePath(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLocaleLowerCase('en-US') : absolute
}

function validateMovePaths(sourcePath: string, destinationPath: string): { source: string; destination: string } {
  if (!isAbsolute(sourcePath) || !isAbsolute(destinationPath)) {
    throw new Error('[cluster-lifecycle] atomic move 路径必须为绝对路径')
  }
  const source = resolve(sourcePath)
  const destination = resolve(destinationPath)
  if (comparablePath(source) === comparablePath(destination)) {
    throw new Error('[cluster-lifecycle] atomic move 源与目标不得相同')
  }
  if (comparablePath(dirname(source)) !== comparablePath(dirname(destination))) {
    throw new Error('[cluster-lifecycle] atomic move 只允许同一 lifecycle 父目录内迁移')
  }
  if (basename(source) === '' || basename(destination) === '') {
    throw new Error('[cluster-lifecycle] atomic move 源或目标末级名为空')
  }
  return { source, destination }
}

function snapshotDirectory(path: string, label: string): DirectoryEntrySnapshot[] {
  const root = lstatSync(path)
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`[cluster-lifecycle] ${label} 不是实体目录:${path}`)
  }
  const entries = readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
  const snapshot = entries.map(entry => {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`[cluster-lifecycle] ${label} 含非普通文件:${entry.name}`)
    }
    return { name: entry.name, bytes: readFileSync(join(path, entry.name)) }
  })
  if (!snapshot.some(entry => entry.name === COMMIT_FILE)) {
    throw new Error(`[cluster-lifecycle] ${label} 缺少提交标记:${COMMIT_FILE}`)
  }
  return snapshot
}

function assertSameSnapshot(
  actual: DirectoryEntrySnapshot[],
  expected: DirectoryEntrySnapshot[],
  label: string,
): void {
  if (actual.length !== expected.length) {
    throw new Error(`[cluster-lifecycle] ${label} 文件数漂移:${actual.length}/${expected.length}`)
  }
  for (let index = 0; index < expected.length; index++) {
    const before = expected[index]!
    const after = actual[index]!
    if (before.name !== after.name || !before.bytes.equals(after.bytes)) {
      throw new Error(`[cluster-lifecycle] ${label} 字节漂移:${before.name}/${after.name}`)
    }
  }
}

/**
 * 同一 lifecycle 父目录内的 fail-closed move-no-replace。
 *
 * `mkdir(destination)` 是唯一目标槽竞争点，既有 file/dir 都会原样拒绝。`lease.json`
 * 沿用为读侧结构提交标记并最后写入；复制、复核或删源任一步失败都不清理现场，使读侧继续拒绝。
 */
export function moveLifecycleDirectoryNoReplace(
  sourcePath: string,
  destinationPath: string,
  label: string,
): void {
  const { source, destination } = validateMovePaths(sourcePath, destinationPath)
  let sourceSnapshot: DirectoryEntrySnapshot[]
  try {
    sourceSnapshot = snapshotDirectory(source, `${label} source`)
    mkdirSync(destination)
    for (const entry of sourceSnapshot) {
      if (entry.name === COMMIT_FILE) continue
      publishLifecycleFileAtomically(join(destination, entry.name), entry.bytes, 'create-only')
    }
    const commit = sourceSnapshot.find(entry => entry.name === COMMIT_FILE)!
    publishLifecycleFileAtomically(join(destination, commit.name), commit.bytes, 'create-only')
    assertSameSnapshot(snapshotDirectory(source, `${label} source verify`),
      sourceSnapshot, `${label} source`)
    assertSameSnapshot(snapshotDirectory(destination, `${label} destination verify`),
      sourceSnapshot, `${label} destination`)
    rmSync(source, { recursive: true })
  } catch (error) {
    throw new Error(`[cluster-lifecycle] ${label} move-no-replace 失败:${errorMessage(error)}`, { cause: error })
  }
}

function operatorRoot(share: string): string {
  return join(share, LIFECYCLE_NAMESPACE, '_control')
}

function activeLockPath(share: string): string {
  return join(operatorRoot(share), 'operator-lock')
}

function activeLeasePath(share: string): string {
  return join(activeLockPath(share), COMMIT_FILE)
}

function leaseTimeMs(value: string, label: string): number {
  const ms = Date.parse(requireIsoTime(value, label))
  if (!Number.isFinite(ms)) throw new Error(`[cluster-lifecycle] ${label} 不是可解析的时刻:${value}`)
  return ms
}

function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

interface ErrnoInfo {
  code: string
  detail: string
}

/**
 * 顺着 `cause` 链找第一个带 errno 的错误。**必须挖 cause**:`readJson` 会把 fs 异常包一层
 * 自己的说明再抛,只看最外层永远看不到 `EBUSY`,于是「文件被占着」会被误判成「内容不合法」。
 */
function errnoInfoOf(error: unknown): ErrnoInfo | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    const code = (current as NodeJS.ErrnoException).code
    if (typeof code === 'string' && code !== '') return { code, detail: current.message }
    current = current.cause
  }
  return undefined
}

interface ActiveOperatorLease {
  token: string
  owner: string
  acquiredAt: string
  /** v1 存量锁没有这些字段(0902 共享盘上那把就是),读侧一律容忍缺失。 */
  expiresAt?: string
  machine?: string
  pid?: number
  purpose?: string
}

/**
 * 锁槽的四态。区分这四种是必须的,因为**只有两种值得等**:
 * · `held` 有人合法持锁 —— 等,或到期回收;
 * · `unreadable` 读不出来(EBUSY/EPERM/EACCES…) —— 也要等:文件被占住是**会过去的**,
 *   把它当污染而当场失败,等于把一次瞬时读冲突谎报成「控制面被人塞了东西」(0905 真机实测踩到);
 * · `foreign` 读出来了但内容不合法 —— 这才是真占位物,不会自己消失,当场失败让人来看;
 * · `absent` 锁位空着(含读的这一刻锁目录整个消失)—— 再试一轮就能抢到。
 */
type ActiveLockProbe =
  | { kind: 'absent' }
  | { kind: 'unreadable'; code: string; detail: string }
  | { kind: 'foreign'; reason: string }
  | { kind: 'held'; lease: ActiveOperatorLease }

type LeaseReader = (path: string, label: string) => Record<string, unknown>

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function optionalPid(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function probeActiveOperatorLock(share: string, readLease: LeaseReader): ActiveLockProbe {
  const path = activeLockPath(share)
  if (!existsSync(path)) return { kind: 'absent' } // 刚被放开/正在换手 ⇒ 值得再试一轮
  let raw: Record<string, unknown>
  try {
    raw = readLease(join(path, COMMIT_FILE), 'active operator lock')
  } catch (error) {
    const errno = errnoInfoOf(error)
    if (errno?.code === 'ENOENT' || errno?.code === 'ENOTDIR') {
      // 「找不到」有两种,结论正相反:锁目录在读的这一刻被别人整个搬走了 = 锁位空了,再试一轮就能抢到;
      // 锁位**还在**却没有 lease.json = 有人往锁位塞了别的东西(文件/野目录),那是占位物,当场失败。
      if (!existsSync(path)) return { kind: 'absent' }
      return { kind: 'foreign', reason: `锁位还在却读不到 ${COMMIT_FILE}(${errno.detail})` }
    }
    if (errno !== undefined) return { kind: 'unreadable', code: errno.code, detail: errno.detail }
    // 没有 errno = 不是「读不出来」而是「读出来的东西不对」(JSON 坏了),那是真占位物。
    return { kind: 'foreign', reason: `读不出 ${COMMIT_FILE}(${errorMessage(error)})` }
  }
  if (raw.schema !== LOCK_SCHEMA) return { kind: 'foreign', reason: `schema 不是 ${LOCK_SCHEMA}` }
  try {
    const expiresAt = raw.expiresAt
    const machine = optionalText(raw.machine)
    const pid = optionalPid(raw.pid)
    const purpose = optionalText(raw.purpose)
    return {
      kind: 'held',
      lease: {
        token: requireText(raw.token, 'operator lock token'),
        owner: requireText(raw.owner, 'operator lock owner'),
        acquiredAt: requireIsoTime(raw.acquiredAt, 'operator lock acquiredAt'),
        ...(expiresAt === undefined ? {} : { expiresAt: requireIsoTime(expiresAt, 'operator lock expiresAt') }),
        ...(machine === undefined ? {} : { machine }),
        ...(pid === undefined ? {} : { pid }),
        ...(purpose === undefined ? {} : { purpose }),
      },
    }
  } catch (error) {
    return { kind: 'foreign', reason: `lease 字段不合法(${errorMessage(error)})` }
  }
}

/**
 * 锁的失效时刻。存量 v1 锁没写 expiresAt,按 `acquiredAt + 租期` 推算——否则冷切换那天留在共享盘上的
 * 旧锁会永远堵着,新代码反而不敢碰它。
 */
function operatorLeaseExpiryMs(lease: ActiveOperatorLease, leaseMs: number): number {
  if (lease.expiresAt !== undefined) return leaseTimeMs(lease.expiresAt, 'operator lock expiresAt')
  return leaseTimeMs(lease.acquiredAt, 'operator lock acquiredAt') + leaseMs
}

/**
 * 回收一把过期锁的四种结局。**`raced` 与 `blocked` 必须分开**——这正是本卡治的病:
 * 从前两者都被一个光秃秃的 `catch {}` 压成 `false`,调用方无从区分
 * 「别人抢先了(该重试)」和「本机根本改不动它(重试无用)」,于是只能一路空等到超时,
 * 还对人说「再重试就会自动回收接管」——0905 真机实测,那句话在 EPERM 场景下是反的。
 */
type ReclaimOutcome =
  | { kind: 'reclaimed' }
  | { kind: 'raced' }
  | { kind: 'blocked'; code: string; detail: string }
  | { kind: 'skipped' }

/**
 * 回收过期锁。**取走而不是删掉**:改名的源只有一个,并发回收里恰好一方成功、另一方
 * ENOENT 落空后继续重试,不会出现两个人同时认为自己回收成功;僵尸锁的现场也留在
 * `operator-lock-reclaimed-*` 里可查。
 */
function reclaimExpiredOperatorLock(
  share: string, nowMs: number, leaseMs: number, sources: LifecycleSources,
  lease: ActiveOperatorLease, rename: (source: string, destination: string) => void,
): ReclaimOutcome {
  if (nowMs < operatorLeaseExpiryMs(lease, leaseMs)) return { kind: 'skipped' }
  const nonce = requireSafeSegment(sources.nonce(), 'operator lock reclaim nonce')
  try {
    rename(activeLockPath(share), join(operatorRoot(share), `operator-lock-reclaimed-${nonce}`))
  } catch (error) {
    const errno = errnoInfoOf(error)
    if (errno?.code === 'ENOENT') return { kind: 'raced' } // 别人先回收了,下一轮就能抢到
    return { kind: 'blocked', code: errno?.code ?? 'UNKNOWN', detail: errno?.detail ?? errorMessage(error) }
  }
  return { kind: 'reclaimed' }
}

/** 单次抢锁。抢不到返回 undefined —— 失败路径**必须**把自己刚建的 candidate 清干净。 */
function tryAcquireOperatorLock(
  share: string, owner: string, leaseMs: number, sources: LifecycleSources, purpose?: string,
): LifecycleOperatorLock | undefined {
  const token = requireSafeSegment(sources.nonce(), 'operator lock token')
  const acquiredAt = requireIsoTime(sources.now(), 'operator lock acquiredAt')
  const expiresAt = new Date(leaseTimeMs(acquiredAt, 'operator lock acquiredAt') + leaseMs).toISOString()
  const candidate = join(operatorRoot(share), `operator-lock-candidate-${token}`)
  // machine/pid/purpose 是给**撞锁的人**看的:光有 token 和一个字母的 owner,
  // 判不出持锁者还活着没有,只能靠人去扫全机进程(0902 现场就是这么过的)。
  const lease = {
    schema: LOCK_SCHEMA, token, owner, acquiredAt, expiresAt,
    machine: hostname(), pid: process.pid,
    ...(purpose === undefined ? {} : { purpose: requireText(purpose, 'operator lock purpose') }),
  }
  try {
    mkdirSync(candidate)
    publishLifecycleFileAtomically(join(candidate, COMMIT_FILE),
      `${canonicalLifecycleJson(lease)}\n`, 'create-only')
    moveLifecycleDirectoryNoReplace(candidate, activeLockPath(share), 'operator lock acquire')
  } catch {
    // 0902 共享盘上堆的 193 个 operator-lock-candidate-* 全是这一步没清理留下的残骸。
    rmSync(candidate, { recursive: true, force: true })
    return undefined
  }
  const active = readJson(activeLeasePath(share), 'active operator lock')
  if (active.schema !== LOCK_SCHEMA || active.token !== token || active.owner !== owner
    || active.acquiredAt !== acquiredAt) throw new Error('[cluster-lifecycle] operator lock 身份漂移')
  return { share, token, owner, acquiredAt, expiresAt }
}

/**
 * 持锁进程还在不在。**只是提示,绝不作为回收判据**——回收的唯一依据仍然是 TTL 过期。
 * 跨机器的 pid 毫无意义,所以只在 machine 就是本机时才探;探不动(EPERM)一律当它还活着。
 */
function describeHolderProcess(lease: ActiveOperatorLease): string {
  if (lease.pid === undefined || lease.machine !== hostname()) return ''
  try {
    process.kill(lease.pid, 0)
  } catch (error) {
    if (errnoInfoOf(error)?.code === 'ESRCH') return ',该进程已不在'
  }
  return ''
}

function describeHolder(lease: ActiveOperatorLease): string {
  const fields = [`acquiredAt=${lease.acquiredAt}`]
  if (lease.machine !== undefined) fields.push(`machine=${lease.machine}`)
  if (lease.pid !== undefined) fields.push(`pid=${lease.pid}`)
  if (lease.purpose !== undefined) fields.push(`purpose=${lease.purpose}`)
  return `owner=${lease.owner}(${fields.join(',')}${describeHolderProcess(lease)})`
}

interface BlockerContext {
  held?: ActiveOperatorLease
  blocked?: ErrnoInfo
  unreadable?: ErrnoInfo
}

/**
 * 超时报错要说清「在等谁的锁、等了多久、为什么没能自动回收、下一步该干什么」。
 * 关键是**不许再无条件说「重试会自动回收接管」**:只有真的还没到期时那句话才成立;
 * 回收试过且被挡住时,重试一万次也没用,该说的是「本机现在改不动它,去查谁攥着那个文件」。
 * 全部素材取自等待期间记下来的最后一次观察,**不在报错路径上再读一次共享盘**
 * (读得到才有话说,而这条路径恰恰常常是「读不到」)。
 */
function describeOperatorLockBlocker(
  share: string, nowMs: number, leaseMs: number, waitedMs: number, context: BlockerContext,
): string {
  const parts = [`已等 ${Math.round(waitedMs / 1000)} 秒`]
  if (context.held !== undefined) parts.push(`当前持有者 ${describeHolder(context.held)}`)
  if (context.blocked !== undefined) {
    parts.push(`本机现在改不动这把锁(${context.blocked.code}):回收 operator-lock 那步失败`
      + `(${context.blocked.detail}),重试无用——请查是谁攥着 ${activeLeasePath(share)}`)
  }
  if (context.unreadable !== undefined) {
    parts.push(`锁位现在读不出(${context.unreadable.code}):${context.unreadable.detail}`
      + `——多半是有进程正攥着 ${activeLeasePath(share)},等它松手即可`)
  }
  if (context.blocked === undefined && context.unreadable === undefined) {
    if (context.held === undefined) {
      return `${parts.join(';')},但读不到当前持有者(锁可能正在换手),重试即可`
    }
    const leftSec = Math.max(0, Math.ceil((operatorLeaseExpiryMs(context.held, leaseMs) - nowMs) / 1000))
    parts.push(`再过 ${leftSec} 秒该锁即视为僵尸,届时重试会自动回收接管`)
  }
  return parts.join(';')
}

/**
 * 排他领取 operator lock。抢不到**不当场硬失败**,而是有界退避重试到 `waitMs`;
 * 期间见到过期锁就原子回收(见 reclaimExpiredOperatorLock)。
 *
 * 治的是 CLUSTER-OPERATOR-LOCK-STARVE-AND-LEAK 三连(并行会话互相饿死 / candidate 目录泄漏 /
 * 锁无过期回收)与 CLUSTER-OPERATOR-LOCK-FORENSICS(回收失败被吞、读冲突被误判成控制面污染)。
 * 注意本函数只保证「拿到锁」这件事的排他性——**临界区该多短就多短**,
 * 把只读的等待放进锁里会让所有人一起饿死(0902 已把 cluster-dispatch 的 --wait 移出锁外)。
 */
export function acquireLifecycleOperatorLock(
  share: string, ownerValue: string, options: OperatorLockOptions = {},
): LifecycleOperatorLock {
  const owner = requireText(ownerValue, 'operator lock owner')
  const sources = options.sources ?? productionSources
  const leaseMs = options.leaseMs ?? DEFAULT_OPERATOR_LOCK_LEASE_MS
  const waitMs = options.waitMs ?? DEFAULT_OPERATOR_LOCK_WAIT_MS
  const pollMs = options.pollMs ?? DEFAULT_OPERATOR_LOCK_POLL_MS
  const sleep = options.sleep ?? sleepSync
  const rename = options.renameDirectory ?? renameSync
  const readLease = options.readLeaseJson ?? readJson
  mkdirSync(operatorRoot(share), { recursive: true })

  const startedMs = leaseTimeMs(sources.now(), 'operator lock wait start')
  const deadlineMs = startedMs + waitMs
  const context: BlockerContext = {}
  for (;;) {
    const lock = tryAcquireOperatorLock(share, owner, leaseMs, sources, options.purpose)
    if (lock !== undefined) return lock
    const probe = probeActiveOperatorLock(share, readLease)
    // 读出来了但内容不合法 = 真占位物,不会自己消失,空等到超时只会把「控制面被污染」
    // 这个真问题伪装成一次等待失败(fail-closed:当场失败让人来看)。
    if (probe.kind === 'foreign') {
      throw new Error('[cluster-lifecycle] operator lock 排他领取失败:锁位被外来占位物占着'
        + `(${probe.reason})——这类占位不会自己消失,故不空等;请人工检查共享盘 _control/operator-lock`)
    }
    if (probe.kind === 'held') { context.held = probe.lease; context.unreadable = undefined }
    if (probe.kind === 'unreadable') context.unreadable = { code: probe.code, detail: probe.detail }
    const nowMs = leaseTimeMs(sources.now(), 'operator lock now')
    if (probe.kind === 'held') {
      const outcome = reclaimExpiredOperatorLock(share, nowMs, leaseMs, sources, probe.lease, rename)
      if (outcome.kind === 'reclaimed') continue
      if (outcome.kind === 'blocked') context.blocked = { code: outcome.code, detail: outcome.detail }
      if (outcome.kind === 'raced') context.blocked = undefined
    }
    if (nowMs >= deadlineMs) {
      throw new Error('[cluster-lifecycle] operator lock 排他领取失败:'
        + describeOperatorLockBlocker(share, nowMs, leaseMs, nowMs - startedMs, context))
    }
    sleep(pollMs)
  }
}

export function releaseLifecycleOperatorLock(lock: LifecycleOperatorLock): void {
  const probe = probeActiveOperatorLock(lock.share, readJson)
  if (probe.kind !== 'held') {
    throw new Error('[cluster-lifecycle] operator lock release 读不到活锁:'
      + '你手上这把多半已因超过租期未释放被后来者回收(现场留在 operator-lock-reclaimed-* 里)')
  }
  const active = probe.lease
  if (active.token !== lock.token || active.owner !== lock.owner || active.acquiredAt !== lock.acquiredAt) {
    throw new Error(`[cluster-lifecycle] operator lock release token 漂移:活锁现属 owner=${active.owner}`
      + ',你手上这把多半已因超过租期被回收后由别人接管')
  }
  moveLifecycleDirectoryNoReplace(
    activeLockPath(lock.share),
    join(operatorRoot(lock.share), `operator-lock-retired-${lock.token}`),
    'operator lock release',
  )
}

export interface OperatorLockInspectOptions {
  readonly sources?: LifecycleSources
  readonly leaseMs?: number
  /** 只替换读取边界,用于复现共享盘读失败;不替换解析和过期判据。 */
  readonly readLeaseText?: (path: string) => string
}

export type OperatorLockInspection = { path: string; observedAt: string } & (
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string; rawPreview?: string; rawTruncated: boolean }
  | { kind: 'held'; lease: ActiveOperatorLease; expiresAt: string; remainingMs: number; expired: boolean }
)

/** 只读锁位,不要求 ACTIVE 控制面。坏内容/读失败返回异常快照,不当成无人持锁。 */
export function inspectLifecycleOperatorLock(
  share: string, options: OperatorLockInspectOptions = {},
): OperatorLockInspection {
  const observedAt = requireIsoTime((options.sources ?? productionSources).now(), 'operator lock inspectedAt')
  const base = { path: activeLockPath(share), observedAt }
  const readText = options.readLeaseText ?? ((path: string) => readFileSync(path, 'utf8'))
  let rawText: string | undefined
  const invalid = (reason: string): OperatorLockInspection => ({
    ...base, kind: 'invalid', reason,
    rawPreview: rawText?.slice(0, 1024), rawTruncated: (rawText?.length ?? 0) > 1024,
  })
  let lockType: 'directory' | 'file' | 'other'
  try {
    const entry = lstatSync(base.path)
    lockType = entry.isSymbolicLink() ? 'other' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
  } catch (error) {
    const errno = errnoInfoOf(error)
    if (errno?.code === 'ENOENT') return { ...base, kind: 'absent' }
    return invalid(`${errno?.code ?? 'UNKNOWN'}:${errorMessage(error)}`)
  }
  try {
    if (lockType !== 'directory') {
      if (lockType === 'file') rawText = readText(base.path)
      return invalid('锁位不是实体目录')
    }
    // 与抢锁方共用 schema、身份和旧版租期口径,原文仅在检查入口留作故障证据。
    const probe = probeActiveOperatorLock(share, path => {
      rawText = readText(path)
      const raw = requireRecord(JSON.parse(rawText), 'operator lock')
      for (const field of ['machine', 'purpose'] as const) {
        if (raw[field] !== undefined) requireText(raw[field], `operator lock ${field}`)
      }
      if (raw.pid !== undefined && optionalPid(raw.pid) === undefined) throw new Error('operator lock pid 不合法')
      return raw
    })
    if (probe.kind === 'absent') return { ...base, kind: 'absent' }
    if (probe.kind === 'foreign') return invalid(probe.reason)
    if (probe.kind === 'unreadable') return invalid(`${probe.code}:${probe.detail}`)
    const expiresMs = operatorLeaseExpiryMs(probe.lease, options.leaseMs ?? DEFAULT_OPERATOR_LOCK_LEASE_MS)
    const remainingMs = Math.max(0, expiresMs - leaseTimeMs(observedAt, 'operator lock inspectedAt'))
    return { ...base, kind: 'held', lease: probe.lease, expiresAt: new Date(expiresMs).toISOString(),
      remainingMs, expired: remainingMs === 0 }
  } catch (error) {
    return invalid(`${errnoInfoOf(error)?.code ?? 'INVALID'}:${errorMessage(error)}`)
  }
}

export interface OperatorLockReclaimOptions extends OperatorLockInspectOptions {
  readonly forceUnexpired?: boolean
  readonly renameDirectory?: (source: string, destination: string) => void
}

export type OperatorLockReclaimResult =
  | { kind: 'reclaimed'; archivePath: string }
  | { kind: 'absent' | 'refused' | 'blocked'; reason: string }

/**
 * 手工摘除检查过的锁。归档前复核身份,换手/异常即拒绝;默认仅到期可摘。
 * 沿用自动回收的同目录 rename 和命名,不删文件、不改 lease,共享盘失败保留现场并返回原因。
 */
export function reclaimLifecycleOperatorLock(
  share: string, inspected: OperatorLockInspection, options: OperatorLockReclaimOptions = {},
): OperatorLockReclaimResult {
  if (inspected.path !== activeLockPath(share)) return { kind: 'refused', reason: '查锁路径与摘锁路径不一致' }
  if (inspected.kind === 'absent') return { kind: 'absent', reason: '没有锁可摘' }
  if (inspected.kind === 'invalid') return { kind: 'refused', reason: '锁文件异常,无法确认身份和到期时刻,拒绝摘锁' }
  const current = inspectLifecycleOperatorLock(share, options)
  if (current.kind === 'absent') return { kind: 'absent', reason: '没有锁可摘(已被其他操作移走)' }
  if (current.kind !== 'held' || canonicalLifecycleJson(current.lease) !== canonicalLifecycleJson(inspected.lease)) {
    return { kind: 'refused', reason: '锁在检查后发生变化或已不可读,拒绝摘锁;请重新查锁' }
  }
  if (!current.expired && options.forceUnexpired !== true) {
    return { kind: 'refused', reason: '锁未过期,拒绝摘锁;提前摘锁必须显式带 --force-unexpired-operator-lock' }
  }
  const rename = options.renameDirectory ?? renameSync
  try {
    const nonce = requireSafeSegment((options.sources ?? productionSources).nonce(), 'operator lock reclaim nonce')
    const archivePath = join(operatorRoot(share), `operator-lock-reclaimed-${nonce}`)
    if (existsSync(archivePath)) return { kind: 'refused', reason: `归档位置已存在,拒绝覆盖:${archivePath}` }
    rename(activeLockPath(share), archivePath)
    return { kind: 'reclaimed', archivePath }
  } catch (error) {
    const errno = errnoInfoOf(error)
    if (errno?.code === 'ENOENT' && inspectLifecycleOperatorLock(share, options).kind === 'absent') {
      return { kind: 'absent', reason: '没有锁可摘(已被其他操作移走)' }
    }
    return { kind: 'blocked', reason: `归档失败(${errno?.code ?? 'UNKNOWN'}):${errorMessage(error)};`
      + '请检查共享盘权限或文件占用,现场未主动删除' }
  }
}
