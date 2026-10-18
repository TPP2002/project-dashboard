/**
 * 申请核数按历史实测自动纠正(SCHED-CORES-HISTORY-AUTOCORRECT-1010)的派单员侧底座:
 * usageKey 归一、最近邻秩 90 分位、改核建议、执行用量记账与共享盘滚动统计文件。
 *
 * 读数来源:代理心跳 attemptLoad 里每张在管单的实测核数(matchedManagedReadings,
 * 与超用标红同一份读数),派单员每拍喂给 tracker 累计;统计不依赖 managedLoad 开关。
 * 统计文件 `<share>/sched/_stats/cores-usage.json` 是可再生缓存:按 usageKey 分组、
 * 每组只留最近 20 条、原子写;写失败只告警一次(写成功拍复位),绝不停派单员。
 * 纯函数(usageKeyFor / nearestRankP90 / suggestCores)在 client/sched.cjs 有一份
 * 零依赖的同名同逻辑实现,同一张表驱动用例钉着两边逐项一致(照 overuseCheck 先例)。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import { errorMessage, hasCode } from '../bot/cluster-lifecycle-contract'
import { assertWritableFormat, canonicalJson, schedPaths } from './sched-contract'

/** 客户端只在共享盘格式声明了这个能力位时才随请求发新字段(混跑无碍)。 */
export const USAGE_HISTORY_CAPABILITY = 'usage-history-v1'
/** 每组统计只留最近这么多个执行;更早的随写随滚掉。 */
export const USAGE_HISTORY_GROUP_LIMIT = 20
/** 挂号端纠正时读同键最近这么多个执行的 peakCores。 */
export const USAGE_HISTORY_READ_LIMIT = 10
/** 历史不足这么多个执行不纠正(样本太少,分位数没有代表性)。 */
export const USAGE_HISTORY_MIN_HISTORY = 3
/** 请求字段 usageKey 的长度上限(契约同判据)。 */
export const USAGE_KEY_MAX_LENGTH = 120

/** 一次执行的用量折算:峰值核数、90 分位核数、读数个数;写进 finished 事件与统计。 */
export interface AttemptUsage {
  peakCores: number
  p90Cores: number
  samples: number
}

/** 统计文件里的一条执行记录;按 usageKey 分组滚动保留。 */
export interface UsageHistoryEntry extends AttemptUsage {
  at: string
  ticketId: string
  project: string
  workType: string
  usageKey: string
  grantedCores: number
  requestedCores: number
  runningMs: number
}

export interface UsageHistoryFile {
  formatVersion: 1
  groups: Record<string, UsageHistoryEntry[]>
}

export function usageStatsPath(share: string): string {
  return join(schedPaths(share).root, '_stats', 'cores-usage.json')
}

const COMMAND_SUFFIX = /\.(exe|cmd|bat|py|js|cjs|mjs|ts)$/i
const PURE_NUMBER = /^\d+$/
/** ≥7 位十六进制:提交哈希、单号碎片这类噪声词。 */
const HEX_WORD = /^[0-9a-fA-F]{7,}$/
/** 以 - 开头、后面是 ≥7 位十六进制的旗标(如 -e4f3d2c1b0a):携带哈希值的参数,同样是噪声。
 *  阈值与 HEX_WORD 同一把尺——只有 1 位十六进制的短旗标(如 python 的 -m)是稳定语义,保留。 */
const HEX_FLAG = /^-[0-9a-fA-F]{7,}$/

/** 命令头里的一个词:只留文件名部分(去目录,正反斜杠都认)、去可执行/脚本后缀;
 *  纯数字、哈希样、带哈希值的旗标丢弃(返回 null)。 */
export function usageKeyWord(word: string): string | null {
  let name = word
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  if (slash >= 0) name = name.slice(slash + 1)
  name = name.replace(COMMAND_SUFFIX, '')
  if (name === '' || PURE_NUMBER.test(name) || HEX_WORD.test(name) || HEX_FLAG.test(name)) return null
  return name
}

/**
 * 同类活的统计键:`${project}|${workType}` + (有命令时 '|' + 命令头)。
 * 命令头 = [command, ...args] 前 3 个词逐个归一后剩下的部分,空格连接;
 * 总长封顶 120 字符(与请求字段 usageKey 的契约上限同一把尺,挂号端造的键必须能原样进请求)。
 */
