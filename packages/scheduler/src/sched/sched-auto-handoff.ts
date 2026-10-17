import deployment from './client/deployment-config.cjs'
/** 跨机 auto 交接的纯规则与同步投前复核。 */
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LifecycleStatusSnapshot } from '../bot/cluster-lifecycle-status'
import { jobHardTimeoutMs, snapshotDir, snapshotManifestPath, validateSnapshotManifest,
  type EventDraft, type LedgerEvent, type TicketSnapshot } from './sched-contract'
import { autoClusterJobCandidate } from './sched-cluster-job'
import type { ProjectionState } from './sched-project'

/** 执行机协议号下限：低于它或心跳读不到的机器不投 auto 单、回排钉挂号机；null = 一律不投(5b 换代前的休眠态)。
 *  取 75:执行端认 auto 自 v57,作业环境泄漏 v68 修，挂号端 HUB6 v73 上线;75 是打开时两台代理的现役版本(卡 SCHED-HUB4-AUTO-FLOOR-1009)。 */
export const AUTO_JOB_MIN_AGENT_PROTOCOL: number | null = 75
export const AUTO_REQUEUE_SAME_MAX = 2
export const AUTO_HARD_TIMEOUT_PROJECT = deployment.getDeploymentConfig().legacyProjectId
export function autoJobHardTimeoutMs(ticket: TicketSnapshot): number | undefined {
  return ticket.request.project === AUTO_HARD_TIMEOUT_PROJECT ? jobHardTimeoutMs(ticket.request.work.type) : undefined
}

export function isAutoHandoffTicket(ticket: TicketSnapshot): boolean {
  if (ticket.request.execution !== 'auto') return false
  const active = ticket.attempts.at(-1)
  return Boolean(active?.intent || (ticket.pendingQueue && /^handoff-(pin|retry):/.test(active?.result?.reason ?? ''))
    || (ticket.state === 'granted' && active?.permit && active.permit.machine !== ticket.request.origin && active.snapshotReady))
}

export type AutoRefusalDisposition = 'pin' | 'retry' | 'terminal'
export const AUTO_REFUSAL_DISPOSITION: Readonly<Record<string, AutoRefusalDisposition>> = {
  'runtime-mismatch': 'pin', 'executor-disk-low': 'pin', 'executor-no-workspace': 'pin',
  'mirror-failed': 'pin', 'workspace-broken': 'pin', 'deps-install-failed': 'pin',
  'deps-timeout': 'pin', 'deps-recipe-unsupported': 'pin', 'snapshot-sensitive': 'pin',
  'snapshot-no-head': 'pin', 'snapshot-base-missing': 'pin', 'snapshot-missing': 'pin',
  'snapshot-bundle-prerequisite-missing': 'pin', 'snapshot-git-failed': 'pin',
  'snapshot-timeout': 'pin', 'executor-launch-notice-failed': 'pin',
  'menu-agent-stale': 'retry', 'executor-aborted': 'retry',
  'snapshot-commit-mismatch': 'terminal', 'snapshot-bad-ticket': 'terminal',
  'menu-project-unregistered': 'terminal', 'menu-project-not-accepted': 'terminal',
  'menu-no-such-item': 'terminal', 'menu-invalid-args': 'terminal',
  'menu-shell-metachar': 'terminal', 'menu-bad-argument': 'terminal',
  'menu-item-not-portable': 'terminal', 'menu-no-restore-template': 'terminal',
  'menu-entry-missing': 'terminal', 'menu-bad-cores': 'terminal',
  'auto-job-malformed': 'terminal', 'executor-identity-mismatch': 'terminal',
}
export function autoRefusalDisposition(code: string): AutoRefusalDisposition {
  return AUTO_REFUSAL_DISPOSITION[code] ?? (code.startsWith('menu-') ? 'terminal' : 'pin')
}
export function isUnknownAutoRefusal(code: string): boolean {
  return !Object.hasOwn(AUTO_REFUSAL_DISPOSITION, code)
    && !code.startsWith('deps-') && !code.startsWith('snapshot-') && !code.startsWith('menu-')
}
export function autoRetryCount(ticket: TicketSnapshot): number {
  return ticket.attempts.filter(attempt => attempt.result?.reason.startsWith('handoff-retry:')).length
}

