import type { SceneFactory, SceneHandle } from '../../types'
import { attributes } from '../../fx/svg'
import { createSite } from './site'
import { createSequence } from './sequence'
import { createAssembly } from './assembly'
import { createTransport } from './transport'
import { createLighting } from './lighting'
import { createEffects } from './effects'
import { createScreen } from './screen'
import { COMPACT_VIEWBOX, STANDARD_VIEWBOX } from './layout'
import { createPaletteTransition } from '../../paletteTransition'

/** 场景不调度帧、不读取 store、不存本地设置；生命周期由 W1 骨架统一拥有。 */
export const createLaunchScene: SceneFactory = (host, options): SceneHandle => {
  let sound = options.sound
  const site = createSite(host), sequence = createSequence(options.state, cue => sound?.(cue))
  const assembly = createAssembly(site), transport = createTransport(site), lighting = createLighting(site)
  const effects = createEffects(site), screen = createScreen(site, host)
  let dayNight = options.dayNight, detail = options.detail, reduced = options.reducedMotion
  const daylight = createPaletteTransition(dayNight, reduced, site.paintDaylight)
  let elapsed = 0, destroyed = false
  function render(dt = 0) {
    if (destroyed) return
    const frame = sequence.frame()
    assembly(frame, elapsed, reduced)
    sequence.setTruckSafe(transport.update(dt, elapsed, frame, detail, reduced))
    lighting.update(dt, elapsed, frame, detail, reduced, daylight.daylight)
    effects.update(dt, frame, detail, reduced, daylight.daylight)
    site.ambient(elapsed, reduced, frame.phase)
    screen(frame, elapsed, reduced)
  }
  function setHeight(value: typeof options.height) {
    attributes(host, { viewBox: value === 'compact' ? COMPACT_VIEWBOX : STANDARD_VIEWBOX })
    attributes(site.get('[data-pad-label]'), { y: value === 'compact' ? 450 : 464 })
  }
  attributes(site.root, { 'data-day-night': dayNight })
  site.setDetail(detail); setHeight(options.height)
  sequence.setReducedMotion(reduced)
  render()
  return {
    setState(state) { if (!destroyed) { sequence.setState(state); render() } },
    handleEvent(event, animate) {
      if (destroyed) return
      sequence.handleEvent(event, animate)
      render()
    },
    tick(dt, time) {
      if (destroyed) return
      elapsed = reduced ? 0 : time
      sequence.tick(reduced ? 0 : dt)
      daylight.tick(reduced ? 0 : dt)
      render(reduced ? 0 : dt)
    },
    setDayNight(value) { if (!destroyed && dayNight !== value) {
      dayNight = value; daylight.setDayNight(value); attributes(site.root, { 'data-day-night': value }); render()
    } },
    setDetail(value) { if (!destroyed && detail !== value) { detail = value; site.setDetail(value); render() } },
    setHeight(value) { if (!destroyed) setHeight(value) },
    setReducedMotion(value) {
      if (destroyed || reduced === value) return
      reduced = value; sequence.setReducedMotion(value)
      daylight.setReducedMotion(value)
      if (value) elapsed = 0
      render()
    },
    setSound(value) { sound = value },
    destroy() {
      if (destroyed) return
      destroyed = true
      effects.destroy(); lighting.destroy(); transport.destroy(); site.destroy()
    },
  }
}

export const createScene = createLaunchScene
