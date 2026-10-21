import { aiWork, memberActions } from 'virtual:collaboration-rules'
import type { RuleTask } from 'virtual:collaboration-rules'
import type { User } from './types'
import { drawerActions } from './board'

export function ownerCardAction(task: RuleTask, user: Readonly<User> | null): 'claim' | 'progress' | 'join' | null {
  if (!user || task.aiWork || aiWork(task)) return null
  const actions = memberActions(task, user)
  if (actions.includes('claim')) return 'claim'
  const participating = task.assigneeUserId === user.id || task.collaborators?.some(person => person.userId === user.id)
  if (participating && actions.includes('progress')) return 'progress'
  return actions.includes('join') ? 'join' : null
}

export function ownerDrawerActions(task: RuleTask, user: Readonly<User> | null) {
  return drawerActions({ actions: memberActions(task, user) })
}
