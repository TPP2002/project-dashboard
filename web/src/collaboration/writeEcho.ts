export function patchMemberTasks<T extends { id: string }>(tasks: T[], task: T): T[] {
  const index = tasks.findIndex(item => item.id === task.id)
  if (index < 0) return [...tasks, task]
  return tasks.map((item, i) => i === index ? task : item)
}

export function applyOwnerEcho<T extends { id: string }>(task: T, echo: unknown): T {
  if (!echo || typeof echo !== 'object' || Array.isArray(echo)) return task
  const source = echo as Record<string, unknown>
  if (source.id !== task.id || typeof source.status !== 'string') return task
  const result: Record<string, unknown> = { ...task }
  for (const key of ['status', 'assigneeUserId', 'assigneeName', 'lastProgressAt', 'priority']) {
    if (typeof source[key] === 'string') result[key] = source[key]
    else delete result[key]
  }
  if (Number.isInteger(source.percent)) result.percent = source.percent
  if (Array.isArray(source.collaborators) && source.collaborators.length) {
    result.collaborators = source.collaborators.map(({ userId, name, joinedAt }) => ({ userId, name, joinedAt }))
  } else delete result.collaborators
  if (source.dates && typeof source.dates === 'object' && !Array.isArray(source.dates)) {
    const dates = source.dates as Record<string, unknown>
    const existing = result.dates
    const merged: Record<string, unknown> = existing && typeof existing === 'object' ? { ...existing } : {}
    for (const key of ['start', 'done', 'design']) if (typeof dates[key] === 'string') merged[key] = dates[key]
    result.dates = merged
  }
  return result as T
}
