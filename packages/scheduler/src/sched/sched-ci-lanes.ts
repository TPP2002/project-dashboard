import deployment from './client/deployment-config.cjs'
/**
 * CI 车道余量表(UDQ-T4B-CI-LANE-HEADROOM,负责人 0914 拍板):CI 在跑时按**车道**给本机留核,
 * 不再「有 Worker 在跑就整机不派」。
 *
 * 【口径】按车道的历史峰值留,不按此刻用量;数字由派单方按 0913 实测(主机 CI 在跑时外部负载
 * 在 8.4~17.8 核之间摆)定。两条保守缺省不许放宽:
 * - **认不出的 runner**(读数没带名字、或名字不在表里)按该机**整机配额**留,
 *   也就是改前「有 CI 就不派」的等价物;
 * - CI 状态不是 `active`(含 `unknown`)一律留 0 —— 但 `unknown` 在准入那侧照旧一票否决,
 *   这里留 0 不代表可派。
 * - 返回值按设计 C7 / HUB13-1 封顶到整机配额;超过配额时封顶前后可派均为 0,
 *   因而不改准入结果,恒等测试见 tests/unit/sched/schedCiReserveCap.test.ts。
 *
 * 【覆盖文件】`<共享盘>/sched/_control/ci-lanes.json` = `{formatVersion:1,reserveCores:{<runner名>:非负整数}}`。
 * 文件里的条目按名字**覆盖**缺省表,没写的车道仍用缺省值;整份读不到或校验不过就整份忽略、
 * 退回缺省表并告警一次,**绝不让坏文件把派单员搞停**。
 */
import { readFileSync } from 'node:fs'
import { fields, integer, oneOf, schedControlPaths, segment } from './sched-contract'

export type CiLaneReserveTable = Readonly<Record<string, number>>

/** 本机 runner 布局(0914 实测的四条车道 + 副机两条);认不出的名字一律按整机配额留。 */
export const CI_LANE_RESERVE_DEFAULTS: CiLaneReserveTable = deployment.getDeploymentConfig().ci.reserveCores

export const CI_LANE_OVERRIDE_SCHEMA = 1

/**
 * 本机要给 CI 留的核数。`runners` 缺失或为空 = 认不出,按整机配额留;
 * 表里没写的 runner 同样按整机配额留(Σ 里那一项直接记配额)。
 */
export function ciReserveCores(input: {
  quotaCores: number
  ci: 'active' | 'idle' | 'unknown'
  runners?: readonly string[] | undefined
  table?: CiLaneReserveTable
}): number {
  if (input.ci !== 'active') return 0
  const quota = Math.max(0, Math.floor(input.quotaCores))
  const runners = input.runners
  if (runners === undefined || runners.length === 0) return quota
  const table = input.table ?? CI_LANE_RESERVE_DEFAULTS
  let total = 0
  for (const name of runners) total += table[name] ?? quota
  return Math.min(total, quota)
}

function reserveEntries(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('[sched] ci-lanes.reserveCores 必须是 runner 名到非负整数的对象')
  }
  for (const [name, cores] of Object.entries(value)) { segment(name); integer(cores) }
}

/** 校验不过一律抛错由调用方整份忽略;只为合法文件返回「缺省表 + 文件条目」的合并表。 */
export function parseCiLaneReserveTable(raw: string): CiLaneReserveTable {
  const value: unknown = JSON.parse(raw)
  fields(value, { formatVersion: oneOf([CI_LANE_OVERRIDE_SCHEMA]), reserveCores: reserveEntries })
  return { ...CI_LANE_RESERVE_DEFAULTS, ...(value as { reserveCores: CiLaneReserveTable }).reserveCores }
}

export interface CiLaneReserveReader { read(): CiLaneReserveTable }

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ')
}

/**
 * 派单员主循环每拍读一次;缺文件就是缺省表(不算错),其它读失败或校验失败告警一次后照用缺省表。
 * 同类失败只报一行、内容变化或恢复正常后重置,免得每两秒刷屏。
 */
export function createCiLaneReserveReader(options: {
  share: string
  warn?: (message: string) => void
  readFile?: (path: string) => string
}): CiLaneReserveReader {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const path = schedControlPaths(options.share).ciLanes
  let warned: string | undefined
  const fallback = (signature: string, message: string): CiLaneReserveTable => {
    if (signature !== warned) { warned = signature; options.warn?.(message) }
    return CI_LANE_RESERVE_DEFAULTS
  }
  return {
    read(): CiLaneReserveTable {
      let raw: string
      try { raw = readFile(path) } catch (error) {
        if ((error as { code?: string } | null)?.code === 'ENOENT') return CI_LANE_RESERVE_DEFAULTS
        return fallback(`read:${messageOf(error)}`, `⚠ CI 余量表读不到,按缺省表算:${messageOf(error)}`)
      }
      try {
        const table = parseCiLaneReserveTable(raw)
        warned = undefined
        return table
      } catch (error) {
        return fallback(`parse:${raw}`, `⚠ CI 余量表不合法,整份忽略按缺省表算:${messageOf(error)}`)
      }
    },
  }
}
