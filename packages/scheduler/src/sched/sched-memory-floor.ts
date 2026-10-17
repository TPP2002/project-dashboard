/**
 * 内存下限闸(SCHED-MR6-MEMORY-DIMENSION-0924):机器三十秒窗口的自由内存低于下限时少放、不放新活。
 * 三态:free ≥ 偏紧线(open)/ 下限 ≤ free < 偏紧线(single,一份读数只放一张)/ free < 下限(blocked,
 * 但本机没有调度台自己的在跑活时按 single 放行——机器空着却被卡死比偶尔超卖更伤)。
 * 下限 = max(2048MB, 总量的 1/8 向上取整),偏紧线 = 下限 × 2;`_control/memory-floor.json` 可逐项覆盖。
 * 开关不开,这里的任何东西都不该被碰到:派单员只在 hub.memoryFloor 为 true 时才算闸、才落边车。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import { canonicalJson, isoTime, READING_FRESHNESS_MS, schedPaths, segment } from './sched-contract'
import type { MachineInput } from './sched-decide'

/** 下限常量:再小的机器也保 2GB 给系统;下限从总量的 1/8 起;偏紧线是下限的 2 倍。 */
export const MEMORY_FLOOR_MIN_MB = 2_048
export const MEMORY_FLOOR_FRACTION = 8
export const MEMORY_TIGHT_FACTOR = 2

export type MemoryGateMode = 'open' | 'single' | 'blocked'

/** 一台机器这一拍的闸门结论;没读数的机器只有 mode 与 reason(边车不收没有读数的机器)。 */
export interface MemoryGateEntry {
  mode: MemoryGateMode
  freeMb?: number
  totalMb?: number
  floorMb?: number
  tightMb?: number
  sampledAt?: string
  reason: string
}

/** `share/sched/memory-floor/state.json` 的形状(给客户端 status 解释「为什么这台不派」)。 */
export const MEMORY_FLOOR_STATE_FORMAT_VERSION = 1

/** 配置文件 `_control/memory-floor.json`;缺的字段用公式,越界/写坏整份忽略按公式。 */
export interface MemoryFloorConfig {
  floorMb?: number
  tightFactor?: number
  perMachine?: Readonly<Record<string, { floorMb?: number; tightFactor?: number }>>
}

export const MEMORY_FLOOR_CONFIG_FORMAT_VERSION = 1
const FLOOR_MB_MIN = 512
const FLOOR_MB_MAX = 65_536
const TIGHT_FACTOR_MIN = 1
const TIGHT_FACTOR_MAX = 4
const CONFIG_FIELDS = ['formatVersion', 'floorMb', 'tightFactor', 'perMachine']

/** 下限公式:max(2048, ceil(totalMb / 8))。 */
export function memoryFloorMb(totalMb: number): number {
  return Math.max(MEMORY_FLOOR_MIN_MB, Math.ceil(totalMb / MEMORY_FLOOR_FRACTION))
}

/** 心跳里的内存读数只认形状完整的:totalMb 正整数、freeMb 非负整数且 ≤ totalMb、30 秒窗、合法时刻。 */
export function readMemoryReading(value: unknown): { totalMb: number; freeMb: number; windowSec: 30; sampledAt: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { totalMb, freeMb, windowSec, sampledAt } = value as Record<string, unknown>
  if (typeof totalMb !== 'number' || !Number.isInteger(totalMb) || totalMb <= 0
    || typeof freeMb !== 'number' || !Number.isInteger(freeMb) || freeMb < 0 || freeMb > totalMb
    || windowSec !== 30 || typeof sampledAt !== 'string' || !Number.isFinite(Date.parse(sampledAt))) return undefined
  return { totalMb, freeMb, windowSec: 30, sampledAt }
}

/** MB → 人话,一位小数带单位:4070→「4.0GB」、3174→「3.1GB」。 */
export function memoryMbText(mb: number): string {
  return `${(Math.round(mb / 102.4) / 10).toFixed(1)}GB`
}

/**
 * 按机器算这一拍的闸门。readings 已过 readMemoryReading;residentCores 是长期占用单占的核
 * (sched-decide.residentLeaseCores 的账)——「本机没有调度台自己的在跑活」按
 * 关时按 grantedCores − residentCores ≤ 0 判，实际用量开时机器表已经剔除常驻核，直接看 grantedCores。
 * consumed 是记账器里「这份读数已放过一张」的机器表。
 */
