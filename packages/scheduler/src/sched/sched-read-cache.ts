/**
 * SCHED-SELF-OVERHEAD-0925:派单员共享读缓存。
 * 【定位】“文件未变 ⇒ 解析结论不变”的重复读+解析合并成一次 statSync 命中。
 * 【边界】只缓存由内容决定的结果(解析/校验结论、原始字节);读失败不缓存——EBUSY/EPERM
 * 等瞬态错误原样抛给调用方,下一拍重试的语义与未加缓存时完全一致。
 * 【为什么安全】终态回报/指令是 create-only,落盘后内容永不改写;心跳文件只被存活 wrapper
 * 整文件替换。命中判定 (size, mtimeMs):NTFS mtime 精度 100ns,替换必然同时改变尺寸或时间。
 * 指纹在读之前取:若文件在 stat 与 read 之间被改写,缓存记的是旧指纹,下一拍必然判失配并重读,
 * 最多晚一拍自纠错;反向(读后再取指纹)才会把新指纹配旧内容锁死,故不采用。
 * 【不做】不缓存目录枚举(新文件仍一拍可见);不改任何盘上格式。
 * 容量满后保留已有键,新路径直读但不入缓存,避免超过容量的顺序扫描每拍清空/抖动。
 *
 * 【批读副本】本文件还提供 readCommandBatchCached / readReportBatchCached / readBeatBatchCached /
 * readSubmissionBatchCached:与 sched-commands / sched-reports / sched-reclaim / sched-intake 里的原函数
 * 分类口径逐字一致(那四个文件不在本单施工面)。逐字一致由 tests/unit/sched/schedSelfOverhead.test.ts
 * 的「缓存版批读器与原函数逐字一致」用例和「整树逐字节一致」对照用例共同锁死;改原函数时必须同步这里。
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { types } from 'node:util'
import { errorMessage } from '../bot/cluster-lifecycle-contract'
import {
  parseReportName, reportName, schedPaths, segment, validateAttemptBeat, validateCommand, validateReport,
  type AttemptBeat, type AttemptReport, type SchedulerCommand,
} from './sched-contract'
import { SchedulerReadUnavailableError } from './sched-control'
import { readSchedDirectory } from './sched-ledger'
import type { BeatBatch } from './sched-reclaim'
import type { SubmissionFile } from './sched-intake'

/** 缓存条目硬上限;超过上限的路径仍正常读取,不驱逐已有工作集。 */
export const SCHED_READ_CACHE_MAX_ENTRIES = 20_000
export const SCHED_READ_CACHE_MAX_BYTES = 16 * 1024 * 1024
export const SCHED_READ_CACHE_MAX_ITEM_BYTES = 1024 * 1024

export type CachedOutcome<T> = { status: 'ok'; value: T } | { status: 'invalid'; error: unknown }

export interface SchedReadCache {
  /** 读文件并解析;解析失败以 invalid 返回(同样可缓存:坏内容的结论也不变)。I/O 错误原样抛。 */
  read<T>(path: string, parse: (raw: string) => T): CachedOutcome<T>
  /** 按原始字节读(提交批的哈希/UTF-8 校验要字节级一致,不能走 utf8 解码)。 */
  readRaw(path: string): Buffer
  invalidate(path?: string): void
  /** 只接受一次成功的完整目录枚举；失败时调用方不得传入空表猜测目录已清空。 */
  retainDirectory(directory: string, names: readonly string[]): void
  close(): void
  counters(): { hits: number; misses: number; entries: number }
  /** 原始数据权重，不是 JS 堆大小；counters 保留原有字段和对象形状。 */
  resources(): { bytes: number; maxBytes: number; maxItemBytes: number; skipped: number; reclaimed: number }
}

interface CacheEntry { size: number; mtimeMs: number; bytes: number; directory: string; outcome: CachedOutcome<unknown> }

function parseOutcome<T>(raw: string, parse: (raw: string) => T): CachedOutcome<T> {
  try { return { status: 'ok', value: parse(raw) } } catch (error) { return { status: 'invalid', error } }
}

const nativeErrorConstructors = [Error, SyntaxError, TypeError, RangeError, ReferenceError, URIError, EvalError]
const nativeErrorPrototypes = new Set(nativeErrorConstructors.map(constructor => constructor.prototype))
// Node 24 的原生 stack 可以是访问器。仅保存从新建内建 Error 上取得的函数身份，
// 不保存探针 Error/栈，不调用任何访问器，也不根据函数名或 toString 猜测“原生”。
const nativeStackAccessors = nativeErrorConstructors.map(constructor => {
  const descriptor = Object.getOwnPropertyDescriptor(new constructor(), 'stack')
  return { get: descriptor?.get, set: descriptor?.set }
}).filter(descriptor => descriptor.get !== undefined)

