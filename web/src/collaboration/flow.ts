import type { Invite, MemberTask, Session } from './types'

export function sessionView(session: Session | null): 'loading' | 'local' | 'login' | 'owner' | 'member' | 'viewer' {
  if (!session) return 'loading'
  if (session.mode === 'local') return 'local'
  return session.user?.role ?? 'login'
}

/** Called before the owner hash router is imported. The secret never enters router history. */
export function consumeInvite(location: Pick<Location, 'href'>, history: Pick<History, 'replaceState' | 'state'>): string {
  const url = new URL(location.href)
  const fragment = new URLSearchParams(url.hash.slice(1).replace(/^\//, ''))
  const key = fragment.has('invite') ? 'invite' : url.pathname === '/invite' && fragment.has('token') ? 'token' : null
  if (!key) return ''
  const token = fragment.get(key) ?? ''
  fragment.delete(key)
  url.hash = fragment.toString()
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
  return token
}
export function inviteLink(origin: string, token: string): string {
  return `${origin}/#invite=${encodeURIComponent(token)}`
}
export function inviteState(invite: Invite, now = Date.now()): string {
  if (invite.revoked) return '已撤销'
  if (Date.parse(invite.expiresAt) <= now) return '已过期'
  if (invite.uses >= invite.maxUses) return '已用完'
  return '可使用'
}
export function canClaim(task: MemberTask): boolean {
  return !task.assigneeUserId && ['未开工', '待开工', '可复工', '已拍板'].includes(task.status)
}
export function ownsTask(task: MemberTask, userId: string): boolean {
  return task.assigneeUserId === userId
}
export function progressBody(percent: number, note: string): { percent: number; note?: string } {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('进度须为 0 到 100')
  const text = note.trim()
  if (text.length > 500) throw new Error('留言请控制在 500 字以内')
  return { percent, ...(text ? { note: text } : {}) }
}
