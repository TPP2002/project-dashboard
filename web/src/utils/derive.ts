// 读时派生（R9a）：所有统计 / 分组 / 聚合都是纯函数，现算不落盘。
// store getter 与视图共用，board.json 永不持久化任何派生字段。
import type { Board, Task, Activity, Decision } from '@/types'
import { STATUS_ORDER, DONE_STATUSES } from '@/api/schema'

export type StatusCounts = Record<string, number>

export function statusCounts(board: Board | null | undefined): StatusCounts {
  const c: StatusCounts = {}
  for (const t of board?.tasks ?? []) c[t.status] = (c[t.status] || 0) + 1
  return c
}

export interface Progress {
  total: number
  done: number
  percent: number
}

/** 进度口径①：完工任务占比 */
export function progress(board: Board | null | undefined): Progress {
  const tasks = board?.tasks ?? []
  const total = tasks.length
  const done = tasks.filter((t) => DONE_STATUSES.has(t.status)).length
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 }
}

/** 进度口径②：各任务 percent 的平均（更细腻，进度环用） */
export function avgPercent(board: Board | null | undefined): number {
  const tasks = board?.tasks ?? []
  if (!tasks.length) return 0
  return Math.round(tasks.reduce((s, t) => s + (t.percent || 0), 0) / tasks.length)
}

export interface StatusGroup {
  status: string
  tasks: Task[]
}

/** 按 STATUS 顺序分组（泳道用），空泳道也保留占位 */
export function groupByStatus(board: Board | null | undefined): StatusGroup[] {
  const map = new Map<string, Task[]>()
  for (const s of STATUS_ORDER) map.set(s, [])
  for (const t of board?.tasks ?? []) {
    if (!map.has(t.status)) map.set(t.status, [])
    map.get(t.status)!.push(t)
  }
  return [...map.entries()].map(([status, tasks]) => ({ status, tasks }))
}

export interface WaveGroup {
  wave: number
  tasks: Task[]
}

export function groupByWave(board: Board | null | undefined): WaveGroup[] {
  const map = new Map<number, Task[]>()
  for (const t of board?.tasks ?? []) {
    const w = t.wave ?? 0
    if (!map.has(w)) map.set(w, [])
    map.get(w)!.push(t)
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([wave, tasks]) => ({ wave, tasks }))
}

export interface PendingItem {
  projectId: string
  projectName: string
  task: Task
  decision: Decision
}

/** 收集所有 answer===null 的待拍板决策（跨项目） */
export function collectPending(boards: Board[]): PendingItem[] {
  const out: PendingItem[] = []
  for (const b of boards) {
    for (const t of b.tasks ?? []) {
      for (const d of t.decisions ?? []) {
        if (d.answer === null || d.answer === undefined) {
          out.push({ projectId: b.project.id, projectName: b.project.name, task: t, decision: d })
        }
      }
    }
  }
  return out
}

export type ActivityWithProject = Activity & { projectId: string; projectName: string }

/** 合并各项目 activity，按时间倒序取前 limit 条 */
export function mergeActivity(boards: Board[], limit = 60): ActivityWithProject[] {
  const all: ActivityWithProject[] = boards.flatMap((b) =>
    (b.activity ?? []).map((a) => ({ ...a, projectId: b.project.id, projectName: b.project.name })),
  )
  all.sort((x, y) => (y.ts || '').localeCompare(x.ts || ''))
  return limit > 0 ? all.slice(0, limit) : all
}

/** 某任务相关的活动（抽屉用） */
export function activityOfTask(board: Board | null | undefined, taskId: string): Activity[] {
  return (board?.activity ?? [])
    .filter((a) => a.taskId === taskId)
    .sort((x, y) => (y.ts || '').localeCompare(x.ts || ''))
}

/** 风险任务：暂缓 / 有阻塞 / 有待拍板（风险面板用） */
export function riskTasks(board: Board | null | undefined): Task[] {
  return (board?.tasks ?? []).filter(
    (t) =>
      t.status === '暂缓' ||
      (t.deps?.blockedBy?.length ?? 0) > 0 ||
      !!t.blockReason ||
      (t.decisions ?? []).some((d) => d.answer === null || d.answer === undefined),
  )
}
