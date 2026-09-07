import { defsFor } from './defs'
import { attributes, noise, quantity, smooth, svg, type FxHandle, type FxParams } from './svg'

export interface RainParams extends FxParams { age: number; width?: number; height?: number }

/** 有尾部衰减的斜雨与落地小弧；age 由场景注入，不创建定时器。 */
export function create(host: SVGGElement, initial: RainParams): FxHandle<RainParams> {
  const defs = defsFor(host)
  const root = svg(host, 'g', { 'data-fx': 'rain', fill: 'none', 'stroke-linecap': 'round' })
  const drops = Array.from({ length: 108 }, (_, i) => ({
    streak: svg(root, 'path', { d: 'M0 0l-5 16', stroke: defs.url('rain-tail'), 'stroke-width': .65 + noise(i, 42) * .55 }),
    splash: svg(root, 'path', { d: 'M-4 0q2-5 4 0q2-4 5 0', stroke: 'var(--wf-ice)', 'stroke-width': .6 }),
  }))
  function update(_dt: number, p: RainParams) {
    const visible = p.enabled !== false && !p.reducedMotion
    attributes(root, { opacity: visible ? smooth(p.age / 350) : 0 })
    if (!visible) return
    const count = quantity(108, p.detail), width = p.width ?? 1400, height = p.height ?? 520
    drops.forEach(({ streak, splash }, i) => {
      if (i >= count) { attributes(streak, { visibility: 'hidden' }); attributes(splash, { visibility: 'hidden' }); return }
      const floor = height - noise(i, 84) * 165, speed = 250 + noise(i, 92) * 145
      const distance = p.age / 1000 * speed + noise(i, 81) * (floor + 40)
      const y = distance % (floor + 40) - 30
      const x = ((noise(i, 83) * width - distance * .3) % (width + 80) + width + 80) % (width + 80) - 40
      const landed = y > floor - 12, alpha = (1 - smooth((y - floor + 8) / 18)) * (.15 + noise(i, 17) * .3)
      attributes(streak, { visibility: 'visible', transform: `translate(${x},${y})`, opacity: alpha })
      attributes(splash, { visibility: landed ? 'visible' : 'hidden', transform: `translate(${x-4},${floor}) scale(${1+(y-floor+12)/12},1)`, opacity: alpha * .7 })
    })
  }
  update(0, initial)
  return { update, destroy() { root.remove() } }
}
