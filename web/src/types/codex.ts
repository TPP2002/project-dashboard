export interface JobSummary {
  slug: string
  title: string
  taskId: string | null
  dispatchedAt: string | null
  running: boolean
  collected: boolean
  passed: boolean | null
  exitCode: number | null
  threadId?: string
  rejectionReason?: string
}

export interface Acceptance { id: string; required?: boolean; passed?: boolean; exitCode?: number | null }
export interface SelfReport { status?: string; summary?: string }
export interface ChatEntry { at?: string; direction: 'out' | 'in'; text: string }

export interface JobDetail extends JobSummary {
  acceptance: Acceptance[]
  selfReport: SelfReport | null
  chat: ChatEntry[]
  tail: string
}

export interface LinkedJob { slug: string; title: string }
export interface SessionSummary {
  sessionId: string
  startedAt: string | null
  cwd: string
  project: string
  active: boolean
  lastActivityAt: string | null
  sizeBytes: number
  lastOrdinal: number | null
  tokensUsed: number | null
  model: string
  reasoningEffort: string
  originator: string | null
  cliVersion: string | null
  job?: LinkedJob
}

export interface SessionEvent {
  timestamp: string | null
  ordinal: number | null
  outerType: string
  type: string
  role?: string
  text?: string
  toolName?: string
  command?: string
  summary?: string
}

export interface SessionDetail extends SessionSummary {
  sessionMeta: Record<string, unknown> | null
  events: SessionEvent[]
}

export interface QuotaSnapshot {
  rate_limits: {
    primary?: { used_percent?: number; window_minutes?: number; resets_at?: number }
    secondary?: unknown
    credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string }
    plan_type?: string
  } | null
  sampledAt: string | null
  usedPercent: number | null
  band: 'green' | 'yellow' | 'red' | 'unknown'
  resetsAtLocal: string | null
}

export interface CodexReport {
  dispatched: number
  passed: number
  rejected: number
  running: number
  tokensUsed: number
  quotaUsedPercent: number | null
  quotaBand: 'green' | 'yellow' | 'red' | 'unknown'
  lastActivityAt: string | null
  rejectedJobs: Array<{ slug: string; title: string; reason: string }>
}

export interface CodexUsage {
  byDay: Array<{ date: string; tokens: number; sessions: number; projects: Record<string, number> }>
  byProject: Array<{ project: string; tokens: number; sessions: number }>
  totals: { tokens: number; sessions: number }
  selected: { project: string; tokens: number; sessions: number; byDay: Array<{ date: string; tokens: number }> }
}

export interface CombinedUsage {
  claudeTokens: number
  codexTokens: number
  totalTokens: number
  savingsEstimateUsd: number | null
}
