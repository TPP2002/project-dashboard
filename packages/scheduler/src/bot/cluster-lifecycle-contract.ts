import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const LIFECYCLE_NAMESPACE = 'jobs-v12' as const
export const LIFECYCLE_SCHEMA = 12 as const
export const LIFECYCLE_STATES = ['inbox', 'running', 'done', 'failed', 'quarantine'] as const
export type LifecycleState = typeof LIFECYCLE_STATES[number]

/**
 * **身份链接受的最低代理协议号**(CLUSTER-AGENT-PROTOCOL-BUMP-VS-HARDCODE,2026-08-31)。
 *
 * `cluster-agent.ts` 的 `AGENT_PROTOCOL` 按规矩「改了代理行为就 +1」;而 owner 记录、
 * 心跳、切换回执与 legacy 交接证明上都带着**当时那个代理的号**。此前这些地方逐字比 `13`,
 * 于是把 `AGENT_PROTOCOL` 提到 14 会让**跑 14 的代理发出的身份记录被全部判非法**
 * —— 表现不是报错,是**全集群静默停更**(派活方只看到「某台机器一直停在老代码上」)。
 * 故判据改成下限:`协议号 >= AGENT_PROTOCOL_MIN` 即合法。
 *
 * ⚠️ **本常量不跟着 `AGENT_PROTOCOL` 走,也不许自动跟。** 它的语义是「身份记录形状的最低版本」,
 * 只有身份记录本身发生破坏性改动时才该抬。跟着 bump 走的话,每提一号就会把所有**还没升上来的**
 * 执行机一起判非法 —— 那正是 2026-08-30 拍板 d1 列的头号病症「副机永久滞留、靠自己爬不回来」
 * (立场与病根链留痕见 `cluster-agent-contract.ts` 的 `upgradeVerdict` 头注)。
 *
 * ⚠️ **不设上界。** 主机侧代码可能比执行机旧(执行机从别的分支自升过),
 * 卡上界等于制造反方向的静默冻结 —— 记录的每个字段本来就逐条校验,号本身不必封顶。
 */
export const AGENT_PROTOCOL_MIN = 13 as const

export const SHA1 = /^[0-9a-f]{40}$/
export const SHA256 = /^[0-9a-f]{64}$/
export const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

export interface LifecycleSources {
  now: () => string
  nonce: () => string
}

export const productionSources: LifecycleSources = {
  now: () => new Date().toISOString(),
  nonce: () => randomUUID(),
}

export interface LifecycleControl {
  namespace: typeof LIFECYCLE_NAMESPACE
  lifecycleSchema: typeof LIFECYCLE_SCHEMA
  epoch: string
  state: 'ACTIVE'
  codeVersion: string
  configuredMachines: string[]
  createdAt: string
  createdBy: string
}

export interface LifecycleIdentity {
  namespace: typeof LIFECYCLE_NAMESPACE
  lifecycleSchema: typeof LIFECYCLE_SCHEMA
  epoch: string
  jobId: string
  submissionId: string
  machine: string
  codeVersion: string
  createdAt: string
  createdBy: string
  payloadSha256: string
}

export interface LifecycleStateRecord extends LifecycleIdentity {
  state: LifecycleState
  payload: Record<string, unknown>
  metadata?: Record<string, unknown>
  result?: Record<string, unknown>
}

export interface PublishLifecycleJobOptions {
  share: string
  machine: string
  jobId: string
  submissionId?: string
  codeVersion: string
  createdAt?: string
  createdBy: string
  payload: Record<string, unknown>
  expectedEpoch?: string
  sources?: LifecycleSources
}

export interface PublishedLifecycleJob {
  identity: LifecycleIdentity
  claimPath: string
  statePath: string
  record: LifecycleStateRecord
}

export interface ReadLifecycleStateOptions {
  share: string
  epoch: string
  machine: string
  submissionId: string
  state: LifecycleState
}

