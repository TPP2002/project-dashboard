import { attributes, clamp, smooth } from '../../fx/svg'
import { PAD_X, ROCKET_Y } from './layout'
import type { Site } from './site'
import type { LaunchFrame } from './sequence'
import { bindSurfaces } from './surfaces'

export function createAssembly(site: Site) {
  const pad = site.get('[data-pad-rocket]'), hull = site.get('[data-rocket]', pad)
  const arms = site.all('[data-arm]'), clamps = site.all<SVGGElement>('[data-clamp]')
  const liquid = site.get('[data-liquid]'), label = site.get('[data-level-label]'), elevator = site.get('[data-elevator]')
  const lamp = site.get('[data-tower-lamp]'), flag = site.get('[data-flag]'), monument = site.get('[data-monument]')
  const sky = site.get('[data-sky-dark]'), puddles = site.get('[data-puddles]'), cloud = site.get('[data-storm-cloud]')
  const stockLabels = site.stockSlots.map(slot => site.get('.serial', slot))
  const padSerial = site.get('.serial', pad), rolloutSerial = site.get('.serial', site.get('[data-rollout-rocket]'))
  const waitingSerial = site.get('.serial', site.get('[data-waiting-rocket]'))
  const syncClips = bindSurfaces(site)
  let lastSignal = '', lastFrost = -1
  const serialText = (node: SVGElement, value: string) => {
    if (node.textContent !== value) node.textContent = value
    attributes(node, { 'font-size': value.length > 5 ? 3.8 : value.length > 3 ? 5.5 : 8, textLength: value.length > 3 ? 19 : 12, lengthAdjust: 'spacingAndGlyphs' })
  }
  return (frame: LaunchFrame, elapsed: number, reduced: boolean) => {
    const { phase, fuel, flightAge, dockAge } = frame
    const signal = phase === 'HOLD' ? 'amber' : phase === 'SCRUB' ? 'red' : 'cyan'
    if (lastSignal !== signal) { lastSignal = signal; site.root.style.setProperty('--launch-signal', `var(--launch-${signal})`) }
    const seating = dockAge === null ? 0 : 6 * (1 - smooth(dockAge / 600))
    attributes(pad, { visibility: frame.pad ? 'visible' : 'hidden', transform: `translate(${PAD_X},${ROCKET_Y - frame.altitude - seating})` })
    let armOpen = frame.pad ? 0 : 1, clampOpen = armOpen
    if (dockAge !== null) { clampOpen = 1 - smooth((dockAge - 600) / 300); armOpen = 1 - smooth((dockAge - 900) / 400) }
    if (flightAge !== null) armOpen = clampOpen = smooth(flightAge / 400)
    arms.forEach(arm => attributes(arm, { transform: `rotate(${-60*armOpen})` }))
    clamps.forEach(node => attributes(node, { transform: `rotate(${35*Number(node.dataset.side)*clampOpen})` }))
    const frost = clamp(fuel / 100) * .85 * (flightAge === null ? 1 : 1 - .82 * clamp(flightAge / 700))
    if (lastFrost !== frost) { lastFrost = frost; hull.style.setProperty('--launch-frost', String(frost)) }
    const height = 104 * clamp(fuel / 100)
    attributes(liquid, { y: 104 - height, height, fill: 'var(--launch-signal)' })
    const percent = `${Math.round(fuel)}%`
    if (label.textContent !== percent) label.textContent = percent
    const fueling = phase === 'FUEL' && fuel > 0 && fuel < 100
    attributes(elevator, { transform: `translate(1,${fueling && !reduced ? 111+Math.sin(elapsed/1900)*83 : 181})` })
    attributes(lamp, { fill: `var(--launch-${phase === 'HOLD' ? 'amber' : 'red'})` })
    const storm = phase === 'SCRUB' || phase === 'HOLD'
    attributes(cloud, { opacity: storm ? 1 : 0 })
    attributes(sky, { opacity: phase === 'SCRUB' ? 1 : 0 }); attributes(puddles, { opacity: phase === 'SCRUB' ? 1 : 0 })
    attributes(flag, { fill: frame.state.complete ? `url(#${site.id('gBand')})` : `url(#${site.id('gRocket')})` })
    const rise = frame.state.complete ? reduced || frame.completeAge === null ? 1 : smooth(frame.completeAge / 900) : 0
    attributes(monument, { opacity: rise, transform: `scale(1,${rise})` })
    serialText(padSerial, frame.task?.id ?? ''); serialText(rolloutSerial, frame.task?.id ?? '')
    serialText(waitingSerial, frame.waiting?.id ?? '')
    site.stockSlots.forEach((slot, i) => {
      const task = frame.stock[i]
      attributes(slot, { visibility: task ? 'visible' : 'hidden', 'data-task-id': task?.id ?? '', transform: `translate(${283-i*16},${193+i*6}) scale(${1-i*.025})` })
      if (task) serialText(stockLabels[i], task.id)
    })
    syncClips(`${armOpen}:${clampOpen}`, `${frame.altitude}:${seating}`)
  }
}
