/**
 * CI 标签路由的主机可用性判定(CI-RUNNER-LABEL-ROUTING-0924 §8)。
 *
 * 只回答一个问题:这台主机现在能不能动它的 CI 标签。结论三态:
 * - reserved:预约在身或业主保留,标签一律不动;
 * - busy:主机连 CI 自己的负载一起算仍在高位,要把受管车道标签摘下来挡新活;
 * - allow:基线,标签保持原样。
 *
 * 判定带滞回与去抖:读数拿不准时冻结原判(基线化只在持续拿不准时兜底),
 * 升档与降档各自要满足阈值并持续一段时间,预约解除另留宽限,防止抖动反复摘挂。
 */
/** 负载采样与 CI 树采样允许的读数偏移上限;超窗一律按拿不准处理。 */
export const CI_TREE_MAX_SKEW_MS = 30_000

export type CiAvailabilityVerdict = 'allow' | 'busy' | 'reserved'

/** 一台机器在某一拍的单源观察,由接线层从派单输入与执行心跳拼装。 */
export interface CiMachineObservation {
  machine: string
  at: string
  online: boolean
  fresh: boolean
  quotaCores: number
  grantedCores: number
  /** 整机忙碌核数(含 CI 自身);读不到为 null。 */
  busyCores: number | null
  loadSampledAt: string | null
  ci: 'active' | 'idle' | 'unknown'
  /** CI 在跑的 runner 名单;读不到为 null。 */
  ciRunners: string[] | null
  /** CI 树自身的核数读数;读不到为 null。 */
  ciTreeCores: number | null
  ciTreeSampledAt: string | null
  reservationCores: number
  ownerHold: boolean
}

export interface CiAvailabilityParams {
  /** 压力占比到这条线及以上才算高。 */
  enterBusyRatio: number
  /** 压力占比回到这条线及以下才算回落。 */
  exitBusyRatio: number
  /** 高位持续满这个秒数才转忙。 */
  enterDwellSec: number
  /** 回落持续满这个秒数才回基线。 */
  exitDwellSec: number
  /** 预约解除后的宽限秒数,期内一律保持 reserved。 */
  reservedGraceSec: number
  /** 读数持续拿不准满这个秒数,busy 兜底回基线。 */
  unknownRestoreSec: number
}

/** 每台机器的判定记忆,随状态文件落盘、重启可续。 */
export interface CiAvailabilityMemory {
  verdict: CiAvailabilityVerdict
  since: string
  /** 正在计时的升/降档候选;null 表示没有计时。 */
  candidate: { verdict: 'allow' | 'busy'; since: string } | null
  /** 预约解除的时刻;null 表示还没解除过或仍在预约。 */
  reservedClearedAt: string | null
  /** 拿不准状态自何时起;null 表示上一拍读数可信。 */
  uncertainSince: string | null
}

export interface CiAvailabilityStep {
  verdict: CiAvailabilityVerdict
  memory: CiAvailabilityMemory
  /** 本拍读数是否可信;不可信时压力与占比为 null。 */
  certain: boolean
  /** 排除 CI 自身负载后的压力核数;冻结借出的 granted 照计。 */
  pressureCores: number | null
  /** 压力占配额之比;配额为零不会出现在可信读数里。 */
  ratio: number | null
  reason: string
}

const parseAt = (at: string): number => {
  const value = Date.parse(at)
  if (!Number.isFinite(value)) throw new Error(`[ci-labels] 时刻不合法:${at}`)
  return value
}

export function initialAvailabilityMemory(at: string): CiAvailabilityMemory {
  return { verdict: 'allow', since: at, candidate: null, reservedClearedAt: null, uncertainSince: null }
}

/** 压力口径:CI 在跑时从整机忙碌里扣掉树读数;idle 时树读数一律按零,免得残留读数把压力算小。 */
export function pressureCores(o: CiMachineObservation): number {
  const tree = o.ci === 'active' ? Math.max(0, o.ciTreeCores ?? 0) : 0
  return Math.max(Math.max(0, (o.busyCores ?? 0) - tree), o.grantedCores)
}

/**
 * 读数可信度。掉线、过期、配额为零、CI 未知、负载或树读数缺失/超窗、
 * CI 在跑却报不出可信名单(名单外的 runner 说明台账过期)都算拿不准。
 */
export function observationCertainty(o: CiMachineObservation, knownRunners: ReadonlySet<string>): boolean {
  if (!o.online || !o.fresh || o.quotaCores <= 0 || o.ci === 'unknown') return false
  if (o.busyCores === null) return false
  const at = parseAt(o.at)
  if (o.loadSampledAt === null || Math.abs(at - parseAt(o.loadSampledAt)) > CI_TREE_MAX_SKEW_MS) return false
  if (o.ci === 'active') {
    if (o.ciTreeCores === null || o.ciTreeSampledAt === null) return false
    if (Math.abs(at - parseAt(o.ciTreeSampledAt)) > CI_TREE_MAX_SKEW_MS) return false
    if (o.ciRunners === null || o.ciRunners.some(runner => !knownRunners.has(runner))) return false
  }
  return true
}

