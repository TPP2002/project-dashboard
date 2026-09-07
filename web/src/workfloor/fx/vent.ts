/** 样张 03 右格：连续下沉的三层气流、噪声明暗错位、源头雾丝与地面冷雾。 */
import { defsFor } from './defs'
import { advance, attributes, quantity, smooth, svg, type FxHandle, type FxParams } from './svg'

export interface VentParams extends FxParams {
  density?: number
  /** 创建时确定固定池上限；update 可降低数量，标准档再减半。 */
  particleLimit?: number
}

export function create(host: SVGGElement, initial: VentParams): FxHandle<VentParams> {
  const defs = defsFor(host)
  const root = svg(host, 'g', { 'data-fx': 'vent' })
  svg(root, 'ellipse', { cx: 62, cy: 128, rx: 70, ry: 10, fill: defs.url('vapor'), opacity: .3, filter: defs.url('blur9') })
  const capacity = Math.max(1, Math.min(28, Math.floor(initial.particleLimit ?? 28)))
  const puffs = Array.from({ length: capacity }, () => {
    const group = svg(root, 'g')
    const under = svg(group, 'ellipse', { cx: 3, cy: 4, rx: 20, ry: 12, fill: defs.url('vapor-shade') })
    const main = svg(group, 'ellipse', { rx: 18, ry: 10, fill: defs.url('vapor') })
    const rim = svg(group, 'ellipse', { cx: -4, cy: -2, rx: 12, ry: 6, fill: defs.url('vapor'), filter: defs.url('blur2') })
    return { group, under, main, rim }
  })
  const threads = svg(root, 'g', { fill: 'none', stroke: 'var(--wf-paper)', 'stroke-linecap': 'round', filter: defs.url('blur2') })
  for (let i = 0; i < 4; i++) svg(threads, 'path', { d: `M${i * 5} ${i * 7} C${12 + i * 8} ${14 + i * 10} ${16 + i * 10} ${22 + i * 13} ${24 + i * 12} ${34 + i * 15}`, 'stroke-width': 1.6 - i * .15, opacity: .55 - i * .1 })
  svg(root, 'ellipse', { rx: 7, ry: 4, fill: 'var(--wf-paper)', opacity: .85, filter: defs.url('blur2') })
  let time = 0
  function update(dt: number, p: VentParams) {
    time = advance(time, dt, p)
    const count = quantity(Math.max(1, Math.min(capacity, p.particleLimit ?? capacity)), p.detail)
    attributes(root, { opacity: p.enabled === false ? 0 : p.density ?? 1 })
    puffs.forEach((puff, i) => {
      const t = (time / 3200 + i / count) % 1
      attributes(puff.group, { visibility: i < count ? 'visible' : 'hidden', opacity: .6 * smooth(t / .07) * (1 - t),
        transform: `translate(${8 + 65 * t + Math.sin(t * 6 + i) * 3 * t},${5 + 58 * t + 62 * t * t}) scale(${.3 + 2.3 * t})` })
      attributes(puff.main, { filter: defs.filter('vapor', p.detail) })
      attributes(puff.under, { filter: defs.filter('vapor', p.detail) })
    })
    attributes(threads, { transform: `translate(${Math.sin(time / 500) * 1.5},${Math.sin(time / 650) * 2})` })
  }
  update(0, initial)
  return { update, destroy() { root.remove() } }
}
