import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import {
  LIFECYCLE_NAMESPACE,
  LIFECYCLE_SCHEMA,
  SAFE_SEGMENT,
  SHA1,
  errorMessage,
  lifecyclePayloadSha256,
  readJson,
  requireAgentProtocol,
  requireInteger,
  requireSafeSegment,
  requireSha1,
} from './cluster-lifecycle-contract'
import {
  indexLegacyHandoffProofs,
  type LegacyHandoffProof,
} from './cluster-lifecycle-handoff'

export interface LegacyBootstrapSnapshot {
  namespace: string
  lifecycleSchema: number
  epoch: string
  machine: string
  codeVersion: string
  codeHeadSha: string
  bundleHeadSha: string
  heartbeatHeadSha: string
  sourceSha: string
  ownerMachine: string
  heartbeatMachine: string
  maintenanceOpen: boolean
  legacyInboxCount: number
  legacyRunningCount: number
  sourceProtocol: number
}

export interface LegacyBootstrapVerdict {
  ok: boolean
  reason?: string
}

export interface LegacyQueueEntry {
  path: string
  sha256: string
}
export interface LegacyQueueSnapshot {
  entries: LegacyQueueEntry[]
  manifestSha256: string
}

export interface LegacyBootstrapExpectation {
  machine: string
  sourceProtocol: 6 | 8
  submissionId: string
  codeVersion: string
}

export interface LegacyBootstrapIsolationEvidence {
  machine: string
  bootstrapSubmissionId: string
  bootstrapSourceProtocol: 6 | 8
  bootstrapObservedPath: string
  bootstrapObservedState: 'inbox' | 'running' | 'done' | 'failed'
  bootstrapFileSha256: string
  bootstrapIsolated: boolean
  otherLegacyConsumedCount: number
}

/** 只证明严格 6/8 -> 13 单机 bootstrap；“任意更小版本”或任一指纹漂移都拒绝。 */
export function validateLegacyBootstrapSnapshot(snapshot: LegacyBootstrapSnapshot): LegacyBootstrapVerdict {
  const bad = (reason: string): LegacyBootstrapVerdict => ({ ok: false, reason })
  if (snapshot.namespace !== LIFECYCLE_NAMESPACE || snapshot.lifecycleSchema !== LIFECYCLE_SCHEMA) {
    return bad('bootstrap namespace/schema 不匹配')
  }
  if (!SAFE_SEGMENT.test(snapshot.epoch) || !SAFE_SEGMENT.test(snapshot.machine)) return bad('bootstrap 坐标非法')
  if (snapshot.sourceProtocol !== 6 && snapshot.sourceProtocol !== 8) return bad('只接受显式 legacy protocol 6 或 8')
  if (snapshot.maintenanceOpen !== true) return bad('维护窗未开启')
  if (snapshot.legacyInboxCount !== 0 || snapshot.legacyRunningCount !== 0) return bad('legacy inbox/running 未 drain')
  if (snapshot.ownerMachine !== snapshot.machine || snapshot.heartbeatMachine !== snapshot.machine) {
    return bad('owner/heartbeat machine 身份漂移')
  }
  if (!SHA1.test(snapshot.codeVersion)) return bad('bootstrap codeVersion 非 exact SHA')
  for (const [label, value] of Object.entries({
    codeHeadSha: snapshot.codeHeadSha,
    bundleHeadSha: snapshot.bundleHeadSha,
    heartbeatHeadSha: snapshot.heartbeatHeadSha,
    sourceSha: snapshot.sourceSha,
  })) {
    if (value !== snapshot.codeVersion) return bad(`${label} 与 codeVersion 漂移`)
  }
  return { ok: true }
}

function legacyQueueCount(path: string, directInbox: boolean): number {
  let entries: Dirent[]
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch (error) {
    throw new Error(`[cluster-lifecycle] 读取 legacy 队列失败:${path}:${errorMessage(error)}`, { cause: error })
  }
  let count = 0
  for (const entry of entries) {
    if (directInbox && entry.isDirectory()) continue
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`[cluster-lifecycle] legacy 队列含非法条目:${join(path, entry.name)}`)
    }
    count++
  }
  return count
}

function readDirectory(path: string, label: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch (error) {
    throw new Error(`[cluster-lifecycle] 读取 ${label} 失败:${path}:${errorMessage(error)}`, { cause: error })
  }
}

function fileSha256(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (error) {
    throw new Error(`[cluster-lifecycle] 读取 legacy 隔离文件失败:${path}:${errorMessage(error)}`, { cause: error })
  }
}

