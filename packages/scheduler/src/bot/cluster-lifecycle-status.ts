import { readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import {
  LIFECYCLE_NAMESPACE,
  LIFECYCLE_SCHEMA,
  LIFECYCLE_STATES,
  SHA256,
  assertArrayExactly,
  errorMessage,
  hasCode,
  identityFrom,
  lifecyclePayloadSha256,
  readJson,
  requireAgentProtocol,
  requireInteger,
  requireIsoTime,
  requireRecord,
  requireSafeSegment,
  requireSha1,
  requireText,
  type LifecycleControl,
  type LifecycleState,
} from './cluster-lifecycle-contract'
import { lifecyclePaths, readActiveLifecycleControl } from './cluster-lifecycle-control'
import {
  legacyBootstrapState,
  legacyQueueSnapshot,
  type LegacyQueueSnapshot,
} from './cluster-lifecycle-legacy'
import { TransitionLeaseBarrierError } from './cluster-lifecycle-lease'
// 类型从状态层导入后再转出(本文件 620 行那处包装也要 new 它):既避开状态层反向依赖状态扫描的环,
// 又让派单员既有的导入路径(cluster-lifecycle-status)一字不变。
import { LifecycleStateConflictError, readLifecycleStateRecord } from './cluster-lifecycle-state'
import { verifyLifecycleExactReceipt, verifyLifecycleReceiptMachine } from './cluster-lifecycle-maintenance'
import type { OperatorLockInspection } from './cluster-lifecycle-atomic-move'
import { OWNER_STALE_MS } from './cluster-owner'
import type { AgentLoad, AgentMemoryLoad } from './cluster-agent-load'
import type { AgentAttemptLoad, AgentCiTreeLoad } from './cluster-agent-attempt-load'
import { attemptId, isoTime, ticketId } from '../sched/sched-contract'

/** 每项一行,原文用 JSON 转义保留换行/控制字符,可直接粘贴进排障工单。 */
export function formatLifecycleOperatorLockStatus(snapshot: OperatorLockInspection): string {
  const lines = [`锁位置:${snapshot.path}`, `检查时刻:${snapshot.observedAt}`]
  if (snapshot.kind === 'absent') return [...lines, '锁状态:没人占'].join('\n')
  if (snapshot.kind === 'invalid') {
    return [...lines, `锁状态:锁文件异常;到期与可回收状态未知`, `异常原因:${snapshot.reason}`,
      `原始内容片段:${snapshot.rawPreview === undefined ? '无法读取' : JSON.stringify(snapshot.rawPreview)}`
        + (snapshot.rawTruncated ? ' (已截断,仅显示前 1024 字符)' : '')].join('\n')
  }
  const { lease } = snapshot
  return [...lines, `锁状态:有人占;${snapshot.expired ? '已过期,可回收' : '未过期'}`,
    `持有者:${JSON.stringify(lease.owner)}`, `机器名:${lease.machine === undefined ? '未记录' : JSON.stringify(lease.machine)}`,
    `进程号:${lease.pid ?? '未记录'}`, `用途:${lease.purpose === undefined ? '未记录' : JSON.stringify(lease.purpose)}`,
    `获取时刻:${lease.acquiredAt}`, `到期时刻:${snapshot.expiresAt}`,
    `剩余租期:${snapshot.remainingMs} 毫秒 (${Math.ceil(snapshot.remainingMs / 1000)} 秒)`].join('\n')
}

export const CUTOVER_RECEIPT_SCHEMA = 'cluster-lifecycle-cutover-receipt/v2' as const
export const COLD_CUTOVER_RECEIPT_SCHEMA = 'cluster-lifecycle-cold-cutover-receipt/v1' as const
const AGENT_STATES = new Set(['idle', 'maintenance', 'running', 'installing-deps', 'self-upgrading', 'crashed', 'code-mismatch'])

/**
 * 同单双态的可识别类型,定义在状态层(cluster-lifecycle-state.ts,那里要抛它,反向导入会成环),
 * 这里原样转出——派单员既有的导入路径(本文件)一字不变,拿到的仍是同一个类。
 * 「为什么只放宽同单双态、其余照旧 fail-closed」的完整口径见状态层里的类型注释。
 */
export { LifecycleStateConflictError }

export interface LifecycleAgentIdentitySnapshot {
  machine: string
  state: string
  at: string
  pid: number
  /** 这台机器实际跑着的代理协议号,原样透传;写死成常量会让 --status 报假号。 */
  protocol: number
  head: string
  ownerPid: number
  ownerToken: string
  /** 提示性运行状态,不参与身份链校验;老代理或无效提示字段均省略。 */
  ciYield?: { ciWorkers: number; since: string }
  load?: AgentLoad
  jobSlots?: { max: number; running: number }
  attemptLoad?: AgentAttemptLoad
  ciTreeLoad?: AgentCiTreeLoad
}

export interface LifecycleMachineStatus {
  machine: string
  /** 未上线或单机身份记录异常时不可选机；异常原因见 fault。 */
  heartbeat: LifecycleAgentIdentitySnapshot | undefined
  fault?: { kind: 'record-corrupt' | 'identity-drift' | 'record-missing'; reason: string }
  counts: Record<LifecycleState, number>
}

export interface LifecycleStatusSnapshot {
  control: LifecycleControl
  machines: LifecycleMachineStatus[]
}

export function readAgentJobSlots(heartbeat: Record<string, unknown>): LifecycleAgentIdentitySnapshot['jobSlots'] {
  const slots = heartbeat.jobSlots
  if (typeof slots !== 'object' || slots === null || Array.isArray(slots)) return undefined
  const { schema, max, running } = slots as Record<string, unknown>
  if (schema !== 1 || typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 64
    || typeof running !== 'number' || !Number.isInteger(running) || running < 0 || running > max) return undefined
  return { max, running }
}

export function readAgentAttemptLoad(heartbeat: Record<string, unknown>): AgentAttemptLoad | undefined {
  const load = heartbeat.attemptLoad
  if (!isLoadRecord(load) || load.schema !== 1 || typeof load.sampledAt !== 'string' || load.windowSec !== 30
    || !Array.isArray(load.attempts) || load.attempts.length > 64) return undefined
  const seen = new Set<string>()
  const attempts: AgentAttemptLoad['attempts'] = []
  try {
    isoTime(load.sampledAt)
    for (const entry of load.attempts) {
      if (!isLoadRecord(entry) || typeof entry.cores !== 'number' || !Number.isFinite(entry.cores) || entry.cores < 0) return undefined
      const id = ticketId(entry.ticketId)
      const attempt = attemptId(entry.attemptId)
      const key = `${id}--${attempt}`
      if (seen.has(key)) return undefined
      seen.add(key)
      attempts.push({ ticketId: id, attemptId: attempt, cores: entry.cores })
    }
  } catch { return undefined }
  return { schema: 1, sampledAt: load.sampledAt, windowSec: 30, attempts }
}

export function readAgentCiTreeLoad(heartbeat: Record<string, unknown>): AgentCiTreeLoad | undefined {
  const load = heartbeat.ciTreeLoad
  if (!isLoadRecord(load) || load.schema !== 1 || typeof load.sampledAt !== 'string' || load.windowSec !== 30
    || typeof load.cores !== 'number' || !Number.isFinite(load.cores) || load.cores < 0 || load.cores > 1024
    || typeof load.workers !== 'number' || !Number.isInteger(load.workers) || load.workers < 0 || load.workers > 64) return undefined
  try { isoTime(load.sampledAt) } catch { return undefined }
  return { schema: 1, sampledAt: load.sampledAt, windowSec: 30, cores: load.cores, workers: load.workers }
}

function readAgentCiYield(heartbeat: Record<string, unknown>): LifecycleAgentIdentitySnapshot['ciYield'] {
  const { yieldingToCi, ciWorkers, yieldingSince } = heartbeat
  // 时间有效性沿用 requireIsoTime 的口径,但提示字段不完整时不能把身份记录判坏。
  if (yieldingToCi !== true || typeof ciWorkers !== 'number' || !Number.isInteger(ciWorkers) || ciWorkers <= 0
    || typeof yieldingSince !== 'string' || !Number.isFinite(Date.parse(yieldingSince))) return undefined
  return { ciWorkers, since: yieldingSince }
}

function isLoadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoadTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/**
 * 正在跑的 runner 名只在 `state === 'active'` 且是「非空、去重、逐项非空字符串」的数组时才透传
 * (UDQ-T4B-CI-LANE-HEADROOM)：派单员据此按车道余量表留核，认不出就按该机整机余量保守处理。
 * 名字缺失/不是数组/含重复或非字符串/空数组一律省略该字段——但**不把整条心跳判无效**：
 * 那会让机器被当成读数陈旧或离线，比保守缺省更坏。
 */
function readAgentCiRunners(state: unknown, value: unknown): string[] | undefined {
  if (state !== 'active' || !Array.isArray(value) || value.length === 0) return undefined
  const runners: string[] = []
  for (const name of value) {
    if (typeof name !== 'string' || name.length === 0 || runners.includes(name)) return undefined
    runners.push(name)
  }
  return runners
}

/**
 * 内存读数(SCHED-MR6-MEMORY-DIMENSION-0924):与让路提示同款容错——形状不对只省略
 * memory 字段,绝不把整条负载读数判无效;CPU 全缺的早分支也照样带上有效内存。
 */
function readAgentMemory(value: unknown): AgentMemoryLoad | undefined {
  if (!isLoadRecord(value)) return undefined
  const { totalMb, freeMb, windowSec, sampledAt } = value
  if (typeof totalMb !== 'number' || !Number.isInteger(totalMb) || totalMb <= 0
    || typeof freeMb !== 'number' || !Number.isInteger(freeMb) || freeMb < 0 || freeMb > totalMb
    || windowSec !== 30 || !isLoadTime(sampledAt)) return undefined
  return { totalMb, freeMb, windowSec: 30, sampledAt }
}

function readAgentLoad(heartbeat: Record<string, unknown>): LifecycleAgentIdentitySnapshot['load'] {
  const load = heartbeat.load
  if (!isLoadRecord(load) || load.schema !== 1 || !isLoadRecord(load.ci)) return undefined
  const { state, ciWorkers, observedAt, stateSince } = load.ci
  // 同让路提示字段：读数不完整或非法只省略，绝不升级成身份错误，也不将未知当空闲。
  if ((state !== 'idle' && state !== 'active' && state !== 'unknown')
    || typeof ciWorkers !== 'number' || !Number.isInteger(ciWorkers) || ciWorkers < 0
    || (state === 'active' ? ciWorkers === 0 : ciWorkers !== 0)
    || !isLoadTime(observedAt) || !isLoadTime(stateSince)) return undefined
  const runners = readAgentCiRunners(state, load.ci.runners)
  const ci: AgentLoad['ci'] = { state, ciWorkers, observedAt, stateSince,
    ...(runners === undefined ? {} : { runners }) }
  const memory = readAgentMemory(load.memory)
  const { cores, busyCores, busyPct, windowSec, sampledAt } = load
  if ([cores, busyCores, busyPct, windowSec, sampledAt].every(value => value === undefined)) {
    return { schema: 1, ci, ...(memory === undefined ? {} : { memory }) }
  }
  // CPU 是一组读数：未采够时全缺合法，半组或坏数不能拼成看似完整的负载。
  if (typeof cores !== 'number' || !Number.isInteger(cores) || cores <= 0
    || typeof busyCores !== 'number' || !Number.isFinite(busyCores) || busyCores < 0 || busyCores > cores
    || typeof busyPct !== 'number' || !Number.isFinite(busyPct) || busyPct < 0 || busyPct > 100
    || windowSec !== 30 || !isLoadTime(sampledAt)) return undefined
  return { schema: 1, cores, busyCores, busyPct, windowSec, sampledAt,
    ...(memory === undefined ? {} : { memory }), ci }
}

export function validateAgentIdentityRecord(
  heartbeat: Record<string, unknown>,
  owner: Record<string, unknown>,
  control: LifecycleControl,
  machine: string,
): LifecycleAgentIdentitySnapshot {
  for (const [label, record] of [['heartbeat', heartbeat], ['owner', owner]] as const) {
    if (record.namespace !== LIFECYCLE_NAMESPACE || record.lifecycleSchema !== LIFECYCLE_SCHEMA) {
      throw new Error(`[cluster-lifecycle] ${machine} ${label} namespace/schema 漂移`)
    }
    if (record.epoch !== control.epoch || record.machine !== machine) {
      throw new Error(`[cluster-lifecycle] ${machine} ${label} epoch/machine 漂移`)
    }
    // 下限判定,不逐字比数字:bump AGENT_PROTOCOL 后新代理的心跳/owner 必须照样合法,
    // 否则 --status、自动选机与冷切换等待循环会一起判「机器不在册」(静默停更)。
    requireAgentProtocol(record.protocol, `${machine} ${label}.protocol`)
    /**
     * head 不再与 control.codeVersion 逐字对卡(CLUSTER-CUTOVER-RECOVERY-B,2026-08-31):
     * head 是「这台机器当前停在哪份代码」的**状态**,不是身份——版本对齐由领单时的
     * ensureCodeVersion 闸负责。在这里卡死会让「刚上线还没领单对齐」的机器把整页 status
     * 与自动选机一起炸断(冷切换后 absent 机器自愈入伙的必经窗口)。protocol/pid/token
     * 等身份链照旧逐字校验;head 只验格式并原样展示,--status 负责把差异摊开给人看。
     */
    requireSha1(record.head, `${machine} ${label}.head`)
    requireIsoTime(record.at, `${machine} ${label}.at`)
    requireInteger(record.pid, `${machine} ${label}.pid`)
  }
  if (owner.name !== undefined && owner.name !== machine) {
    throw new Error(`[cluster-lifecycle] ${machine} owner.name 漂移`)
  }
  if (heartbeat.pid !== owner.pid) throw new Error(`[cluster-lifecycle] ${machine} heartbeat/owner pid 漂移`)
  const ownerToken = requireSafeSegment(owner.token, `${machine} owner.token`)
  if (heartbeat.ownerToken !== ownerToken) throw new Error(`[cluster-lifecycle] ${machine} heartbeat/owner token 漂移`)
  const state = requireText(heartbeat.state, `${machine} heartbeat.state`)
  if (!AGENT_STATES.has(state)) throw new Error(`[cluster-lifecycle] ${machine} heartbeat.state 未知:${state}`)
  const ciYield = readAgentCiYield(heartbeat)
  const load = readAgentLoad(heartbeat)
  const jobSlots = readAgentJobSlots(heartbeat)
  const attemptLoad = readAgentAttemptLoad(heartbeat)
  const ciTreeLoad = readAgentCiTreeLoad(heartbeat)
  return {
    machine,
    state,
    at: requireIsoTime(heartbeat.at, `${machine} heartbeat.at`),
    pid: requireInteger(heartbeat.pid, `${machine} heartbeat.pid`),
    protocol: requireAgentProtocol(heartbeat.protocol, `${machine} heartbeat.protocol`),
    head: requireSha1(heartbeat.head, `${machine} heartbeat.head`),
    ownerPid: requireInteger(owner.pid, `${machine} owner.pid`),
    ownerToken,
    ...(ciYield === undefined ? {} : { ciYield }),
    ...(load === undefined ? {} : { load }),
    ...(jobSlots === undefined ? {} : { jobSlots }),
    ...(attemptLoad === undefined ? {} : { attemptLoad }),
    ...(ciTreeLoad === undefined ? {} : { ciTreeLoad }),
  }
}

function tryReadIdentityJson(path: string, label: string): Record<string, unknown> | undefined {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch (error) {
    /**
     * EBUSY 与 ENOENT 同判「还没就绪」(CLUSTER-CUTOVER-RECOVERY-B,2026-08-31 真实切换实测):
     * agent 正在写 owner/heartbeat 的瞬间,cutover 等待循环恰好来读 ⇒ Windows/SMB 报 EBUSY。
     * 这是毫秒级瞬态,fail-closed 会把整场切换事务打成 HOLD(实测第一场就这么失败的);
     * 本函数只服务「等待/展示」语义,交给上层循环下一轮重试才是正确姿态。
     * 其余错误(EACCES、路径类)照旧抛——那些不是等一下就能好的。
     */
    if (hasCode(error, 'ENOENT') || hasCode(error, 'EBUSY')) return undefined
    throw new Error(`[cluster-lifecycle] 读取 ${label} 失败:${path}:${errorMessage(error)}`, { cause: error })
  }
  /**
   * 半截 JSON 与 EBUSY 同族(2026-08-31 实测第二例):写者正把 identity 写到一半,读者
   * 拿到 Unexpected end of JSON input——同样是毫秒级瞬态,同判「还没就绪」交上层重试。
   * 永久损坏的文件靠等待超时暴露(超时报错点名在等哪台),不会被无声吞掉。
   */
  try { return requireRecord(JSON.parse(raw), label) } catch { return undefined }
}

/** cutover 等待期允许 identity 尚未同时出现；一旦两者齐全就走与 ACTIVE status 相同的逐字校验。 */
export function tryReadLifecycleAgentIdentity(
  share: string,
  control: LifecycleControl,
  machine: string,
): LifecycleAgentIdentitySnapshot | undefined {
  const paths = lifecyclePaths(share, control.epoch, machine)
  const heartbeat = tryReadIdentityJson(join(paths.heartbeat, `${machine}.json`), `${machine} v13 heartbeat`)
  const owner = tryReadIdentityJson(join(paths.owners, `${machine}.json`), `${machine} v13 owner`)
  if (heartbeat === undefined || owner === undefined) return undefined
  return validateAgentIdentityRecord(heartbeat, owner, control, machine)
}

class MachineStatusFault extends Error {
  constructor(readonly kind: NonNullable<LifecycleMachineStatus['fault']>['kind'], reason: string, options?: ErrorOptions) {
    super(reason, options)
  }
}

function readStatusIdentityText(path: string, machine: string, label: 'heartbeat' | 'owner'): string {
  const recordLabel = `${machine} ${label}`
  try { return readFileSync(path, 'utf8') } catch (error) {
    const missing = hasCode(error, 'ENOENT')
    throw new MachineStatusFault(missing ? 'record-missing' : 'record-corrupt',
      `${recordLabel} ${missing ? '记录不存在，尚未上线' : '记录无法读取'}:${path}:${errorMessage(error)};建议重建这份记录`,
      { cause: error })
  }
}

/** 展示/选机先确认记录完整可读，再比身份；切换等待与默认读取不经过此入口。 */
function readStatusIdentityJson(
  path: string, machine: string, label: 'heartbeat' | 'owner', raw = readStatusIdentityText(path, machine, label),
): Record<string, unknown> {
  const recordLabel = `${machine} ${label}`
  try {
    if (raw.trim() === '') throw new Error('记录为空或全空白')
    if (raw.split('\0').join('').trim() === '') throw new Error('记录为空（全 NUL）')
    const record = requireRecord(JSON.parse(raw), recordLabel)
    requireText(record.namespace, `${recordLabel}.namespace`)
    requireInteger(record.lifecycleSchema, `${recordLabel}.lifecycleSchema`)
    requireSafeSegment(record.epoch, `${recordLabel}.epoch`)
    requireSafeSegment(record.machine, `${recordLabel}.machine`)
    requireAgentProtocol(record.protocol, `${recordLabel}.protocol`)
    requireSha1(record.head, `${recordLabel}.head`)
    requireIsoTime(record.at, `${recordLabel}.at`)
    requireInteger(record.pid, `${recordLabel}.pid`)
    const tokenField = label === 'heartbeat' ? 'ownerToken' : 'token'
    requireSafeSegment(record[tokenField], `${recordLabel}.${tokenField}`)
    if (label === 'heartbeat') requireText(record.state, `${recordLabel}.state`)
    if (label === 'owner' && record.name !== undefined) requireSafeSegment(record.name, `${recordLabel}.name`)
    return record
  } catch (error) {
    throw new MachineStatusFault('record-corrupt',
      `${recordLabel} 记录损坏:${path}:${errorMessage(error)};建议重建这份记录`)
  }
}

/** 只用已校验记录的时间差区分换代进度，不引入读取时刻或修改身份校验。 */
function formatStatusIdentityDriftReason(heartbeat: Record<string, unknown>, owner: Record<string, unknown>): string {
  const heartbeatAt = String(heartbeat.at)
  const ownerAt = String(owner.at)
  const lag = Date.parse(ownerAt) - Date.parse(heartbeatAt)
  const leaseDurationMs = typeof owner.leaseDurationMs === 'number'
    && Number.isInteger(owner.leaseDurationMs) && owner.leaseDurationMs > 0
    ? owner.leaseDurationMs : OWNER_STALE_MS
  if (lag < 0) {
    return `心跳与租约的记录彼此矛盾(心跳 pid ${String(heartbeat.pid)}@${heartbeatAt}`
      + ` 比租约 pid ${String(owner.pid)}@${ownerAt} 还新);建议核对这台机器的代理进程与两份记录`
  }
  if (lag > leaseDurationMs) {
    return `新一代(pid ${String(owner.pid)})在 ${ownerAt} 拿到租约后已 ${Math.floor(lag / 60_000)} 分钟没写出心跳`
      + `(心跳仍是 pid ${String(heartbeat.pid)} 于 ${heartbeatAt} 写的);`
      + '这不是换代过渡态,多半卡死在启动阶段,不会自己好;建议查这台机器上的代理日志'
  }
  return `换代过渡态:新一代(pid ${String(owner.pid)})已于 ${ownerAt} 拿到租约,还没写出第一次心跳;`
    + '正常一分钟内自愈,建议稍后重查'
}

function readStatusAgentIdentity(
  share: string, control: LifecycleControl, machine: string, allowNotReady: boolean,
): LifecycleAgentIdentitySnapshot | undefined {
  const paths = lifecyclePaths(share, control.epoch, machine)
  const heartbeatPath = join(paths.heartbeat, `${machine}.json`)
  const ownerPath = join(paths.owners, `${machine}.json`)
  let heartbeatRaw: string | undefined
  let ownerRaw: string | undefined
  if (allowNotReady) {
    // cold 下先读齐两份文件；缺失/共享冲突是尚未入伙，读齐后的坏内容才算损坏。
    try {
      heartbeatRaw = readStatusIdentityText(heartbeatPath, machine, 'heartbeat')
      ownerRaw = readStatusIdentityText(ownerPath, machine, 'owner')
    } catch (error) {
      if (error instanceof MachineStatusFault && (hasCode(error.cause, 'ENOENT') || hasCode(error.cause, 'EBUSY'))) {
        return undefined
      }
      throw error
    }
  }
  const heartbeat = readStatusIdentityJson(heartbeatPath, machine, 'heartbeat', heartbeatRaw)
  const owner = readStatusIdentityJson(ownerPath, machine, 'owner', ownerRaw)
  // 未知运行态不属于身份换代，仍按既有契约失败关闭。
  const state = requireText(heartbeat.state, `${machine} heartbeat.state`)
  if (!AGENT_STATES.has(state)) throw new Error(`[cluster-lifecycle] ${machine} heartbeat.state 未知:${state}`)
  try {
    return validateAgentIdentityRecord(heartbeat, owner, control, machine)
  } catch (error) {
    const identityMismatch = heartbeat.pid !== owner.pid || heartbeat.ownerToken !== owner.token
    const reason = identityMismatch
      ? `心跳与租约的${heartbeat.pid !== owner.pid ? '进程号' : '身份令牌'}不一致`
      : errorMessage(error)
    throw new MachineStatusFault('identity-drift', `${machine} ${reason};`
      + `heartbeat ${heartbeatPath} pid=${String(heartbeat.pid)},写入时间=${String(heartbeat.at)};`
      + `owner ${ownerPath} pid=${String(owner.pid)},写入时间=${String(owner.at)};`
      + (identityMismatch ? formatStatusIdentityDriftReason(heartbeat, owner) : '建议核对本机记录与 ACTIVE control 的身份配置'))
  }
}

export function readVerifiedReceipt(path: string, expectedSchema: string): Record<string, unknown> {
  const receipt = readJson(path, expectedSchema)
  const actualHash = requireText(receipt.receiptSha256, `${expectedSchema}.receiptSha256`)
  if (!SHA256.test(actualHash)) throw new Error(`[cluster-lifecycle] ${expectedSchema} receiptSha256 非 64 位摘要`)
  const unsigned = { ...receipt }
  delete unsigned.receiptSha256
  if (lifecyclePayloadSha256(unsigned) !== actualHash) throw new Error(`[cluster-lifecycle] ${expectedSchema} receipt hash 漂移`)
  if (receipt.receiptSchema !== expectedSchema || receipt.status !== 'PASS' || receipt.exitCode !== 0) {
    throw new Error(`[cluster-lifecycle] ${expectedSchema} 不是 PASS/exit0`)
  }
  return receipt
}

interface StatusReceiptMachine {
  machine: string
  ownerPid: number
  ownerToken: string
  agentHeadSha: string
}

function requireZero(value: unknown, label: string): void {
  if (requireInteger(value, label) !== 0) throw new Error(`[cluster-lifecycle] ${label} 必须为 0`)
}

interface StatusReceiptVerdict {
  mode: 'live' | 'cold'
  machines: Map<string, StatusReceiptMachine>
}

function validateStatusReceipt(
  share: string,
  control: LifecycleControl,
  legacy: LegacyQueueSnapshot,
  sourceHeadSha?: string,
): StatusReceiptVerdict {
  const path = join(share, LIFECYCLE_NAMESPACE, '_control', 'receipts', `cutover-${control.epoch}.json`)
  /**
   * 按 receiptSchema 分流(CLUSTER-CUTOVER-RECOVERY-B):live 仪式的 receipt 保持原有
   * 全量重验;冷切换 receipt 只验「历史链完整」(hash 自洽 + 与 control 身份一致)——
   * receipt 是 cutover 那一刻的历史证明,不拿它冻结此后的运营世界(agent 重启换 pid、
   * 领单换 head、main 前进刷锚点都是合法演化)。未知 schema 照旧拒绝。
   */
  const schema = readJson(path, 'cutover receipt').receiptSchema
  if (schema === COLD_CUTOVER_RECEIPT_SCHEMA) {
    const receipt = readVerifiedReceipt(path, COLD_CUTOVER_RECEIPT_SCHEMA)
    if (receipt.namespace !== LIFECYCLE_NAMESPACE || receipt.lifecycleSchema !== LIFECYCLE_SCHEMA
      || receipt.epoch !== control.epoch || receipt.mergeSha !== control.codeVersion
      || receipt.controlState !== 'ACTIVE' || receipt.coldMode !== true) {
      throw new Error('[cluster-lifecycle] cold cutover receipt control identity 漂移')
    }
    assertArrayExactly(receipt.configuredMachines, control.configuredMachines, 'cold cutover configuredMachines')
    return { mode: 'cold', machines: new Map() }
  }
  const receipt = readVerifiedReceipt(path, CUTOVER_RECEIPT_SCHEMA)
  if (receipt.namespace !== LIFECYCLE_NAMESPACE || receipt.lifecycleSchema !== LIFECYCLE_SCHEMA
    || receipt.epoch !== control.epoch || receipt.mergeSha !== control.codeVersion || receipt.controlState !== 'ACTIVE') {
    throw new Error('[cluster-lifecycle] cutover receipt control identity 漂移')
  }
  assertArrayExactly(receipt.configuredMachines, control.configuredMachines, 'cutover configuredMachines')
  verifyLifecycleExactReceipt({
    share,
    control,
    exact: receipt.exactProof,
    maintenance: receipt.maintenanceGate,
    sourceHeadSha,
  })
  const drain = requireRecord(receipt.legacyDrain, 'cutover legacyDrain')
  requireZero(drain.legacyInboxCount, 'cutover legacyDrain.legacyInboxCount')
  requireZero(drain.legacyRunningCount, 'cutover legacyDrain.legacyRunningCount')
  requireIsoTime(drain.drainCheckedAt, 'cutover legacyDrain.drainCheckedAt')
  const drainMachines = drain.perMachine
  if (!Array.isArray(drainMachines) || drainMachines.length !== control.configuredMachines.length) {
    throw new Error('[cluster-lifecycle] cutover legacyDrain.perMachine 数量漂移')
  }
  drainMachines.forEach((value, index) => {
    const item = requireRecord(value, `cutover legacyDrain.perMachine[${index}]`)
    if (item.machine !== control.configuredMachines[index]) throw new Error('[cluster-lifecycle] cutover legacy drain machine 漂移')
    requireZero(item.legacyInboxCount, `cutover ${String(item.machine)} legacyInboxCount`)
    requireZero(item.legacyRunningCount, `cutover ${String(item.machine)} legacyRunningCount`)
  })
  const orphan = requireRecord(receipt.legacyOrphan, 'cutover legacyOrphan')
  if (orphan.legacyRoot !== 'jobs' || orphan.manifestScope !== 'queue-json-excluding-heartbeat-owner') {
    throw new Error('[cluster-lifecycle] cutover legacy manifest scope 漂移')
  }
  const beforeHash = requireText(orphan.beforeManifestSha256, 'cutover beforeManifestSha256')
  const afterHash = requireText(orphan.afterManifestSha256, 'cutover afterManifestSha256')
  if (!SHA256.test(beforeHash) || !SHA256.test(afterHash) || afterHash !== legacy.manifestSha256) {
    throw new Error('[cluster-lifecycle] ACTIVE 后 legacy 隔离 manifest 漂移')
  }
  if (requireInteger(orphan.afterEntryCount, 'cutover afterEntryCount') !== legacy.entries.length
    || requireInteger(orphan.bootstrapObservedCount, 'cutover bootstrapObservedCount') !== control.configuredMachines.length) {
    throw new Error('[cluster-lifecycle] cutover legacy 隔离计数漂移')
  }
  requireInteger(orphan.beforeEntryCount, 'cutover beforeEntryCount')
  requireZero(orphan.unexpectedWriteCount, 'cutover unexpectedWriteCount')
  requireZero(orphan.consumedCount, 'cutover consumedCount')
  const receiptMachines = receipt.perMachine
  if (!Array.isArray(receiptMachines) || receiptMachines.length !== control.configuredMachines.length) {
    throw new Error('[cluster-lifecycle] cutover perMachine 数量漂移')
  }
  const legacyEntries = new Map(legacy.entries.map(entry => [entry.path, entry.sha256]))
  const machines = new Map<string, StatusReceiptMachine>()
  receiptMachines.forEach((value, index) => {
    const item = requireRecord(value, `cutover perMachine[${index}]`)
    const machine = requireSafeSegment(item.machine, `cutover perMachine[${index}].machine`)
    if (machine !== control.configuredMachines[index] || machines.has(machine)) {
      throw new Error('[cluster-lifecycle] cutover perMachine machine 重复或漂移')
    }
    const exactMachine = verifyLifecycleReceiptMachine(item, control, machine)
    const submissionId = requireSafeSegment(item.bootstrapSubmissionId, `${machine} bootstrapSubmissionId`)
    const observedPath = requireText(item.bootstrapObservedPath, `${machine} bootstrapObservedPath`)
    const fileHash = requireText(item.bootstrapFileSha256, `${machine} bootstrapFileSha256`)
    if (legacyBootstrapState(observedPath, machine, submissionId) === undefined || !SHA256.test(fileHash)
      || legacyEntries.get(observedPath) !== fileHash || item.bootstrapIsolated !== true
      || item.otherLegacyConsumedCount !== 0 || (item.bootstrapSourceProtocol !== 6 && item.bootstrapSourceProtocol !== 8)) {
      throw new Error(`[cluster-lifecycle] cutover ${machine} bootstrap isolation 漂移`)
    }
    machines.set(machine, { machine, ...exactMachine })
  })
  const firstClaim = requireRecord(receipt.firstClaim, 'cutover firstClaim')
  if (firstClaim.observed !== true || firstClaim.rollbackAllowed !== false
    || firstClaim.rollbackMode !== 'HOLD_AND_FORWARD_FIX_ONLY') throw new Error('[cluster-lifecycle] cutover firstClaim fence 不完整')
  const submissionId = requireSafeSegment(firstClaim.submissionId, 'cutover firstClaim.submissionId')
  const firstMachine = control.configuredMachines[0]!
  const claim = identityFrom(readJson(join(lifecyclePaths(share, control.epoch, firstMachine).claims,
    `${submissionId}.json`), 'cutover first claim'), 'cutover first claim')
  if (claim.submissionId !== submissionId || claim.machine !== firstMachine || claim.epoch !== control.epoch
    || claim.codeVersion !== control.codeVersion || lifecyclePayloadSha256(claim) !== firstClaim.claimSha256) {
    throw new Error('[cluster-lifecycle] cutover firstClaim identity 漂移')
  }
  return { mode: 'live', machines }
}

function assertKnownStateDirectories(machineRoot: string): void {
  const entries = (() => {
    try { return readdirSync(machineRoot, { withFileTypes: true }) } catch (error) {
      throw new Error(`[cluster-lifecycle] 读取 machine lifecycle 根失败:${machineRoot}:${errorMessage(error)}`, { cause: error })
    }
  })()
  const names = entries.map(entry => {
    if (!entry.isDirectory()) throw new Error(`[cluster-lifecycle] machine lifecycle 根含非目录:${entry.name}`)
    return entry.name
  }).sort()
  const expected = [...LIFECYCLE_STATES].sort()
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`[cluster-lifecycle] machine lifecycle 含未知或缺失状态:${names.join(',')}`)
  }
}

