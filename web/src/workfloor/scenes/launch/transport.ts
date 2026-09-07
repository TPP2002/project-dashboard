import { path } from '../../fx'
import { attributes, clamp, smooth } from '../../fx/svg'
import type { Detail } from '../../types'
import { NOZZLE_Y } from './layout'
import type { LaunchFrame } from './sequence'
import type { Site } from './site'

export function createTransport(site: Site) {
  const route = site.get<SVGPathElement>('[data-crawler-route]'), length = route.getTotalLength()
  const rollout = site.get('[data-rollout-vehicle]'), waiting = site.get('[data-waiting-vehicle]')
  const carriedRocket = site.get('[data-rollout-rocket]'), waitingRocket = site.get('[data-waiting-rocket]')
  const custom = (host: SVGGElement) => site.get('[data-crawler]', host)
  const primary = path.create(rollout, { path: route, kind: 'crawler', vehicle: custom(rollout), progress: 1, enabled: false })
  const secondary = path.create(waiting, { path: route, kind: 'crawler', vehicle: custom(waiting), progress: .22, enabled: false })
  const truckHost = site.get('[data-truck]'), truckRoute = site.get<SVGPathElement>('[data-truck-route]')
  const truck = path.create(truckHost, { path: truckRoute, kind: 'fuel', vehicle: truckHost.firstElementChild as SVGGElement, progress: 0 })
  const deck = site.get('[data-crawler-deck]', rollout), reverse = site.get('[data-reverse-lamp]', rollout)
  let homeSince: number | null = -Infinity
  function update(dt: number, elapsed: number, frame: LaunchFrame, detail: Detail, reducedMotion: boolean) {
    const common = { detail, reducedMotion }, docking = frame.dockAge !== null
    const backing = docking ? smooth(clamp((frame.dockAge! - 1300) / 600)) : 1
    const progress = frame.phase === 'ROLLOUT' ? frame.rollout - backing * (docking ? 60 / length : 0) : 1 - 60 / length
    primary.update(dt, { ...common, path: route, kind: 'crawler', offsetY: -18, progress,
      enabled: frame.phase === 'ROLLOUT' || frame.pad && frame.flightAge === null,
      onPose: pose => attributes(carriedRocket, { transform: `matrix(1 0 0 1 ${pose.x} ${pose.y - NOZZLE_Y})` }) })
    attributes(carriedRocket, { visibility: frame.carrying ? 'visible' : 'hidden' })
    attributes(deck, { transform: `translate(0,${docking ? 6 * smooth(frame.dockAge! / 600) : 6})` })
    attributes(reverse, { opacity: docking && backing > 0 && backing < 1 && !reducedMotion ? .6+.4*Math.sin(elapsed/85) : 0 })
    secondary.update(dt, { ...common, path: route, kind: 'crawler', offsetY: -18, progress: frame.waitingProgress, enabled: Boolean(frame.waiting),
      onPose: pose => attributes(waitingRocket, { transform: `matrix(1 0 0 1 ${pose.x} ${pose.y - NOZZLE_Y})` }) })
    attributes(waitingRocket, { visibility: frame.waiting ? 'visible' : 'hidden' })
    const fueling = (frame.phase === 'FUEL' || frame.phase === 'GO') && frame.fuel > 0 && frame.fuel < 100 && !frame.launchRequested
    truck.update(dt, { ...common, path: truckRoute, kind: 'fuel', duration: 5600, returnHome: !fueling,
      ...(reducedMotion ? { progress: 0 } : {}),
      onPose: pose => { if (pose.distance > .1) homeSince = null; else if (homeSince === null) homeSince = elapsed } })
    return homeSince !== null && elapsed - homeSince >= 2000
  }
  return { update, destroy() { primary.destroy(); secondary.destroy(); truck.destroy() } }
}
