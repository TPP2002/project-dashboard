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

declare module 'virtual:board-schema' {
  export const SCHEMA_VERSION: string
  export const STATUS: string[]
  export const STATUS_EMOJI: Record<string, string>
  export function emojiFor(status: string): string
}
