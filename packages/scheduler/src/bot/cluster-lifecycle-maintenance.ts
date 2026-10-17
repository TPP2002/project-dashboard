import deployment from '../sched/client/deployment-config.cjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { publishLifecycleFileAtomically } from './cluster-lifecycle-atomic-file'
import { dirname, join } from 'node:path'
import {
  LIFECYCLE_NAMESPACE,
  canonicalLifecycleJson,
  errorMessage,
  hasCode,
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
} from './cluster-lifecycle-contract'
import { activeLifecycleControlPath } from './cluster-lifecycle-control'
import {
  acquireLifecycleOperatorLock,
  releaseLifecycleOperatorLock,
  type LifecycleOperatorLock,
} from './cluster-lifecycle-atomic-move'
import { pathExistsFailClosed } from './cluster-lifecycle-state'

const GATE_SCHEMA = 'cluster-lifecycle-maintenance-gate/v1' as const
export type { LifecycleOperatorLock } from './cluster-lifecycle-atomic-move'

export interface LifecycleExactProof {
  sourceHeadSha: string
  codeHeadSha: string
  bundleHeadSha: string
  bundleSha256: string
  controlSha256: string
  maintenanceGateSha256: string
  maintenanceClosedSha256: string
  operatorLockToken: string
}

function controlRoot(share: string): string {
  return join(share, LIFECYCLE_NAMESPACE, '_control')
}

function gatePath(share: string): string {
  return join(controlRoot(share), 'maintenance-gate.json')
}

function closedPath(share: string, maintenanceId: string): string {
  return join(controlRoot(share), `maintenance-${maintenanceId}-closed.json`)
}

function writeExclusive(path: string, value: unknown, label: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    // 缺省暂存面 = `_control` 的父目录（生命周期根），无 fail-closed 扫描器。
    publishLifecycleFileAtomically(path, `${canonicalLifecycleJson(value)}\n`, 'create-only')
  } catch (error) {
    throw new Error(`[cluster-lifecycle] ${label} wx 失败:${path}:${errorMessage(error)}`, { cause: error })
  }
}

function optionalJson(path: string, label: string): Record<string, unknown> | undefined {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw new Error(`[cluster-lifecycle] 读取 ${label} 失败:${path}:${errorMessage(error)}`, { cause: error })
  }
  try { return requireRecord(JSON.parse(raw), label) } catch (error) {
    throw new Error(`[cluster-lifecycle] ${label} 非合法 JSON:${errorMessage(error)}`, { cause: error })
  }
}

function validateGate(gate: Record<string, unknown>): {
  maintenanceId: string
  operatorLockToken: string
  owner: string
} {
  if (gate.schema !== GATE_SCHEMA || gate.state !== 'OPEN' || gate.exclusive !== true) {
    throw new Error('[cluster-lifecycle] maintenance gate schema/state/exclusive 漂移')
  }
  requireIsoTime(gate.openedAt, 'maintenance openedAt')
  return {
    maintenanceId: requireSafeSegment(gate.maintenanceId, 'maintenanceId'),
    operatorLockToken: requireSafeSegment(gate.operatorLockToken, 'operatorLockToken'),
    owner: requireText(gate.owner, 'maintenance owner'),
  }
}

export function readLifecycleMaintenance(share: string): {
  open: boolean
  gate?: Record<string, unknown>
  closed?: Record<string, unknown>
} {
  const gate = optionalJson(gatePath(share), 'maintenance gate')
  if (gate === undefined) return { open: false }
  const identity = validateGate(gate)
  const closed = optionalJson(closedPath(share, identity.maintenanceId), 'maintenance closed marker')
  if (closed === undefined) return { open: true, gate }
  if (closed.state !== 'CLOSED' || closed.maintenanceId !== identity.maintenanceId
    || closed.operatorLockToken !== identity.operatorLockToken) {
    throw new Error('[cluster-lifecycle] maintenance closed marker 身份漂移')
  }
  requireIsoTime(closed.closedAt, 'maintenance closedAt')
  return { open: false, gate, closed }
}

export function assertLifecycleDispatchAllowed(share: string): void {
  if (readLifecycleMaintenance(share).open) {
    throw new Error('[cluster-lifecycle] maintenance OPEN，publisher 零写拒绝')
  }
}

export function assertLifecyclePathAbsent(path: string, label: string): void {
  if (pathExistsFailClosed(path)) throw new Error(`[cluster-lifecycle] ${label} 已存在，禁止复用:${path}`)
}

