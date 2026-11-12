import { sortLaneByPriority } from '../utils/taskPriority'
import { readViewPref, writeViewPref } from './viewPrefs'

type TeamTask = { assigneeUserId?: string | null; collaborators?: readonly { userId: string }[] }
export function isMine(task: TeamTask, userId: string): 'lead' | 'collab' | null {
  if (!userId) return null
  if (task.assigneeUserId === userId) return 'lead'
  return task.collaborators?.some(person => person.userId === userId) ? 'collab' : null
}
export function splitMine<T extends TeamTask & { status: string }>(tasks: readonly T[], userId: string, closed: (status: string) => boolean): { mine: T[]; rest: T[] } {
  const mine: T[] = [], rest: T[] = []
  for (const task of tasks) (isMine(task, userId) && !closed(task.status) ? mine : rest).push(task)
  return { mine, rest }
}
function stateRank(status: string): number {
  return ({ '施工中': 0, '待收单': 1, '待拍板': 2 } as Record<string, number>)[status] ?? 3
}
export function sortMine<T extends { status: string; priority?: string }>(tasks: readonly T[], mode: 'priority' | 'original'): T[] {
  const ordered = [...tasks].sort((a, b) => stateRank(a.status) - stateRank(b.status))
  return mode === 'priority' ? sortLaneByPriority(ordered, '我在做') : ordered
}
export function readMyLane(): 'on' | 'off' {
  return readViewPref('dashboard.myLane', 'on') === 'off' ? 'off' : 'on'
}
export function writeMyLane(value: 'on' | 'off'): void { writeViewPref('dashboard.myLane', value) }
