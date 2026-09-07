/** 样张 04 右格：双楔形软光、灯室三层光斑、表面亮斑、朝向衰减；光程由场景给定。 */
import { defsFor } from './defs'
import { advance, attributes, svg, type FxHandle, type FxParams } from './svg'

export interface BeamParams extends FxParams {
  length?: number
  angle?: number
  sweep?: number
  /** 场景提供可受光区域；光线碰到实体前须通过 length 截断。 */
  surfaceClip?: string
  /** 接收光的竖直表面位置（相对于灯）；扫到该面即截断，避免穿透。 */
  surfaceX?: number
}

export function create(host: SVGGElement, initial: BeamParams): FxHandle<BeamParams> {
  const defs = defsFor(host)
  const root = svg(host, 'g', { 'data-fx': 'beam' })
  const rotor = svg(root, 'g')
  const outer = svg(rotor, 'path', { fill: defs.url('beam-wide'), filter: defs.url('blur9') })
  const inner = svg(rotor, 'path', { fill: defs.url('beam'), filter: defs.url('blur2') })
  const hit = svg(root, 'g')
  const pool = svg(hit, 'ellipse', { rx: 25, ry: 7, fill: defs.url('lamp'), filter: defs.url('blur4') })
  const lamp = svg(root, 'g')
  svg(lamp, 'circle', { r: 26, fill: defs.url('lamp'), opacity: .55, filter: defs.url('blur9') })
  svg(lamp, 'circle', { r: 12, fill: defs.url('lamp'), opacity: .9, filter: defs.url('blur2') })
  svg(lamp, 'circle', { r: 4, fill: 'var(--wf-paper)' })
  let time = 0
  function update(dt: number, p: BeamParams) {
    time = advance(time, dt, p)
    const angle = (p.angle ?? 28) + Math.sin(time / 1432) * (p.sweep ?? 15)
    const radians = angle * Math.PI / 180
    const distance = p.surfaceX !== undefined && Math.cos(radians) > 0 ? p.surfaceX / Math.cos(radians) : Infinity
    const length = Math.min(p.length ?? 120, distance)
    attributes(root, { opacity: p.enabled === false ? 0 : 1 })
    attributes(rotor, { transform: `rotate(${angle})`, opacity: .25 + .75 * Math.max(0, Math.cos(radians)) })
    attributes(outer, { d: `M0 0L${length} ${-length * .22}V${length * .22}Z` })
    attributes(inner, { d: `M0 0L${length} ${-length * .1}V${length * .1}Z` })
    attributes(lamp, { opacity: .8 + .2 * Math.max(0, Math.cos(radians)) })
    attributes(hit, { 'clip-path': p.surfaceClip ? `url(#${p.surfaceClip})` : 'none' })
    attributes(pool, { cx: Math.cos(radians) * length, cy: Math.sin(radians) * length, opacity: .45 + .2 * Math.max(0, Math.sin(radians)) })
  }
  update(0, initial)
  return { update, destroy() { root.remove() } }
}
