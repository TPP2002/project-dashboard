declare module 'virtual:collaboration-rules' {
  export interface RuleTask {
    status?: string
    builder?: string
    gitBranch?: string[]
    prNumbers?: number[]
    commitShas?: string[]
    decisions?: { answer?: unknown }[]
    collaborators?: { userId: string }[]
    assigneeUserId?: string | null
    createdByUserId?: string | null
    blockReason?: string | null
    deps?: { blockedBy?: string[] }
    aiWork?: boolean
  }
  export function memberActions(task: RuleTask, user: Readonly<import('./collaboration/types').User> | null): import('./collaboration/types').TaskAction[]
  export function aiWork(task: RuleTask): boolean
}
