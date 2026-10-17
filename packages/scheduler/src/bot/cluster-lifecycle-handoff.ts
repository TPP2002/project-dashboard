import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  LIFECYCLE_NAMESPACE,
  LIFECYCLE_SCHEMA,
  SHA256,
  lifecyclePayloadSha256,
  readJson,
  requireAgentProtocol,
  requireInteger,
  requireIsoTime,
  requireSafeSegment,
  requireSha1,
  requireText,
  type LifecycleControl,
} from './cluster-lifecycle-contract'
import {
  tryReadLifecycleAgentIdentity,
  type LifecycleAgentIdentitySnapshot,
} from './cluster-lifecycle-status'

export const LEGACY_HANDOFF_STAGES = [
  'ARMED', 'CONSUMED', 'RETIRED', 'ACQUIRED', 'COMPLETE',
] as const
export type LegacyHandoffStage = typeof LEGACY_HANDOFF_STAGES[number]
const HANDOFF_SCHEMA = 'cluster-legacy-handoff/v1' as const

export interface LegacyHandoffReadOptions {
  share: string
  epoch: string
  machine: string
  challenge: string
  sourceProtocol: 6 | 8
  submissionId: string
  codeVersion: string
}

export interface LegacyHandoffProof {
  machine: string
  challenge: string
  sourceProtocol: 6 | 8
  submissionId: string
  codeVersion: string
  witnessToken: string
  oldPid: number
  oldProcessBirthIdentity: string
  /** 接管上来的新代理实际跑着的协议号;原样透传,不回写常量。 */
  newProtocol: number
  newPid: number
  newOwnerToken: string
  newHead: string
  markerSha256: Record<LegacyHandoffStage, string>
}

export function indexLegacyHandoffProofs(
  proofs: readonly LegacyHandoffProof[] | undefined,
  expectations: readonly { machine: string }[],
): Map<string, LegacyHandoffProof> {
  if (proofs === undefined || proofs.length !== expectations.length) {
    throw new Error('[cluster-lifecycle] legacy bootstrap 缺逐机 COMPLETE witness handoff 证明')
  }
  const indexed = new Map<string, LegacyHandoffProof>()
  for (const proof of proofs) {
    if (indexed.has(proof.machine)) throw new Error(`[cluster-lifecycle] ${proof.machine} handoff proof 重复`)
    indexed.set(proof.machine, proof)
  }
  return indexed
}

class HandoffPendingError extends Error {}

function handoffRoot(share: string, epoch: string, machine: string, challenge: string): string {
  return join(
    share,
    LIFECYCLE_NAMESPACE,
    '_control',
    'handoffs',
    requireSafeSegment(epoch, 'handoff epoch'),
    requireSafeSegment(machine, 'handoff machine'),
    requireSafeSegment(challenge, 'handoff challenge'),
  )
}

export function legacyHandoffClaimPath(share: string, epoch: string, machine: string, challenge: string): string {
  return join(handoffRoot(share, epoch, machine, challenge), 'witness-claim.json')
}

export function legacyHandoffStageDirectory(
  share: string,
  epoch: string,
  machine: string,
  challenge: string,
  stage: string,
): string {
  if (!LEGACY_HANDOFF_STAGES.includes(stage as LegacyHandoffStage)) {
    throw new Error(`[cluster-lifecycle] handoff stage 未知:${stage}`)
  }
  return join(handoffRoot(share, epoch, machine, challenge), stage)
}

function sha256(value: unknown, label: string): string {
  const text = requireText(value, label)
  if (!SHA256.test(text)) throw new Error(`[cluster-lifecycle] ${label} 非 64 位小写摘要`)
  return text
}

function markerPath(options: LegacyHandoffReadOptions, stage: LegacyHandoffStage): string {
  const directory = legacyHandoffStageDirectory(
    options.share, options.epoch, options.machine, options.challenge, stage,
  )
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new HandoffPendingError(`[cluster-lifecycle] ${stage} marker 缺失`)
    throw new Error(`[cluster-lifecycle] 读取 ${stage} marker 失败:${String(error)}`, { cause: error })
  }
  if (entries.length === 0) throw new HandoffPendingError(`[cluster-lifecycle] ${stage} marker 缺失`)
  if (entries.length !== 1 || !entries[0]!.isFile() || !entries[0]!.name.endsWith('.json')) {
    throw new Error(`[cluster-lifecycle] ${stage} marker 数量或类型异常:${entries.map(entry => entry.name).join(',')}`)
  }
  return join(directory, entries[0]!.name)
}

