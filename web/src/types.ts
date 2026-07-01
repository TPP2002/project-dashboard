// board.json 的前端 TS 视图。字段集对齐 core/boardSchema.cjs 与方案 §4。
// 统计（各状态计数/进度/矩阵/波次）一律读时派生，不在此类型中持久化（R9a）。

// 状态联合 = core STATUS 顺序（运行时值由 @core/boardSchema.cjs 提供，见 api/schema.ts）
export type Status =
  | '未开工' | '待开工' | '待拍板' | '已拍板' | '施工中'
  | '可复工' | '收官' | '已完工' | '暂缓' | '压轴'

export interface Decision {
  id: string
  question: string
  options: string[]
  recommended: string
  answer: string | null
  decidedAt: string | null
}

export interface Deps {
  dependsOn?: string[]
  blockedBy?: string[]
  relatedTasks?: string[]
}

export interface Tests {
  total?: number
  passing?: number
  mustFailFirst?: number
}

export interface TaskDates {
  design?: string | null
  start?: string | null
  done?: string | null
}

// docs 兼容"纯路径字符串"与"{title,path}"两种形态
export type DocRef = string | { title?: string; path: string }

export interface Task {
  id: string
  title: string
  description?: string
  status: Status
  percent?: number
  wave?: number
  dates?: TaskDates
  gitBranch?: string[]
  worktree?: string[]
  prNumbers?: number[]
  commitShas?: string[]
  decisions?: Decision[]
  deps?: Deps
  tests?: Tests
  bot?: Record<string, unknown>
  typecheck?: boolean
  blockReason?: string
  nextMilestone?: string
  parkedNote?: string
  forbiddenZones?: string[]
  fileScope?: string[]
  docs?: DocRef[]
}

export interface Activity {
  ts: string
  author?: string
  type?: string
  text?: string
  taskId?: string | null
}

export interface ProjectMeta {
  id: string
  name: string
  mainRepo?: string
  forbiddenZones?: string[]
  createdAt?: string
  updatedAt?: string
}

export interface Board {
  schemaVersion: string
  project: ProjectMeta
  tasks: Task[]
  activity?: Activity[]
}

// GET /api/projects 的清单项（前端只依赖 id/name；统计一律从 board 读时派生）
export interface ProjectSummary {
  id: string
  name: string
  mainRepo?: string
  updatedAt?: string
}
