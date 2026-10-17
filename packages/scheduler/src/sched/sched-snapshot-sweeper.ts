/** 保护区外单航道清理；只碰快照目录顶层可识别的普通文件。 */
import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'
import { hasCode } from '../bot/cluster-lifecycle-contract'
import { snapshotDir } from './sched-contract'
import type { ProjectionState } from './sched-project'

export const SNAPSHOT_SWEEP_TERMINAL_GRACE_MS = 60_000
export const SNAPSHOT_SWEEP_STALE_MS = 10 * 60_000
export const SNAPSHOT_SWEEP_BATCH_BUDGET_MS = 60_000
export const SNAPSHOT_SWEEP_INTERVAL_MS = 60_000
export const SNAPSHOT_SWEEP_STUCK_WARN_MS = 5 * 60_000
export type SnapshotName = { kind: 'bundle' | 'manifest' | 'launch' | 'bundle-temp' | 'launch-temp';
  ticketId: string; attemptId?: string }
export function classifySnapshotName(name: string): SnapshotName | undefined {
  let match = /^(tk-[0-9a-f]{20})[.]bundle$/.exec(name)
  if (match) return { kind: 'bundle', ticketId: match[1]! }
  match = /^(tk-[0-9a-f]{20})--(a[1-9][0-9]*)[.]json$/.exec(name)
  if (match) return { kind: 'manifest', ticketId: match[1]!, attemptId: match[2]! }
  match = /^(tk-[0-9a-f]{20})--(a[1-9][0-9]*)[.]launch[.]json$/.exec(name)
  if (match) return { kind: 'launch', ticketId: match[1]!, attemptId: match[2]! }
  match = /^[.](tk-[0-9a-f]{20})[.]bundle[.]tmp-[^/\\]+$/.exec(name)
  if (match) return { kind: 'bundle-temp', ticketId: match[1]! }
  match = /^[.](tk-[0-9a-f]{20})--(a[1-9][0-9]*)[.]launch[.]tmp-[^/\\]+$/.exec(name)
  if (match) return { kind: 'launch-temp', ticketId: match[1]!, attemptId: match[2]! }
  return undefined
}

export function snapshotFileVerdict(entry: { name: string; mtimeMs: number }, state: ProjectionState,
  now: number): 'keep' | 'delete' | 'unknown' {
  const parsed = classifySnapshotName(entry.name)
  if (!parsed) return 'unknown'
  const age = now - entry.mtimeMs
  if (age < 0) return 'keep'
  if (parsed.kind === 'bundle-temp' || parsed.kind === 'launch-temp') return age >= SNAPSHOT_SWEEP_STALE_MS ? 'delete' : 'keep'
  const ticket = state.tickets[parsed.ticketId]
  if (!ticket) return age >= SNAPSHOT_SWEEP_STALE_MS ? 'delete' : 'keep'
  if (ticket.endedAt !== null) return now - Date.parse(ticket.endedAt) >= SNAPSHOT_SWEEP_TERMINAL_GRACE_MS ? 'delete' : 'keep'
  const active = ticket.attempts.at(-1)
  const inFlight = ticket.request.execution === 'auto' && active?.permit
    && active.permit.machine !== ticket.request.origin
    && ['granted', 'running', 'paused', 'slow'].includes(ticket.state)
  if (inFlight && (parsed.kind === 'bundle' || parsed.attemptId === ticket.currentAttemptId)) return 'keep'
  return age >= SNAPSHOT_SWEEP_STALE_MS ? 'delete' : 'keep'
}

export interface SnapshotSweepIo {
  readdir(path: string): Promise<string[]>
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; mtimeMs: number }>
  unlink(path: string): Promise<void>
}
export interface SnapshotSweeper {
  pump(state: () => ProjectionState): void
  inFlight(): boolean
  close(): void
}
export function createSnapshotSweeper(options: { share: string; now: () => number;
  log?: (message: string) => void; io?: SnapshotSweepIo }): SnapshotSweeper {
  const io = options.io ?? fs
  const dir = snapshotDir(options.share)
  const warned = new Set<string>()
  let closed = false, running = false, started = Number.NEGATIVE_INFINITY
  let lastStarted = Number.NEGATIVE_INFINITY, stuckWarned = false
  const log = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    try { options.log?.(message) } catch { /* 告警端口不得停清理器 */ }
  }
  const batch = async (state: () => ProjectionState): Promise<void> => {
    try {
      const root = await io.lstat(dir)
      if (closed) return
      if (!root.isDirectory() || root.isSymbolicLink()) { log('root', '[sched] 快照目录不是普通目录，保留'); return }
      const names = (await io.readdir(dir)).sort()
      for (const name of names) {
        if (closed || options.now() - started >= SNAPSHOT_SWEEP_BATCH_BUDGET_MS) break
        const parsed = classifySnapshotName(name)
        if (!parsed) { log(`name:${name}`, `[sched] 快照目录未知名字，已保留:${JSON.stringify(name)}`); continue }
        const path = join(dir, name)
        if (relative(dir, path) !== name) { log(`path:${name}`, '[sched] 快照文件不在目录边界内，已保留'); continue }
        try {
          const info = await io.lstat(path)
          if (closed || options.now() - started >= SNAPSHOT_SWEEP_BATCH_BUDGET_MS) break
          if (!info.isFile() || info.isSymbolicLink()) {
            log(`type:${name}`, `[sched] 快照目录条目不是普通文件，已保留:${JSON.stringify(name)}`)
            continue
          }
          // 用最新投影判定；判定与发起 unlink 之间没有 await。
          if (snapshotFileVerdict({ name, mtimeMs: info.mtimeMs }, state(), options.now()) !== 'delete') continue
          if (closed) break
          await io.unlink(path)
        } catch (error) {
          if (hasCode(error, 'ENOENT')) continue
          if (hasCode(error, 'EBUSY') || hasCode(error, 'EPERM') || hasCode(error, 'EACCES')) {
            log(`busy:${name}`, `[sched] 快照文件暂不能清理，留到下一批:${JSON.stringify(name)}`)
            continue
          }
          log(`file:${name}`, `[sched] 快照文件清理失败:${JSON.stringify(name)}`)
        }
      }
    } catch (error) { if (!hasCode(error, 'ENOENT')) log('batch', '[sched] 快照目录清理失败，留到下一批') }
    finally { running = false }
  }
  return {
    pump(state) {
      if (closed) return
      const now = options.now()
      if (running) {
        if (!stuckWarned && now - started >= SNAPSHOT_SWEEP_STUCK_WARN_MS) {
          stuckWarned = true; log(`stuck:${started}`, '[sched] 快照清理一批在途超过五分钟')
        }
        return
      }
      if (now - lastStarted < SNAPSHOT_SWEEP_INTERVAL_MS) return
      running = true; started = now; lastStarted = now; stuckWarned = false
      void batch(state).catch(() => { running = false; log('rejection', '[sched] 快照清理异步失败') })
    },
    inFlight: () => running,
    close() { closed = true },
  }
}
