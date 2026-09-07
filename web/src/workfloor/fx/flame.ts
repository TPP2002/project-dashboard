/** 样张 01 右格：三层贝塞尔火舌、冲击菱、噪声边缘、喷口柔光与地面受光。 */
import { defsFor } from './defs'
import { advance, attributes, clamp, svg, type FxHandle, type FxParams } from './svg'

export interface FlameParams extends FxParams {
  intensity?: number
  length?: number
  onLight?: (intensity: number) => void
  /** 起飞中的光池由场景固定在台面，不能跟随箭体飞走。 */
  groundLight?: boolean
}

export function create(host: SVGGElement, initial: FlameParams): FxHandle<FlameParams> {
  const defs = defsFor(host)
  const root = svg(host, 'g', { 'data-fx': 'flame' })
  const pool = svg(root, 'ellipse', { cy: 155, rx: 100, ry: 20, fill: defs.url('fire-light'), filter: defs.url('blur9') })
  const glow = svg(root, 'ellipse', { cy: 12, rx: 46, ry: 30, fill: defs.url('fire-light'), filter: defs.url('blur16') })
  const plume = svg(root, 'g')
  svg(plume, 'path', { d: 'M-22 0C-31 20-24 44-34 66C-41 86-32 103-20 119C-21 104-9 142 0 160C9 143 22 127 16 113C31 125 38 95 29 78C22 61 29 33 22 0Z', fill: defs.url('fire-outer'), filter: defs.url('blur4') })
  svg(plume, 'path', { d: 'M-15 0C-19 21-13 38-22 59C-27 81-18 91-12 111C-11 100-5 119 0 137C8 123 14 104 12 94C25 103 26 81 18 61C12 42 19 21 15 0Z', fill: defs.url('fire-mantle') })
  svg(plume, 'path', { d: 'M-7 0C-10 16-4 30-10 45C-14 61-9 80 0 107C7 90 13 73 9 56C4 42 10 21 7 0Z', fill: defs.url('fire-core') })
  const diamonds = [20, 39, 57, 74].map((cy, i) => svg(plume, 'ellipse', { cy, rx: 5.8 - i, ry: 3.8 - i * .65, fill: 'var(--wf-paper)' }))
  let time = 0
  function update(dt: number, p: FlameParams) {
    time = advance(time, dt, p)
    const intensity = p.enabled === false ? 0 : clamp(p.intensity ?? 1)
    const flicker = p.reducedMotion ? 1 : 1 + Math.sin(time * .038) * .055 + Math.sin(time * .021) * .03
    const light = intensity * (.84 + .16 * flicker)
    attributes(root, { opacity: intensity })
    attributes(plume, { filter: defs.filter('fire', p.detail), transform: `scale(${flicker},${(p.length ?? 1) * (1 + (p.reducedMotion ? 0 : .08 * Math.sin(time * .046)))})` })
    attributes(pool, { opacity: p.groundLight === false ? 0 : light * .75 })
    attributes(glow, { opacity: light * .65 })
    diamonds.forEach((node, i) => attributes(node, { opacity: p.reducedMotion ? .85 : .6 + .3 * Math.sin(time / 50 + i) }))
    p.onLight?.(light)
  }
  update(0, initial)
  return { update, destroy() { initial.onLight?.(0); root.remove() } }
}
