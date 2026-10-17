import { createBoundedCiActivityProbe, type AsyncCiActivityProbeOptions } from './cluster-agent-ci-gate'

export interface AgentCiObservation {
  state: 'idle' | 'active' | 'unknown'
  ciWorkers: number
  observedAt: string
  stateSince: string
  /**
   * 正在跑的 runner 名(去重排序),只在 state==='active' 且名字全部认得出时带上;
   * 认不出时不带,派单员按该机整机余量保守处理。idle/unknown 一律不带。
   */
  runners?: string[]
  /**
   * 本拍探针失败但沿用了上一拍「在跑」读数时带 true;不带 = 新鲜读数,绝不写 false。
   * 只沿用 active:idle 沿用会反向误放行(机器可能已被 CI 跑满),unknown 对 idle 场景保守是对的。
   */
  stale?: true
  /** 沿用的那份读数最后一次被探针真实观察到的时刻(ISO);连续沿用期间不漂移。 */
  staleSince?: string
}

export interface AgentCiObserver {
  start(): void
  stop(): void
  read(): AgentCiObservation
}

const OBSERVE_INTERVAL_MS = 5000
const OBSERVE_CAP_MS = 3000

/**
 * 沿用上一拍「在跑」读数的时间上限(毫秒)。满载期间探针间歇成功,stale 只覆盖两次成功之间的
 * 空窗;上限只防「探针本身坏了」时无限沿用陈旧的 runner 集合。取 CI_YIELD_CAP_MS(20 分钟)的一半。
 */
export const CI_OBSERVATION_STALE_CAP_MS = 10 * 60_000

/**
 * 独立探针只供心跳观测，不复用让路探针的在途状态，也不参与派单决策。
 * 每五秒异步观察，单次最多等三秒；失败或超时若上一拍是「在跑」且最后一次真实观察未超上限，
 * 则沿用该读数并标 stale(observedAt 仍更新为本拍,派单员的整机新鲜度判定才不被卡住),
 * 其余情形记未知；只有状态切换才重置 stateSince。
 * start/stop 幂等；停止后不再调度，已发出的探针自行收尾，迟到结果不能覆盖新一代读数。
 */
export function createAgentCiObserver(
  options: AsyncCiActivityProbeOptions & { now?: () => number } = {},
): AgentCiObserver {
  const now = options.now ?? (() => new Date().getTime())
  const probe = createBoundedCiActivityProbe({ ...options, capMs: OBSERVE_CAP_MS })
  const unknown = (): AgentCiObservation => {
    const at = new Date(now()).toISOString()
    return { state: 'unknown', ciWorkers: 0, observedAt: at, stateSince: at }
  }
  let reading = unknown()
  let timer: ReturnType<typeof setInterval> | undefined
  let generation = 0

  async function observe(startedGeneration: number): Promise<void> {
    const result = await probe()
    if (startedGeneration !== generation) return
    const at = new Date(now()).toISOString()
    // 满载期「探不到」≠「确认没有」:上一拍在跑且最后一次真实观察未超上限 ⇒ 原样沿用并标 stale,
    // 派单员按车道余量留核照派;observedAt 表示这一拍观察过了,staleSince 表示读数真实到几点。
    if (result.failed && reading.state === 'active'
      && now() - Date.parse(reading.staleSince ?? reading.observedAt) <= CI_OBSERVATION_STALE_CAP_MS) {
      reading = { state: reading.state, ciWorkers: reading.ciWorkers, observedAt: at,
        stateSince: reading.stateSince, stale: true, staleSince: reading.staleSince ?? reading.observedAt,
        ...(reading.runners === undefined ? {} : { runners: [...reading.runners] }) }
      return
    }
    const state = result.failed ? 'unknown' : result.ciWorkers > 0 ? 'active' : 'idle'
    const runners = state === 'active' ? result.runners : undefined
    reading = { state, ciWorkers: result.failed ? 0 : result.ciWorkers, observedAt: at,
      stateSince: state === reading.state ? reading.stateSince : at,
      ...(runners === undefined ? {} : { runners: [...runners] }) }
  }

  return {
    start(): void {
      if (timer !== undefined) return
      reading = unknown()
      const startedGeneration = ++generation
      timer = setInterval(() => { void observe(startedGeneration) }, OBSERVE_INTERVAL_MS)
      timer.unref()
      void observe(startedGeneration)
    },
    stop(): void {
      clearInterval(timer)
      timer = undefined
      generation++
    },
    read: () => ({ ...reading }),
  }
}