/** 不保留任意抛出对象/cause 树；普通原生解析错误仍可命中，错误返回本身不裁剪或改写。 */
function boundedError(error: unknown): boolean {
  // 原生品牌检查和 Proxy 排除均不调用用户的 getter/prototype trap。
  if (types.isProxy(error) || !types.isNativeError(error)) return false
  if (!nativeErrorPrototypes.has(Object.getPrototypeOf(error))) return false
  let bytes = 0
  for (const key of Reflect.ownKeys(error)) {
    if (typeof key !== 'string' || !['name', 'message', 'stack', 'code'].includes(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(error, key)!
    if (key === 'stack' && !('value' in descriptor)
      && nativeStackAccessors.some(native => descriptor.get === native.get && descriptor.set === native.set)) continue
    if (!('value' in descriptor) || typeof descriptor.value !== 'string') return false
    bytes += Buffer.byteLength(descriptor.value, 'utf8')
    if (bytes > 64 * 1024) return false
  }
  return true
}

export function createSchedReadCache(options: { passthrough?: boolean } = {}): SchedReadCache {
  const entries = new Map<string, CacheEntry>()
  const passthrough = options.passthrough === true
  let hits = 0
  let misses = 0
  let bytes = 0
  let skipped = 0
  let reclaimed = 0
  let closed = false
  const drop = (path: string): void => {
    const entry = entries.get(path)
    if (entry === undefined) return
    bytes -= entry.bytes
    entries.delete(path)
  }
  const store = (path: string, stamp: { size: number; mtimeMs: number }, weight: number, outcome: CachedOutcome<unknown>): void => {
    // 替换前旧项已经释放。超大/满额只跳过这一项，绝不清空热集合。
    if (weight > SCHED_READ_CACHE_MAX_ITEM_BYTES || bytes + weight > SCHED_READ_CACHE_MAX_BYTES
      || entries.size >= SCHED_READ_CACHE_MAX_ENTRIES || (outcome.status === 'invalid' && !boundedError(outcome.error))) {
      skipped++
      return
    }
    entries.set(path, { size: stamp.size, mtimeMs: stamp.mtimeMs, bytes: weight,
      directory: resolve(dirname(path)), outcome })
    bytes += weight
  }
  return {
    read<T>(path: string, parse: (raw: string) => T): CachedOutcome<T> {
      if (passthrough || closed) return parseOutcome(readFileSync(path, 'utf8'), parse)
      const stamp = statSync(path)
      const cached = entries.get(path)
      if (cached && cached.size === stamp.size && cached.mtimeMs === stamp.mtimeMs) {
        hits += 1
        return cached.outcome as CachedOutcome<T>
      }
      misses += 1
      drop(path)
      const raw = readFileSync(path, 'utf8')
      const outcome = parseOutcome(raw, parse)
      // 与 stat/read 竞态下实际读到的大内容一起计重，不能拿较小的旧 stat 绕过字节闸。
      store(path, stamp, Math.max(stamp.size, Buffer.byteLength(raw, 'utf8')), outcome)
      return outcome
    },
    readRaw(path: string): Buffer {
      if (passthrough || closed) return readFileSync(path)
      const stamp = statSync(path)
      const cached = entries.get(path)
      if (cached && cached.size === stamp.size && cached.mtimeMs === stamp.mtimeMs
        && cached.outcome.status === 'ok' && Buffer.isBuffer(cached.outcome.value)) {
        hits += 1
        return cached.outcome.value
      }
      misses += 1
      drop(path)
      const raw = readFileSync(path)
      store(path, stamp, Math.max(stamp.size, raw.byteLength), { status: 'ok', value: raw })
      return raw
    },
    invalidate(path?: string): void {
      if (path === undefined) { entries.clear(); bytes = 0 }
      else drop(path)
    },
    retainDirectory(directory, names): void {
      if (entries.size === 0) return
      const root = resolve(directory)
      const present = new Set(names)
      for (const [path, entry] of entries) {
        if (entry.directory !== root || present.has(basename(path))) continue
        drop(path)
        reclaimed++
      }
    },
    close(): void {
      entries.clear(); bytes = 0; closed = true
    },
    counters(): { hits: number; misses: number; entries: number } {
      return { hits, misses, entries: entries.size }
    },
    resources() { return { bytes, maxBytes: SCHED_READ_CACHE_MAX_BYTES, maxItemBytes: SCHED_READ_CACHE_MAX_ITEM_BYTES, skipped, reclaimed } },
  }
}

export interface CachedCommandBatch {
  commands: SchedulerCommand[]
  invalid: { commandId: string; reason: string }[]
  invalidNames: string[]
}

/** 与 sched-commands.readCommandBatch 分类逐字一致;唯一差别是未变文件不重读不重解析。 */
export function readCommandBatchCached(share: string, cache: SchedReadCache, checkpoint?: () => void): CachedCommandBatch {
  const paths = schedPaths(share)
  const listing = readSchedDirectory(share, paths.commands)
  if (listing.status !== 'ok') throw new SchedulerReadUnavailableError(`[sched] 指令目录不可读:${listing.path}`)
  cache.retainDirectory(paths.commands, listing.value)
  const batch: CachedCommandBatch = { commands: [], invalid: [], invalidNames: [] }
  for (const name of listing.value.filter(name => name.endsWith('.json'))) {
    checkpoint?.()
    const id = name.slice(0, -5)
    try { segment(id) } catch { batch.invalidNames.push(name); continue }
    let outcome: CachedOutcome<SchedulerCommand>
    try {
      outcome = cache.read(join(paths.commands, name), raw => {
        const command = validateCommand(JSON.parse(raw))
        if (command.commandId !== id) throw new Error('[sched] 指令编号与文件名不符')
        return command
      })
    } catch (error) {
      throw new SchedulerReadUnavailableError(`[sched] 指令不可读:${name}`, { cause: error })
    }
    checkpoint?.()
    if (outcome.status === 'ok') batch.commands.push(outcome.value)
    else batch.invalid.push({ commandId: id, reason: `指令格式非法:${errorMessage(outcome.error).replace(/\s+/g, ' ').trim().slice(0, 200)}` })
  }
  return batch
}

export interface CachedReportBatch {
  reports: AttemptReport[]
  invalid: { name: string; reason: string }[]
  invalidNames: string[]
}

/** 与 sched-reports.readReportBatch 分类逐字一致;唯一差别是未变文件不重读不重解析。 */
export function readReportBatchCached(share: string, cache: SchedReadCache, checkpoint?: () => void): CachedReportBatch {
  const directory = schedPaths(share).reports
  const listing = readSchedDirectory(share, directory)
  if (listing.status !== 'ok') throw new SchedulerReadUnavailableError(`[sched] 回报目录不可读:${listing.path}`)
  cache.retainDirectory(directory, listing.value)
  const batch: CachedReportBatch = { reports: [], invalid: [], invalidNames: [] }
  for (const name of listing.value.filter(name => name.endsWith('.json'))) {
    checkpoint?.()
    try { parseReportName(name) } catch { batch.invalidNames.push(name); continue }
    let outcome: CachedOutcome<AttemptReport>
    try {
      outcome = cache.read(join(directory, name), raw => {
        const report = validateReport(JSON.parse(raw))
        if (reportName(report) !== name) throw new Error('[sched] 回报编号与文件名不符')
        return report
      })
    } catch (error) {
      throw new SchedulerReadUnavailableError(`[sched] 回报不可读:${name}`, { cause: error })
    }
    checkpoint?.()
    if (outcome.status === 'ok') batch.reports.push(outcome.value)
    else batch.invalid.push({ name, reason: `回报格式非法:${errorMessage(outcome.error).replace(/\s+/g, ' ').trim().slice(0, 200)}` })
  }
  return batch
}

/** 与 sched-reclaim.readBeatBatch 分类逐字一致;唯一差别是未变文件不重读不重解析。 */
export function readBeatBatchCached(share: string, cache: SchedReadCache, checkpoint?: () => void): BeatBatch {
  const directory = schedPaths(share).beats
  const listing = readSchedDirectory(share, directory)
  if (listing.status !== 'ok') throw new SchedulerReadUnavailableError(`[sched] 心跳目录不可读:${listing.path}`)
  cache.retainDirectory(directory, listing.value)
  const batch: BeatBatch = { beats: new Map(), invalid: [] }
  for (const name of listing.value.filter(name => name.endsWith('.json'))) {
    checkpoint?.()
    let outcome: CachedOutcome<AttemptBeat>
    try {
      outcome = cache.read(join(directory, name), raw => {
        const beat = validateAttemptBeat(JSON.parse(raw))
        if (`${beat.ticketId}--${beat.attemptId}.json` !== name) throw new Error('心跳文件名不符')
        return beat
      })
    } catch (error) {
      throw new SchedulerReadUnavailableError(`[sched] 心跳不可读:${name}`, { cause: error })
    }
    checkpoint?.()
    if (outcome.status === 'ok') batch.beats.set(name, outcome.value)
    else batch.invalid.push(`${name}:${errorMessage(outcome.error)}`)
  }
  return batch
}

/** 与 sched-intake.readSubmissionBatch 一致;原始字节走 readRaw,保住非法 UTF-8 的字节级哈希语义。 */
export function readSubmissionBatchCached(share: string, cache: SchedReadCache, checkpoint?: () => void): SubmissionFile[] {
  const paths = schedPaths(share)
  const listing = readSchedDirectory(share, paths.submit)
  if (listing.status !== 'ok') throw new SchedulerReadUnavailableError(`[sched] 收件目录不可读:${listing.status}:${listing.path}`)
  cache.retainDirectory(paths.submit, listing.value)
  return listing.value.filter(name => name.endsWith('.json')).map(name => {
    checkpoint?.()
    const key = segment(name.slice(0, -5))
    let raw: Buffer
    try { raw = cache.readRaw(join(paths.submit, name)) } catch (error) {
      throw new SchedulerReadUnavailableError(`[sched] 挂号文件不可读:${name}`, { cause: error })
    }
    checkpoint?.()
    return { key, raw }
  })
}