export function withLifecycleOperatorLock<T>(
  share: string,
  owner: string,
  action: (lock: LifecycleOperatorLock) => T,
  /** 本次持锁干什么(如 `--job test`)。写进 lease,让撞锁的人不必靠人肉扫进程判死活。 */
  purpose?: string,
): T {
  assertLifecycleDispatchAllowed(share)
  const lock = acquireLifecycleOperatorLock(share, owner, purpose === undefined ? {} : { purpose })
  let result: T | undefined
  let operationError: unknown
  try {
    assertLifecycleDispatchAllowed(share)
    result = action(lock)
  } catch (error) { operationError = error }
  let releaseError: unknown
  try { releaseLifecycleOperatorLock(lock) } catch (error) { releaseError = error }
  if (operationError !== undefined) throw operationError
  if (releaseError !== undefined) {
    throw new Error(`[cluster-lifecycle] operator lock release 失败:${errorMessage(releaseError)}`, { cause: releaseError })
  }
  return result as T
}

export function openLifecycleMaintenance(
  lock: LifecycleOperatorLock,
  maintenanceId: string,
  openedAt: string,
): Record<string, unknown> {
  const gate = {
    schema: GATE_SCHEMA,
    maintenanceId: requireSafeSegment(maintenanceId, 'maintenanceId'),
    operatorLockToken: lock.token,
    owner: lock.owner,
    openedAt: requireIsoTime(openedAt, 'maintenance openedAt'),
    exclusive: true,
    state: 'OPEN',
  }
  writeExclusive(gatePath(lock.share), gate, 'maintenance gate')
  return gate
}

export function closeLifecycleMaintenance(
  lock: LifecycleOperatorLock,
  maintenanceId: string,
  closedAt: string,
): Record<string, unknown> {
  const current = readLifecycleMaintenance(lock.share)
  if (!current.open || current.gate === undefined
    || current.gate.maintenanceId !== maintenanceId || current.gate.operatorLockToken !== lock.token) {
    throw new Error('[cluster-lifecycle] maintenance close 身份漂移')
  }
  const closed = {
    maintenanceId,
    operatorLockToken: lock.token,
    closedAt: requireIsoTime(closedAt, 'maintenance closedAt'),
    state: 'CLOSED',
  }
  writeExclusive(closedPath(lock.share, maintenanceId), closed, 'maintenance closed marker')
  return closed
}

function exactHead(path: string, label: string): string {
  let value: string
  try { value = readFileSync(path, 'utf8').split(/\r?\n/)[0]?.trim() ?? '' } catch (error) {
    throw new Error(`[cluster-lifecycle] 读取 ${label} 失败:${path}:${errorMessage(error)}`, { cause: error })
  }
  return requireSha1(value, label)
}

function fileSha256(path: string, label: string): string {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') } catch (error) {
    throw new Error(`[cluster-lifecycle] 读取 ${label} 失败:${path}:${errorMessage(error)}`, { cause: error })
  }
}

function verifiedBundleSha256(path: string, expectedSha: string): string {
  const before = fileSha256(path, 'shared bundle')
  let output: string
  try {
    execFileSync('git', ['bundle', 'verify', path], { stdio: 'pipe', windowsHide: true })
    output = execFileSync('git', ['bundle', 'list-heads', path], { encoding: 'utf8', windowsHide: true })
  } catch (error) {
    throw new Error(`[cluster-lifecycle] shared bundle Git 校验失败:${path}:${errorMessage(error)}`, { cause: error })
  }
  const heads = output.split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim())
    if (match === null) throw new Error(`[cluster-lifecycle] shared bundle list-heads 输出非法:${line}`)
    return match[1]!
  })
  const after = fileSha256(path, 'shared bundle')
  if (before !== after) throw new Error('[cluster-lifecycle] shared bundle 校验期间漂移')
  if (!heads.includes(expectedSha)) throw new Error('[cluster-lifecycle] shared bundle 未包含 expected exact head')
  return after
}

