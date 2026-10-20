export type ContributionWeeks = 4 | 8 | 12
export type ContributionAction = 'create' | 'message' | 'claim' | 'progress' | 'join' | 'leave' | 'removeCollaborator' | 'unclaim' | 'park' | 'unpark' | 'done' | 'cancel' | 'reopen' | 'other'
export interface ContributionWeek { weekStart: string; completed: number; messages: number; ops: number }
export interface ContributionRange { from: string; to: string; weeks: number }
export interface ContributionTotals {
  completed: number; completedWithCollaborators: number; inProgress: number; activeMembers: number
  createdByMembers: number; createdOther: number; messages: number; aiOps: number; attributedOps: number
}
export interface ContributionMember {
  userId: string; name: string; role: 'owner' | 'member' | 'viewer' | null; unknownUser: boolean
  created: number; claimed: number; completedAsOwner: number; completedAsCollaborator: number
  inProgressAsOwner: number; inProgressAsCollaborator: number; messages: number; progressUpdates: number
  statusChanges: number; aiOps: number; ops: number; lastActiveAt: string | number | null; weekly: ContributionWeek[]
}
export interface ContributionUnattributed {
  messages: number; statusChanges: number; ops: number; weekly: ContributionWeek[]; completedWithoutMember: number
}
export interface ContributionRecent {
  ts: string | number | null; userId: string; name: string; action: ContributionAction
  taskId: string | null; taskTitle: string; viaAi?: true
}
interface ContributionBase { range: ContributionRange; totals: ContributionTotals; weekly: ContributionWeek[] }
export interface ContributionSummary extends ContributionBase { scope: 'summary' }
export interface ContributionFull extends ContributionBase {
  scope: 'full'; members: ContributionMember[]; unattributed: ContributionUnattributed
  membersWeekly: { userId: string; weekly: ContributionWeek[] }[]; recent: ContributionRecent[]; skipped: number
}
export type Contributions = ContributionFull | ContributionSummary

export function contributionsPath(projectId: string, weeks: ContributionWeeks): string {
  return `/api/collaboration/projects/${encodeURIComponent(projectId)}/contributions?weeks=${weeks}`
}
const labels: Record<ContributionAction, string> = {
  create: '建卡', message: '留言于', claim: '领取', progress: '更新进度', join: '加入协作', leave: '退出协作',
  removeCollaborator: '移出协作人', unclaim: '放弃认领', park: '暂缓', unpark: '复工', done: '收官', cancel: '作废', reopen: '重开', other: '操作了',
}
export function actionLabel(action: ContributionAction): string { return labels[action] }
export function doneSplit(member: Pick<ContributionMember, 'completedAsOwner' | 'completedAsCollaborator'>, maxCompleted: number): { owner: number; collaborator: number } {
  if (maxCompleted <= 0) return { owner: 0, collaborator: 0 }
  return { owner: member.completedAsOwner / maxCompleted * 100, collaborator: member.completedAsCollaborator / maxCompleted * 100 }
}
/** Negative index denotes the unsigned row; all named members cycle five tokens. */
export function memberColor(index: number): `--${string}` {
  return index < 0 ? '--chart-7' : `--chart-${index % 5 + 1}`
}
