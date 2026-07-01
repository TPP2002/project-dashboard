/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

// 复用 core 零依赖底座的单一真相源（状态枚举 / emoji）。
// 运行时由 vite alias '@core' → ../core 解析；这里只补 TS 类型（.cjs 无 .d.ts）。
declare module '@core/boardSchema.cjs' {
  export const SCHEMA_VERSION: string
  export const STATUS: string[]
  export const STATUS_EMOJI: Record<string, string>
  export function emojiFor(status: string): string
  export function emptyBoard(project: { id: string; name?: string; mainRepo?: string }): unknown
  export function validate(board: unknown): { ok: boolean; errors: string[] }
  export function assertValid(board: unknown): void
}
