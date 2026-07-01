/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

// 状态枚举 / emoji 的单一真相源经 vite 虚拟模块注入（见 vite.config.ts 的 boardSchemaVirtualPlugin，
// Node 端 require core/boardSchema.cjs 后内联成 ESM）。这里只补 TS 类型。
declare module 'virtual:board-schema' {
  export const SCHEMA_VERSION: string
  export const STATUS: string[]
  export const STATUS_EMOJI: Record<string, string>
  export function emojiFor(status: string): string
}