export interface TransitionLifecycleHooks {
  beforeDestinationCreate?: (context: { sourcePath: string; destinationPath: string }) => void
  afterLeaseAcquire?: (context: { token: string; renewLease: () => void }) => void
  beforeLeaseRelease?: (context: { token: string; retirementPath: string }) => void
}

export interface TransitionLifecycleJobOptions {
  share: string
  epoch: string
  machine: string
  submissionId: string
  from: LifecycleState
  to: LifecycleState
  metadata?: Record<string, unknown>
  result?: Record<string, unknown>
  hooks?: TransitionLifecycleHooks
  sources?: LifecycleSources
  leaseDurationMs?: number
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`[cluster-lifecycle] ${label} 必须是 JSON object`)
  }
  return value as Record<string, unknown>
}

export function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`[cluster-lifecycle] ${label} 必须是非空字符串`)
  }
  return value
}

export function requireSafeSegment(value: unknown, label: string): string {
  const text = requireText(value, label)
  if (!SAFE_SEGMENT.test(text)) {
    throw new Error(`[cluster-lifecycle] ${label} 含不允许的路径字符:${text}`)
  }
  return text
}

export function requireSha1(value: unknown, label: string): string {
  const text = requireText(value, label)
  if (!SHA1.test(text)) throw new Error(`[cluster-lifecycle] ${label} 必须是 40 位小写 commit SHA`)
  return text
}

export function requireIsoTime(value: unknown, label: string): string {
  const text = requireText(value, label)
  if (!Number.isFinite(Date.parse(text))) throw new Error(`[cluster-lifecycle] ${label} 不是合法 ISO 时间:${text}`)
  return text
}

export function readJson(path: string, label: string): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`[cluster-lifecycle] 读取 ${label} 失败:${path}:${errorMessage(error)}`, { cause: error })
  }
  try {
    return requireRecord(JSON.parse(raw), label)
  } catch (error) {
    throw new Error(`[cluster-lifecycle] ${label} 不是合法 JSON:${path}:${errorMessage(error)}`, { cause: error })
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const item = canonicalize(source[key])
      if (item !== undefined) sorted[key] = item
    }
    return sorted
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('[cluster-lifecycle] canonical JSON 不接受非有限数值')
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`[cluster-lifecycle] canonical JSON 不接受 ${typeof value}`)
  }
  return value
}

/** 跨发布者、agent 和 wait 共用的稳定 JSON 编码。 */
export function canonicalLifecycleJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value))
  if (encoded === undefined) throw new Error('[cluster-lifecycle] 值无法编码为 canonical JSON')
  return encoded
}

/** 工单执行 payload 的逐字身份摘要。 */
export function lifecyclePayloadSha256(payload: unknown): string {
  return createHash('sha256').update(canonicalLifecycleJson(payload)).digest('hex')
}

export interface BuildLifecycleIdentityOptions {
  namespace?: typeof LIFECYCLE_NAMESPACE
  lifecycleSchema?: typeof LIFECYCLE_SCHEMA
  epoch: string
  jobId: string
  submissionId?: string
  machine: string
  codeVersion: string
  createdAt?: string
  createdBy: string
  payload: Record<string, unknown>
  sources?: LifecycleSources
}

