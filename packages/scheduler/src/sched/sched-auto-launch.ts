/** 执行端开跑申请：准备期与真正开跑之间的只建一次凭据。 */
import { promises as fs, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { hasCode } from '../bot/cluster-lifecycle-contract'
import { canonicalJson, isoTime, snapshotDir, submissionId, type TicketSnapshot } from './sched-contract'

export const AUTO_LAUNCH_FUTURE_TOLERANCE_MS = 5 * 60_000
export interface AutoLaunchNotice {
  schema: 1; ticketId: string; attemptId: string; submissionId: string;
  machine: string; token: string; launchedAt: string
}
export function autoLaunchNoticePath(share: string, ticket: string, attempt: string): string {
  return join(snapshotDir(share), `${submissionId(ticket, attempt)}.launch.json`)
}
export function validateAutoLaunchNotice(value: unknown): AutoLaunchNotice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('[sched] 开跑申请必须是对象')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'attemptId,launchedAt,machine,schema,submissionId,ticketId,token') {
    throw new Error('[sched] 开跑申请字段集合不合法')
  }
  if (record.schema !== 1 || typeof record.ticketId !== 'string' || !/^tk-[0-9a-f]{20}$/.test(record.ticketId)
    || typeof record.attemptId !== 'string' || !/^a[1-9][0-9]*$/.test(record.attemptId)
    || record.submissionId !== submissionId(record.ticketId, record.attemptId)
    || typeof record.machine !== 'string' || !/^[A-Za-z0-9._-]+$/.test(record.machine)
    || typeof record.token !== 'string' || record.token.length === 0) throw new Error('[sched] 开跑申请身份不合法')
  isoTime(record.launchedAt)
  return value as AutoLaunchNotice
}

export interface AutoLaunchWriteIo {
  writeFile(path: string, content: string, options: { flag: 'wx' }): Promise<void>
  link(from: string, to: string): Promise<void>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  unlink(path: string): Promise<void>
}
export async function writeAutoLaunchNotice(share: string, notice: AutoLaunchNotice,
  io: AutoLaunchWriteIo = fs): Promise<'created' | 'exists'> {
  validateAutoLaunchNotice(notice)
  const path = autoLaunchNoticePath(share, notice.ticketId, notice.attemptId)
  const temp = join(snapshotDir(share), `.${notice.submissionId}.launch.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
  let result: 'created' | 'exists' = 'created'
  let failed = false
  let failure: unknown
  try {
    await io.writeFile(temp, canonicalJson(notice), { flag: 'wx' })
    try { await io.link(temp, path) }
    catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      const old = validateAutoLaunchNotice(JSON.parse(await io.readFile(path, 'utf8')))
      if (old.ticketId === notice.ticketId && old.attemptId === notice.attemptId
        && old.machine === notice.machine && old.token === notice.token) result = 'exists'
      else throw new Error('[sched] 已有开跑申请身份冲突', { cause: error })
    }
  } catch (error) {
    failed = true
    failure = error
  }
  let cleanupFailed = false
  let cleanupFailure: unknown
  try { await io.unlink(temp) }
  catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      cleanupFailed = true
      cleanupFailure = error
    }
  }
  if (cleanupFailed) throw cleanupFailure
  if (failed) throw failure
  return result
}

export type AutoLaunchRead = { kind: 'absent' } | { kind: 'ok'; notice: AutoLaunchNotice }
  | { kind: 'bad'; reason: string }
export function readAutoLaunchNotice(share: string, ticket: string, attempt: string,
  read: (path: string) => string = path => readFileSync(path, 'utf8')): AutoLaunchRead {
  try { return { kind: 'ok', notice: validateAutoLaunchNotice(JSON.parse(read(autoLaunchNoticePath(share, ticket, attempt)))) } }
  catch (error) { return hasCode(error, 'ENOENT') ? { kind: 'absent' } : { kind: 'bad', reason: '开跑申请不可读或形状不合法' } }
}

export interface AutoLaunchReader {
  effectiveLaunchAt(ticket: TicketSnapshot, at: string): string | undefined
  prune(live: ReadonlySet<string>): void
}
export function createAutoLaunchReader(options: { share: string; read?: (path: string) => string;
  log?: (message: string) => void }): AutoLaunchReader {
  const cache = new Map<string, string>()
  const warned = new Set<string>()
  return {
    effectiveLaunchAt(ticket, at) {
      const active = ticket.attempts.at(-1)
      if (ticket.request.execution !== 'auto' || !active?.intent || !active.permit || active.startedAt === null) return undefined
      const key = submissionId(ticket.ticketId, ticket.currentAttemptId)
      const cached = cache.get(key)
      if (cached) return cached
      const found = readAutoLaunchNotice(options.share, ticket.ticketId, ticket.currentAttemptId, options.read)
      if (found.kind === 'absent') return undefined
      const notice = found.kind === 'ok' ? found.notice : undefined
      if (!notice || notice.ticketId !== ticket.ticketId || notice.attemptId !== ticket.currentAttemptId
        || notice.submissionId !== key || notice.machine !== active.intent.machine || notice.token !== active.permit.token
        || Date.parse(notice.launchedAt) > Date.parse(at) + AUTO_LAUNCH_FUTURE_TOLERANCE_MS) {
        if (!warned.has(key)) {
          warned.add(key)
          try { options.log?.(`[sched] ${key} 开跑申请不合法，按准备期继续等待`) } catch { /* 日志不得影响派单 */ }
        }
        return undefined
      }
      const launched = Date.parse(notice.launchedAt) < Date.parse(active.startedAt) ? active.startedAt : notice.launchedAt
      // launchedAt 是执行机按自己的墙钟盖的(10-09 实测副机快约 1.2 秒),可能晚于派单员读到它的这一拍;夹到不晚于
      // 这一拍再缓存,硬超时测量就不会拿两台机器的钟相减出负窗口把派单员整个抛死(SCHED-HUB12-LAUNCH-CLOCK-SKEW-1009)。
      const effective = Date.parse(launched) > Date.parse(at) ? at : launched
      cache.set(key, effective)
      return effective
    },
    prune(live) {
      for (const key of cache.keys()) if (!live.has(key)) cache.delete(key)
      for (const key of warned) if (!live.has(key)) warned.delete(key)
    },
  }
}
