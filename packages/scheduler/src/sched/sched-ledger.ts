import { closeSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import { errorMessage, hasCode } from '../bot/cluster-lifecycle-contract'
import {
  assertWritableFormat, canonicalJson, contentHash, eventWithoutChecksum, isoTime, ledgerPath, ledgerRecordTime,
  schedPaths, SCHED_CAPABILITIES, SCHED_FORMAT_VERSION, utcDate, validateEventDraft, validateLedgerEvent,
  type EventDraft, type LedgerCursor, type LedgerEvent, type ReadResult, type SchedulerSources,
} from './sched-contract'

export interface DiscardedTail { path: string; truncateBytes: number; reason: string }
export interface LedgerReplay {
  events: LedgerEvent[]
  cursor: LedgerCursor
  discardedTail: DiscardedTail | null
}
export const EMPTY_CURSOR: LedgerCursor = { seq: 0, at: null, sha256: null }

/** 原子发布包装了 cause，不能把 EEXIST 以外的磁盘错误误报成重传。 */
export function causedByCode(error: unknown, code: string): boolean {
  if (hasCode(error, code)) return true
  return error instanceof Error && error.cause !== undefined && causedByCode(error.cause, code)
}

/** share 不存在/不可读是故障；只有可读 share 下 sched 缺失才是尚未初始化。 */
export function readSchedDirectory(share: string, directory: string): ReadResult<string[]> {
  const root = schedPaths(share).root
  let path = share
  try {
    if (!statSync(share).isDirectory()) throw new Error('共享盘不是目录')
    readdirSync(share)
    path = root
    try { statSync(root) } catch (error) {
      if (hasCode(error, 'ENOENT')) return { status: 'not-initialized', path: root }
      throw error
    }
    // 即使子目录存在，也不能绕过 sched 本身的访问失败。
    readdirSync(root)
    path = directory
    return { status: 'ok', value: readdirSync(directory).sort() }
  } catch (error) {
    return { status: 'unreadable', path, reason: errorMessage(error) }
  }
}

export function assertSchedulerWritable(share: string): void {
  const paths = schedPaths(share)
  const readable = readSchedDirectory(share, paths.control)
  if (readable.status !== 'ok') throw new Error(`[sched] 无法写入:${readable.status}:${readable.path}`)
  assertWritableFormat(JSON.parse(readFileSync(paths.format, 'utf8')))
}

/** 仅显式初始化时建目录；读函数和普通追加绝不把失联共享盘“补成”新空队列。 */
export function initializeScheduler(share: string, sources: SchedulerSources): void {
  if (!statSync(share).isDirectory()) throw new Error('[sched] 共享盘不是目录')
  const paths = schedPaths(share)
  try { assertWritableFormat(JSON.parse(readFileSync(paths.format, 'utf8'))) } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
  for (const [key, directory] of Object.entries(paths)) if (key !== 'format') mkdirSync(directory, { recursive: true })
  const format = { formatVersion: SCHED_FORMAT_VERSION, capabilities: [...SCHED_CAPABILITIES], createdAt: isoTime(sources.now()) }
  try { publishLifecycleFileAtomically(paths.format, canonicalJson(format), 'create-only', paths.staging) } catch (error) {
    if (!causedByCode(error, 'EEXIST')) throw error
  }
  assertSchedulerWritable(share)
}

interface LedgerFile { path: string; date: string; bytes: Buffer }

/**
 * SCHED-SELF-OVERHEAD-0925:追加方的账本尾增量状态。只在同一写者进程内活着;重启后为空,
 * 首次追加自动退回全量读并重建。bytes 是已确认读到(含校验和游标核对)的文件末偏移。
 */
export interface LedgerTailState { path: string; bytes: number; cursor: LedgerCursor }
export function emptyLedgerTail(): LedgerTailState { return { path: '', bytes: 0, cursor: { ...EMPTY_CURSOR } } }

/** 目录名闸与全量读共用:未知文件名/坏日期在增量路径上同样停写,不给「少查一次」留缝。 */
function ledgerListing(share: string): ReadResult<string[]> {
  const listing = readSchedDirectory(share, schedPaths(share).ledger)
  if (listing.status !== 'ok') return listing
  for (const name of listing.value) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) throw new Error(`[sched] 台账目录含未知文件:${name}`)
    isoTime(`${name.slice(0, 10)}T00:00:00.000Z`)
  }
  return listing
}

/**
 * 只读末文件新增字节:chunk 与文件尾严格对齐,parseFiles 里「最后一行」的语义与全量读一致。
 * 记住的文件不再是目录末日、变短、或任何读取异常,都返回 undefined 让调用方退回全量路径。
 */