function strictStateFiles(path: string, state: LifecycleState): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch (error) {
    throw new Error(`[cluster-lifecycle] 读取 ${state} 目录失败:${path}:${errorMessage(error)}`, { cause: error })
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`[cluster-lifecycle] ${state} 含非工单条目:${entry.name}`)
    }
    names.push(requireSafeSegment(entry.name.slice(0, -5), `${state} submissionId`))
  }
  return names.sort()
}

/** 默认保留既有严格契约；显式容忍只隔离单机身份记录，全局前提与五态校验仍抛错。 */
export function readLifecycleStatusSnapshot(
  share: string,
  sourceHeadSha?: string,
  options?: { tolerateMachineFaults?: boolean },
): LifecycleStatusSnapshot {
  const control = readActiveLifecycleControl({ share })
  const receiptVerdict = validateStatusReceipt(share, control, legacyQueueSnapshot(share), sourceHeadSha)
  const machines = control.configuredMachines.map(machine => {
    const paths = lifecyclePaths(share, control.epoch, machine)
    assertKnownStateDirectories(paths.machineRoot)
    /**
     * live receipt 保留 cutover 时刻 identity 快照的逐字对比(pid/token 身份链),且
     * identity 文件必须在(live 仪式等到全员上线才算完成);head 除外——那是运营状态,
     * 领单对齐后必然前进,冻结它会让 status 永久失败。
     * cold receipt 下 identity 允许缺失(absent 机器自愈上线前的合法窗口,展示为未上线),
     * 出现后身份合法性由 validateAgentIdentityRecord 的 protocol/pid/token 链保证,
     * 不与 receipt 快照对比:agent 是 cutover 之后各机自愈冷启动出来的。
     */
    let heartbeat: LifecycleAgentIdentitySnapshot | undefined
    let fault: LifecycleMachineStatus['fault']
    try {
      heartbeat = options?.tolerateMachineFaults === true
        ? readStatusAgentIdentity(share, control, machine, receiptVerdict.mode === 'cold')
        : receiptVerdict.mode === 'cold'
          ? tryReadLifecycleAgentIdentity(share, control, machine)
          : validateAgentIdentityRecord(
            readJson(join(paths.heartbeat, `${machine}.json`), `${machine} heartbeat`),
            readJson(join(paths.owners, `${machine}.json`), `${machine} owner`),
            control,
            machine,
          )
      if (receiptVerdict.mode === 'live') {
        const receiptMachine = receiptVerdict.machines.get(machine)
        if (receiptMachine === undefined || heartbeat === undefined || receiptMachine.ownerPid !== heartbeat.ownerPid
          || receiptMachine.ownerToken !== heartbeat.ownerToken) {
          const reason = `[cluster-lifecycle] ${machine} 当前 identity 与 cutover receipt 漂移`
          if (options?.tolerateMachineFaults !== true) throw new Error(reason)
          throw new MachineStatusFault('identity-drift',
            `${reason};建议核对本机身份与切换回执`)
        }
      }
    } catch (error) {
      if (options?.tolerateMachineFaults !== true || !(error instanceof MachineStatusFault)) throw error
      heartbeat = undefined
      fault = { kind: error.kind, reason: error.message }
    }
    const counts = Object.fromEntries(LIFECYCLE_STATES.map(state => [state, 0])) as Record<LifecycleState, number>
    const seen = new Map<string, LifecycleState>()
    for (const state of LIFECYCLE_STATES) {
      for (const submissionId of strictStateFiles(paths[state], state)) {
        const previous = seen.get(submissionId)
        if (previous !== undefined) {
          throw new LifecycleStateConflictError(`[cluster-lifecycle] 状态冲突:${submissionId} 同时位于 ${previous},${state}`)
        }
        seen.set(submissionId, state)
        // 历史态只按文件名计数、查冲突；单张工单的全文校验留给 --wait。
        if (state === 'inbox' || state === 'running') {
          try {
            readLifecycleStateRecord({ share, epoch: control.epoch, machine, submissionId, state })
          } catch (error) {
            // 双态大多先在这里炸(读单态时看见 inbox+running 两份);同单双态属可自愈的并发瞬态,
            // 转成 LifecycleStateConflictError 让派单员只跳拍,不整个退出。迁移锁是另一种瞬态,
            // 有自己的类型,原样放行;其余读错误(记录损坏等)照旧抛,不当冲突。
            if (error instanceof TransitionLeaseBarrierError) throw error
            if (error instanceof Error && error.message.startsWith('[cluster-lifecycle] 状态冲突:')) {
              throw new LifecycleStateConflictError(error.message, { cause: error })
            }
            throw error
          }
        }
        counts[state]++
      }
    }
    return { machine, heartbeat, counts, ...(fault === undefined ? {} : { fault }) }
  })
  return { control, machines }
}