export function evaluateMemoryGate(input: {
  now: string
  machines: readonly Pick<MachineInput, 'name' | 'grantedCores'>[]
  readings: Readonly<Record<string, { totalMb: number; freeMb: number; windowSec: 30; sampledAt: string } | undefined>>
  residentCores: ReadonlyMap<string, number>
  /** 机器表已剔除常驻授予核时传 true；缺省仍按原租约口径扣一次。 */
  residentActualUsage?: boolean
  consumed: ReadonlyMap<string, string>
  config: MemoryFloorConfig
}): Record<string, MemoryGateEntry> {
  const nowMs = Date.parse(isoTime(input.now))
  const result: Record<string, MemoryGateEntry> = {}
  for (const machine of input.machines) {
    const reading = input.readings[machine.name]
    if (reading === undefined) {
      result[machine.name] = { mode: 'open', reason: '没有内存读数,不设闸' }
      continue
    }
    const sampledAtMs = Date.parse(reading.sampledAt)
    if (!Number.isFinite(sampledAtMs) || Math.abs(nowMs - sampledAtMs) > READING_FRESHNESS_MS) {
      result[machine.name] = { mode: 'open', freeMb: reading.freeMb, totalMb: reading.totalMb,
        sampledAt: reading.sampledAt, reason: '内存读数已过期,不设闸' }
      continue
    }
    const override = input.config.perMachine?.[machine.name]
    const floorMb = override?.floorMb ?? input.config.floorMb ?? memoryFloorMb(reading.totalMb)
    const tightMb = floorMb * (override?.tightFactor ?? input.config.tightFactor ?? MEMORY_TIGHT_FACTOR)
    const base = { freeMb: reading.freeMb, totalMb: reading.totalMb, floorMb, tightMb, sampledAt: reading.sampledAt }
    if (reading.freeMb >= tightMb) {
      result[machine.name] = { mode: 'open', ...base,
        reason: `可用内存 ${memoryMbText(reading.freeMb)} 高于偏紧线 ${memoryMbText(tightMb)},不设限` }
      continue
    }
    if (reading.freeMb >= floorMb) {
      // 一份读数只放一张:记账器里这份 sampledAt 已经放过,同一份读数不再放宽;读数换新自动恢复。
      if (input.consumed.get(machine.name) === reading.sampledAt) {
        result[machine.name] = { mode: 'blocked', ...base,
          reason: `可用内存 ${memoryMbText(reading.freeMb)} 不宽裕(下限 ${memoryMbText(floorMb)}),同一份读数已放过一张,等读数更新` }
      } else {
        result[machine.name] = { mode: 'single', ...base,
          reason: `可用内存 ${memoryMbText(reading.freeMb)} 在下限 ${memoryMbText(floorMb)} 与偏紧线 ${memoryMbText(tightMb)} 之间,同一份读数只放一张` }
      }
      continue
    }
    // 实际用量开时授予核已只剩非常驻活，不再减常驻核；关时保留原扣除口径。
    const ownBusyCores = input.residentActualUsage === true ? machine.grantedCores
      : machine.grantedCores - (input.residentCores.get(machine.name) ?? 0)
    if (ownBusyCores <= 0) {
      result[machine.name] = { mode: 'single', ...base,
        reason: `可用内存 ${memoryMbText(reading.freeMb)} 低于下限 ${memoryMbText(floorMb)},但本机没有调度台自己的活在跑,仍放一张` }
    } else {
      result[machine.name] = { mode: 'blocked', ...base,
        reason: `可用内存 ${memoryMbText(reading.freeMb)} 低于下限 ${memoryMbText(floorMb)},暂停放新活` }
    }
  }
  return result
}

/** single 态放过一张的记账:机器 → 放行时那份读数的 sampledAt;读数换新自然失效。 */
export interface MemoryFloorTracker {
  readonly consumed: ReadonlyMap<string, string>
  afterDecision(grants: readonly { machine: string }[], gate: Readonly<Record<string, MemoryGateEntry>>): void
}

export function createMemoryFloorTracker(): MemoryFloorTracker {
  const consumed = new Map<string, string>()
  return {
    consumed,
    afterDecision(grants, gate): void {
      for (const grant of grants) {
        const entry = gate[grant.machine]
        if (entry?.mode !== 'single' || entry.sampledAt === undefined) continue
        consumed.set(grant.machine, entry.sampledAt)
      }
    },
  }
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ')
}

