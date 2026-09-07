import { attributes } from '../../fx/svg'
import type { LaunchFrame } from './sequence'
import type { Site } from './site'

const setText = (node: SVGElement, value: string) => { if (node.textContent !== value) node.textContent = value }

export function createScreen(site: Site, host: SVGSVGElement) {
  const screen = site.get('[data-screen]'), countdown = site.get('[data-countdown]'), missions = site.get('[data-missions]')
  const extra = site.get('[data-queue-extra]')
  return (frame: LaunchFrame, elapsed: number, reduced: boolean) => {
    const { state, phase } = frame
    const countdownText = frame.countdown === null ? '' : `T-00:${String(frame.countdown).padStart(2, '0')}`
    const hold = reduced || Math.floor(elapsed / 1000) % 2 === 0 ? 'HOLD' : 'GO?'
    const words = { READY: 'READY', ROLLOUT: 'ROLLOUT', FUEL: `FUEL ${Math.round(frame.fuel)}`, HOLD: hold,
      GO: frame.countdown === 10 ? 'GO' : countdownText, SCRUB: 'SCRUB', STANDBY: 'STANDBY',
      LIFTOFF: 'LIFTOFF', NOMINAL: 'NOMINAL', COMPLETE: 'MISSION COMPLETE' }
    const word = words[phase]
    setText(screen, word); attributes(screen, { 'font-size': word.length > 14 ? 9 : 11 })
    setText(countdown, phase === 'COMPLETE' ? '' : countdownText)
    setText(missions, `MISSIONS ${state.done.length}`)
    attributes(missions, { 'font-size': state.done.length > 999 ? 6 : 8 })
    setText(extra, frame.stock.length > 3 ? `+${frame.stock.length - 3}` : '')
    const action = phase === 'COMPLETE' ? '项目全部完成' : phase === 'HOLD' ? '等待拍板' : phase === 'SCRUB' ? '阻塞暂停'
      : phase === 'STANDBY' ? '暂时停工' : phase === 'LIFTOFF' ? '点火起飞' : phase === 'ROLLOUT' ? '转运上台'
      : frame.task ? `加注 ${Math.round(frame.fuel)}%` : '等待认领'
    attributes(host, { 'aria-label': `发射场：${state.queued.length} 枚待发射，${state.active.length} 枚施工，${action}，累计发射 ${state.done.length}` })
    attributes(site.root, { 'data-phase': phase, 'data-task-id': frame.task?.id ?? '', 'data-done-count': state.done.length })
  }
}
