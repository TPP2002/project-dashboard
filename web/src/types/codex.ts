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
  /** 'stalled' = 状态说还在跑，但已经联系不上（进程没了/早该收工/长时间没动静）。 */
  liveness?: 'running' | 'stalled' | 'finished'
  stalledReason?: string | null
  /** 三条失联判据里命中的是哪一条。前两条是铁证,'silent' 是软判据。 */
  stalledEvidence?: 'process-gone' | 'overdue' | 'silent' | null
  /** 是否**确定**已经死了(只有两条铁证才 true)。复派闸只认这个,软判据不许放行。 */
  confirmedDead?: boolean
  lastActivityAt?: string | null
}

export interface Acceptance {
  id: string
  kind?: string
  target?: string
  note?: string
  required?: boolean
  passed?: boolean
  exitCode?: number | null
}
export interface SelfReport { status?: string; summary?: string }
export interface ChatEntry { at?: string; direction: 'out' | 'in'; text: string }

export interface JobDetail extends JobSummary {
  goal: string | null
  acceptance: Acceptance[]
  plainSummary: string | null
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
  stalled: number
  rejectedJobs: Array<{ slug: string; title: string; reason: string }>
  stalledJobs: Array<{
    slug: string; title: string; reason: string
    lastActivityAt: string | null; dispatchedAt: string | null
  }>
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
