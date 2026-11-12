import type { Activity, Board, Task } from '../types'

export interface BoardDelta {
  ok: true
  delta: true
  base: string
  rest: Omit<Board, 'tasks' | 'activity'>
  order: string[]
  tasks: Task[]
  activityAppend: Activity[]
}

export function applyBoardDelta(old: Board, delta: BoardDelta, limit?: number): Board | null {
  const tasks = new Map(old.tasks.map(task => [task.id, task]))
  for (const task of delta.tasks) tasks.set(task.id, task)
  const ordered: Task[] = []
  for (const id of delta.order) {
    const task = tasks.get(id)
    if (!task) return null
    ordered.push(task)
  }
  const activity = [...(old.activity ?? []), ...delta.activityAppend]
  return { ...delta.rest, tasks: ordered, activity: limit ? activity.slice(-limit) : activity }
}