/** 只审计 legacy 工单队列；heartbeat/owner 是迁移期可变控制面，不可伪装成队列隔离证据。 */
export function legacyQueueSnapshot(share: string): LegacyQueueSnapshot {
  const root = join(share, 'jobs')
  const entries: LegacyQueueEntry[] = []
  for (const machineEntry of readDirectory(root, 'legacy 根目录')) {
    if (machineEntry.name === '_heartbeat' || machineEntry.name === '_owners') {
      if (!machineEntry.isDirectory()) throw new Error(`[cluster-lifecycle] legacy 控制目录类型非法:${machineEntry.name}`)
      continue
    }
    if (!machineEntry.isDirectory()) throw new Error(`[cluster-lifecycle] legacy 根含非目录条目:${machineEntry.name}`)
    const machineRoot = join(root, machineEntry.name)
    for (const entry of readDirectory(machineRoot, `legacy machine ${machineEntry.name}`)) {
      if (entry.isFile()) {
        if (!entry.name.endsWith('.json')) throw new Error(`[cluster-lifecycle] legacy inbox 含非 JSON:${entry.name}`)
        const relativePath = `${machineEntry.name}/${entry.name}`
        entries.push({ path: relativePath, sha256: fileSha256(join(machineRoot, entry.name)) })
        continue
      }
      if (!entry.isDirectory() || !['running', 'done', 'failed'].includes(entry.name)) {
        throw new Error(`[cluster-lifecycle] legacy machine 含未知状态:${machineEntry.name}/${entry.name}`)
      }
      for (const stateEntry of readDirectory(join(machineRoot, entry.name), `legacy ${entry.name}`)) {
        if (!stateEntry.isFile() || !stateEntry.name.endsWith('.json')) {
          throw new Error(`[cluster-lifecycle] legacy ${entry.name} 含非法条目:${stateEntry.name}`)
        }
        const relativePath = `${machineEntry.name}/${entry.name}/${stateEntry.name}`
        entries.push({ path: relativePath, sha256: fileSha256(join(machineRoot, entry.name, stateEntry.name)) })
      }
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path))
  return { entries, manifestSha256: lifecyclePayloadSha256(entries) }
}

export function assertLegacyQueueDrained(snapshot: LegacyQueueSnapshot): void {
  const active = snapshot.entries.filter(entry => {
    const parts = entry.path.split('/')
    return parts.length === 2 || parts[1] === 'running'
  })
  if (active.length > 0) {
    throw new Error(`[cluster-lifecycle] legacy inbox/running 未 drain:${active.map(entry => entry.path).join(',')}`)
  }
}

export function legacyBootstrapState(
  path: string,
  machine: string,
  submissionId: string,
): LegacyBootstrapIsolationEvidence['bootstrapObservedState'] | undefined {
  const file = `${submissionId}.json`
  if (path === `${machine}/${file}`) return 'inbox'
  for (const state of ['running', 'done', 'failed'] as const) {
    if (path === `${machine}/${state}/${file}`) return state
  }
  return undefined
}