export function usageKeyFor(input: { project: string; workType: string; command?: string; args?: readonly string[] }): string {
  let key = `${input.project}|${input.workType}`
  if (input.command !== undefined) {
    const head = [input.command, ...(input.args ?? [])].slice(0, 3)
      .map(usageKeyWord)
      .filter((word): word is string => word !== null)
      .join(' ')
    key += `|${head}`
  }
  return key.length > USAGE_KEY_MAX_LENGTH ? key.slice(0, USAGE_KEY_MAX_LENGTH) : key
}

/** 最近邻秩 90 分位:升序第 ceil(0.9×n) 个;空表没有分位,返回 null。 */
export function nearestRankP90(values: readonly number[]): number | null {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const rank = Math.min(sorted.length, Math.ceil(0.9 * sorted.length))
  return sorted[rank - 1]!
}

/** 核数显示:整数不带小数点,非整数保留一位小数(读数本来就是 0.1 核粒度)。 */
export function formatCores(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
}

export interface CoresSuggestion {
  cores: number
  changed: boolean
  p90: number | null
  /** changed 时是给 stdout 的提醒行原文(带 [sched] 前缀);否则为 null。 */
  reason: string | null
}

/**
 * 按历史实测判断申请核数要不要改小:历史不足 minHistory 个、带 strict、或申请没有超过
 * 2×p90 且高出不足 2 核时,原申请放行;否则改成 max(1, ceil(p90)+1)。
 * 只改小不改大;label 是提醒行里「同类活(...)」的括号内容(命令头或作业名)。
 */
export function suggestCores(input: {
  requested: number; peaks: readonly number[]; strict?: boolean; minHistory?: number; label?: string
}): CoresSuggestion {
  const minHistory = input.minHistory ?? USAGE_HISTORY_MIN_HISTORY
  if (input.strict === true || input.peaks.length < minHistory) {
    return { cores: input.requested, changed: false, p90: null, reason: null }
  }
  const p90 = nearestRankP90(input.peaks)!
  if (!(input.requested > 2 * p90 && input.requested - p90 >= 2)) {
    return { cores: input.requested, changed: false, p90, reason: null }
  }
  const cores = Math.max(1, Math.ceil(p90) + 1)
  return { cores, changed: true, p90, reason: `[sched] 申请 ${formatCores(input.requested)} 核超过同类活(${input.label ?? ''})`
    + `最近 ${input.peaks.length} 单实测 90 分位 ${formatCores(p90)} 核的 2 倍,已改为 ${formatCores(cores)} 核;`
    + `要保留原申请加 --cores-strict` }
}

interface UsageAccrual {
  last: string
  peakTenths: number
  /** 按 0.1 核计数的直方图:桶 = 核数×10,值 = 读数次数。 */
  histogram: Map<number, number>
}

export interface UsageHistoryTracker {
  /** 每拍把 matchedManagedReadings 的当前读数累计进来;sampledAt 不前进的重复读数跳过。 */
  observe(input: { at: string; readings: ReadonlyMap<string, { cores: number; sampledAt: string }> }): void
  /** 执行结束时折出 usage 并清掉该执行;没有任何读数返回 null。 */
  finish(input: { ticketId: string; attemptId: string }): AttemptUsage | null
  /** 主动丢弃一个执行(`ticketId--attemptId`)的累计,用于执行从投影里消失时。 */
  forget(key: string): void
  keys(): string[]
}

/** 每执行一份的峰值+直方图记账;只活在派单员进程内存里,重启后从零重攒。 */
export function createUsageHistoryTracker(): UsageHistoryTracker {
  const state = new Map<string, UsageAccrual>()
  return {
    observe(input) {
      for (const [key, reading] of input.readings) {
        const previous = state.get(key) ?? { last: '', peakTenths: 0, histogram: new Map<number, number>() }
        if (previous.last !== '' && reading.sampledAt <= previous.last) continue
        const tenths = Math.max(0, Math.round(reading.cores * 10))
        previous.peakTenths = Math.max(previous.peakTenths, tenths)
        previous.histogram.set(tenths, (previous.histogram.get(tenths) ?? 0) + 1)
        previous.last = reading.sampledAt
        state.set(key, previous)
      }
    },
    finish(input) {
      const key = `${input.ticketId}--${input.attemptId}`
      const accrual = state.get(key)
      state.delete(key)
      if (accrual === undefined) return null
      let samples = 0
      for (const count of accrual.histogram.values()) samples += count
      if (samples === 0) return null
      const rank = Math.min(samples, Math.ceil(0.9 * samples))
      let seen = 0
      let p90Tenths = accrual.peakTenths
      for (const tenths of [...accrual.histogram.keys()].sort((left, right) => left - right)) {
        seen += accrual.histogram.get(tenths)!
        if (seen >= rank) { p90Tenths = tenths; break }
      }
      return { peakCores: accrual.peakTenths / 10, p90Cores: p90Tenths / 10, samples }
    },
    forget(key) { state.delete(key) },
    keys() { return [...state.keys()] },
  }
}