/** 身份只从显式输入和可注入 clock/crypto nonce 构造，不用裸随机或秒级墙钟充当唯一性。 */
export function buildLifecycleIdentity(options: BuildLifecycleIdentityOptions): LifecycleIdentity {
  if (options.namespace !== undefined && options.namespace !== LIFECYCLE_NAMESPACE) {
    throw new Error(`[cluster-lifecycle] namespace 必须是 ${LIFECYCLE_NAMESPACE}`)
  }
  if (options.lifecycleSchema !== undefined && options.lifecycleSchema !== LIFECYCLE_SCHEMA) {
    throw new Error(`[cluster-lifecycle] lifecycleSchema 必须是 ${LIFECYCLE_SCHEMA}`)
  }
  const sources = options.sources ?? productionSources
  const epoch = requireSafeSegment(options.epoch, 'epoch')
  const jobId = requireSafeSegment(options.jobId, 'jobId')
  const machine = requireSafeSegment(options.machine, 'machine')
  const codeVersion = requireSha1(options.codeVersion, 'codeVersion')
  const createdAt = requireIsoTime(options.createdAt ?? sources.now(), 'createdAt')
  const createdBy = requireText(options.createdBy, 'createdBy')
  const submissionId = requireSafeSegment(
    options.submissionId ?? `${jobId}--${requireSafeSegment(sources.nonce(), 'nonce')}`,
    'submissionId',
  )
  return {
    namespace: LIFECYCLE_NAMESPACE,
    lifecycleSchema: LIFECYCLE_SCHEMA,
    epoch,
    jobId,
    submissionId,
    machine,
    codeVersion,
    createdAt,
    createdBy,
    payloadSha256: lifecyclePayloadSha256(options.payload),
  }
}

export function identityFrom(value: unknown, label: string): LifecycleIdentity {
  const raw = requireRecord(value, label)
  if (raw.namespace !== LIFECYCLE_NAMESPACE || raw.lifecycleSchema !== LIFECYCLE_SCHEMA) {
    throw new Error(`[cluster-lifecycle] ${label} namespace/schema 不匹配`)
  }
  const payloadSha256 = requireText(raw.payloadSha256, `${label}.payloadSha256`)
  if (!SHA256.test(payloadSha256)) throw new Error(`[cluster-lifecycle] ${label}.payloadSha256 非 64 位小写摘要`)
  return {
    namespace: LIFECYCLE_NAMESPACE,
    lifecycleSchema: LIFECYCLE_SCHEMA,
    epoch: requireSafeSegment(raw.epoch, `${label}.epoch`),
    jobId: requireSafeSegment(raw.jobId, `${label}.jobId`),
    submissionId: requireSafeSegment(raw.submissionId, `${label}.submissionId`),
    machine: requireSafeSegment(raw.machine, `${label}.machine`),
    codeVersion: requireSha1(raw.codeVersion, `${label}.codeVersion`),
    createdAt: requireIsoTime(raw.createdAt, `${label}.createdAt`),
    createdBy: requireText(raw.createdBy, `${label}.createdBy`),
    payloadSha256,
  }
}

export const IDENTITY_FIELDS: readonly (keyof LifecycleIdentity)[] = [
  'namespace', 'lifecycleSchema', 'epoch', 'jobId', 'submissionId', 'machine',
  'codeVersion', 'createdAt', 'createdBy', 'payloadSha256',
]

export function assertSameIdentity(actual: LifecycleIdentity, expected: LifecycleIdentity, label: string): void {
  for (const field of IDENTITY_FIELDS) {
    if (actual[field] !== expected[field]) {
      throw new Error(`[cluster-lifecycle] ${label}.${field} 身份漂移`)
    }
  }
}

export function requireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`[cluster-lifecycle] ${label} 必须是整数`)
  }
  return value
}

/**
 * 身份链上「这条记录是哪一代代理写的」的唯一判据:整数且不低于 `AGENT_PROTOCOL_MIN`。
 * 返回**实际读到的号**,调用方一律原样透传,不许再回写常量 —— 否则 `--status` 之类的
 * 展示面会对着人报一个假号。读不出/非整数仍照旧拒绝(与逐字比较时期逐字相同)。
 */
export function requireAgentProtocol(value: unknown, label: string): number {
  const protocol = requireInteger(value, label)
  if (protocol < AGENT_PROTOCOL_MIN) {
    throw new Error(`[cluster-lifecycle] ${label} 协议号 ${protocol} 低于下限 ${AGENT_PROTOCOL_MIN}`)
  }
  return protocol
}

export function assertArrayExactly(actual: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw new Error(`[cluster-lifecycle] ${label} 数量不匹配`)
  }
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) throw new Error(`[cluster-lifecycle] ${label}[${index}] 身份漂移`)
  }
}
