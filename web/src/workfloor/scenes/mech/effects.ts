import { beam, drone, flame, sparks } from '../../fx'
import type { DayNight, Detail, Height } from '../../types'
import type { Assembly } from './assembly'
import type { Cue } from './pose'
import { partCenter } from './pose'
import { required, setAttrs } from './dom'

export interface EffectFrame {
  detail: Detail
  reducedMotion: boolean
  dayNight: DayNight
  height: Height
  snap: boolean
  weldingPoint: { x: number; y: number } | null
  cue: Cue | null
}

/** 所有粒子和动态光束来自 W1 特效库；本模块只负责机库中的位置与启停。 */
export function createEffects(root: SVGGElement, initial: EffectFrame, onLight: (intensity: number) => void) {
  const weldHost = required<SVGGElement>(root, '[data-welder]')
  const inspectHost = required<SVGGElement>(root, '[data-inspector]')
  const sparkHost = required<SVGGElement>(root, '[data-sparks]')
  const common = { detail: initial.detail, reducedMotion: true }
  const welder = drone.create(weldHost, { ...common, target: { x: 1000, y: 120 }, mode: 'weld', working: false })
  const inspector = drone.create(inspectHost, { ...common, target: { x: 1200, y: 100 }, mode: 'inspect', working: false })
  const welding = sparks.create(sparkHost, { ...common, enabled: false })
  const lamps = [...root.querySelectorAll<SVGGElement>('[data-ceiling-beam], [data-gantry-beam]')].map(host => {
    const length = host.hasAttribute('data-ceiling-beam') ? 390 : 116
    return { fx: beam.create(host, { ...common, length, angle: 0, sweep: 0 }), length }
  })
  const thrusters = [...root.querySelectorAll<SVGGElement>('[data-thruster]')].map(host => flame.create(host, { ...common, enabled: false, length: 1 }))
  let wasWelding = false, wasPowered = false
  function update(dt: number, assembly: Assembly, frame: EffectFrame) {
    const params = { detail: frame.detail, reducedMotion: frame.reducedMotion || frame.snap }
    const cue = frame.cue
    const fetching = cue?.kind === 'claim' && cue.age < 2000
    const recoil = cue?.kind === 'block' && cue.age < 2600
    const center = assembly.target ? partCenter(assembly.target, frame.height) : null
    let target = frame.weldingPoint ? { x: frame.weldingPoint.x, y: frame.weldingPoint.y - 23 }
      : center ? { x: center.x + 46, y: center.y - 40 } : { x: 1000, y: 120 }
    if (assembly.mode === 'pend') target.x += 40
    if (assembly.mode === 'block' || recoil) target.x += 80
    if (assembly.mode === 'park' || assembly.mode === 'powered' || assembly.mode === 'ready') target = { x: 1000, y: 120 }
    if (fetching && cue.age < 900) target = { x: cue.pickup.x, y: cue.pickup.y - 23 }
    const working = assembly.mode === 'build' && !!frame.weldingPoint && !fetching
    const parked = assembly.mode === 'park' && cue?.kind !== 'park'
    welder.update(dt, { ...params, reducedMotion: params.reducedMotion || parked, target, mode: 'weld', working: working && !frame.reducedMotion })
    inspector.update(dt, { ...params, reducedMotion: params.reducedMotion || parked, mode: 'inspect', working: assembly.mode === 'pend',
      target: assembly.mode === 'pend' && center ? { x: center.x - 40, y: center.y - 56 } : { x: 1200, y: 100 } })
    const scale = frame.height === 'compact' ? .68 * .74 : .68
    const floorY = frame.height === 'compact' ? 54.84 + 474 * .74 : 474
    if (frame.weldingPoint) setAttrs(sparkHost, { transform: `translate(${frame.weldingPoint.x},${frame.weldingPoint.y}) scale(${scale})` })
    const enabled = working && !frame.reducedMotion
    if (enabled || wasWelding || frame.snap) welding.update(dt, { ...params, enabled, intensity: 1,
      floor: (floorY - (frame.weldingPoint?.y ?? floorY)) / scale, onLight })
    wasWelding = enabled
    const powered = assembly.mode === 'powered'
    if (powered || wasPowered || frame.snap) thrusters.forEach(fx => fx.update(dt, { ...params, enabled: powered, intensity: .9, length: 1 }))
    wasPowered = powered
    // 光锥固定朝向，无需在帧内更新；昼夜、档位或静态落位时再应用参数。
    if (frame.snap) lamps.forEach(({ fx, length }) => fx.update(0, { ...params, enabled: true, length, angle: 0, sweep: 0 }))
  }
  return { update, destroy() {
    welder.destroy(); inspector.destroy(); welding.destroy()
    lamps.forEach(({ fx }) => fx.destroy())
    thrusters.forEach(fx => fx.destroy())
  } }
}