function validateMarker(
  options: LegacyHandoffReadOptions,
  stage: LegacyHandoffStage,
  expectedPrevious: string | undefined,
): Record<string, unknown> {
  const path = markerPath(options, stage)
  const marker = readJson(path, `${stage} handoff marker`)
  if (marker.schema !== HANDOFF_SCHEMA || marker.writer !== 'cluster-agent-handoff' || marker.stage !== stage) {
    throw new Error(`[cluster-lifecycle] ${stage} witness writer/schema/stage 漂移`)
  }
  if (marker.namespace !== LIFECYCLE_NAMESPACE || marker.lifecycleSchema !== LIFECYCLE_SCHEMA
    || marker.epoch !== options.epoch || marker.machine !== options.machine
    || marker.challenge !== options.challenge || marker.sourceProtocol !== options.sourceProtocol
    || marker.submissionId !== options.submissionId || marker.codeVersion !== options.codeVersion) {
    throw new Error(`[cluster-lifecycle] ${stage} handoff 身份漂移`)
  }
  const witnessToken = requireSafeSegment(marker.witnessToken, `${stage}.witnessToken`)
  if (basename(path) !== `${witnessToken}.json`) throw new Error(`[cluster-lifecycle] ${stage} marker/token 路径漂移`)
  requireInteger(marker.witnessPid, `${stage}.witnessPid`)
  requireSafeSegment(marker.witnessHost, `${stage}.witnessHost`)
  requireInteger(marker.oldPid, `${stage}.oldPid`)
  sha256(marker.oldProcessBirthIdentity, `${stage}.oldProcessBirthIdentity`)
  sha256(marker.legacyOwnerSha256, `${stage}.legacyOwnerSha256`)
  sha256(marker.legacyHeartbeatSha256, `${stage}.legacyHeartbeatSha256`)
  requireIsoTime(marker.observedAt, `${stage}.observedAt`)
  if (marker.previousStageSha256 !== (expectedPrevious ?? null)) {
    throw new Error(`[cluster-lifecycle] ${stage} previousStageSha256 链漂移`)
  }
  const recordSha256 = sha256(marker.recordSha256, `${stage}.recordSha256`)
  const unsigned = { ...marker }
  delete unsigned.recordSha256
  if (lifecyclePayloadSha256(unsigned) !== recordSha256) {
    throw new Error(`[cluster-lifecycle] ${stage} marker hash 漂移`)
  }
  return marker
}

function readThrough(
  options: LegacyHandoffReadOptions,
  finalStage: LegacyHandoffStage,
): { markers: Record<LegacyHandoffStage, Record<string, unknown>>; hashes: Record<LegacyHandoffStage, string> } {
  requireSha1(options.codeVersion, 'handoff codeVersion')
  const claim = readJson(legacyHandoffClaimPath(
    options.share, options.epoch, options.machine, options.challenge,
  ), 'handoff witness claim')
  if (claim.schema !== HANDOFF_SCHEMA || claim.writer !== 'cluster-agent-handoff'
    || claim.namespace !== LIFECYCLE_NAMESPACE || claim.lifecycleSchema !== LIFECYCLE_SCHEMA
    || claim.epoch !== options.epoch || claim.machine !== options.machine
    || claim.challenge !== options.challenge || claim.sourceProtocol !== options.sourceProtocol
    || claim.submissionId !== options.submissionId || claim.codeVersion !== options.codeVersion) {
    throw new Error('[cluster-lifecycle] handoff witness claim 身份漂移')
  }
  const claimToken = requireSafeSegment(claim.witnessToken, 'handoff claim witnessToken')
  const markers = {} as Record<LegacyHandoffStage, Record<string, unknown>>
  const hashes = {} as Record<LegacyHandoffStage, string>
  let previous: string | undefined
  let previousTime: number | undefined
  let identity: string | undefined
  for (const stage of LEGACY_HANDOFF_STAGES) {
    const marker = validateMarker(options, stage, previous)
    if (marker.witnessToken !== claimToken || marker.witnessPid !== claim.witnessPid
      || marker.witnessHost !== claim.witnessHost || marker.oldPid !== claim.oldPid
      || marker.oldProcessBirthIdentity !== claim.oldProcessBirthIdentity
      || marker.legacyOwnerSha256 !== claim.legacyOwnerSha256
      || marker.legacyHeartbeatSha256 !== claim.legacyHeartbeatSha256) {
      throw new Error(`[cluster-lifecycle] ${stage} 与 witness claim 身份漂移`)
    }
    const stableIdentity = lifecyclePayloadSha256({
      witnessToken: marker.witnessToken,
      witnessPid: marker.witnessPid,
      witnessHost: marker.witnessHost,
      oldPid: marker.oldPid,
      oldProcessBirthIdentity: marker.oldProcessBirthIdentity,
      legacyOwnerSha256: marker.legacyOwnerSha256,
      legacyHeartbeatSha256: marker.legacyHeartbeatSha256,
    })
    if (identity !== undefined && stableIdentity !== identity) {
      throw new Error(`[cluster-lifecycle] ${stage} witness 身份链漂移`)
    }
    const observedTime = Date.parse(String(marker.observedAt))
    if (previousTime !== undefined && observedTime < previousTime) {
      throw new Error(`[cluster-lifecycle] ${stage} witness 时钟倒退`)
    }
    identity = stableIdentity
    previousTime = observedTime
    previous = requireText(marker.recordSha256, `${stage}.recordSha256`)
    markers[stage] = marker
    hashes[stage] = previous
    if (stage === finalStage) break
  }
  return { markers, hashes }
}