/** 写失败告警的去重表:同一共享盘写成功前只报一行,成功拍复位。 */
const warnedShares = new Set<string>()

/**
 * 往统计文件追加一条执行记录:读旧表(缺失/内容坏 → 当空表重建)、同键滚动保留最近
 * USAGE_HISTORY_GROUP_LIMIT 条、staging 原子 replace。任何失败只告警一次、不上抛。
 */
export function appendUsageHistory(input: {
  share: string; key: string; entry: UsageHistoryEntry; warn?: (message: string) => void
}): void {
  const paths = schedPaths(input.share)
  const file = usageStatsPath(input.share)
  try {
    let groups: Record<string, UsageHistoryEntry[]> = {}
    let text: string | undefined
    try { text = readFileSync(file, 'utf8') } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
    if (text !== undefined) {
      // 内容坏按空表重建(可再生缓存,自愈);版本或形状不认识的不覆盖,按写失败只告警。
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { parsed = undefined }
      if (parsed !== undefined) {
        const record = parsed as UsageHistoryFile | null
        if (record === null || typeof record !== 'object' || record.formatVersion !== 1
          || record.groups === null || typeof record.groups !== 'object' || Array.isArray(record.groups)) {
          throw new Error(`统计文件版本或形状不认识(formatVersion=${JSON.stringify((parsed as { formatVersion?: unknown }).formatVersion)}),不覆盖`)
        }
        groups = record.groups
      }
    }
    groups = { ...groups, [input.key]: [...(groups[input.key] ?? []), input.entry].slice(-USAGE_HISTORY_GROUP_LIMIT) }
    mkdirSync(dirname(file), { recursive: true })
    mkdirSync(paths.staging, { recursive: true })
    publishLifecycleFileAtomically(file, canonicalJson({ formatVersion: 1 as const, groups }), 'replace', paths.staging)
    warnedShares.delete(input.share)
  } catch (error) {
    if (!warnedShares.has(input.share)) {
      warnedShares.add(input.share)
      try { input.warn?.(`[sched] 用量历史统计写失败,写成功前不再重复告警:${errorMessage(error)}`) } catch { /* 告警不得停派单员 */ }
    }
  }
}

/** 读同键最近 limit 个执行的 peakCores;文件缺失、内容坏、键不存在都返回空表。 */
export function readUsagePeaks(share: string, key: string, limit = USAGE_HISTORY_READ_LIMIT): number[] {
  let list: unknown
  try {
    const parsed: unknown = JSON.parse(readFileSync(usageStatsPath(share), 'utf8'))
    const record = parsed as UsageHistoryFile | null
    if (record === null || typeof record !== 'object' || record.formatVersion !== 1
      || record.groups === null || typeof record.groups !== 'object' || Array.isArray(record.groups)) return []
    list = record.groups[key]
  } catch { return [] }
  if (!Array.isArray(list)) return []
  return list.slice(-Math.max(0, limit))
    .filter((entry): entry is UsageHistoryEntry => typeof entry === 'object' && entry !== null
      && typeof (entry as UsageHistoryEntry).peakCores === 'number' && Number.isFinite((entry as UsageHistoryEntry).peakCores))
    .map(entry => entry.peakCores)
}

/**
 * 既有共享盘补 'usage-history-v1' 能力位:与 sched-publish.ts 里 cluster-work-workers
 * 同一做法(读 format → 并集 → 原子 replace),由派单员启动时的发布事务调用;
 * sched-publish.ts 不在本单施工面,这份并集挂在其后的同一 owner.commit 里,口径一致。
 */
export function ensureUsageHistoryCapability(share: string): void {
  const paths = schedPaths(share)
  const format = assertWritableFormat(JSON.parse(readFileSync(paths.format, 'utf8')))
  if (format.capabilities.includes(USAGE_HISTORY_CAPABILITY)) return
  const capabilities = [...new Set([...format.capabilities, USAGE_HISTORY_CAPABILITY])]
  publishLifecycleFileAtomically(paths.format, canonicalJson({ ...format, capabilities }), 'replace', paths.staging)
}