export function readLifecycleExactProof(options: {
  share: string
  epoch: string
  expectedSha: string
  sourceHead: () => string
  maintenanceId: string
  operatorLockToken: string
}): LifecycleExactProof {
  const expected = requireSha1(options.expectedSha, 'exact expectedSha')
  const sourceHeadSha = requireSha1(options.sourceHead(), 'source HEAD')
  const codeHeadSha = exactHead(join(options.share, 'code-head.txt'), 'code-head')
  const bundleHeadSha = exactHead(join(options.share, 'bundle-head.txt'), 'bundle-head')
  if ([sourceHeadSha, codeHeadSha, bundleHeadSha].some(value => value !== expected)) {
    throw new Error('[cluster-lifecycle] source/code-head/bundle-head exact 漂移')
  }
  const control = readJson(activeLifecycleControlPath(options.share), 'exact ACTIVE control')
  if (control.state !== 'ACTIVE' || control.epoch !== options.epoch || control.codeVersion !== expected) {
    throw new Error('[cluster-lifecycle] exact ACTIVE control 漂移')
  }
  const maintenance = readLifecycleMaintenance(options.share)
  const gateToken = maintenance.gate === undefined
    ? undefined
    : requireSafeSegment(maintenance.gate.operatorLockToken, 'live maintenance operatorLockToken')
  if (maintenance.open || maintenance.gate === undefined || maintenance.closed === undefined
    || maintenance.gate.maintenanceId !== options.maintenanceId
    || gateToken !== options.operatorLockToken) {
    throw new Error('[cluster-lifecycle] exact maintenance token/closed 漂移')
  }
  return {
    sourceHeadSha,
    codeHeadSha,
    bundleHeadSha,
    bundleSha256: verifiedBundleSha256(join(options.share, configuredBundleName()), expected),
    controlSha256: lifecyclePayloadSha256(control),
    maintenanceGateSha256: lifecyclePayloadSha256(maintenance.gate),
    maintenanceClosedSha256: lifecyclePayloadSha256(maintenance.closed),
    operatorLockToken: gateToken,
  }
}

export function verifyLifecycleExactReceipt(options: {
  share: string
  control: LifecycleControl
  exact: unknown
  maintenance: unknown
  sourceHeadSha?: string
}): void {
  const exact = requireRecord(options.exact, 'cutover exactProof')
  const maintenance = requireRecord(options.maintenance, 'cutover maintenanceGate')
  const live = readLifecycleExactProof({
    share: options.share,
    epoch: options.control.epoch,
    expectedSha: options.control.codeVersion,
    sourceHead: () => options.sourceHeadSha ?? requireSha1(exact.sourceHeadSha, 'receipt sourceHeadSha'),
    maintenanceId: requireSafeSegment(maintenance.maintenanceId, 'receipt maintenanceId'),
    operatorLockToken: requireSafeSegment(maintenance.operatorLockToken, 'receipt operatorLockToken'),
  })
  for (const [field, value] of Object.entries(live)) {
    if (exact[field] !== value) throw new Error(`[cluster-lifecycle] cutover exactProof.${field} live 漂移`)
  }
}

export function verifyLifecycleReceiptMachine(
  item: Record<string, unknown>,
  control: LifecycleControl,
  machine: string,
): { ownerPid: number; ownerToken: string; agentHeadSha: string } {
  const agentHeadSha = requireSha1(item.agentHeadSha, `${machine} agentHeadSha`)
  for (const field of ['codeHeadSha', 'bundleHeadSha', 'sourceSha'] as const) {
    if (requireSha1(item[field], `${machine} ${field}`) !== control.codeVersion) {
      throw new Error(`[cluster-lifecycle] cutover ${machine} ${field} 漂移`)
    }
  }
  // 协议号按下限判,不逐字比数字:提号之后跑新协议的机器仍要能出具合法回执。
  requireAgentProtocol(item.agentProtocol, `${machine} agentProtocol`)
  if (agentHeadSha !== control.codeVersion || item.identityConsistent !== true) {
    throw new Error(`[cluster-lifecycle] cutover ${machine} agent identity 漂移`)
  }
  const owner = requireRecord(item.owner, `${machine} receipt owner`)
  const heartbeat = requireRecord(item.heartbeat, `${machine} receipt heartbeat`)
  const ownerPid = requireInteger(owner.pid, `${machine} receipt owner.pid`)
  const ownerToken = requireSafeSegment(owner.token, `${machine} receipt owner.token`)
  requireAgentProtocol(heartbeat.protocol, `${machine} receipt heartbeat.protocol`)
  if (owner.machine !== machine || heartbeat.machine !== machine
    || heartbeat.headSha !== control.codeVersion || heartbeat.ownerToken !== ownerToken) {
    throw new Error(`[cluster-lifecycle] cutover ${machine} owner/heartbeat 漂移`)
  }
  return { ownerPid, ownerToken, agentHeadSha }
}

function configuredBundleName(): string {
  const name = deployment.getDeploymentConfig().lifecycleBundleName
  if (!name) throw new Error('[cluster-lifecycle] deployment lifecycle bundle name not configured')
  return name
}
