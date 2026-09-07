import { flame, smoke, vent, frost, rain, fireworks } from '../../fx'
import { attributes, clamp, svg } from '../../fx/svg'
import type { Detail } from '../../types'
import { MOUNT_TOP, NOZZLE_Y, PAD_X, ROCKET_Y, SMOKE_MS } from './layout'
import type { Site } from './site'
import type { LaunchFrame } from './sequence'

/** 特效固定池全部在创建阶段分配；不可见的池不逐帧更新。 */
export function createEffects(site: Site) {
  const rocket = site.get('[data-pad-rocket]'), ventHost = site.get('[data-rocket-vent]', rocket)
  const fireHost = site.get('[data-rocket-flame]', rocket)
  const warmGround = site.get('[data-warm-ground]'), warmSurfaces = site.get('[data-warm-surfaces]')
  const vents = [-1,1].flatMap(side => [88,105].map(y => {
    const group = svg(ventHost, 'g', { transform: `translate(${side*16},${y}) scale(${side*.36},.42)` })
    return vent.create(group, { enabled: false, particleLimit: 12 })
  }))
  const flames = [-8,0,8].map((x,i) => {
    const group = svg(fireHost, 'g', { transform: `translate(${x},${NOZZLE_Y-(i===1?0:1)}) scale(.3,.7)` })
    return { group, effect: flame.create(group, { enabled: false, groundLight: false }) }
  })
  const clouds = smoke.create(site.get('[data-smoke]'), { enabled: false, burstAge: 0 })
  const shards = frost.create(site.get('[data-frost]'), { enabled: false, repeat: false, burstId: 0 })
  const rainEffect = rain.create(site.get('[data-rain]'), { enabled: false, age: 0 })
  const centers = [{ x: 1148, y: 178 }, { x: 1302, y: 164 }, { x: 1226, y: 212 }]
  const celebration = fireworks.create(site.get('[data-fireworks]'), { enabled: false, age: 0, centers, reflectionHost: site.get('[data-water-flash]') as SVGGElement })
  const shown = new Set<string>()
  function transition(name: string, enabled: boolean, run: () => void) {
    if (enabled || shown.has(name)) run()
    if (enabled) shown.add(name); else shown.delete(name)
  }
  function update(dt: number, frame: LaunchFrame, detail: Detail, reducedMotion: boolean, daylight: number) {
    const common = { detail, reducedMotion }, burning = frame.flightAge !== null && !reducedMotion
    attributes(fireHost, { opacity: 1 - .32 * daylight })
    const vapor = frame.pad && frame.fuel > 0 && !reducedMotion && (frame.flightAge === null || frame.flightAge < 1000)
    transition('vent', vapor, () => vents.forEach(effect => effect.update(dt, { ...common, enabled: vapor, particleLimit: 12,
      density: clamp(frame.fuel/100) * (frame.flightAge === null ? 1 : clamp(1-frame.flightAge/1000)) })))
    transition('fire', burning, () => flames.forEach(({ group, effect }, i) => {
      const thin = 1 - .78*clamp((frame.altitude-430)/260)
      attributes(group, { transform: `translate(${[-8,0,8][i]},${NOZZLE_Y-(i===1?0:1)}) scale(${.3*thin},${i===1?.7:.62})` })
      effect.update(dt, { ...common, enabled: burning, intensity: clamp((frame.flightAge ?? 0)/160), length: .6+.5*clamp(frame.altitude/380), groundLight: false,
        onLight: i === 1 ? light => {
          const warm = light*clamp(1-frame.altitude/260) * (1 - .65 * daylight)
          attributes(warmGround, { opacity: warm*.5 }); attributes(warmSurfaces, { opacity: warm*.3 })
        } : undefined })
    }))
    const smoky = frame.smokeAge !== null && frame.smokeAge < SMOKE_MS && !reducedMotion
    transition('smoke', smoky, () => clouds.update(dt, { ...common, enabled: smoky, burstAge: frame.smokeAge ?? 0, clearAfter: SMOKE_MS,
      exits: [{ x: PAD_X-24, y: 428, side: -1 }, { x: PAD_X+150, y: 434, side: 1 }],
      fireLight: burning ? clamp(1-frame.altitude/120) * (1 - .6 * daylight) : 0, moonLight: .7 * (1 - daylight), daylight }))
    const shedding = smoky && (frame.smokeAge ?? 0) < 2600
    transition('frost', shedding, () => shards.update(dt, { ...common, enabled: shedding, floor: MOUNT_TOP-ROCKET_Y-141, burstId: frame.launchId, repeat: false }))
    const raining = frame.phase === 'SCRUB' && !reducedMotion
    transition('rain', raining, () => rainEffect.update(dt, { ...common, enabled: raining, age: frame.rainAge }))
    const celebrating = frame.state.complete && frame.completeAge !== null && frame.completeAge < 3000 && !reducedMotion
    transition('complete', celebrating, () => celebration.update(dt, { ...common, enabled: celebrating, age: frame.completeAge ?? 0, centers }))
  }
  return { update, destroy() {
    vents.forEach(effect => effect.destroy()); flames.forEach(({ effect }) => effect.destroy())
    clouds.destroy(); shards.destroy(); rainEffect.destroy(); celebration.destroy()
  } }
}
