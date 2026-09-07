import { appearance } from '@/utils/appearance'
import { onBoardEvent, findCardElement } from '@/utils/boardEvents'
import { burstConfettiAt } from '@/utils/confetti'
import { reducedMotion } from '@/utils/iconMotion'
import { openCycle, readStops } from '@/utils/spectrum'

let lastBurstAt = -Infinity

const unsubscribe = onBoardEvent(event => {
  if (event.kind !== 'done' || !appearance.confetti || reducedMotion.value) return
  const el = findCardElement(`${event.projectId}:${event.taskId}`)
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0
    || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return

  // 按实际播放时刻限频；略过的事件仍由看板照常计数，不排队补放。
  const now = performance.now()
  if (now - lastBurstAt < 1000) return
  const colors = openCycle(readStops('--spec-active'))
  if (!colors.length) return
  lastBurstAt = now
  burstConfettiAt(rect, { count: appearance.confettiCount, colors })
})

// 开发时热替换也只保留一个订阅，避免一次完工重复播放。
if (import.meta.hot) import.meta.hot.dispose(unsubscribe)
