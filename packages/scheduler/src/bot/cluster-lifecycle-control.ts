import { join } from 'node:path'
import {
  LIFECYCLE_NAMESPACE,
  LIFECYCLE_SCHEMA,
  readJson,
  requireIsoTime,
  requireSafeSegment,
  requireSha1,
  requireText,
  type LifecycleControl,
} from './cluster-lifecycle-contract'

export interface LifecyclePaths {
  root: string
  control: string
  epochRoot: string
  claims: string
  transitionLocks: string
  heartbeat: string
  owners: string
  /** 原子发布的暂存面。刻意与五态目录、machines 根分开:那两层都有 fail-closed 扫描器。 */
  staging: string
  machinesRoot: string
  machineRoot: string
  inbox: string
  running: string
  done: string
  failed: string
  quarantine: string
}

export function activeLifecycleControlPath(share: string): string {
  return join(share, LIFECYCLE_NAMESPACE, '_control', 'active-epoch.json')
}

export function lifecyclePaths(share: string, epoch: string, machine: string): LifecyclePaths {
  requireSafeSegment(epoch, 'epoch')
  requireSafeSegment(machine, 'machine')
  const root = join(share, LIFECYCLE_NAMESPACE)
  const epochRoot = join(root, 'epochs', epoch)
  const machineRoot = join(epochRoot, 'machines', machine)
  return {
    root,
    control: activeLifecycleControlPath(share),
    epochRoot,
    // `_claims` 不在 machines/<machine>/inbox，agent 只扫描 inbox 里的 *.json，故不会把 claim 当工单。
    claims: join(epochRoot, '_claims'),
    transitionLocks: join(epochRoot, '_transition-locks'),
    heartbeat: join(epochRoot, '_heartbeat'),
    owners: join(epochRoot, '_owners'),
    staging: join(epochRoot, '_staging'),
    machinesRoot: join(epochRoot, 'machines'),
    machineRoot,
    inbox: join(machineRoot, 'inbox'),
    running: join(machineRoot, 'running'),
    done: join(machineRoot, 'done'),
    failed: join(machineRoot, 'failed'),
    quarantine: join(machineRoot, 'quarantine'),
  }
}

export interface ReadLifecycleControlOptions {
  share: string
  expectedEpoch?: string
  machine?: string
  codeVersion?: string
}

/** ACTIVE control 缺失、损坏、漂移或 I/O 异常都抛错；本函数绝不创建目录。 */
export function readActiveLifecycleControl({
  share,
  expectedEpoch,
  machine,
  codeVersion,
}: ReadLifecycleControlOptions): LifecycleControl {
  const raw = readJson(activeLifecycleControlPath(share), 'ACTIVE lifecycle control')
  if (raw.namespace !== LIFECYCLE_NAMESPACE || raw.lifecycleSchema !== LIFECYCLE_SCHEMA) {
    throw new Error('[cluster-lifecycle] control namespace/schema 不是 jobs-v12/12')
  }
  if (raw.state !== 'ACTIVE') throw new Error(`[cluster-lifecycle] control 非 ACTIVE:${String(raw.state)}`)
  const epoch = requireSafeSegment(raw.epoch, 'control.epoch')
  const controlCodeVersion = requireSha1(raw.codeVersion, 'control.codeVersion')
  const createdAt = requireIsoTime(raw.createdAt, 'control.createdAt')
  const createdBy = requireText(raw.createdBy, 'control.createdBy')
  if (!Array.isArray(raw.configuredMachines) || raw.configuredMachines.length === 0) {
    throw new Error('[cluster-lifecycle] control.configuredMachines 必须是非空数组')
  }
  const configuredMachines = raw.configuredMachines.map((entry, index) =>
    requireSafeSegment(entry, `control.configuredMachines[${index}]`))
  if (new Set(configuredMachines).size !== configuredMachines.length) {
    throw new Error('[cluster-lifecycle] control.configuredMachines 有重复机器')
  }
  if (expectedEpoch !== undefined && epoch !== expectedEpoch) {
    throw new Error(`[cluster-lifecycle] epoch 漂移:期待 ${expectedEpoch}，实际 ${epoch}`)
  }
  if (machine !== undefined && !configuredMachines.includes(machine)) {
    throw new Error(`[cluster-lifecycle] machine ${machine} 不在 ACTIVE epoch 配置中`)
  }
  if (codeVersion !== undefined && controlCodeVersion !== codeVersion) {
    throw new Error(`[cluster-lifecycle] codeVersion 漂移:期待 ${codeVersion}，实际 ${controlCodeVersion}`)
  }
  return {
    namespace: LIFECYCLE_NAMESPACE,
    lifecycleSchema: LIFECYCLE_SCHEMA,
    epoch,
    state: 'ACTIVE',
    codeVersion: controlCodeVersion,
    configuredMachines,
    createdAt,
    createdBy,
  }
}
