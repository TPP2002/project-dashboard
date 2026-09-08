// board.json 的前端 TS 视图。字段集对齐 core/boardSchema.cjs 与方案 §4。
// 统计（各状态计数/进度/矩阵/波次）一律读时派生，不在此类型中持久化（R9a）。

// 状态联合 = core STATUS 顺序（运行时值由 @core/boardSchema.cjs 提供，见 api/schema.ts）
export type Status =
  | '未开工' | '待开工' | '待拍板' | '已拍板' | '施工中'
  | '可复工' | '收官' | '已完工' | '暂缓' | '压轴' | '已作废'

export type DecisionInfoField = 'background' | 'optionPros' | 'recommendReason'

export interface Decision {
  id: string
  question: string
  options: string[]
  recommended: string
  answer: string | null
  decidedAt: string | null
  background?: string
  optionPros?: Record<string, string>
  recommendReason?: string
  infoRequestedAt?: string
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

/** 施工成本登记(CLI `cost` 命令写入;BOARD-COST-MONITOR 0901) */
export interface CostEntry {
  date: string
  author?: string
  /** 模型档 → 个数,如 { sonnet: 3, opus: 1 } 或主对话直施的 { fable: 1 } */
  agents?: Record<string, number>
  /** 可选:自报的大约 token 数 */
  tokens?: number
  note?: string
}
export interface TaskCost {
  entries?: CostEntry[]
}

export interface Task {
  /** 任务卡编号:模型用来定位,如 NUMERIC-ROUND-FACADE-UNIFY */
  id: string
  /** 任务详细说明:给模型读的技术描述 */
  title: string
  /** 标题:一句人话,给不写代码的负责人看。老卡可能没有,界面要回落到 title */
  plainTitle?: string
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
  /** 解除暂缓的依据(CLI unpark --reason 写入;卡走到「可复工」后要在卡面上看得见) */
  unparkReason?: string
  /** 解除暂缓的日期(YYYY-MM-DD) */
  unparkedAt?: string
  /** 放弃认领的理由(CLI unclaim --reason 写入):这卡为什么退回来、没人接了 */
  unclaimReason?: string
  /** 放弃认领的日期(YYYY-MM-DD) */
  unclaimedAt?: string
  /** 作废的理由(CLI cancel --reason 写入):这活为什么不做了 */
  cancelReason?: string
  /** 作废的日期(YYYY-MM-DD) */
  cancelledAt?: string
  /** 重开的理由(CLI reopen --reason 写入):结了案的卡为什么又要做 */
  reopenReason?: string
  /** 重开的日期(YYYY-MM-DD) */
  reopenedAt?: string
  forbiddenZones?: string[]
  fileScope?: string[]
  docs?: DocRef[]
  /** CLI progress 时更新的进度时间戳（施工中卡的"多久没动了"提醒用） */
  lastProgressAt?: string
  /** 施工成本登记(每卡用了哪些 agent/模型档) */
  cost?: TaskCost
  /** 建议施工档位(建卡时由梳理对话按路由表标注,如 "sonnet·低" / "fable·max") */
  modelHint?: string
}

export interface Activity {
  ts: string
  author?: string
  type?: string
  text?: string
  taskId?: string | null
  kind?: string
  did?: string
  missing?: DecisionInfoField[]
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

// GET /api/projects 的清单项（含可选项目色/图标；统计一律从 board 读时派生）
export interface ProjectSummary {
  id: string
  name: string
  color?: string
  icon?: string
  mainRepo?: string
  updatedAt?: string
}