const clean = (value: string, max: number): string => value.replace(/[\r\n]+/g, ' ').slice(0, max)
export function formatAutoRequeueReason(mode: 'pin' | 'retry', code: string, detail: string): string {
  return `handoff-${mode}:${code}:${clean(detail, 200)}`
}
export function autoPinData(reason: string): Extract<EventDraft, { type: 'placement-checked' }>['data'] {
  const match = /^handoff-pin:([a-z][a-z0-9-]{0,63}):(.*)$/.exec(reason)
  if (!match) throw new Error('[sched] auto 回排钉理由不合法')
  return { portable: false, reason: match[1]!, detail: clean(`hub4:${match[2]}`, 500) }
}

export function agentProtocolsFrom(snapshot: LifecycleStatusSnapshot): ReadonlyMap<string, number | undefined> {
  return new Map(snapshot.machines.map(machine => [machine.machine,
    machine.fault || !machine.heartbeat ? undefined : machine.heartbeat.protocol]))
}

export interface AutoPreflightIo {
  readManifest: (path: string) => string
  lstatBundle: (path: string) => { isFile(): boolean; size: number }
}
export interface AutoPreflightContext {
  share: string; agentProtocols?: ReadonlyMap<string, number | undefined>
  autoMinAgentProtocol?: number | null; io?: AutoPreflightIo
}
export type AutoPreflightResult = { ok: true } | { ok: false; code: string; detail: string }
const refused = (code: string, detail: string): AutoPreflightResult => ({ ok: false, code, detail })

/** 顺序就是处置优先级；异常只折成码，不回显挂号端原值。 */
export function preflightAutoHandoff(context: AutoPreflightContext, ticket: TicketSnapshot): AutoPreflightResult {
  const candidate = autoClusterJobCandidate(ticket)
  if (!candidate.ok) return refused('preflight-bad-job', '工单字段违反 auto 单规则')
  const active = ticket.attempts.at(-1)!
  const floor = context.autoMinAgentProtocol === undefined ? AUTO_JOB_MIN_AGENT_PROTOCOL : context.autoMinAgentProtocol
  const protocol = context.agentProtocols?.get(active.permit!.machine)
  if (floor === null || protocol === undefined || protocol < floor) return refused('executor-stale', '执行机协议号未达下限')
  const io = context.io ?? { readManifest: (path: string) => readFileSync(path, 'utf8'), lstatBundle: lstatSync }
  let manifest: ReturnType<typeof validateSnapshotManifest>
  try {
    manifest = validateSnapshotManifest(JSON.parse(io.readManifest(snapshotManifestPath(context.share,
      ticket.ticketId, ticket.currentAttemptId))))
    if (manifest.state !== 'ready' || manifest.ticketId !== ticket.ticketId || manifest.attemptId !== ticket.currentAttemptId) {
      return refused('preflight-manifest', '快照清单形状或身份不符')
    }
  } catch { return refused('preflight-manifest', '快照清单不可读或不合法') }
  const ready = active.snapshotReady!
  if (manifest.commit !== ready.commit || manifest.base !== ready.base || manifest.bundle !== ready.bundle
    || manifest.bundleBytes !== ready.bundleBytes) return refused('preflight-commit-mismatch', '快照清单与就绪记录不符')
  let info: ReturnType<AutoPreflightIo['lstatBundle']>
  try { info = io.lstatBundle(join(snapshotDir(context.share), ready.bundle)) }
  catch { return refused('preflight-bundle-missing', '快照包不可读') }
  if (!info.isFile() || info.size !== ready.bundleBytes) return refused('preflight-bundle-mismatch', '快照包类型或字节数不符')
  return { ok: true }
}

/** 在授予前补钉，覆盖重排之后、钉结论之前断电的窗口。 */
export function repinAutoTickets(context: { at: string; state: () => ProjectionState;
  append: (draft: EventDraft) => LedgerEvent; log?: (message: string) => void }): void {
  for (const id of Object.keys(context.state().tickets).sort()) {
    const ticket = context.state().tickets[id]!
    if (ticket.request.execution !== 'auto' || !['queued', 'unsatisfiable'].includes(ticket.state)
      || ticket.attempts.at(-1)?.permit) continue
    const previous = ticket.attempts.at(-2)?.result?.reason
    if (!previous?.startsWith('handoff-pin:')) continue
    if (ticket.placement?.attemptId === ticket.currentAttemptId && ticket.placement.portable === false) continue
    context.append({ at: context.at, type: 'placement-checked', ticketId: id, attemptId: ticket.currentAttemptId,
      data: autoPinData(previous) })
    context.log?.(`[sched] ${id} 恢复 auto 回排钉结论`)
  }
}
