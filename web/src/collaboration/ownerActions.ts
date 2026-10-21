import { aiWork, memberActions } from 'virtual:collaboration-rules'
import type { RuleTask } from 'virtual:collaboration-rules'
import type { TaskAction, User } from './types'
import { drawerActions } from './board'

type OwnerTask = RuleTask & { percent?: number }

export function ownerCardAction(task: RuleTask, user: Readonly<User> | null): 'claim' | 'progress' | 'join' | null {
  if (!user || task.aiWork || aiWork(task)) return null
  const actions = memberActions(task, user)
  if (actions.includes('claim')) return 'claim'
  const participating = task.assigneeUserId === user.id || task.collaborators?.some(person => person.userId === user.id)
  if (participating && actions.includes('progress')) return 'progress'
  return actions.includes('join') ? 'join' : null
}

export function ownerDrawerActions(task: OwnerTask, user: Readonly<User> | null) {
  const entries = drawerActions({ actions: memberActions(task, user) })
  const progressIndex = entries.findIndex(entry => entry.action === 'progress')
  const doneIndex = entries.findIndex(entry => entry.action === 'done')
  if (task.percent === 100 && progressIndex !== -1 && doneIndex !== -1) {
    const [done] = entries.splice(doneIndex, 1)
    entries.splice(progressIndex, 0, done!)
  }
  return entries
}

export function ownerCardActions(task: OwnerTask, user: Readonly<User> | null): TaskAction[] {
  const primary = ownerCardAction(task, user)
  if (primary === 'progress' && task.percent === 100 && memberActions(task, user).includes('done')) {
    return ['done', 'progress']
  }
  return primary ? [primary] : []
}

export function ownerHiddenLegacyActions(user: Readonly<User> | null): TaskAction[] {
  return user?.role === 'owner' ? ['park', 'unpark', 'cancel', 'reopen'] : []
}
