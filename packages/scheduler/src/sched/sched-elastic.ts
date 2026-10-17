import type { SubmissionRequest } from './sched-contract'

/** 本卡 2026-09-24:保底 4 核,副机单测开 4 路仍可在可接受时间跑完,与 e2e 缺省 4 核同档。 */
export const ELASTIC_FLOOR_CORES = 4
/** 本卡 2026-09-24:最多 12 核,沿用今天单测的授予上限。 */
export const ELASTIC_CAP_CORES = 12
/** 本卡 2026-09-24:预留 2 核,一张 typecheck 加一张 lint 可以随到随跑。 */
export const ELASTIC_HEADROOM_CORES = 2

export function isElasticRequest(request: { execution?: string; category: string; work: { workers?: number } }): boolean {
  return request.execution === 'cluster' && request.category === 'unit-test' && request.work.workers === undefined
}
export function elasticReplayAllowed(request: SubmissionRequest): boolean {
  return isElasticRequest(request) || (request.execution === 'auto' && request.menu?.elastic === true)
}

export function elasticFloorCores(quotaCores: number | undefined): number {
  return quotaCores === undefined ? ELASTIC_FLOOR_CORES : Math.min(ELASTIC_FLOOR_CORES, Math.max(quotaCores - 1, 1))
}

export function elasticCapCores(quotaCores: number): number {
  return Math.min(ELASTIC_CAP_CORES, Math.max(quotaCores - 1, 1))
}

/**
 * 满额申请的核数 = 配额 − 2 核余量(卡 CLUSTER-FULL-QUOTA-NEVER-GRANTED-1002)。
 * 为什么不是配额本身:调度台授予要求「可派核 ≥ 申请数」,而可派核已扣外部负载——Windows
 * 常态底噪 0.2~1.5 核,申请满额时这条判据永远不成立,单子会静默排队到超时(1002 现场:主机
 * 可派核 15.8 < 申请 17,排队 9 分钟纹丝不动,撤单改 --workers 才跑起来)。
 * 为什么复用 ELASTIC_HEADROOM_CORES:弹性授予留 2 核给「一张 typecheck 加一张 lint 随到随跑」,
 * 这里是同一个道理的余量——既兜住外部负载的底噪,也给 CI 小活留位,不另造一个数字。
 */
export function fullQuotaCores(quotaCores: number): number {
  if (!Number.isSafeInteger(quotaCores) || quotaCores < 1) {
    throw new Error(`[sched] 满额申请需要有效的配额读数:${quotaCores}`)
  }
  return Math.min(quotaCores, Math.max(quotaCores - ELASTIC_HEADROOM_CORES, 1))
}

export function elasticGrantCores(input: {
  requestedCores: number; quotaCores: number; availableCores: number; freeSlotsAfter: number; waitingCores: number
}): number {
  const headroom = input.freeSlotsAfter >= 1 ? ELASTIC_HEADROOM_CORES : 0
  return Math.max(input.requestedCores,
    Math.min(elasticCapCores(input.quotaCores), Math.floor(input.availableCores - input.waitingCores - headroom)))
}