function readLedgerTailIncremental(share: string, tail: LedgerTailState, path: string): LedgerFile | undefined {
  if (tail.path !== path || tail.bytes <= 0) return undefined
  const listing = ledgerListing(share)
  if (listing.status !== 'ok') return undefined
  // 记住的文件被挪走/出现了更新的日文件时交回全量路径,由它执行「不能向较早台账追加」的原判。
  if (listing.value.at(-1) !== basename(path)) return undefined
  let fd: number
  try { fd = openSync(path, 'r') } catch { return undefined }
  try {
    const size = fstatSync(fd).size
    if (size < tail.bytes) return undefined
    const chunk = Buffer.alloc(size - tail.bytes)
    let read = 0
    while (read < chunk.length) {
      const count = readSync(fd, chunk, read, chunk.length - read, tail.bytes + read)
      if (count === 0) break
      read += count
    }
    if (read !== chunk.length) return undefined
    return { path, date: basename(path).slice(0, 10), bytes: chunk }
  } catch { return undefined } finally { closeSync(fd) }
}

function readLedgerFiles(share: string, tailOnly: boolean): ReadResult<LedgerFile[]> {
  const directory = schedPaths(share).ledger
  const listing = ledgerListing(share)
  if (listing.status !== 'ok') return listing
  const files: LedgerFile[] = []
  // 稳定运行时只读末日；末日空/只剩坏尾时再取前一天。历史完整性由启动重放建立。
  for (const name of [...listing.value].reverse()) {
    const path = join(directory, name)
    try { files.unshift({ path, date: name.slice(0, 10), bytes: readFileSync(path) }) } catch (error) {
      return { status: 'unreadable', path, reason: errorMessage(error) }
    }
    if (tailOnly) {
      const parsed = parseFiles(files, false)
      if (parsed.events.length > 0) break
    }
  }
  return { status: 'ok', value: files }
}

/**
 * initial/offsetBase 只在增量续读时使用:initial 是 chunk 起点已确认的游标,offsetBase 是
 * chunk 在文件里的绝对偏移(坏尾修剪、中间坏行报错都要绝对坐标)。全量路径与旧实现逐字等价。
 */
function parseFiles(files: LedgerFile[], requireStart: boolean, initial: LedgerCursor = EMPTY_CURSOR, offsetBase = 0): LedgerReplay {
  const events: LedgerEvent[] = []
  let cursor = { ...initial }
  let discardedTail: DiscardedTail | null = null
  for (const [fileIndex, file] of files.entries()) {
    let offset = 0
    while (offset < file.bytes.length) {
      const newline = file.bytes.indexOf(10, offset)
      const end = newline < 0 ? file.bytes.length : newline
      const next = newline < 0 ? end : end + 1
      const last = fileIndex === files.length - 1 && next === file.bytes.length
      let decoded: unknown
      let badChecksum: boolean
      let corruption = ''
      try {
        decoded = JSON.parse(file.bytes.subarray(offset, end).toString('utf8'))
        if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) badChecksum = true
        else {
          const { sha256, ...body } = decoded as Record<string, unknown>
          badChecksum = sha256 !== contentHash(body)
        }
        if (badChecksum) corruption = '校验和失败'
      } catch (error) { corruption = errorMessage(error) }
      if (corruption) {
        if (!last) throw new Error(`[sched] 台账中间坏行:${file.path}:${offset + offsetBase}:${corruption}`)
        discardedTail = { path: file.path, truncateBytes: offsetBase + offset, reason: corruption }
        break
      }
      // 版本、data、序号和日期错即使在最后一行也不是“断电截断”，不得放过。
      const event = validateLedgerEvent(decoded)
      // 增量 chunk 从文件中部起算,首事件必须正好接上已确认游标;全量首行(游标为零)仍沿用旧口径。
      const expected = events.length === 0 && !requireStart && cursor.seq === 0 ? event.seq : cursor.seq + 1
      if (event.seq !== expected) throw new Error(`[sched] 台账 seq 不连续:${event.seq}，应为 ${expected}`)
      const recordedAt = ledgerRecordTime(event)
      if (utcDate(recordedAt) !== file.date) throw new Error('[sched] 台账事件日期与文件不符')
      if (cursor.at !== null && recordedAt < cursor.at) throw new Error('[sched] 台账时间倒序')
      cursor = { seq: event.seq, at: recordedAt, sha256: event.sha256 }
      events.push(event)
      offset = next
    }
  }
  return { events, cursor, discardedTail }
}

/** 空流水是 ok + events:[]；I/O 故障返回 unreadable，内容损坏直接抛错。 */
export function readLedger(share: string): ReadResult<LedgerReplay> {
  const files = readLedgerFiles(share, false)
  if (files.status !== 'ok') return files
  return { status: 'ok', value: parseFiles(files.value, true) }
}

