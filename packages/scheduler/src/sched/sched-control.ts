/** 运维配置与只读控制面；缺文件和读失败分开，绝不因读不到共享盘而补建队列。 */
import { readFileSync } from 'node:fs'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import { hasCode } from '../bot/cluster-lifecycle-contract'
import {
  canonicalJson, fields, isoTime, schedControlPaths, schedPaths, segment, text, validateDispatcherHeartbeat,
  type DispatcherConfig, type DispatcherHeartbeat, type SchedulerSources,
} from './sched-contract'
import { assertSchedulerWritable, causedByCode } from './sched-ledger'

export class SchedulerReadUnavailableError extends Error {}

export function readDispatcherConfig(share: string): DispatcherConfig | undefined {
  let raw: string
  try { raw = readFileSync(schedControlPaths(share).dispatcher, 'utf8') } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw new SchedulerReadUnavailableError('[sched] 无法读取派单主机配置', { cause: error })
  }
  const value: unknown = JSON.parse(raw)
  fields(value, { machine: segment, createdAt: isoTime, createdBy: text })
  return value as DispatcherConfig
}

/** 重复初始化同一主机保留原创建信息；不同主机不能通过 init 偷换归属。 */
export function createDispatcherConfig(share: string, machine: string, createdBy: string, sources: SchedulerSources): void {
  assertSchedulerWritable(share)
  segment(machine); text(createdBy)
  const value: DispatcherConfig = { machine, createdAt: isoTime(sources.now()), createdBy }
  try {
    publishLifecycleFileAtomically(schedControlPaths(share).dispatcher, canonicalJson(value), 'create-only', schedPaths(share).staging)
  } catch (error) {
    if (!causedByCode(error, 'EEXIST')) throw error
    if (readDispatcherConfig(share)?.machine !== machine) throw new Error('[sched] 已指定其他派单主机，禁止覆盖', { cause: error })
  }
}

/** 心跳是展示缓存；调用方先核格式与写者权。 */
export function writeDispatcherHeartbeat(share: string, heartbeat: DispatcherHeartbeat): void {
  assertSchedulerWritable(share)
  validateDispatcherHeartbeat(heartbeat)
  publishLifecycleFileAtomically(schedControlPaths(share).heartbeat, canonicalJson(heartbeat), 'replace', schedPaths(share).staging)
}
