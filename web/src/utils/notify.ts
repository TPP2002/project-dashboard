import router from '@/router'
import { useBoardStore } from '@/stores/board'
import { appearance } from '@/utils/appearance'
import { onBoardEvent } from '@/utils/boardEvents'
import { inQuietHours, shouldThrottle } from '@/utils/soundRules'
import { humanTitle } from '@/utils/taskTitle'

const lastByTag = new Map<string, number>()
const titles = { pending: '有新的待拍板', done: '有卡完工', block: '有卡被卡住' } as const

const unsubscribe = onBoardEvent(event => {
  if (!appearance.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const kind = event.kind === 'park' ? 'block' : event.kind
  if (kind !== 'pending' && kind !== 'done' && kind !== 'block') return
  if (!appearance.notifyEvents[kind]) return
  const local = new Date()
  const hm = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`
  if (inQuietHours(hm, appearance.quietStart, appearance.quietEnd)) return

  const tag = `${event.projectId}:${event.taskId}:${event.kind}`
  const now = performance.now()
  for (const [key, last] of lastByTag) {
    if (!shouldThrottle(last, now)) lastByTag.delete(key)
  }
  if (shouldThrottle(lastByTag.get(tag), now)) return
  const store = useBoardStore()
  const board = store.boards[event.projectId]
  const task = board?.tasks.find(item => item.id === event.taskId)
  const projectName = board?.project.name ?? store.projects.find(item => item.id === event.projectId)?.name ?? event.projectId
  // 后台页也要通知；不能沿用提示音对文档可见性的限制。
  const notification = new Notification(`${titles[kind]} · ${projectName}`, {
    body: task ? humanTitle(task) : event.taskId, tag,
  })
  lastByTag.set(tag, now)
  notification.onclick = () => {
    window.focus()
    if (kind === 'pending') {
      store.centerScopeAll = true
      void router.push('/approvals').catch(error => console.error('打开待拍板中心失败', error))
    } else {
      store.selectProject(event.projectId)
      store.openTask(event.taskId, event.projectId)
    }
    notification.close()
  }
})

if (import.meta.hot) import.meta.hot.dispose(() => { unsubscribe(); lastByTag.clear() })
