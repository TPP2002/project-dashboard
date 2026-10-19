import type { MemberTask, TaskAction, Collaborator } from './types'

const laneNames = ['待开工', '待拍板', '施工中', '待收单', '暂缓', '已完工', '已作废'] as const
type Lane = typeof laneNames[number]
export function laneOf(status: string): Lane {
  return laneNames.includes(status as Lane) ? status as Lane : '待开工'
}
export function groupLanes<T extends { status: string }>(tasks: readonly T[]): { name: Lane; tasks: T[] }[] {
  return laneNames.map(name => ({ name, tasks: tasks.filter(task => laneOf(task.status) === name) }))
}
type ActionTask = Pick<MemberTask, 'actions'>
export function cardPrimaryAction(task: ActionTask): 'claim' | 'progress' | null {
  return task.actions?.includes('claim') ? 'claim' : task.actions?.includes('progress') ? 'progress' : null
}
export interface DrawerAction {
  action: TaskAction
  label: string
  kind: 'primary' | 'normal' | 'danger'
  needs: 'none' | 'reason' | 'progress' | 'confirm'
}
const buttons: DrawerAction[] = [
  { action: 'claim', label: '领取', kind: 'primary', needs: 'none' },
  { action: 'progress', label: '更新进度', kind: 'primary', needs: 'progress' },
  { action: 'done', label: '收官', kind: 'normal', needs: 'confirm' },
  { action: 'park', label: '暂缓', kind: 'normal', needs: 'reason' },
  { action: 'unpark', label: '复工', kind: 'normal', needs: 'reason' },
  { action: 'unclaim', label: '放弃认领', kind: 'normal', needs: 'reason' },
  { action: 'cancel', label: '作废', kind: 'danger', needs: 'reason' },
  { action: 'reopen', label: '重开', kind: 'normal', needs: 'reason' },
  { action: 'join', label: '加入协作', kind: 'primary', needs: 'none' },
  { action: 'leave', label: '退出协作', kind: 'normal', needs: 'confirm' },
]
export function drawerActions(task: ActionTask): DrawerAction[] {
  return buttons.filter(button => task.actions?.includes(button.action)).map(button => ({ ...button }))
}
export function actionPath(projectId: string, taskId: string, action: TaskAction): string {
  return `/api/collaboration/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/${action === 'removeCollaborator' ? 'remove-collaborator' : action}`
}
export type TeamTask = Pick<MemberTask, 'assigneeUserId' | 'assigneeName' | 'aiWork' | 'collaborators' | 'dates'>
export interface Lead { userId: string | null; name: string; ai: boolean }
/** max counts the lead, matching mockup 07: one lead + two collaborators + N. */
export function avatarStack(task: TeamTask, max = 3): { lead: Lead | null; shown: Collaborator[]; more: number } {
  const lead = task.assigneeUserId || task.assigneeName
    ? { userId: task.assigneeUserId || null, name: task.assigneeName || '主负责人', ai: false }
    : task.aiWork ? { userId: null, name: 'AI', ai: true } : null
  const people = task.collaborators ?? []
  const capacity = Math.max(0, Math.floor(max) - (lead ? 1 : 0))
  const shown = people.slice(0, capacity)
  return { lead, shown, more: people.length - shown.length }
}
export function relationLabel(task: TeamTask, userId: string): string {
  const { lead } = avatarStack(task)
  const people = task.collaborators ?? []
  const mine = !!userId && task.assigneeUserId === userId
  const name = mine ? '我' : lead?.ai ? 'AI 施工' : lead?.name || '未领取'
  if (!people.length) return name
  if (mine) return `我 + ${people.length} 人协作`
  if (userId && people.some(person => person.userId === userId)) return `${name} · 我协作`
  if (people.length === 1) return `${name} · ${people[0]!.name}协作`
  return `${name} + ${people.length} 人`
}
export function slots(task: TeamTask): number { return Math.min(5, task.collaborators?.length ?? 0) }
export function passwordProblem(newPassword: string, confirm: string): string {
  if (newPassword.length < 6 || newPassword.length > 128) return '密码需要 6 到 128 个字符'
  return newPassword === confirm ? '' : '两次输入的密码不一致'
}
export function reasonProblem(text: string): string {
  return text.trim().length < 1 || text.trim().length > 500 ? '理由请填写 1 到 500 个字' : ''
}
export function titleProblem(title: string): string {
  return title.trim().length < 1 || title.trim().length > 200 ? '标题请填写 1 到 200 个字' : ''
}
export function messageProblem(text: string): string {
  return text.trim().length < 1 || text.trim().length > 2000 ? '留言请填写 1 到 2000 个字' : ''
}