/** baseline 文件必须逐字保留；新增项只能是每机恰好一份身份正确的 bootstrap。 */
export function observeLegacyBootstrapIsolation(options: {
  share: string
  before: LegacyQueueSnapshot
  bootstraps: LegacyBootstrapExpectation[]
  handoffProofs?: readonly LegacyHandoffProof[]
}): {
  snapshot: LegacyQueueSnapshot
  perMachine: LegacyBootstrapIsolationEvidence[]
  consumedCount: number
  unexpectedWriteCount: number
} {
  const proofs = indexLegacyHandoffProofs(options.handoffProofs, options.bootstraps)
  const snapshot = legacyQueueSnapshot(options.share)
  const current = new Map(snapshot.entries.map(entry => [entry.path, entry.sha256]))
  const baselineDrift = options.before.entries.filter(entry => current.get(entry.path) !== entry.sha256)
  if (baselineDrift.length > 0) {
    throw new Error(`[cluster-lifecycle] legacy 隔离基线被消费或漂移:${baselineDrift.map(entry => entry.path).join(',')}`)
  }
  const consumedCount = baselineDrift.length
  const beforePaths = new Set(options.before.entries.map(entry => entry.path))
  const additions = snapshot.entries.filter(entry => !beforePaths.has(entry.path))
  const consumed = new Set<string>()
  const perMachine = options.bootstraps.map(expectation => {
    const proof = proofs.get(expectation.machine)
    if (proof === undefined || proof.submissionId !== expectation.submissionId
      || proof.sourceProtocol !== expectation.sourceProtocol || proof.codeVersion !== expectation.codeVersion) {
      throw new Error(`[cluster-lifecycle] ${expectation.machine} handoff proof 身份漂移`)
    }
    // 接管后的协议号按下限判(来源号 6/8 仍是逐字枚举,那是「从哪来」不是「现在跑几号」)。
    requireAgentProtocol(proof.newProtocol, `${expectation.machine} handoff proof newProtocol`)
    const stateOf = (path: string) => legacyBootstrapState(path, expectation.machine, expectation.submissionId)
    const reused = options.before.entries.some(entry => stateOf(entry.path) !== undefined)
    if (reused) throw new Error(`[cluster-lifecycle] legacy bootstrap submission 已存在:${expectation.submissionId}`)
    const matches = additions.filter(entry => stateOf(entry.path) !== undefined)
    if (matches.length !== 1) {
      throw new Error(`[cluster-lifecycle] legacy bootstrap 隔离态数量异常:${expectation.submissionId}:${matches.length}`)
    }
    const match = matches[0]!
    const state = stateOf(match.path)!
    const raw = readJson(join(options.share, 'jobs', ...match.path.split('/')), `${expectation.submissionId} bootstrap`)
    if (raw.jobId !== expectation.submissionId || raw.codeVersion !== expectation.codeVersion
      || raw.createdBy !== 'cluster-lifecycle-cutover' || raw.kind !== 'test'
      || raw.handoffChallenge !== proof.challenge) {
      throw new Error(`[cluster-lifecycle] legacy bootstrap 身份漂移:${expectation.submissionId}`)
    }
    requireSafeSegment(raw.jobId, `${expectation.submissionId}.jobId`)
    requireSha1(raw.codeVersion, `${expectation.submissionId}.codeVersion`)
    consumed.add(match.path)
    return {
      machine: expectation.machine,
      bootstrapSubmissionId: expectation.submissionId,
      bootstrapSourceProtocol: expectation.sourceProtocol,
      bootstrapObservedPath: match.path,
      bootstrapObservedState: state,
      bootstrapFileSha256: match.sha256,
      bootstrapIsolated: matches.length === 1 && current.get(match.path) === match.sha256,
      otherLegacyConsumedCount: consumedCount,
    }
  })
  const unexpected = additions.filter(entry => !consumed.has(entry.path))
  if (unexpected.length > 0) {
    throw new Error(`[cluster-lifecycle] legacy 隔离发现迟到或未知写入:${unexpected.map(entry => entry.path).join(',')}`)
  }
  return { snapshot, perMachine, consumedCount, unexpectedWriteCount: unexpected.length }
}

export interface LegacyMachineBootstrap {
  machine: string
  sourceProtocol: 6 | 8
  ownerPid: number
  legacyInboxCount: number
  legacyRunningCount: number
}

export function inspectLegacyMachine(share: string, epoch: string, machine: string, codeVersion: string): LegacyMachineBootstrap {
  const jobs = join(share, 'jobs')
  const heartbeat = readJson(join(jobs, '_heartbeat', `${machine}.json`), `${machine} legacy heartbeat`)
  const owner = readJson(join(jobs, '_owners', `${machine}.json`), `${machine} legacy owner`)
  const sourceProtocol = requireInteger(heartbeat.protocol, `${machine} legacy protocol`)
  const snapshot: LegacyBootstrapSnapshot = {
    namespace: LIFECYCLE_NAMESPACE,
    lifecycleSchema: LIFECYCLE_SCHEMA,
    epoch,
    machine,
    codeVersion,
    codeHeadSha: codeVersion,
    bundleHeadSha: codeVersion,
    heartbeatHeadSha: requireSha1(heartbeat.head, `${machine} legacy heartbeat.head`),
    sourceSha: codeVersion,
    ownerMachine: requireSafeSegment(owner.machine, `${machine} legacy owner.machine`),
    heartbeatMachine: requireSafeSegment(heartbeat.machine, `${machine} legacy heartbeat.machine`),
    maintenanceOpen: true,
    legacyInboxCount: legacyQueueCount(join(jobs, machine), true),
    legacyRunningCount: legacyQueueCount(join(jobs, machine, 'running'), false),
    sourceProtocol,
  }
  const verdict = validateLegacyBootstrapSnapshot(snapshot)
  if (!verdict.ok) throw new Error(`[cluster-lifecycle] ${machine} bootstrap 拒绝:${verdict.reason ?? 'unknown'}`)
  if (owner.protocol !== sourceProtocol || owner.head !== codeVersion) {
    throw new Error(`[cluster-lifecycle] ${machine} legacy owner protocol/head 漂移`)
  }
  return {
    machine,
    sourceProtocol: sourceProtocol as 6 | 8,
    ownerPid: requireInteger(owner.pid, `${machine} owner.pid`),
    legacyInboxCount: snapshot.legacyInboxCount,
    legacyRunningCount: snapshot.legacyRunningCount,
  }
}

export function legacyManifestSha256(share: string): string {
  return legacyQueueSnapshot(share).manifestSha256
}
