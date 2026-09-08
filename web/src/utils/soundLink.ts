import { onBoardEvent } from '@/utils/boardEvents'
import { playSound } from '@/utils/sound'

const unsubscribe = onBoardEvent(event => {
  if (event.kind === 'pending') void playSound('ding')
  else if (event.kind === 'done') void playSound('dong')
  else if (event.kind === 'block' || event.kind === 'park') void playSound('low')
})

// 热替换时移除旧订阅，避免同一事件重复响。
if (import.meta.hot) import.meta.hot.dispose(unsubscribe)
