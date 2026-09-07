import { defsFor } from './defs'
import { attributes, clamp, noise, quantity, svg, type FxHandle, type FxParams, type Point } from './svg'

export interface FireworkParams extends FxParams {
  age: number
  centers: readonly Point[]
  /** 已由场景裁到水面的组；仅创建水光，不复制整幅画面。 */
  reflectionHost?: SVGGElement
}

/** 三轮相隔 700ms，彗尾、重力和水面光池使用同一个事件年龄。 */
export function create(host: SVGGElement, initial: FireworkParams): FxHandle<FireworkParams> {
  const defs = defsFor(host)
  const root = svg(host, 'g', { 'data-fx': 'fireworks' })
  const water = initial.reflectionHost ? svg(initial.reflectionHost, 'g') : null
  const rounds = initial.centers.slice(0, 3).map((_, round) => ({
    flash: svg(root, 'circle', { r: 22, fill: defs.url('flash'), filter: defs.url('blur2') }),
    pool: water ? svg(water, 'ellipse', { rx: 50, ry: 9, fill: defs.url('lamp'), filter: defs.url('blur4') }) : null,
    particles: Array.from({ length: 54 }, (_, i) => svg(root, 'path', {
      fill: 'none', stroke: defs.url(`comet-${['project', 'paper', 'fire-gold'][(i+round)%3]}`),
      'stroke-width': 1.3 + noise(i, 62) * .8, 'stroke-linecap': 'round',
    })),
  }))
  function update(_dt: number, p: FireworkParams) {
    const visible = p.enabled !== false && !p.reducedMotion
    attributes(root, { opacity: visible ? 1 : 0 })
    if (water) attributes(water, { opacity: visible ? 1 : 0 })
    if (!visible) return
    const count = quantity(54, p.detail)
    rounds.forEach((nodes, round) => {
      const center = p.centers[round] ?? initial.centers[round], age = p.age - round * 700
      const t = Math.max(0, age) / 1000, live = age >= 0 && age < 1600
      const opacity = live ? Math.pow(clamp(1 - t / 1.6), .65) : 0
      attributes(nodes.flash, { cx: center.x, cy: center.y, opacity: live ? .8 * Math.exp(-t * 14) : 0 })
      if (nodes.pool) attributes(nodes.pool, { cx: center.x, cy: 530 - center.y * .45, opacity: opacity * .28 })
      nodes.particles.forEach((particle, i) => {
        if (!live || i >= count) { attributes(particle, { visibility: 'hidden' }); return }
        const angle = i / count * Math.PI * 2, radius = 35 + noise(i, 63 + round) * 8
        const point = (seconds: number) => ({ x: center.x + Math.cos(angle) * radius * (1 - Math.exp(-seconds * 6)),
          y: center.y + Math.sin(angle) * radius * (1 - Math.exp(-seconds * 6)) + 18 * seconds * seconds })
        const head = point(t), tail = point(Math.max(0, t - .1))
        const color = ['project', 'paper', 'fire-gold'][(i+round)%3]
        attributes(particle, { visibility: 'visible', d: `M${tail.x},${tail.y}L${head.x},${head.y}`, opacity,
          stroke: defs.url(`comet-${color}${head.x < tail.x ? '-reverse' : ''}`) })
      })
    })
  }
  update(0, initial)
  return { update, destroy() { root.remove(); water?.remove() } }
}