export function stepAvailability(o: CiMachineObservation, memory: CiAvailabilityMemory, params: CiAvailabilityParams,
  knownRunners: ReadonlySet<string>): CiAvailabilityStep {
  const at = parseAt(o.at)
  const certain = observationCertainty(o, knownRunners)
  const pressure = pressureCores(o)
  const shownPressure = certain ? pressure : null
  const ratio = certain ? pressure / o.quotaCores : null
  // 规则一:预约与业主保留压过一切,读数准不准都一样,立刻转 reserved。
  if (o.reservationCores > 0 || o.ownerHold) {
    return { verdict: 'reserved', certain: true, pressureCores: shownPressure, ratio,
      memory: { verdict: 'reserved', since: o.at, candidate: null, reservedClearedAt: null, uncertainSince: null },
      reason: o.ownerHold ? '业主保留在身' : '预约在身' }
  }
  // 规则二:预约刚解除的宽限,期内保持 reserved;期满按当前压力瞬时定去留,从此走常规滞回。
  if (memory.verdict === 'reserved') {
    if (memory.reservedClearedAt === null) {
      return { verdict: 'reserved', certain, pressureCores: shownPressure, ratio,
        memory: { ...memory, reservedClearedAt: o.at, candidate: null, uncertainSince: null },
        reason: '预约刚解除,进入宽限' }
    }
    if (at - parseAt(memory.reservedClearedAt) < params.reservedGraceSec * 1000) {
      return { verdict: 'reserved', certain, pressureCores: shownPressure, ratio, memory,
        reason: '预约解除宽限期内' }
    }
    if (certain && ratio !== null && ratio >= params.enterBusyRatio) {
      return { verdict: 'busy', certain, pressureCores: shownPressure, ratio,
        memory: { verdict: 'busy', since: o.at, candidate: null, reservedClearedAt: null, uncertainSince: null },
        reason: `宽限结束且压力 ${ratio.toFixed(2)} 仍在高位,直接转入忙` }
    }
    return { verdict: 'allow', certain, pressureCores: shownPressure, ratio,
      memory: { verdict: 'allow', since: o.at, candidate: null, reservedClearedAt: null, uncertainSince: null },
      reason: '宽限结束,回到基线' }
  }
  // 规则三:读数拿不准就冻结原判;busy 冻结满兜底时长回基线,allow 本来就是基线,保持即可。
  if (!certain) {
    const uncertainSince = memory.uncertainSince ?? o.at
    if (memory.verdict === 'busy' && at - parseAt(uncertainSince) >= params.unknownRestoreSec * 1000) {
      return { verdict: 'allow', certain, pressureCores: null, ratio: null,
        memory: { verdict: 'allow', since: o.at, candidate: null, reservedClearedAt: null, uncertainSince },
        reason: '读数持续拿不准，回到基线' }
    }
    return { verdict: memory.verdict, certain, pressureCores: null, ratio: null,
      memory: { ...memory, candidate: null, uncertainSince },
      reason: memory.verdict === 'busy' ? '读数拿不准,维持忙' : '读数拿不准,维持基线' }
  }
  // 规则四:读数可信,升档与降档各走各的阈值与去抖;中间带原判不动、候选清空。
  if (memory.verdict === 'busy') {
    if (ratio !== null && ratio <= params.exitBusyRatio) {
      const candidate = memory.candidate?.verdict === 'allow' ? memory.candidate : { verdict: 'allow' as const, since: o.at }
      if (at - parseAt(candidate.since) >= params.exitDwellSec * 1000) {
        return { verdict: 'allow', certain, pressureCores: shownPressure, ratio,
          memory: { verdict: 'allow', since: o.at, candidate: null, reservedClearedAt: null, uncertainSince: null },
          reason: `回落到 ${ratio.toFixed(2)} 满 ${params.exitDwellSec} 秒,解除忙` }
      }
      return { verdict: 'busy', certain, pressureCores: shownPressure, ratio,
        memory: { ...memory, candidate, uncertainSince: null, reservedClearedAt: null },
        reason: `回落计时中(${ratio.toFixed(2)}),维持忙` }
    }
    return { verdict: 'busy', certain, pressureCores: shownPressure, ratio,
      memory: { ...memory, candidate: null, uncertainSince: null, reservedClearedAt: null },
      reason: `压力 ${ratio?.toFixed(2)} 在退出线之上,维持忙` }
  }
  if (ratio !== null && ratio >= params.enterBusyRatio) {
    const candidate = memory.candidate?.verdict === 'busy' ? memory.candidate : { verdict: 'busy' as const, since: o.at }
    if (at - parseAt(candidate.since) >= params.enterDwellSec * 1000) {
      return { verdict: 'busy', certain, pressureCores: shownPressure, ratio,
        memory: { verdict: 'busy', since: o.at, candidate: null, reservedClearedAt: null, uncertainSince: null },
        reason: `压力 ${ratio.toFixed(2)} 满 ${params.enterDwellSec} 秒,转入忙` }
    }
    return { verdict: 'allow', certain, pressureCores: shownPressure, ratio,
      memory: { ...memory, candidate, uncertainSince: null, reservedClearedAt: null },
      reason: `升高计时中(${ratio.toFixed(2)}),维持基线` }
  }
  return { verdict: 'allow', certain, pressureCores: shownPressure, ratio,
    memory: { ...memory, candidate: null, uncertainSince: null, reservedClearedAt: null },
    reason: '压力在进入线之下,维持基线' }
}
