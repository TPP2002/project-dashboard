import { isUtf8 } from 'node:buffer'
import { linkSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { publishLifecycleFileAtomically } from '../bot/cluster-lifecycle-atomic-file'
import { errorMessage, hasCode } from '../bot/cluster-lifecycle-contract'
import {
  canonicalJson, contentHash, deriveTicketId, fields, isoTime, oneOf, rawContentHash,
  requireHash, schedPaths, segment, SUBMIT_CLOCK_SKEW_TOLERANCE_MS, text, ticketId, utcDate, validateSubmission,
  type EventDraft, type LedgerEvent, type SchedulerSources, type SubmissionReceipt, type SubmissionRequest,
} from './sched-contract'
import { appendLedgerEvent, assertSchedulerWritable, causedByCode, readSchedDirectory } from './sched-ledger'
import { projectLedger, rejectionKey, submissionKey, type ProjectionState } from './sched-project'
import { writeTicketSnapshot } from './sched-tickets'
import { SchedulerReadUnavailableError } from './sched-control'

export class SubmissionConflictError extends Error {
  constructor(key: string) { super(`[sched] 幂等键已被不同内容占用:${key}`); this.name = 'SubmissionConflictError' }
}
export function readSubmissionReceipt(share: string, key: string): SubmissionReceipt | null {
  const path = join(schedPaths(share).receipts, `${segment(key)}.json`)
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  }
  const value = JSON.parse(raw) as SubmissionReceipt
  fields(value, {
    idempotencyKey: segment, contentHash: requireHash, at: isoTime, status: oneOf(['accepted', 'rejected']),
    ...(value.status === 'accepted' ? { ticketId } : { reason: text }),
  })
  if (value.idempotencyKey !== key) throw new Error('[sched] 回执幂等键与文件名不符')
  return value
}
function receiptResult(receipt: SubmissionReceipt, hash: string, key: string): string {
  if (receipt.contentHash !== hash) throw new SubmissionConflictError(key)
  if (receipt.status === 'rejected') throw new Error(`[sched] 挂号已拒收:${receipt.reason}`)
  return receipt.ticketId
}

/**
 * T2 零依赖客户端照此顺序：读格式闸→规范 JSON/hash/确定性单号→同卷临时文件→link 到 submit。
 * EEXIST 只在原文件哈希相同时成功，不能覆盖；派单员已归档时查回执，仍须比对内容哈希。
 * 不改变 createdAt、不生成新键来“修复重传”。台账是归档后冲突的最终裁判，客户端不重放台账。
 */
export function writeSubmission(share: string, value: SubmissionRequest): { ticketId: string; contentHash: string; retransmission: boolean } {
  assertSchedulerWritable(share)
  const request = validateSubmission(value)
  const hash = contentHash(request)
  const id = deriveTicketId(request.project, request.idempotencyKey)
  const paths = schedPaths(share)
  const target = join(paths.submit, `${request.idempotencyKey}.json`)
  const receipt = readSubmissionReceipt(share, request.idempotencyKey)
  if (receipt?.status === 'accepted' || receipt?.contentHash === hash) {
    return { ticketId: receiptResult(receipt, hash, request.idempotencyKey), contentHash: hash, retransmission: true }
  }
  try {
    publishLifecycleFileAtomically(target, canonicalJson(request), 'create-only', paths.staging)
    return { ticketId: id, contentHash: hash, retransmission: false }
  } catch (error) {
    if (!causedByCode(error, 'EEXIST')) throw error
    let existing: Buffer
    try { existing = readFileSync(target) } catch (readError) {
      if (!hasCode(readError, 'ENOENT')) throw readError
      // 收件顺序保证先有回执再移走入口文件；不能在读者竞态里把已提交的单子报丢。
      const completed = readSubmissionReceipt(share, request.idempotencyKey)
      if (!completed) throw new Error('[sched] 入口已消失但没有回执，拒绝猜测成功', { cause: readError })
      return { ticketId: receiptResult(completed, hash, request.idempotencyKey), contentHash: hash, retransmission: true }
    }
    if (inspectSubmission(existing, request.idempotencyKey).hash !== hash) throw new SubmissionConflictError(request.idempotencyKey)
    return { ticketId: id, contentHash: hash, retransmission: true }
  }
}

export interface IntakeHooks {
  /** 仅 daemon 注入受控只读共享入口；默认仍使用公共独立副本契约。 */
  project?: typeof projectLedger
  afterLedger?: (event: LedgerEvent) => void
  afterSnapshot?: (receipt: SubmissionReceipt) => void
  afterReceipt?: (receipt: SubmissionReceipt) => void
  afterArchiveLink?: (receipt: SubmissionReceipt) => void
  /** T1b 在本拍任何写入前一次读齐，避免第二个文件不可读时已收了第一个。 */
  batch?: readonly SubmissionFile[]
}
export interface IntakeResult { state: ProjectionState; receipts: SubmissionReceipt[]; archived: string[] }
export interface SubmissionFile { key: string; raw: Buffer }

