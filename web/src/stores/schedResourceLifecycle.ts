import type { TicketDetail } from '@/api/sched'

/** Queue rows only render these immutable registration fields; never retain history here. */
export interface QueueMetadata {
  request: Pick<TicketDetail['request'], 'project' | 'title' | 'submitter'>
}

export function queueMetadataOf(ticket: TicketDetail): QueueMetadata {
  const { project, title, submitter } = ticket.request
  return { request: { project, title, submitter } }
}

export function pruneQueueRecords<T>(records: Record<string, T>, current: ReadonlySet<string>) {
  for (const id of Object.keys(records)) if (!current.has(id)) delete records[id]
}
