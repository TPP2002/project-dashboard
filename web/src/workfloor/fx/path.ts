/** v10 沿路载具：实路径取样、车头跟切线、端点缓停掉头；金属车体、履带或加注罐、灯光与轮转。 */
import { defsFor } from './defs'
import { advance, attributes, clamp, smooth, svg, type FxHandle, type FxParams } from './svg'

export interface PathParams extends FxParams {
  path: SVGPathElement
  kind?: 'crawler' | 'fuel'
  duration?: number
}

export function create(host: SVGGElement, initial: PathParams): FxHandle<PathParams> {
  const defs = defsFor(host)
  const root = svg(host, 'g', { 'data-fx': 'path' })
  const position = svg(root, 'g')
  const heading = svg(position, 'g')
  const vehicle = svg(heading, 'g', { 'shape-rendering': 'geometricPrecision' })
  svg(vehicle, 'ellipse', { cy: 5, rx: 36, ry: 6, fill: 'var(--wf-ink)', opacity: .45, filter: defs.url('blur2') })
  svg(vehicle, 'path', { d: 'M28-12L91-26V12L28-8Z', fill: defs.url('beam'), opacity: .3, filter: defs.url('blur2') })
  svg(vehicle, 'path', { d: 'M-29-12H27L32-6V1H-30Z', fill: defs.url('metal'), stroke: 'var(--wf-ink)', 'stroke-width': 1.4 })
  const tank = svg(vehicle, 'g')
  svg(tank, 'rect', { x: -27, y: -30, width: 39, height: 19, rx: 9, fill: defs.url('metal'), stroke: 'var(--wf-metal-dark)', 'stroke-width': 1.1 })
  svg(tank, 'path', { d: 'M-18-29V-12M3-29V-12M-22-26H6', stroke: 'var(--wf-metal-light)', 'stroke-width': 1, fill: 'none' })
  const crawler = svg(vehicle, 'g')
  svg(crawler, 'path', { d: 'M-31-19H15L20-14V-10H-31Z', fill: 'var(--wf-project)', stroke: 'var(--wf-metal-light)', 'stroke-width': .8 })
  svg(crawler, 'rect', { x: -32, y: -2, width: 63, height: 9, rx: 4, fill: 'var(--wf-rubber)', stroke: 'var(--wf-metal-mid)', 'stroke-width': 1 })
  for (let i = 0; i < 13; i++) svg(crawler, 'path', { d: `M${-28 + i * 4.5} -1v7`, stroke: 'var(--wf-metal-mid)', 'stroke-width': 1 })
  svg(vehicle, 'path', { d: 'M15-26H26L32-19V-10H15Z', fill: 'var(--wf-project)', stroke: 'var(--wf-ink)', 'stroke-width': 1.2 })
  svg(vehicle, 'path', { d: 'M18-24H25L29-19V-17H18Z', fill: defs.url('glass'), stroke: 'var(--wf-ice)', 'stroke-width': .5 })
  const wheels = [-20, 23].map(x => {
    const axle = svg(vehicle, 'g', { transform: `translate(${x},2)` })
    svg(axle, 'circle', { r: 5.5, fill: 'var(--wf-rubber)' })
    svg(axle, 'circle', { r: 3.3, fill: defs.url('metal') })
    return svg(axle, 'path', { d: 'M-3 0H3M0-3V3', stroke: 'var(--wf-metal-dark)', 'stroke-width': .8 })
  })
  const brake = svg(vehicle, 'rect', { x: -31, y: -9, width: 3, height: 4, fill: 'var(--wf-fire-red)' })
  svg(vehicle, 'circle', { cx: 31, cy: -12, r: 8, fill: defs.url('lamp') })
  svg(vehicle, 'rect', { x: 30, y: -14, width: 2, height: 4, fill: 'var(--wf-warm)' })
  const beacon = svg(vehicle, 'circle', { cx: 22, cy: -28, r: 5, fill: defs.url('lamp') })
  let time = 0, route = initial.path, length = route.getTotalLength()
  function update(dt: number, p: PathParams) {
    time = advance(time, dt, p)
    if (route !== p.path) { route = p.path; length = route.getTotalLength(); time = 0 }
    const duration = Math.max(1000, p.duration ?? 5500), leg = duration + 900
    const cycle = time % (leg * 2), back = cycle >= leg, phase = cycle % leg
    const travel = smooth(Math.min(phase / duration, 1)), distance = (back ? 1 - travel : travel) * length
    const point = route.getPointAtLength(distance)
    const before = route.getPointAtLength(clamp(distance - 1, 0, length)), after = route.getPointAtLength(clamp(distance + 1, 0, length))
    const angle = Math.atan2(after.y - before.y, after.x - before.x) * 180 / Math.PI
    const turn = phase > duration ? smooth((phase - duration) / 900) : 0
    const scale = (back ? -1 : 1) * Math.cos(turn * Math.PI)
    attributes(root, { opacity: p.enabled === false ? 0 : 1 })
    attributes(position, { transform: `translate(${point.x},${point.y})` })
    attributes(heading, { transform: `rotate(${angle})` })
    attributes(vehicle, { transform: `scale(${scale},1)` })
    attributes(tank, { visibility: p.kind === 'crawler' ? 'hidden' : 'visible' })
    attributes(crawler, { visibility: p.kind === 'crawler' ? 'visible' : 'hidden' })
    attributes(brake, { opacity: phase > duration ? 1 : .2 })
    attributes(beacon, { opacity: p.reducedMotion ? .7 : .45 + .45 * Math.max(0, Math.sin(time / 180)) })
    wheels.forEach(wheel => attributes(wheel, { transform: `rotate(${distance * 8})` }))
  }
  update(0, initial)
  return { update, destroy() { root.remove() } }
}
