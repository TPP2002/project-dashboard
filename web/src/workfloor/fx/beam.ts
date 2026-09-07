/** 样张 04 右格：双楔形软光、灯室三层光斑、表面亮斑、朝向衰减；光程由场景给定。 */
import { defsFor } from './defs'
import { advance, attributes, svg, type FxHandle, type FxParams } from './svg'

export interface BeamParams extends FxParams {
  length?: number
  innerHalfAngle?: number
  outerHalfAngle?: number
  angle?: number
  sweep?: number
  /** 场景提供可受光区域；光线碰到实体前须通过 length 截断。 */
  surfaceClip?: string
  /** 接收光的竖直表面位置（相对于灯）；扫到该面即截断，避免穿透。 */
  surfaceX?: number
  /** 可选水平受光面与亮斑；坐标相对灯室，裁切区域也使用此局部坐标。 */
  surfaceY?: number
  surfacePoint?: { x: number; y: number }
  surfaceRadius?: { x: number; y: number }
  intensity?: number
  facing?: number
  /** 裁掉实体背后的光锥，避免体积光透过塔身或箭体。 */
  beamClip?: string
  /** 可选的第二受光面；池的个数在创建时固定，之后只改位置与亮度。 */
  surfaces?: readonly { clip: string; x: number; y: number; rx: number; ry: number; opacity: number }[]
}

export function create(host: SVGGElement, initial: BeamParams): FxHandle<BeamParams> {
  const defs = defsFor(host)
  const root = svg(host, 'g', { 'data-fx': 'beam' })
  const air = svg(root, 'g')
  const rotor = svg(air, 'g')
  const outer = svg(rotor, 'path', { fill: defs.url('beam-wide'), filter: defs.url('blur9') })
  const inner = svg(rotor, 'path', { fill: defs.url('beam'), filter: defs.url('blur2') })
  const hit = svg(root, 'g')
  const pool = svg(hit, 'ellipse', { rx: 25, ry: 7, fill: defs.url('lamp'), filter: defs.url('blur4') })
  const surfaces = (initial.surfaces ?? []).map(() => {
    const clip = svg(root, 'g')
    return { clip, pool: svg(clip, 'ellipse', { fill: defs.url('lamp'), filter: defs.url('blur2') }) }
  })
  const lamp = svg(root, 'g')
  svg(lamp, 'circle', { r: 26, fill: defs.url('lamp'), opacity: .55, filter: defs.url('blur9') })
  svg(lamp, 'circle', { r: 12, fill: defs.url('lamp'), opacity: .9, filter: defs.url('blur2') })
  svg(lamp, 'circle', { r: 4, fill: 'var(--wf-paper)' })
  let time = 0
  function update(dt: number, p: BeamParams) {
    time = advance(time, dt, p)
    const angle = (p.angle ?? 28) + Math.sin(time / 1432) * (p.sweep ?? 15)
    const radians = angle * Math.PI / 180
    const distance = p.surfaceX !== undefined && (p.facing === undefined ? Math.cos(radians) > 0 : p.surfaceX / Math.cos(radians) > 0) ? p.surfaceX / Math.cos(radians) : Infinity
    const vertical = p.surfaceY !== undefined && p.surfaceY / Math.sin(radians) > 0 ? p.surfaceY / Math.sin(radians) : Infinity
    const length = Math.min(p.length ?? 120, distance, vertical)
    const facing = Math.cos(radians - (p.facing ?? 0) * Math.PI / 180)
    attributes(root, { opacity: p.enabled === false ? 0 : p.intensity ?? 1 })
    attributes(air, { 'clip-path': p.beamClip ? `url(#${p.beamClip})` : 'none' })
    attributes(rotor, { transform: `rotate(${angle})`, opacity: .25 + .75 * Math.max(0, facing) })
    const outerWidth = length * Math.tan((p.outerHalfAngle ?? 12.4) * Math.PI / 180)
    const innerWidth = length * Math.tan((p.innerHalfAngle ?? 5.7) * Math.PI / 180)
    attributes(outer, { d: `M0 0L${length} ${-outerWidth}V${outerWidth}Z` })
    attributes(inner, { d: `M0 0L${length} ${-innerWidth}V${innerWidth}Z` })
    attributes(lamp, { opacity: .8 + .2 * Math.max(0, facing) })
    attributes(hit, { 'clip-path': p.surfaceClip ? `url(#${p.surfaceClip})` : 'none' })
    attributes(pool, { cx: p.surfacePoint?.x ?? Math.cos(radians) * length, cy: p.surfacePoint?.y ?? Math.sin(radians) * length,
      rx: p.surfaceRadius?.x ?? 25, ry: p.surfaceRadius?.y ?? 7, opacity: .45 + .2 * Math.max(0, Math.sin(radians)) })
    surfaces.forEach((nodes, i) => {
      const surface = p.surfaces?.[i]
      attributes(nodes.clip, { opacity: surface?.opacity ?? 0, 'clip-path': surface ? `url(#${surface.clip})` : 'none' })
      if (surface) attributes(nodes.pool, { cx: surface.x, cy: surface.y, rx: surface.rx, ry: surface.ry })
    })
  }
  update(0, initial)
  return { update, destroy() { root.remove() } }
}
