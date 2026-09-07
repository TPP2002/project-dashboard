import type { Board, Task } from '../types'
import type { BoardEvent } from '../utils/boardEvents'
import { progress } from '../utils/derive'
import { VOID_STATUSES } from '../api/schema'
import type { SceneEvent, SceneState, SceneTask } from './types'

type Group = 'queued' | 'active' | 'pending' | 'blocked' | 'done'
const GROUPS: Record<Exclude<Task['status'], '已作废'>, Group> = {
  未开工: 'queued', 待开工: 'queued', 可复工: 'queued', 压轴: 'queued',
  施工中: 'active', 已拍板: 'active', 收官: 'active',
  待拍板: 'pending', 暂缓: 'blocked', 已完工: 'done',
}

function percent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0
}

function taskPercent(task: Task): number {
  return task.status === '收官' ? Math.max(90, percent(task.percent)) : percent(task.percent)
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const byId = (a: Task, b: Task) => compare(a.id, b.id)
const wave = (task: Task) => Number.isFinite(task.wave) ? task.wave! : 0
// 旧前端类型尚未列 claimed；只在此处读取扩展字段，不改共享 TaskDates。
const claimed = (task: Task) => (task.dates as (Task['dates'] & { claimed?: string | null }))?.claimed || task.id

/** 不改输入；空看板返回空状态。分母与看板页共用 progress，禁止按平均进度另算。 */
export function deriveSceneState(board: Board | null | undefined, projectId: string): SceneState {
  const groups: Record<Group, Task[]> = { queued: [], active: [], pending: [], blocked: [], done: [] }
  for (const task of board?.tasks ?? []) {
    if (VOID_STATUSES.has(task.status)) continue
    const group = GROUPS[task.status as keyof typeof GROUPS]
    if (group) groups[group].push(task)
  }
  groups.queued.sort((a, b) => Number(a.status === '压轴') - Number(b.status === '压轴') || wave(a) - wave(b) || byId(a, b))
  groups.active.sort((a, b) => compare(claimed(a), claimed(b)) || byId(a, b))
  groups.pending.sort(byId)
  groups.blocked.sort(byId)
  groups.done.sort((a, b) => compare(a.dates?.done || a.id, b.dates?.done || b.id) || byId(a, b))
  const rows = (tasks: Task[]): SceneTask[] => tasks.map((task, order) => ({
    id: task.id, title: task.plainTitle || task.title, status: task.status, percent: taskPercent(task), order,
  }))
  const summary = progress(board)
  return {
    projectId, projectName: board?.project?.name ?? '',
    queued: rows(groups.queued), active: rows(groups.active), pending: rows(groups.pending),
    blocked: rows(groups.blocked), done: rows(groups.done),
    total: summary.total, percent: summary.percent,
    complete: summary.total > 0 && groups.done.length === summary.total,
  }
}

/** 总线没有 percent；容器传入刚刷新的状态补齐。可直接映射带 percent 的离线事件。 */
export function mapBoardEvent(
  event: BoardEvent & { percent?: number }, projectId = event.projectId, state?: SceneState,
): SceneEvent | null {
  if (event.projectId !== projectId) return null
  const identity = { projectId: event.projectId, taskId: event.taskId, ts: event.ts }
  if (event.kind === 'progress') {
    const task = state?.projectId === projectId
      ? [...state.queued, ...state.active, ...state.pending, ...state.blocked, ...state.done].find(task => task.id === event.taskId)
      : undefined
    return { ...identity, kind: 'progress', percent: task?.percent ?? percent(event.percent) }
  }
  switch (event.kind) {
    case 'claim': case 'done': case 'block': case 'park': return { ...identity, kind: event.kind }
    case 'pending': return { ...identity, kind: 'hold' }
    case 'decide': return { ...identity, kind: 'go' }
    default: return null
  }
}
