/** v9 焊接 / 检验无人机：金属机身、螺旋桨、三层灯、焊枪或检验束，缓动飞行与悬停次级运动。 */
import { defsFor } from './defs'
import { advance, attributes, svg, type FxHandle, type FxParams, type Point } from './svg'

export interface DroneParams extends FxParams { target?: Point; mode?: 'weld' | 'inspect'; working?: boolean }

export function create(host: SVGGElement, initial: DroneParams): FxHandle<DroneParams> {
  const defs = defsFor(host)
  const root = svg(host, 'g', { 'data-fx': 'drone' })
  const shadow = svg(root, 'ellipse', { cy: 70, rx: 27, ry: 5, fill: 'var(--wf-ink)', opacity: .3, filter: defs.url('blur2') })
  const body = svg(root, 'g', { 'shape-rendering': 'geometricPrecision' })
  svg(body, 'path', { d: 'M-17-7Q-15-12-9-10L13-9Q18-7 17 2L12 8H-11Q-18 6-17-7Z', fill: defs.url('metal'), stroke: 'var(--wf-ink)', 'stroke-width': 1.5 })
  svg(body, 'path', { d: 'M-17-4H-31V0H-16M17-4H31V0H16', fill: 'var(--wf-metal-dark)', stroke: 'var(--wf-metal-mid)', 'stroke-width': .7 })
  svg(body, 'path', { d: 'M-12-8H10M-10 5H-5M5 5H11', fill: 'none', stroke: 'var(--wf-metal-light)', 'stroke-width': .8 })
  const rotors = [-30, 30].map(x => {
    const g = svg(body, 'g', { transform: `translate(${x},-6)` })
    return svg(g, 'ellipse', { rx: 13, ry: 2, fill: 'var(--wf-metal-light)', opacity: .7 })
  })
  svg(body, 'path', { d: 'M-3 7H3V19L0 22-3 19Z', fill: defs.url('metal'), stroke: 'var(--wf-metal-dark)', 'stroke-width': .7 })
  const sensor = svg(body, 'circle', { r: 10, fill: defs.url('flash') })
  svg(body, 'circle', { r: 3, fill: 'var(--wf-project)' })
  svg(body, 'circle', { cx: -1, cy: -1, r: 1, fill: 'var(--wf-paper)' })
  const arc = svg(body, 'g')
  svg(arc, 'circle', { cy: 23, r: 13, fill: defs.url('lamp'), filter: defs.url('blur2') })
  svg(arc, 'circle', { cy: 23, r: 2, fill: 'var(--wf-paper)' })
  const scan = svg(body, 'g')
  svg(scan, 'path', { d: 'M-3 20H3L28 76H-28Z', fill: defs.url('lamp'), opacity: .25, filter: defs.url('blur2') })
  svg(scan, 'ellipse', { cy: 76, rx: 28, ry: 5, fill: defs.url('lamp'), opacity: .6 })
  let time = 0, x = initial.target?.x ?? 0, y = initial.target?.y ?? 0
  function update(dt: number, p: DroneParams) {
    time = advance(time, dt, p)
    const target = p.target ?? { x: 0, y: 0 }
    const easing = p.reducedMotion ? 1 : 1 - Math.exp(-Math.max(0, dt) / 270)
    x += (target.x - x) * easing
    y += (target.y - y) * easing
    const bob = p.reducedMotion ? 0 : Math.sin(time / 340) * 2.5
    attributes(root, { opacity: p.enabled === false ? 0 : 1 })
    attributes(body, { transform: `translate(${x},${y + bob}) rotate(${p.reducedMotion ? 0 : (target.x - x) * .08 + Math.sin(time / 470) * 2})` })
    attributes(shadow, { cx: x, cy: y + 72, rx: 25 - bob * .7 })
    rotors.forEach((node, i) => attributes(node, { transform: `scale(${p.reducedMotion ? 1 : .45 + .55 * Math.abs(Math.sin(time / 27 + i))},1)` }))
    const atTarget = Math.hypot(target.x - x, target.y - y) < 8
    attributes(arc, { opacity: p.working && p.mode !== 'inspect' && atTarget ? (p.reducedMotion ? .7 : .7 + .3 * Math.sin(time / 40)) : 0 })
    attributes(scan, { opacity: p.working && p.mode === 'inspect' && atTarget ? .9 : 0 })
    attributes(sensor, { opacity: p.reducedMotion ? .7 : .65 + .2 * Math.sin(time / 360) })
  }
  update(0, initial)
  return { update, destroy() { root.remove() } }
}