export function readSubmissionBatch(share: string): SubmissionFile[] {
  const paths = schedPaths(share)
  const listing = readSchedDirectory(share, paths.submit)
  if (listing.status !== 'ok') throw new SchedulerReadUnavailableError(`[sched] 收件目录不可读:${listing.status}:${listing.path}`)
  return listing.value.filter(name => name.endsWith('.json')).map(name => {
    const key = segment(name.slice(0, -5))
    try { return { key, raw: readFileSync(join(paths.submit, name)) } } catch (error) {
      throw new SchedulerReadUnavailableError(`[sched] 挂号文件不可读:${name}`, { cause: error })
    }
  })
}

function inspectSubmission(raw: Buffer, key: string): { hash: string; request?: SubmissionRequest; reason?: string } {
  let hash = rawContentHash(raw)
  try {
    // 替换字符可能让损坏的字符串仍通过 JSON 解析，必须在解码前拒收非法字节。
    if (!isUtf8(raw)) throw new Error('[sched] 挂号文件不是合法 UTF-8')
    const decoded: unknown = JSON.parse(raw.toString('utf8'))
    hash = contentHash(decoded)
    const request = validateSubmission(decoded)
    if (request.idempotencyKey !== key) throw new Error('[sched] 请求幂等键与文件名不符')
    return { hash, request }
  } catch (error) { return { hash, reason: errorMessage(error) } }
}
export function ingestedSubmissionPath(share: string, key: string, hash: string, receiptAt: string): string {
  return join(schedPaths(share).ingested, utcDate(receiptAt), `${key}--${hash}.json`)
}
function archiveSubmission(share: string, key: string, hash: string, at: string, receipt: SubmissionReceipt, hooks: IntakeHooks): string {
  assertSchedulerWritable(share)
  const paths = schedPaths(share)
  const source = join(paths.submit, `${key}.json`)
  const directory = join(paths.ingested, utcDate(at))
  mkdirSync(directory, { recursive: true })
  const target = ingestedSubmissionPath(share, key, hash, at)
  try { linkSync(source, target) } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
    if (inspectSubmission(readFileSync(target), key).hash !== hash) throw new Error('[sched] 归档内容冲突', { cause: error })
  }
  hooks.afterArchiveLink?.(receipt)
  // 只有唯一收件者删入口，客户端只做 create-only，因此 link 与 unlink 之间不会被换成别的请求。
  unlinkSync(source)
  return target
}

/**
 * 每节拍调用一次；initial 必须是当前投影，函数不重放全账。唯一写者权由 T1b 提供。
 * 持久顺序不可调换：流水→快照→回执→归档。任意钩子/写入抛错后，调用方丢掉旧内存状态，
 * 重新 readLedger/projectLedger 再调用；已有键只补派生文件，不能第二次追加 submitted。
 */
export function ingestSubmissions(share: string, initial: ProjectionState, sources: SchedulerSources, hooks: IntakeHooks = {}, preserveWallClock = false): IntakeResult {
  assertSchedulerWritable(share)
  const paths = schedPaths(share)
  const batch = hooks.batch ?? readSubmissionBatch(share)
  let state = initial
  const receipts: SubmissionReceipt[] = []
  const archived: string[] = []
  for (const { key, raw } of batch) {
    const inspected = inspectSubmission(raw, key)
    const accepted = state.submissions[submissionKey(key)]
    let receipt: SubmissionReceipt | undefined
    let draft: EventDraft | undefined
    if (accepted?.contentHash === inspected.hash) receipt = accepted
    else {
      receipt = state.rejections[rejectionKey(key, inspected.hash)]
      if (!receipt) {
        const at = isoTime(sources.now())
        const clockSkewMs = inspected.request ? Date.parse(inspected.request.createdAt) - Date.parse(at) : 0
        const reason = accepted ? '幂等键已被不同内容占用' : inspected.reason
          ?? (clockSkewMs > SUBMIT_CLOCK_SKEW_TOLERANCE_MS
            ? `挂号时间超前 ${clockSkewMs} 毫秒，超过跨机时钟偏差容忍值 ${SUBMIT_CLOCK_SKEW_TOLERANCE_MS} 毫秒` : undefined)
        draft = reason
          ? { at, type: 'rejected-submission', data: { idempotencyKey: key, contentHash: inspected.hash, reason } }
          : { at, type: 'submitted', ticketId: deriveTicketId(inspected.request!.project, key), attemptId: 'a1', data: { request: inspected.request!, contentHash: inspected.hash } }
      }
    }
    if (draft) {
      const event = appendLedgerEvent(share, draft, state.cursor, undefined, preserveWallClock)
      hooks.afterLedger?.(event)
      state = (hooks.project ?? projectLedger)([event], state)
      receipt = event.type === 'submitted' ? state.submissions[submissionKey(key)] : state.rejections[rejectionKey(key, inspected.hash)]
    }
    if (!receipt) throw new Error('[sched] 收件没有可恢复的回执')
    if (receipt.status === 'accepted') {
      const ticket = state.tickets[receipt.ticketId]
      if (!ticket) throw new Error('[sched] 台账存在挂号但投影丢失')
      writeTicketSnapshot(share, ticket)
    }
    hooks.afterSnapshot?.(receipt)
    assertSchedulerWritable(share)
    publishLifecycleFileAtomically(join(paths.receipts, `${key}.json`), canonicalJson(receipt), 'replace', paths.staging)
    hooks.afterReceipt?.(receipt)
    archived.push(archiveSubmission(share, key, inspected.hash, receipt.at, receipt, hooks))
    receipts.push(receipt)
  }
  return { state, receipts, archived }
}
