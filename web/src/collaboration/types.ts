export interface User {
  id: string
  username: string
  displayName: string
  role: 'owner' | 'member'
  projectIds: string[]
  disabled: boolean
}
export interface Session {
  ok: true
  mode: 'local' | 'collaboration'
  user: User | null
  csrfToken?: string
}
export interface Project { id: string; name: string }
export interface MemberTask {
  id: string
  title: string
  plainTitle?: string
  description?: string
  status: string
  percent?: number
  assigneeUserId?: string | null
  assigneeName?: string | null
  builder?: string | null
}
export interface Invite {
  id: string; projectIds: string[]; expiresAt: string; maxUses: number; uses: number; revoked: boolean
}
export interface Device { id: string; label: string; createdAt: string; revoked: boolean; expiresAt?: string }
export interface AdminData { ok: true; users: User[]; invites: Invite[]; devices: Device[] }
