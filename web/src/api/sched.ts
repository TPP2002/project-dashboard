/** 调度台只消费派单员决策快照；所有核数单位为核，四段时长单位为毫秒。 */
export type TicketState = 'queued' | 'granted' | 'running' | 'paused' | 'slow' | 'unsatisfiable' | 'passed' | 'failed' | 'cancelled' | 'voided'
export type ReserveCores = 0 | 5 | 10 | 15
export interface ReserveData { requestedCores: ReserveCores; durationMinutes?: 60 | 180 }
export type CommandInput =
  | { kind: 'jump-queue' | 'cancel'; data: { ticketId: string } }
  | { kind: 'owner-hold' | 'owner-release'; data: Record<string, never> }
  | { kind: 'reserve'; data: ReserveData }
export interface LegacySync { ok: boolean; error?: string }
export interface Receipt { commandId: string; status: 'executed' | 'rejected' | 'expired'; at: string; reason?: string }
export interface Timing { queuedMs: number; runningMs: number; pausedMs: number; slowMs: number }
export interface Reservation { requestedCores: ReserveCores; fulfilledCores: number; untilAt: string | null }
export interface MachineSnapshot {
  name: string; preference: number; quotaCores: number; grantedCores: number; externalLoadCores: number
  availableCores: number; overCommitted: boolean; fresh: boolean; online: boolean
  ci: 'active' | 'idle' | 'unknown'; ownerHold: boolean; reservation: Reservation | null
  heartbeatAt: string | null; loadSampledAt: string | null
}
export interface QueueEntry {
  ticketId: string; position: number; band: 0 | 1; requestedCores: number; allowedMachines: string[]
  queuedAt: string; state: 'queued' | 'unsatisfiable'; reason: string | null
}
export interface TicketSummary extends Timing {
  ticketId: string; project: string; title: string; submitter: string; category: string; machine: string | null
  requestedCores: number; grantedCores: number; state: TicketState; result: TicketState; resultReason: string | null
  registerOnly: boolean; pauseReasons: string[]; cancelRequested: boolean; createdAt: string; endedAt: string | null
}
export interface Permit {
  ticketId: string; attemptId: string; token: string; machine: string; category: string; grantedCores: number; issuedAt: string
}
export interface Attempt {
  attemptId: string; queuedAt: string; startedAt: string | null; endedAt: string | null; grantedCores: number
  permit: Permit | null; intent: { machine: string; submissionId: string; codeRef: CodeRef } | null
  codeRef: CodeRef | null; result: { outcome: string; reason: string } | null; timing: Timing
}
export interface CodeRef { kind: 'commit' | 'content'; value: string }
export interface TimelineEvent { seq: number; at: string; type: string; attemptId?: string; data: Record<string, unknown> }
export interface TicketDetail {
  ticketId: string; formatVersion: number; state: TicketState; registerOnly: boolean; cancelRequested: boolean
  currentAttemptId: string; pauseReasons: string[]; attempts: Attempt[]; timing: Timing; timeline: TimelineEvent[]
  createdAt: string; updatedAt: string; endedAt: string | null; contentHash: string
  request: { project: string; title: string; submitter: string; category: string; requestedCores: number
    allowedMachines: string[]; codeRef: CodeRef; work: { type: string; targetPaths: string[] }; parentTicketId?: string }
}
export interface SchedSnapshot {
  ok: true; readable: true; share: string; format: { formatVersion: number; capabilities: string[]; createdAt: string }
  dispatcher: { config: { machine: string; createdAt: string; createdBy: string }; heartbeatAgeMs: number
    heartbeat: { machine: string; pid: number; protocol: number; head: string; at: string; tick: number; cursorSeq: number; queued: number; granted: number } }
  machines: MachineSnapshot[]; queue: QueueEntry[]; locks: { machine: string; byTicketId: string }[]
  running: TicketSummary[]; registerOnly: TicketSummary[]; recentReceipts: Receipt[]
  legacyReserve: { reservedCores: number; reserveExpiresAt: string | null }
}
export interface TicketFilters { project: string; machine: string; submitter: string; result: string; from: string; to: string }
export interface TicketPage {
  ok: boolean; readable: boolean; items: TicketSummary[]; total: number; limit: number; nextCursor: string | null
  filters: { projects: string[]; machines: string[]; submitters: string[] }
}

async function request<T>(endpoint: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/sched/${endpoint}`, { signal, ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) })
  const value = await response.json()
  if (!response.ok || value.ok === false) throw new Error([value.error || '调度请求失败', value.reason || value.legacy?.error].filter(Boolean).join('：'))
  return value as T
}
export const fetchSnapshot = (signal?: AbortSignal) => request<SchedSnapshot>('snapshot', undefined, signal)
export const fetchTicket = (id: string, signal?: AbortSignal) => request<{ ok: boolean; ticket: TicketDetail }>(`ticket/${encodeURIComponent(id)}`, undefined, signal)
export function fetchTickets(filters: Partial<TicketFilters>, cursor = '', limit = 50, signal?: AbortSignal) {
  const query = new URLSearchParams({ cursor, limit: String(limit) })
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value)
  return request<TicketPage>(`tickets?${query}`, undefined, signal)
}
export const postCommand = (body: CommandInput) => request<{ ok: boolean; commandId: string; legacy?: LegacySync }>('command', body)
export const retryLegacyReserve = (data: ReserveData) => request<{ ok: boolean; legacy: LegacySync }>('legacy-reserve', data)
