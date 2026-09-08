/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

// 状态枚举 / emoji 的单一真相源经 vite 虚拟模块注入（见 vite.config.ts 的 boardSchemaVirtualPlugin，
// Node 端 require core/boardSchema.cjs 后内联成 ESM）。这里只补 TS 类型。
// 自动生成物判据的单一真相源 = core/generatedArtifacts.cjs，同样经虚拟模块注入。
declare module 'virtual:generated-artifacts' {
  export const GENERATED_ARTIFACT_PATTERNS: RegExp[]
  export function isGeneratedArtifact(scopeEntry: string): boolean
}

// 「这张卡此刻还算不算数」的判据，单一真相源 = core/taskSignal.cjs（同样经虚拟模块注入）。
declare module 'virtual:task-signal' {
  import type { Board, Task } from '@/types'

  export const SETTLED_STATUSES: string[]
  export const PARKED_STATUS: string
  export const BUILDING_STATUS: string

  export interface BoardIndex {
    settledById: Map<string, boolean>
    lastActivityById: Map<string, string>
  }
  export interface BlockedItem {
    projectId: string
    projectName: string
    task: Task
    /** 还没完工的上游卡号（已完工的上游不列——它已经不挡路了） */
    blockers: string[]
  }
  export interface ParkedItem {
    projectId: string
    projectName: string
    task: Task
  }
  export interface StalestItem {
    projectId: string
    projectName: string
    task: Task
    /** 最后一次有动静的时刻（ISO） */
    since: string
    hours: number
  }
  export interface OverviewSignal {
    blocked: BlockedItem[]
    parked: ParkedItem[]
    building: number
    stalest: StalestItem | null
  }
  export interface OccupancyHolder {
    id: string
    title: string
    plainTitle?: string
    status: string
    settled: boolean
  }
  export interface OccupancyRow {
    v: string
    tasks: OccupancyHolder[]
    conflict: boolean
    generated: boolean
  }

  export function isSettled(task: Task | null | undefined): boolean
  export function isParked(task: Task | null | undefined): boolean
  export function isActive(task: Task | null | undefined): boolean
  export function isOccupying(task: Task | null | undefined): boolean
  export function indexBoard(board: Board | null | undefined): BoardIndex
  export function unfinishedBlockers(task: Task, index: BoardIndex): string[]
  export function isBlocked(task: Task, index: BoardIndex): boolean
  export function isUnblocked(task: Task, index: BoardIndex): boolean
  export function lastTouchedAt(task: Task, index: BoardIndex): string | null
  export function overviewSignal(boards: Board[], opts?: { now?: number }): OverviewSignal
  export function occupancy(
    tasks: Task[],
    field: 'gitBranch' | 'worktree' | 'fileScope',
    opts?: { includeDone?: boolean; isGenerated?: (value: string) => boolean },
  ): OccupancyRow[]
  export function hasAcceptanceEvidence(tasks: Task[]): boolean
}

// 决策落地判据的单一真相源 = core/decisionLanding.cjs。
declare module 'virtual:decision-landing' {
  import type { Task, Decision } from '@/types'

  export function isAnswered(decision: Decision | null | undefined): boolean
  export function isTerminal(task: Task | null | undefined): boolean
  export function isUnlanded(task: Task, decision: Decision): boolean
  export function isPresumedLanded(task: Task, decision: Decision): boolean
  export function unlandedOf(task: Task | null | undefined): Decision[]
  export function presumedLandedOf(task: Task | null | undefined): Decision[]
}

declare module 'virtual:board-schema' {
  export const SCHEMA_VERSION: string
  export const STATUS: string[]
  export const STATUS_EMOJI: Record<string, string>
  export function emojiFor(status: string): string
}
