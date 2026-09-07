/** v9 焊接火花：白热焊点、暖色拖尾、重力抛射和寿命渐隐，保留固定粒子池。 */
import { defsFor } from './defs'
import { advance, attributes, noise, quantity, smooth, svg, type FxHandle, type FxParams } from './svg'

export interface SparksParams extends FxParams {
  intensity?: number
  /** 焊点局部坐标中的地面；碰地后只反弹一次。 */
  floor?: number
  onLight?: (intensity: number) => void
}

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
    const floor = Math.max(0, p.floor ?? 65), gravity = 850
    particles.forEach((particle, i) => {
      const impactAt = (-particle.vy + Math.sqrt(particle.vy ** 2 + 2 * gravity * floor)) / gravity
      const rebound = (particle.vy + gravity * impactAt) * .28
      const life = impactAt + 2 * rebound / gravity + .22
      const age = (time / 1000 + i / count * life) % life
      const position = (t: number) => {
        const after = Math.max(0, t - impactAt)
        return { x: particle.vx * (1 - Math.exp(-t * .45)) / .45,
          y: t <= impactAt ? particle.vy * t + gravity * t * t / 2
            : Math.min(floor, floor - rebound * after + gravity * after * after / 2) }
      }
      const { x, y } = position(age), { x: tx, y: ty } = position(Math.max(0, age - .035))
      const opacity = smooth(age / .04) * (1 - smooth((age - impactAt * .8) / (life - impactAt * .8)))
      attributes(particle.tail, { x1: tx, y1: ty, x2: x, y2: y, opacity, visibility: i < count ? 'visible' : 'hidden' })
      attributes(particle.head, { x1: x * .7 + tx * .3, y1: y * .7 + ty * .3, x2: x, y2: y, opacity, visibility: i < count ? 'visible' : 'hidden' })
    })
    const light = p.reducedMotion ? .8 : .75 + .2 * Math.sin(time / 37)
    attributes(halo, { opacity: light })
    attributes(pool, { cy: floor, opacity: .4 * light })
    p.onLight?.(p.enabled === false ? 0 : light * (p.intensity ?? 1))
  }
  update(0, initial)
  return { update, destroy() { root.remove() } }
}