/** 换行前缀判定统一从盘上取 size-1 处的单个字节:增量手里只有 chunk,全量手里是整份旧快照,盘上读法两边逐字节同口径。 */
function lastByteAt(path: string, size: number): number {
  if (size <= 0) return -1
  const fd = openSync(path, 'r')
  try {
    const one = Buffer.alloc(1)
    return readSync(fd, one, 0, 1, size - 1) === 1 ? one[0]! : -1
  } finally { closeSync(fd) }
}

/**
 * 只能在调用方已经持有派单员写者权时调用；这里不实现租约/进程单例。
 * trustedCursor 只能来自启动重放或上次追加，省掉反复读取全部历史；每次仍与盘上末行比对。
 * 它不是并发锁，T1b 必须把写者 fencing 包住本函数。未传游标时做一次完整重放。
 * tail(SCHED-SELF-OVERHEAD-0925)是同一写者进程记住的末文件偏移:传了就只读新增字节,
 * 任何疑点(变短/换日/名闸失败)自动退回全量路径,坏尾修剪与游标漂移检测一个不松。
 */
export function appendLedgerEvent(share: string, draft: EventDraft, trustedCursor?: LedgerCursor,
  tail?: LedgerTailState | null, preserveWallClock = false): LedgerEvent {
  assertSchedulerWritable(share)
  validateEventDraft(draft)
  let path = ledgerPath(share, preserveWallClock && trustedCursor?.at && draft.at < trustedCursor.at ? trustedCursor.at : draft.at)
  const incremental = tail ? readLedgerTailIncremental(share, tail, path) : undefined
  let files: LedgerFile[]
  let initialCursor = EMPTY_CURSOR
  let offsetBase = 0
  if (incremental) {
    files = [incremental]
    initialCursor = tail!.cursor
    offsetBase = tail!.bytes
  } else {
    const read = readLedgerFiles(share, trustedCursor !== undefined)
    if (read.status !== 'ok') throw new Error(`[sched] 台账不可追加:${read.status}:${read.path}`)
    files = read.value
  }
  const replay = parseFiles(files, trustedCursor === undefined, initialCursor, offsetBase)
  if (trustedCursor && canonicalJson(trustedCursor) !== canonicalJson(replay.cursor)) throw new Error('[sched] 台账游标漂移，必须重新重放')
  const regressed = replay.cursor.at !== null && draft.at < replay.cursor.at
  if (regressed && !preserveWallClock) throw new Error('[sched] 追加时间不能倒退')
  const recordedAt = regressed ? replay.cursor.at! : draft.at
  path = ledgerPath(share, recordedAt)
  const latest = files.at(-1)
  if (latest && utcDate(recordedAt) < latest.date) throw new Error('[sched] 不能向较早的台账文件追加')
  const body = { v: SCHED_FORMAT_VERSION, seq: replay.cursor.seq + 1, ...draft,
    ...(regressed ? { recordedAt } : {}) }
  const event: LedgerEvent = { ...body, sha256: contentHash(body) }
  validateLedgerEvent(event)
  if (replay.discardedTail) {
    const fd = openSync(replay.discardedTail.path, 'r+')
    try { ftruncateSync(fd, replay.discardedTail.truncateBytes); fsyncSync(fd) } finally { closeSync(fd) }
  }
  let prefix = ''
  const target = files.find(file => file.path === path)
  if (target) {
    const size = replay.discardedTail?.path === path ? replay.discardedTail.truncateBytes : offsetBase + target.bytes.length
    if (size > 0 && lastByteAt(path, size) !== 10) prefix = '\n'
  }
  const bytes = Buffer.from(`${prefix}${canonicalJson(event)}\n`, 'utf8')
  const fd = openSync(path, 'a')
  try {
    let written = 0
    while (written < bytes.length) {
      const count = writeSync(fd, bytes, written, bytes.length - written)
      if (count === 0) throw new Error('[sched] 台账追加未取得进展')
      written += count
    }
    fsyncSync(fd)
  } finally { closeSync(fd) }
  if (tail) {
    tail.path = path
    tail.bytes = statSync(path).size
    tail.cursor = { seq: event.seq, at: ledgerRecordTime(event), sha256: event.sha256 }
  }
  // 增量消费者可能直接序列化返回值；含 data 在内的键序必须与写盘再读回完全一致。
  return JSON.parse(canonicalJson(event)) as LedgerEvent
}

/** 纯校验入口也供增量投影使用，避免内存注入绕过磁盘的校验和约束。 */
export function assertLedgerChecksum(event: LedgerEvent): void {
  validateLedgerEvent(event)
  if (contentHash(eventWithoutChecksum(event)) !== event.sha256) throw new Error('[sched] 台账校验和失败')
}