export function waitForLegacyHandoffStage(
  options: LegacyHandoffReadOptions,
  stage: LegacyHandoffStage,
  timeoutMs: number,
): Record<string, unknown> {
  const deadline = performance.now() + timeoutMs
  while (true) {
    try { return readThrough(options, stage).markers[stage] } catch (error) {
      if (!(error instanceof HandoffPendingError)) throw error
      if (performance.now() >= deadline) {
        throw new Error(`[cluster-lifecycle] 等待 ${stage} handoff marker 超时`, { cause: error })
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

export function readLegacyHandoffProof(options: LegacyHandoffReadOptions): LegacyHandoffProof {
  const { markers, hashes } = readThrough(options, 'COMPLETE')
  const consumed = markers.CONSUMED
  const retired = markers.RETIRED
  const acquired = markers.ACQUIRED
  const complete = markers.COMPLETE
  if (consumed.bootstrapState !== 'running') throw new Error('[cluster-lifecycle] CONSUMED 未证明 running')
  sha256(consumed.bootstrapSha256, 'CONSUMED.bootstrapSha256')
  if (requireInteger(retired.selfUpgradeTried, 'RETIRED.selfUpgradeTried') < 1
    || retired.oldPidExited !== true) throw new Error('[cluster-lifecycle] RETIRED 未证明 self-upgrade/PID 退出')
  sha256(retired.selfUpgradingHeartbeatSha256, 'RETIRED.selfUpgradingHeartbeatSha256')
  // 下限判定:交接证明只需证明「接管方跑的是 v13 及以后的身份协议」,不是某一个写死的号。
  const newProtocol = requireAgentProtocol(acquired.newProtocol, 'ACQUIRED.newProtocol')
  if (complete.newProtocol !== newProtocol || complete.complete !== true) {
    throw new Error('[cluster-lifecycle] ACQUIRED/COMPLETE 未证明同一代理协议号')
  }
  const newPid = requireInteger(acquired.newPid, 'ACQUIRED.newPid')
  const oldPid = requireInteger(markers.ARMED.oldPid, 'ARMED.oldPid')
  if (newPid <= 0 || newPid === oldPid || complete.newPid !== newPid) {
    throw new Error('[cluster-lifecycle] 新旧 PID 复用或漂移')
  }
  const newOwnerToken = requireSafeSegment(acquired.newOwnerToken, 'ACQUIRED.newOwnerToken')
  const newHead = requireSha1(acquired.newHead, 'ACQUIRED.newHead')
  if (complete.newOwnerToken !== newOwnerToken || complete.newHead !== newHead || newHead !== options.codeVersion) {
    throw new Error('[cluster-lifecycle] COMPLETE 新 owner/head 漂移')
  }
  for (const field of ['newOwnerSha256', 'newHeartbeatSha256'] as const) {
    const digest = sha256(acquired[field], `ACQUIRED.${field}`)
    if (complete[field] !== digest) throw new Error(`[cluster-lifecycle] COMPLETE.${field} 漂移`)
  }
  return {
    machine: options.machine,
    challenge: options.challenge,
    sourceProtocol: options.sourceProtocol,
    submissionId: options.submissionId,
    codeVersion: options.codeVersion,
    witnessToken: requireSafeSegment(markers.ARMED.witnessToken, 'witnessToken'),
    oldPid,
    oldProcessBirthIdentity: sha256(markers.ARMED.oldProcessBirthIdentity, 'oldProcessBirthIdentity'),
    newProtocol,
    newPid,
    newOwnerToken,
    newHead,
    markerSha256: hashes,
  }
}

export function waitForProtocol13AgentIdentities(
  share: string,
  control: LifecycleControl,
  timeoutMs: number,
): { machine: string; heartbeat: LifecycleAgentIdentitySnapshot }[] {
  const deadline = performance.now() + timeoutMs
  while (true) {
    const snapshots = control.configuredMachines.flatMap(machine => {
      const heartbeat = tryReadLifecycleAgentIdentity(share, control, machine)
      return heartbeat === undefined ? [] : [{ machine, heartbeat }]
    })
    if (snapshots.length === control.configuredMachines.length) return snapshots
    if (performance.now() >= deadline) throw new Error('[cluster-lifecycle] 等待三机 protocol13 identity 超时')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
}
