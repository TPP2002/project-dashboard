export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'optional'] as const
export type Priority = typeof PRIORITIES[number]
export const LABELS: Record<Priority, string> = { urgent: '紧急', high: '高', medium: '中', low: '低', optional: '可选' }
export function normalizePriority(value: unknown): Priority | null {
  return PRIORITIES.find(p => p === value || LABELS[p] === value) ?? null
}
export function rank(task: { priority?: string }) { return PRIORITIES.indexOf(normalizePriority(task.priority) ?? 'medium') }
export function comparePriority(a: { priority?: string }, b: { priority?: string }) { return rank(a) - rank(b) }
export function sortLaneByPriority<T extends { priority?: string }>(tasks: T[], laneStatus: string, baseSort: (tasks: T[]) => T[] = tasks => tasks): T[] {
  if (['已完工', '已作废'].includes(laneStatus)) return tasks
  return [...baseSort([...tasks])].sort(comparePriority)
}
export function placePicker(card: { left: number; right: number; top: number; height: number }, viewport: { width: number; height: number }) {
  const width = 184, height = 236, gap = 12
  const right = card.right + gap + width <= viewport.width - 8
  const left = Math.max(8, Math.min(right ? card.right + gap : card.left - gap - width, viewport.width - width - 8))
  const top = Math.max(8, Math.min(card.top + card.height / 2 - 60, viewport.height - height - 8))
  const arrow = Math.min(Math.max(14, card.top + card.height / 2 - top - 5), height - 24)
  return { left, top, arrow, side: right ? 'right' : 'left' }
}
