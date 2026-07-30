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

/** 收集所有已拍板决策（answer !== null），按 decidedAt 倒序 */
export function collectDecided(boards: Board[]): PendingItem[] {
  const out: PendingItem[] = []
  for (const b of boards) {
    for (const t of b.tasks ?? []) {
      for (const d of t.decisions ?? []) {
        if (d.answer !== null && d.answer !== undefined) {
          out.push({ projectId: b.project.id, projectName: b.project.name, task: t, decision: d })
        }
      }
    }
  }
  out.sort((a, b) => (b.decision.decidedAt || '').localeCompare(a.decision.decidedAt || ''))
  return out
}

/** 收集"已拍板但未落地"的决策——需要新对话去执行 */
export function collectUnlanded(boards: Board[]): PendingItem[] {
  return collectDecided(boards).filter((it) => !(it.decision as any).landed)
}

export interface UnlandedTask {
  projectId: string
  projectName: string
  task: Task
  decisions: Decision[] // 该任务下所有"已拍板未落地"的决策
}

/**
 * 按【任务】聚合待落地决策——治"一个决策一个对话"的错误粒度。
 * 决策从属于任务:P10 的 d1/d2/d3 是同一任务的三个问题,应打包给一个对话,
 * 那对话 claim 一次 P10、带着三个答案一起施工,而不是开三个对话各自 claim 打架。
 */
export function collectUnlandedByTask(boards: Board[]): UnlandedTask[] {
  const out: UnlandedTask[] = []
  for (const b of boards) {
    for (const t of b.tasks ?? []) {
      const ds = (t.decisions ?? []).filter(
        (d) => d.answer !== null && d.answer !== undefined && !(d as any).landed,
      )
      if (ds.length) {
        out.push({ projectId: b.project.id, projectName: b.project.name, task: t, decisions: ds })
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

// ==================== 每日成果（Daily Output） ====================
// 完工日口径：卡当前状态 ∈ DONE_STATUSES 才计入；完工日优先取该卡活动流里最后一条
// type='done' 事件的精确时间戳（转【本地时区】日期），无 done 事件时兜底 dates.done。
// 为什么不直接用 dates.done：CLI 旧版 today() 用 UTC 日期，北京凌晨完工会被记成前一天；
// activity ts 是精确 ISO 时刻，转本地日永远准确。

/** ISO 时间戳 → 本地日 YYYY-MM-DD（无效输入返回 ''） */
export function localDay(ts: string | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 今天的本地日 YYYY-MM-DD */
export function todayLocal(): string {
  return localDay(new Date())
}

export interface DoneRecord {
  projectId: string
  projectName: string
  task: Task
  /** 完工归属日（本地时区 YYYY-MM-DD） */
  day: string
  /** 精确完工时刻（activity done 事件的 ISO ts），无 done 事件时为 null */
  ts: string | null
}

/** 收集所有已完工卡的完工记录（跨项目）；无任何完工日期线索的卡收进 undated */
export function collectDoneRecords(boards: Board[]): { records: DoneRecord[]; undated: number } {
  const records: DoneRecord[] = []
  let undated = 0
  for (const b of boards) {
    // 每任务最后一条 done 活动的 ts
    const lastDone = new Map<string, string>()
    for (const a of b.activity ?? []) {
      if (a.type === 'done' && a.taskId && a.ts) {
        const prev = lastDone.get(a.taskId)
        if (!prev || a.ts > prev) lastDone.set(a.taskId, a.ts)
      }
    }
    for (const t of b.tasks ?? []) {
      if (!DONE_STATUSES.has(t.status)) continue
      const ts = lastDone.get(t.id) ?? null
      const day = ts ? localDay(ts) : (t.dates?.done || '')
      if (!day) { undated++; continue }
      records.push({ projectId: b.project.id, projectName: b.project.name, task: t, day, ts })
    }
  }
  // 同日内按精确时刻倒序（无 ts 的排后面）
  records.sort((a, z) => z.day.localeCompare(a.day) || (z.ts || '').localeCompare(a.ts || ''))
  return { records, undated }
}

/** 按日聚合完工数：day → 该日完工记录列表（倒序遍历安全，Map 保插入序=日期倒序） */
export function groupDoneByDay(records: DoneRecord[]): Map<string, DoneRecord[]> {
  const m = new Map<string, DoneRecord[]>()
  for (const r of records) {
    if (!m.has(r.day)) m.set(r.day, [])
    m.get(r.day)!.push(r)
  }
  return m
}

/** 某日（本地日）各类型活动计数：day → { done: 3, decide: 2, ... }（当日明细的动作统计） */
export function activityCountsOfDay(boards: Board[], day: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const b of boards) {
    for (const a of b.activity ?? []) {
      if (!a.ts || localDay(a.ts) !== day) continue
      const ty = a.type || 'note'
      out[ty] = (out[ty] || 0) + 1
    }
  }
  return out
}

/** 连续产出天数（今天没有完工则从昨天起算；遇到 0 完工的一天即停） */
export function doneStreak(byDay: Map<string, DoneRecord[]>): number {
  const d = new Date()
  if (!byDay.get(localDay(d))?.length) d.setDate(d.getDate() - 1) // 今天还没出货，从昨天起算
  let streak = 0
  while (byDay.get(localDay(d))?.length) {
    streak++
    d.setDate(d.getDate() - 1)
  }
  return streak
}
