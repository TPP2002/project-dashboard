import type { SceneEvent, SceneFactory, SceneState } from '../../types'
import { attributes, svg } from '../../fx/svg'
import { ensureDefs } from '../../fx'
import { palette } from './palette'
import { createExhibits } from './exhibits'

/** W1 的两个世界共用测试台；W2/W3 只需替换各自 factory，不接触桥接与容器。 */
export function benchFactory(placeholder: string): SceneFactory {
  return (host, options) => {
    const defs = ensureDefs(host)
    const root = svg(host, 'g', { 'data-scene': 'bench', 'font-family': 'ui-monospace, Consolas, monospace' })
    svg(root, 'rect', { width: 1400, height: 520, fill: defs.url('sky') })
    svg(root, 'path', { d: 'M0 396Q350 382 700 398T1400 390V520H0Z', fill: palette.floor })
    svg(root, 'path', { d: 'M0 475Q380 446 740 470T1400 459V520H0Z', fill: palette.ink, opacity: .65 })
    const heading = svg(root, 'text', { x: 30, y: 107, fill: palette.project, 'font-size': 17 })
    heading.textContent = placeholder
    const summary = svg(root, 'text', { x: 30, y: 138, fill: palette.text, 'font-size': 14 })
    const tasks = svg(root, 'text', { x: 30, y: 161, fill: palette.muted, 'font-size': 12 })
    const status = svg(root, 'text', { x: 30, y: 184, fill: palette.project, 'font-size': 12 })
    const logTitle = svg(root, 'text', { x: 980, y: 101, fill: palette.muted, 'font-size': 12 })
    logTitle.textContent = 'LIVE EVENTS'
    const rows = Array.from({ length: 5 }, (_, i) => svg(root, 'text', { x: 980, y: 119 + i * 16, fill: palette.text, 'font-size': 11 }))
    const exhibits = createExhibits(root, { detail: options.detail, reducedMotion: options.reducedMotion })
    let state = options.state, reduced = options.reducedMotion, detail = options.detail
    let fingerprint = '', lastAction = 'STANDBY'
    const events: string[] = []
    // 画内只显示英文短语与数字；完整项目名、任务标题由容器中文 aria 描述。
    const ascii = (value: string) => value.replace(/[^\x20-\x7e]/g, '').slice(0, 28) || 'TASK'
    function setState(next: SceneState) {
      state = next
      const key = JSON.stringify(next)
      if (key === fingerprint) return
      fingerprint = key
      summary.textContent = `QUEUED ${next.queued.length}  ACTIVE ${next.active.length}  HOLD ${next.pending.length}  BLOCKED ${next.blocked.length}  DONE ${next.done.length}/${next.total}  ${next.percent}%`
      tasks.textContent = `PROJECT ${ascii(next.projectId)}  |  ${next.active.slice(0, 3).map(task => `${ascii(task.id)} ${task.percent}%`).join('  ') || 'READY'}`
      status.textContent = next.complete ? 'MISSION COMPLETE' : lastAction
    }
    function handleEvent(event: SceneEvent, animate: boolean) {
      const time = event.ts.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? '--:--:--'
      const value = event.kind === 'progress' ? ` ${event.percent}%` : ''
      lastAction = `${event.kind.toUpperCase()}${value}`
      events.unshift(`${time} ${lastAction} ${ascii(event.taskId)}${event.kind === 'done' && !animate ? ' COUNT' : ''}`)
      events.splice(5)
      rows.forEach((row, index) => { row.textContent = events[index] ?? '' })
      status.textContent = state.complete ? 'MISSION COMPLETE' : lastAction
    }
    function setHeight(height: 'standard' | 'compact') {
      host.setAttribute('viewBox', height === 'compact' ? '0 80 1400 360' : '0 0 1400 520')
    }
    setState(state)
    setHeight(options.height)
    attributes(root, { 'data-day-night': options.dayNight, 'data-sound-linked': String(options.sound.linked) })
    return {
      setState, handleEvent, setHeight,
      tick(dt, elapsed) { exhibits.update(dt, elapsed, { detail, reducedMotion: reduced }) },
      setDayNight(value) { attributes(root, { 'data-day-night': value }) },
      setDetail(value) { detail = value },
      setReducedMotion(value) { reduced = value },
      setSound(value) { attributes(root, { 'data-sound-linked': String(value.linked) }) },
      destroy() { exhibits.destroy(); root.remove() },
    }
  }
}

export const createScene: SceneFactory = benchFactory('FX BENCH')
