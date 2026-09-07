/** v9 焊接火花：白热焊点、暖色拖尾、重力抛射和寿命渐隐，保留固定粒子池。 */
import { defsFor } from './defs'
import { advance, attributes, noise, quantity, smooth, svg, type FxHandle, type FxParams } from './svg'

export interface SparksParams extends FxParams { intensity?: number }

export function create(host: SVGGElement, initial: SparksParams): FxHandle<SparksParams> {
  const defs = defsFor(host)
  const root = svg(host, 'g', { 'data-fx': 'sparks' })
  const pool = svg(root, 'ellipse', { cy: 65, rx: 45, ry: 8, fill: defs.url('fire-light'), opacity: .4 })
  const halo = svg(root, 'circle', { r: 18, fill: defs.url('lamp'), filter: defs.url('blur4') })
  svg(root, 'circle', { r: 2.8, fill: 'var(--wf-paper)' })
  const particles = Array.from({ length: 48 }, (_, i) => ({
    tail: svg(root, 'line', { stroke: 'var(--wf-fire-orange)', 'stroke-width': 2.2, 'stroke-linecap': 'round' }),
    head: svg(root, 'line', { stroke: 'var(--wf-warm)', 'stroke-width': 1.1, 'stroke-linecap': 'round' }),
    vx: (noise(i, 112) - .5) * 160, vy: -25 - noise(i, 113) * 120,
  }))
  let time = 0
  function update(dt: number, p: SparksParams) {
    time = advance(time, dt, p)
    const count = quantity(48, p.detail)
    attributes(root, { opacity: p.enabled === false ? 0 : p.intensity ?? 1 })
    particles.forEach((particle, i) => {
      const age = ((time / 1000 + i / count * .9) % .9)
      const t = Math.max(0, age - .045)
      const x = particle.vx * age, y = particle.vy * age + 130 * age * age
      const tx = particle.vx * t, ty = particle.vy * t + 130 * t * t
      const opacity = smooth(age / .04) * (1 - smooth(age / .9))
      attributes(particle.tail, { x1: tx, y1: ty, x2: x, y2: y, opacity, visibility: i < count ? 'visible' : 'hidden' })
      attributes(particle.head, { x1: x * .7 + tx * .3, y1: y * .7 + ty * .3, x2: x, y2: y, opacity, visibility: i < count ? 'visible' : 'hidden' })
    })
    const light = p.reducedMotion ? .8 : .75 + .2 * Math.sin(time / 37)
    attributes(halo, { opacity: light })
    attributes(pool, { opacity: .4 * light })
  }
  update(0, initial)
  return { update, destroy() { root.remove() } }
}
