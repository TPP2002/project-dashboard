/** §6.5 的纯判定。毫秒时间由控制端注入，未知读数绝不能变成恢复许可。 */
import type { PauseReason } from './sched-contract'

export const CI_IDLE_DEBOUNCE_MS = 60_000
export const CI_READING_FRESH_MS = 30_000
export const CI_SLOW_AFTER_MS = 30 * 60_000
export const CI_UNKNOWN_ALERT_MS = 3 * 60 * 60_000
export interface CiObservation { state: 'active' | 'idle' | 'unknown'; observedAt: number }
export interface CiMemory {
  idleSince: number | null; lastAt: number | null; previous: CiObservation | null; unknownMs: number
  admissionHeld?: boolean
}
export function emptyCiMemory(): CiMemory { return { idleSince: null, lastAt: null, previous: null, unknownMs: 0 } }
export function freshCi(observation: CiObservation, now: number): boolean {
  return Number.isFinite(observation.observedAt) && observation.observedAt <= now
    && now - observation.observedAt <= CI_READING_FRESH_MS && observation.state !== 'unknown'
}

/**
 * 每拍取最新读数；缓存同一条空闲不能跨过新鲜度期限。跨重启重新累计空闲窗口。
 * `ciAware`（UDQ-T4B-2）= 这棵树是 CI 在跑期间按余量派出来的：CI 原因对它不置位（manual/owner-hold 照旧），
 * 三小时未知兜底告警也不适用；空闲去抖与未知累计的记账逻辑一字不改，只对 ci 是否入 reasons 短路。
 * `ciCoexist`（SCHED-CI-COEXIST-0925，见 sched-ci-policy.ts）= 共存模式：CI 对所有作业都不置位，
 * 已经因 CI 冻着的树本拍就解冻（不必再等 60 秒空闲去抖）；与 ciAware 的差别只在于不降优先级，
 * 那一半在控制器里，不在这个纯判定里。
 */
export function decideSuspension(input: {
  now: number; observation: CiObservation; memory: CiMemory; reasons: readonly PauseReason[]
  manual: boolean; ownerHold: boolean; category: string; pausedSince: number | null; ciAware?: boolean; ciCoexist?: boolean
}): { mode: 'running' | 'paused' | 'slow'; reasons: PauseReason[]; memory: CiMemory; alert: boolean } {
  const { now, observation, memory: old } = input
  if (!Number.isFinite(now) || (old.lastAt !== null && now < old.lastAt)) throw new Error('[sched] 挂起时钟倒退')
  const ciAware = input.ciAware === true || input.ciCoexist === true
  const known = freshCi(observation, now)
  const contiguous = old.lastAt !== null && now - old.lastAt <= CI_READING_FRESH_MS
    && old.previous?.state === 'idle' && freshCi(old.previous, now)
    && observation.observedAt >= old.previous.observedAt
  const idleSince = known && observation.state === 'idle' ? (contiguous ? old.idleSince ?? now : now) : null
  let ci = !ciAware && input.reasons.includes('ci')
  if (!ciAware && known && observation.state === 'active') ci = true
  if (!ciAware && idleSince !== null && now - idleSince >= CI_IDLE_DEBOUNCE_MS) ci = false
  const reasons: PauseReason[] = []
  if (ci) reasons.push('ci')
  if (input.manual) reasons.push('manual')
  if (input.ownerHold) reasons.push('owner-hold')
  let unknownMs = old.unknownMs
  if (input.reasons.length === 1 && input.reasons[0] === 'ci' && old.lastAt !== null) {
    const knownUntil = old.previous && old.previous.state !== 'unknown' && old.previous.observedAt <= old.lastAt
      ? old.previous.observedAt + CI_READING_FRESH_MS : old.lastAt
    unknownMs += Math.max(0, now - Math.max(old.lastAt, knownUntil))
  }
  if (!ci) unknownMs = 0
  const pureCi = reasons.length === 1 && reasons[0] === 'ci'
  // ciAware 下 reasons 永远不含 ci，pureCi 必假 ⇒ 三小时未知兜底告警对它自然不适用，不必另加判据。
  const alert = pureCi && !known && unknownMs > CI_UNKNOWN_ALERT_MS
  const canSlow = pureCi && ['calib-run', 'perf-bench'].includes(input.category)
    && input.pausedSince !== null && now - input.pausedSince >= CI_SLOW_AFTER_MS
  return { reasons, mode: reasons.length === 0 ? 'running' : canSlow ? 'slow' : 'paused', alert,
    memory: { idleSince, lastAt: now, previous: { ...observation }, unknownMs } }
}

/** 领单口退役旧的二十分钟放行；空闲同样须去抖。零工作时无需启动额外探针。 */
export function ciAllowsAdmission(now: number, observation: CiObservation, memory: CiMemory): { allowed: boolean; memory: CiMemory } {
  if (!memory.admissionHeld && freshCi(observation, now) && observation.state === 'idle') {
    return { allowed: true, memory: { ...memory, lastAt: now, previous: observation, admissionHeld: false } }
  }
  const decision = decideSuspension({ now, observation, memory, reasons: ['ci'], manual: false, ownerHold: false,
    category: 'unit-test', pausedSince: null })
  const allowed = decision.reasons.length === 0
  return { allowed, memory: { ...decision.memory, admissionHeld: !allowed } }
}
