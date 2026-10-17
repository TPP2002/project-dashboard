/**
 * 派单员全局写者：name/machine 都是逻辑锁键，host 才是真实主机。
 * epoch 固定 sched，不能随集群冷切换改变，否则旧租约会被判路径身份漂移。
 * 每 15 秒续租；所有提交仍逐次 fencing。任何失败都永久关闭本实例的写入口。
 */
import {
  claimOwnerLease, commitOwnerLease, releaseOwnerLease, renewOwnerLease,
  type OwnerLeaseHandle,
} from '../bot/cluster-owner'
import { LIFECYCLE_NAMESPACE, LIFECYCLE_SCHEMA } from '../bot/cluster-lifecycle-contract'
import { isoTime, schedControlPaths, type SchedulerSources } from './sched-contract'

export const SCHED_OWNER_NAME = 'sched-dispatcher'
export const SCHED_RENEW_MS = 15_000
// 临时占用与真正故障分开，托管器收到此码才检查旧版本孤儿。
export const SCHED_OCCUPIED_EXIT_CODE = 75
export interface SchedulerOwnerOptions {
  share: string; host: string; pid: number; protocol: number; head: string
  sources: SchedulerSources; leaseDurationMs?: number
}
export interface SchedulerOwner {
  readonly handle: OwnerLeaseHandle
  readonly stopped: boolean
  renew: () => void
  commit: <T>(operation: () => T) => T
  release: () => void
}

/** 只能传同步提交；guard 在回调返回时释放，不能把 Promise 放进保护区。 */
export function claimSchedulerOwner(options: SchedulerOwnerOptions): SchedulerOwner {
  const { sources, head } = options
  const handle = claimOwnerLease({
    ownersDir: schedControlPaths(options.share).owner,
    identity: {
      name: SCHED_OWNER_NAME, machine: SCHED_OWNER_NAME, host: options.host, pid: options.pid,
      protocol: options.protocol, namespace: LIFECYCLE_NAMESPACE, lifecycleSchema: LIFECYCLE_SCHEMA, epoch: 'sched',
    },
    head, sources, ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
  })
  let renewedAt = Date.parse(isoTime(sources.now()))
  let stopped = false
  const guard = <T>(operation: () => T): T => {
    if (stopped) throw new Error('[sched] 写者已停止，禁止继续写入')
    try { return operation() } catch (error) { stopped = true; throw error }
  }
  return {
    handle,
    get stopped() { return stopped },
    renew: () => guard(() => {
      const now = Date.parse(isoTime(sources.now()))
      if (now < renewedAt) throw new Error('[sched] 续租时钟倒退')
      if (now - renewedAt < SCHED_RENEW_MS) return
      renewOwnerLease({ handle, head, sources })
      renewedAt = now
    }),
    commit: operation => guard(() => commitOwnerLease({ handle, sources }, operation)),
    release: () => {
      if (stopped) return
      try { releaseOwnerLease({ handle, sources }) } finally { stopped = true }
    },
  }
}
