/**
 * CI 与调度台作业的相处方式(SCHED-CI-COEXIST-0925,负责人 0925 临时拍板)。
 *
 * 【两种模式】
 * - `freeze`(缺省 = 改前的一切行为):本机 CI 一出现,受管作业整棵进程树冻结、代理不领新单、
 *   派单员按车道历史峰值给 CI 留核。CI 优先,代价是在跑的活不停被冻、CI 期间 CPU 还有大片空着。
 * - `coexist`:CI 不再优先、不再强制暂停任何作业,CI 只是「外部负载」——
 *   派单员按**实测**外部负载准入(能跑的一起跑),不再按历史峰值预留;代理照常领单;
 *   作业不因 CI 冻结、也不被压到最低优先级。手动暂停与所有者占用照旧生效。
 *
 * 【开关】`<共享盘>/sched/_control/ci-policy.json` = `{formatVersion:1,mode:'coexist'|'freeze'}`。
 * 缺文件 = 缺省 `freeze`,所以合并这批代码本身不改任何行为;写文件才生效、改回 `freeze` 立即还原,
 * 派单员/代理/挂号端各自每几秒重读一次,不需要重启。
 * 读不到(共享盘瞬断)或内容不合法时**沿用上一次读到的合法值**并告警一次——绝不因为一次瞬断把
 * 全部作业突然冻住或突然放开;从未读到过合法值就用缺省。
 *
 * 本文件被打进挂号端发行件(sched-client-bundle.cjs),只许依赖 node 内置模块。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type CiPolicyMode = 'coexist' | 'freeze'
export const CI_POLICY_DEFAULT: CiPolicyMode = 'freeze'
export const CI_POLICY_SCHEMA = 1
/** 同一读取器两次读盘之间的最短间隔;挂号端每秒都要问一次,不能每次都碰共享盘。 */
export const CI_POLICY_TTL_MS = 5_000

export function ciPolicyPath(share: string): string { return join(share, 'sched', '_control', 'ci-policy.json') }

/** 校验不过一律抛错,由读取器决定沿用旧值。 */
export function parseCiPolicy(raw: string): CiPolicyMode {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('[sched] ci-policy 必须是对象')
  const record = value as Record<string, unknown>
  const extra = Object.keys(record).filter(key => key !== 'formatVersion' && key !== 'mode' && key !== 'note')
  if (extra.length > 0) throw new Error(`[sched] ci-policy 有未知字段:${extra.join(',')}`)
  if (record.formatVersion !== CI_POLICY_SCHEMA) throw new Error('[sched] ci-policy.formatVersion 只能是 1')
  if (record.mode !== 'coexist' && record.mode !== 'freeze') throw new Error('[sched] ci-policy.mode 只能是 coexist 或 freeze')
  return record.mode
}

export interface CiPolicyReader {
  /** 当前生效的模式;有缓存,绝不抛错。 */
  mode(): CiPolicyMode
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ')
}

export function createCiPolicyReader(options: {
  share: string | undefined
  warn?: (message: string) => void
  /** 模式变化(含第一次就读到非缺省值)时报一行,方便在日志里对上「哪一刻起换了规矩」。 */
  notice?: (message: string) => void
  readFile?: (path: string) => string
  now?: () => number
  ttlMs?: number
}): CiPolicyReader {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? CI_POLICY_TTL_MS
  let current: CiPolicyMode = CI_POLICY_DEFAULT, announced = false
  let nextReadAt = -Infinity, warned: string | undefined
  const say = (fn: ((message: string) => void) | undefined, message: string): void => {
    try { fn?.(message) } catch { /* 日志端口不可影响调度 */ }
  }
  const settle = (mode: CiPolicyMode): void => {
    // 缺省状态下第一次读到不吭声(每次启动都报一行没有信息量);之后凡是变了都报。
    if (announced ? mode !== current : mode !== CI_POLICY_DEFAULT) say(options.notice, `[sched] CI 相处方式:${mode === 'coexist' ? '共存(不冻结作业、按实测负载准入)' : '让路(CI 在跑就冻结、按车道留核)'}`)
    announced = true; current = mode
  }
  return {
    mode(): CiPolicyMode {
      // 没有共享盘路径(测试替身)= 没有开关文件,恒为缺省。
      if (typeof options.share !== 'string' || options.share === '') return CI_POLICY_DEFAULT
      const at = now()
      if (at < nextReadAt) return current
      nextReadAt = at + ttlMs
      let raw: string
      try { raw = readFile(ciPolicyPath(options.share)) } catch (error) {
        if ((error as { code?: string } | null)?.code === 'ENOENT') { warned = undefined; settle(CI_POLICY_DEFAULT); return current }
        const signature = `read:${messageOf(error)}`
        if (signature !== warned) { warned = signature; say(options.warn, `⚠ CI 相处方式开关读不到,沿用上一次的值(${current}):${messageOf(error)}`) }
        return current
      }
      try {
        const mode = parseCiPolicy(raw)
        warned = undefined
        settle(mode)
      } catch (error) {
        const signature = `parse:${raw}`
        if (signature !== warned) { warned = signature; say(options.warn, `⚠ CI 相处方式开关不合法,沿用上一次的值(${current}):${messageOf(error)}`) }
      }
      return current
    },
  }
}