function floorMbOf(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < FLOOR_MB_MIN || value > FLOOR_MB_MAX) {
    throw new Error(`${label} 要是 ${FLOOR_MB_MIN}~${FLOOR_MB_MAX} 的整数,收到 ${JSON.stringify(value)}`)
  }
  return value
}

function tightFactorOf(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < TIGHT_FACTOR_MIN || value > TIGHT_FACTOR_MAX) {
    throw new Error(`${label} 要是 ${TIGHT_FACTOR_MIN}~${TIGHT_FACTOR_MAX} 的整数,收到 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 配置校验:形状或数值越界抛错(调用方整份忽略按公式);不认识的字段只记警告、不影响其余字段。
 */
export function parseMemoryFloorConfig(raw: string): { config: MemoryFloorConfig; warnings: string[] } {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('配置要是一个 JSON 对象')
  const record = value as Record<string, unknown>
  if (record.formatVersion !== MEMORY_FLOOR_CONFIG_FORMAT_VERSION) {
    throw new Error(`formatVersion 只认 ${MEMORY_FLOOR_CONFIG_FORMAT_VERSION},收到 ${JSON.stringify(record.formatVersion)}`)
  }
  const config: { floorMb?: number; tightFactor?: number; perMachine?: Record<string, { floorMb?: number; tightFactor?: number }> } = {}
  if (record.floorMb !== undefined) config.floorMb = floorMbOf(record.floorMb, 'floorMb')
  if (record.tightFactor !== undefined) config.tightFactor = tightFactorOf(record.tightFactor, 'tightFactor')
  if (record.perMachine !== undefined) {
    const raw = record.perMachine
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('perMachine 要是机器名到配置的对象')
    const perMachine: Record<string, { floorMb?: number; tightFactor?: number }> = {}
    for (const [name, entry] of Object.entries(raw)) {
      segment(name)
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`perMachine.${name} 要是配置对象`)
      const one = entry as Record<string, unknown>
      const item: { floorMb?: number; tightFactor?: number } = {}
      if (one.floorMb !== undefined) item.floorMb = floorMbOf(one.floorMb, `perMachine.${name}.floorMb`)
      if (one.tightFactor !== undefined) item.tightFactor = tightFactorOf(one.tightFactor, `perMachine.${name}.tightFactor`)
      perMachine[name] = item
    }
    config.perMachine = perMachine
  }
  const warnings: string[] = []
  for (const key of Object.keys(record)) {
    if (!CONFIG_FIELDS.includes(key)) warnings.push(`不认识的字段 ${key},已忽略`)
  }
  return { config, warnings }
}

export interface MemoryFloorConfigReader { read(): MemoryFloorConfig }

/** 派单员每拍读一次(开关开才读):缺文件静默按公式;其余读失败/校验失败告警一次后照用公式。 */
export function createMemoryFloorConfigReader(options: {
  share: string
  warn?: (message: string) => void
  readFile?: (path: string) => string
}): MemoryFloorConfigReader {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const path = join(schedPaths(options.share).control, 'memory-floor.json')
  let warned: string | undefined
  const warnOnce = (signature: string, message: string): void => {
    if (signature === warned) return
    warned = signature
    try { options.warn?.(message) } catch { /* 告警端口不可影响派单 */ }
  }
  return {
    read(): MemoryFloorConfig {
      let raw: string
      try { raw = readFile(path) } catch (error) {
        if ((error as { code?: string } | null)?.code === 'ENOENT') return {}
        warnOnce(`read:${messageOf(error)}`, `[sched] 内存闸配置读不到,按公式算:${messageOf(error)}`)
        return {}
      }
      try {
        const parsed = parseMemoryFloorConfig(raw)
        // 完全干净才复位限频:带未知字段的文件每拍都读到,不能每拍都刷一遍提示。
        if (parsed.warnings.length === 0) warned = undefined
        else warnOnce(`warnings:${parsed.warnings.join('|')}`, `[sched] 内存闸配置提示:${parsed.warnings.join(';')}`)
        return parsed.config
      } catch (error) {
        warnOnce(`parse:${raw}`, `[sched] 内存闸配置不合法,整份忽略按公式算:${messageOf(error)}`)
        return {}
      }
    },
  }
}

export interface MemoryFloorReporter {
  report(input: { at: string; gate: Readonly<Record<string, MemoryGateEntry>> }): void
}

/** 无变化重写的最小间隔;状态变化(某机 mode 变了)总是立即写。 */
export const MEMORY_FLOOR_STATE_INTERVAL_MS = 15_000

/**
 * 边车写盘器:`share/sched/memory-floor/state.json` 只收**有读数**的机器,原子写(照 sched-ci-labels
 * 的状态文件做法)。日志跟着「可用内存与下限的大小关系」走、不跟 mode 走:跌破下限、回到下限以上各打一行;
 * 下限以下从「空机例外仍放一张」(single)转成「本机有自己的活」(blocked)时补打一行「暂停放新活」——
 * 只在活开始时出现,不是刷屏。偏紧区放一张后的 single↔blocked 来回、下限以下活跑完回 single,都一行不打。
 * 写失败绝不上抛——边车是给人看的,不能反过来把派单员搞停(派单员自己那层还有一道限频告警兜底)。
 */
export function createMemoryFloorReporter(options: {
  share: string
  log?: (message: string) => void
  warn?: (message: string) => void
}): MemoryFloorReporter {
  const dir = join(schedPaths(options.share).root, 'memory-floor')
  const staging = schedPaths(options.share).staging
  let lastModes = new Map<string, MemoryGateMode>()
  let lastBelowFloor = new Map<string, boolean>()
  let lastWrittenModes = new Map<string, MemoryGateMode>()
  let lastWriteAt: number | null = null
  return {
    report(input: { at: string; gate: Readonly<Record<string, MemoryGateEntry>> }): void {
      try {
        const machines: Record<string, MemoryGateEntry> = {}
        const modes = new Map<string, MemoryGateMode>()
        const belowFloor = new Map<string, boolean>()
        for (const [name, entry] of Object.entries(input.gate)) {
          if (entry.freeMb === undefined || entry.totalMb === undefined
            || entry.floorMb === undefined || entry.sampledAt === undefined) continue
          machines[name] = entry
          modes.set(name, entry.mode)
          belowFloor.set(name, entry.freeMb < entry.floorMb)
        }
        for (const [name, current] of belowFloor) {
          const previous = lastBelowFloor.get(name)
          if (previous === undefined) continue // 上一拍未知(首拍、读数过期后重新出现):不打。
          const entry = machines[name]!
          const belowLine = `低于下限 ${memoryMbText(entry.floorMb!)}`
          if (!previous && current) {
            // 跌破下限:本拍 blocked 是「暂停放新活」,空机例外 single 是「仍放一张」——都说的是实情。
            const tail = entry.mode === 'blocked' ? '暂停放新活' : '本机没有调度台自己的活在跑,仍放一张'
            options.log?.(`[sched] 内存闸:${name} 可用内存 ${memoryMbText(entry.freeMb!)} ${belowLine},${tail}`)
          } else if (previous && current && lastModes.get(name) !== 'blocked' && entry.mode === 'blocked') {
            // 下限以下从「仍放一张」转「暂停放新活」(本机开始有自己的活):只在活开始时补一行。
            options.log?.(`[sched] 内存闸:${name} 可用内存 ${memoryMbText(entry.freeMb!)} ${belowLine},暂停放新活`)
          } else if (previous && !current) {
            options.log?.(`[sched] 内存闸:${name} 可用内存回升到 ${memoryMbText(entry.freeMb!)}(下限 ${memoryMbText(entry.floorMb!)}),恢复放活`)
          }
          // 其余一律不打:偏紧区 single↔blocked 来回、下限以下 blocked→single(活跑完,内存没回升)都不打。
        }
        lastModes = modes
        lastBelowFloor = belowFloor
        const changed = lastWriteAt === null || modes.size !== lastWrittenModes.size
          || [...modes].some(([name, mode]) => lastWrittenModes.get(name) !== mode)
        if (!changed && lastWriteAt !== null && Date.parse(input.at) - lastWriteAt < MEMORY_FLOOR_STATE_INTERVAL_MS) return
        mkdirSync(dir, { recursive: true })
        mkdirSync(staging, { recursive: true })
        publishLifecycleFileAtomically(join(dir, 'state.json'),
          canonicalJson({ formatVersion: MEMORY_FLOOR_STATE_FORMAT_VERSION, at: input.at, machines }), 'replace', staging)
        lastWriteAt = Date.parse(input.at)
        lastWrittenModes = modes
      } catch (error) {
        try { options.warn?.(`[sched] 内存闸边车写失败,本拍跳过:${messageOf(error)}`) } catch { /* 告警不得停派单员 */ }
      }
    },
  }
}
