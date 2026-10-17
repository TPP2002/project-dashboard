import projects from './client/sched-projects.cjs'
import type { Category, TicketSnapshot } from './sched-contract'

export const ETA_SHIP_MS = 10_000
export const ETA_DEFAULT_RUN_MS = 60_000
export const ETA_DEFAULT_WARMUP_MS = 110_000
export const ETA_SAMPLE_LIMIT = 20
export const ETA_MIN_SAMPLES = 3
export const ETA_CROWD_KNEE = 0.7

export function crowdFactor(input: { quotaCores: number; availableCores: number; requestedCores: number }): number {
  return 1 + Math.max(0, (input.quotaCores - input.availableCores + input.requestedCores) / input.quotaCores - ETA_CROWD_KNEE)
}
export function etaMs(input: { shipMs: number; warmupMs: number; runMs: number; crowd: number }): number {
  return Math.round(input.shipMs + input.warmupMs + input.runMs * input.crowd)
}

export interface EtaBook {
  add(ticket: TicketSnapshot): void
  runMs(project: string, workType: string, category: Category, requestedCores: number): number
  size(): number
}
type Sample = { ticketId: string; endedAt: string; value: number }
const key = (project: string, workType: string): string => JSON.stringify([projects.normalizeProjectId(project).id, workType])
const compare = (left: Sample, right: Sample): number => left.endedAt < right.endedAt ? -1
  : left.endedAt > right.endedAt ? 1 : left.ticketId < right.ticketId ? -1 : left.ticketId > right.ticketId ? 1 : 0

export function createEtaBook(tickets: Iterable<TicketSnapshot>): EtaBook {
  const samples = new Map<string, Sample[]>()
  const seen = new Set<string>()
  const book: EtaBook = {
    add(ticket) {
      try {
        if (!ticket || ticket.state !== 'passed' || typeof ticket.ticketId !== 'string' || seen.has(ticket.ticketId)) return
        const attempt = [...ticket.attempts].reverse().find(item => item.result?.outcome === 'passed')
        const running = attempt?.timing.runningMs
        const slow = attempt?.timing.slowMs
        const cores = attempt?.grantedCores
        const endedAt = attempt?.endedAt
        if (!attempt || !endedAt || !Number.isFinite(Date.parse(endedAt))
          || !Number.isSafeInteger(running) || !Number.isSafeInteger(slow) || !Number.isSafeInteger(cores)
          || running! < 0 || slow! < 0 || cores! < 1 || running! + slow! <= 0) return
        const value = (running! + slow!) * (ticket.request.category === 'unit-test' ? cores! : 1)
        if (!Number.isSafeInteger(value) || value <= 0 || !ticket.request.project || !ticket.request.work?.type) return
        const group = key(ticket.request.project, ticket.request.work.type)
        const entries = samples.get(group) ?? []
        entries.push({ ticketId: ticket.ticketId, endedAt, value })
        entries.sort(compare)
        if (entries.length > ETA_SAMPLE_LIMIT) entries.splice(0, entries.length - ETA_SAMPLE_LIMIT)
        samples.set(group, entries)
        seen.add(ticket.ticketId)
      } catch { /* 历史投影坏数据不影响派单；该样本不收。 */ }
    },
    runMs(project, workType, category, requestedCores) {
      const values = (samples.get(key(project, workType)) ?? []).map(sample => sample.value).sort((a, b) => a - b)
      if (values.length < ETA_MIN_SAMPLES) return ETA_DEFAULT_RUN_MS
      const mid = Math.floor(values.length / 2)
      const median = values.length % 2 === 0 ? (values[mid - 1]! + values[mid]!) / 2 : values[mid]!
      return Math.round(category === 'unit-test' ? median / requestedCores : median)
    },
    size() { return [...samples.values()].reduce((sum, entries) => sum + entries.length, 0) },
  }
  for (const ticket of tickets) book.add(ticket)
  return book
}
