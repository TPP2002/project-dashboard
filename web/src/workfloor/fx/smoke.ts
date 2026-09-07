/** 样张 02 右格：软形状实体底、同噪声场明暗错层、火光染底、月光染顶。 */
import { defsFor } from './defs'
import { advance, attributes, clamp, noise, quantity, smooth, svg, type FxHandle, type FxParams } from './svg'

export interface SmokeParams extends FxParams {
  fireLight?: number
  moonLight?: number
  /** 单次喷发的相对毫秒；缺省仍为原来的循环演示。 */
  burstAge?: number
  clearAfter?: number
  exits?: readonly { x: number; y: number; side: number }[]
}

export function create(host: SVGGElement, initial: SmokeParams): FxHandle<SmokeParams> {
  const defs = defsFor(host)
  const root = svg(host, 'g', { 'data-fx': 'smoke' })
  const particles = Array.from({ length: 70 }, (_, i) => {
    const node = svg(root, 'g')
    const body = svg(node, 'g', { fill: 'var(--wf-cloud-mid)', filter: defs.url('blur4'), opacity: .55 })
    const shade = svg(node, 'g', { transform: 'translate(3,4)', fill: defs.url('cloud-shadow') })
    const light = svg(node, 'g', { transform: 'translate(-2,-3)', fill: defs.url('cloud-body') })
    for (let j = 0; j < 6 + i % 4; j++) {
      const angle = j * 2.399, r = 9 + noise(i * 13 + j, 3) * 8
      const shape = { cx: Math.cos(angle) * 14, cy: Math.sin(angle) * 9, r }
      svg(body, 'circle', shape)
      svg(shade, 'circle', shape)
      svg(light, 'circle', { ...shape, r: r * .94 })
    }
    const warm = svg(node, 'ellipse', { cx: -6, cy: 11, rx: 26, ry: 14, fill: defs.url('cloud-warm') })
    const cool = svg(node, 'ellipse', { cx: 3, cy: -16, rx: 22, ry: 11, fill: defs.url('cloud-cool') })
    return { node, layers: [shade, light, warm, cool], warm, cool }
  })
  let time = 0
  function update(dt: number, p: SmokeParams) {
    time = advance(time, dt, p)
    const count = quantity(70, p.detail)
    attributes(root, { opacity: p.enabled === false ? 0 : 1 })
    if (p.burstAge !== undefined && p.enabled === false) return
    particles.forEach((particle, i) => {
      if (i >= count) { attributes(particle.node, { visibility: 'hidden' }); return }
      const age = p.burstAge === undefined ? null : p.burstAge - i / count * 800
      const life = 5000 + noise(i, 51) * 2000
      if (age !== null && (age < 0 || age > life || p.burstAge! > (p.clearAfter ?? 7400))) {
        attributes(particle.node, { visibility: 'hidden' }); return
      }
      const t = age === null ? ((time / 5600 + i / count) % 1) : age / life
      const side = i % 2 ? 1 : -1
      const exit = p.exits?.length ? p.exits[i % p.exits.length] : { x: 0, y: 0, side }
      const seconds = (age ?? 0) / 1000
      const x = age === null ? side * (5 + 72 * (1 - Math.exp(-t * 3))) + Math.sin(t * 8 + i) * 3
        : exit.x + exit.side * (1 - Math.exp(-seconds * .9)) * (exit.side > 0 ? 176 : 115) + seconds * 3 + Math.sin(seconds * 3 + i) * 2
      const y = age === null ? -(Math.max(0, t - .25) ** 2) * 155 - Math.sin(Math.min(t * 4, 1) * Math.PI) * 3
        : exit.y - Math.sin(Math.min(seconds, 1) * Math.PI) * 1.5 - Math.max(0, seconds - 1) ** 2 * 8
      const scale = age === null ? (.32 + t * .85) * (.7 + noise(i, 5) * .5)
        : (.4 + smooth(seconds / 3) * 1.3) * (.7 + noise(i, 5) * .4)
      const opacity = age === null ? smooth(t / .08) * (1 - smooth((t - .55) / .45)) * .28
        : smooth(age / 120) * (1 - smooth((age - 2500) / (life - 2500))) * clamp(((p.clearAfter ?? 7400) - p.burstAge!) / 1300) * .72
      attributes(particle.node, { visibility: 'visible', opacity, transform: `translate(${x},${y}) scale(${scale}) rotate(${Math.sin(t * 5 + i) * 9})` })
      particle.layers.forEach(layer => attributes(layer, { filter: defs.filter('cloud', p.detail) }))
      attributes(particle.warm, { opacity: (p.fireLight ?? .8) * (1 - t) })
      attributes(particle.cool, { opacity: p.moonLight ?? .7 })
    })
  }
  update(0, initial)
  return { update, destroy() { root.remove() } }
}
