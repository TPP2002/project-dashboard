import { beam, lightning } from '../../fx'
import { attributes, svg } from '../../fx/svg'
import type { Detail } from '../../types'
import { BODY_R, MASTS, PAD_X, ROCKET_Y, TOWER_X, TOWER_Y, cabinetFaces } from './layout'
import type { Site } from './site'
import type { LaunchFrame } from './sequence'

export function createLighting(site: Site) {
  const localDefs = site.get<SVGDefsElement>('defs')
  const mastGroups = site.all<SVGGElement>('[data-mast-beam]')
  const masts = MASTS.map(([x,y], i) => {
    const edge = PAD_X + (x < PAD_X ? -BODY_R : BODY_R), dx = edge - x, dy = ROCKET_Y + 106 - y
    const airClip = svg(localDefs, 'clipPath', { id: site.id(`mast-${i}-air`), clipPathUnits: 'userSpaceOnUse' })
    svg(airClip, 'rect', { x: x < PAD_X ? -1400 : dx, y: -520, width: x < PAD_X ? 1400 + dx : 1400, height: 1040 })
    const surface = svg(localDefs, 'clipPath', { id: site.id(`mast-${i}-surface`), clipPathUnits: 'userSpaceOnUse' })
    const face = svg(surface, 'rect', { x: PAD_X-BODY_R-x, y: ROCKET_Y+38-y, width: BODY_R*2, height: 142 })
    const params = { length: 420, innerHalfAngle: 5, outerHalfAngle: 12, angle: Math.atan2(dy, dx)*180/Math.PI, sweep: 0, surfaceX: dx,
      surfaceClip: surface.id, surfaceRadius: { x: 5, y: 28 }, facing: x < PAD_X ? 0 : 180, beamClip: airClip.id }
    return { effect: beam.create(mastGroups[i], params), params, face, originY: y }
  })
  const seaClip = site.localSeaClip('lighthouse-sea', 1320, 270)
  const stones = svg(localDefs, 'clipPath', { id: site.id('lighthouse-stones'), clipPathUnits: 'userSpaceOnUse' })
  for (let i = 0; i < 27; i++) svg(stones, 'polygon', {
    points: cabinetFaces(1080+i*12, 350, 12, 14).top.map(point => point.join(',')).join(' '), transform: 'translate(-1320,-270)',
  })
  const stoneSurface = { clip: stones.id, x: 0, y: 80, rx: 58, ry: 15, opacity: 0 }
  const lighthouseHost = site.get('[data-lighthouse-beam]')
  attributes(lighthouseHost, { transform: 'translate(1320,270)' })
  const lighthouse = beam.create(lighthouseHost, { length: 420, angle: 90, sweep: 0, surfaceClip: seaClip, surfaces: [stoneSurface] })
  const cloudLight = site.get('[data-cloud-light]')
  const strike = lightning.create(site.get('[data-lightning]'), {
    enabled: false, length: TOWER_Y-28-65, silhouetteClip: site.id('storm-clip'),
  })
  let strikeVisible = false
  function update(dt: number, elapsed: number, frame: LaunchFrame, detail: Detail, reducedMotion: boolean, daylight: number) {
    const common = { detail, reducedMotion }, brightness = (1 - daylight) * (frame.phase === 'STANDBY' ? .5 : 1)
    masts.forEach(({ effect, params, face, originY }) => {
      attributes(face, { y: ROCKET_Y+38-originY-frame.altitude })
      effect.update(dt, { ...common, ...params, intensity: brightness*(frame.pad ? .8 : .18) })
    })
    const angle = reducedMotion ? 90 : 90 + elapsed / 9000 * 360, radians = angle * Math.PI/180
    const hit = Math.sin(radians) > 0 ? 80 / Math.sin(radians) : Infinity
    lighthouse.update(dt, { ...common, length: 420, innerHalfAngle: 5, outerHalfAngle: 12, angle, facing: 90, sweep: 0, intensity: brightness,
      surfaceClip: seaClip, surfacePoint: { x: Math.cos(radians)*230, y: Math.sin(radians)*230*.65 }, surfaceRadius: { x: 150, y: 19 },
      surfaces: [{ ...stoneSurface, x: Number.isFinite(hit) ? Math.cos(radians)*hit : 0, opacity: hit < 420 ? .15 : 0 }] })
    const enabled = !reducedMotion && (frame.phase === 'HOLD' || frame.phase === 'SCRUB') && frame.stormAge >= 0
    if (enabled || strikeVisible) strike.update(dt, { ...common, enabled, age: Math.max(0, frame.stormAge), period: 5600,
      length: TOWER_Y-28-65, silhouetteClip: site.id('storm-clip'), surfaceBounds: { x: -65, y: 0, width: PAD_X-TOWER_X+BODY_R+70, height: 360 },
      onLight: light => attributes(cloudLight, { opacity: light*.7 }) })
    strikeVisible = enabled
  }
  return { update, destroy() { masts.forEach(mast => mast.effect.destroy()); lighthouse.destroy(); strike.destroy() } }
}
