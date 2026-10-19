export interface User {
  id: string
  username: string
  displayName: string
  role: 'owner' | 'member' | 'viewer'
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
export type TaskAction = 'note' | 'join' | 'leave' | 'removeCollaborator' | 'progress' | 'claim' | 'unclaim' | 'park' | 'unpark' | 'done' | 'cancel' | 'reopen'
export interface Collaborator { userId: string; name: string; joinedAt: string }
export interface TaskMessage { ts: string | null; author: string | null; text: string; userId: string | null }
export interface MemberTask {
  id: string
  title: string
  plainTitle?: string
  description?: string
  status: string
  percent?: number
  assigneeUserId?: string | null
  assigneeName?: string | null
  actions?: TaskAction[]
  messages?: TaskMessage[]
  collaborators?: Collaborator[]
  aiWork?: boolean
  blockReason?: string | null
  cancelReason?: string | null
  createdByUserId?: string | null
  dates?: { design?: string | null; start?: string | null; done?: string | null }
}
export interface Invite {
  role?: 'member' | 'viewer'
  id: string; projectIds: string[]; expiresAt: string; maxUses: number; uses: number; revoked: boolean
}
export interface Device { id: string; label: string; createdAt: string; revoked: boolean; expiresAt?: string }
export interface Reset { id: string; userId: string; expiresAt: string; used: boolean }
export interface AdminData { ok: true; users: User[]; invites: Invite[]; devices: Device[]; resets: Reset[] }
