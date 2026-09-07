import { ORDER, byName, P, bounds, type Point } from './geometry'
import { required, setAttrs, svg } from './dom'
import type { Assembly } from './assembly'

/** 光只落在真实装甲的轮廓内；局部片段跟随部件自身的呼吸与头部姿态。 */
export function createWeldLight(root: SVGGElement) {
  const defs = required<SVGDefsElement>(root, 'defs')
  const prefix = root.getAttribute('data-mech-scene')!
  const faces = ORDER.map(name => {
    const clip = svg(defs, 'clipPath', { id: `${prefix}weld-light-${name}`, clipPathUnits: 'userSpaceOnUse' })
    for (const ring of byName[name].rings ?? [byName[name].main]) svg(clip, 'polygon', { points: P(ring) })
    const group = svg(required<SVGGElement>(root, `[data-part="${name}"]`), 'g', {
      'clip-path': `url(#${clip.id})`, 'pointer-events': 'none', opacity: 0, 'data-weld-light': name,
    })
    const light = svg(group, 'ellipse', { rx: 95, ry: 80, fill: 'var(--scene-paper)', filter: `url(#${prefix}fsoft)` })
    return { name, group, light, box: bounds(byName[name].main) }
  })
  let lit: typeof faces = []
  return {
    aim(assembly: Assembly, point: Point | null) {
      lit = []
      for (const face of faces) {
        const box = face.box
        const near = point && assembly.mode === 'build' && assembly.parts[face.name] !== 'off'
          && point[0] >= box.x - 95 && point[0] <= box.x + box.width + 95
          && point[1] >= box.y - 80 && point[1] <= box.y + box.height + 80
        if (near && point) { setAttrs(face.light, { cx: point[0], cy: point[1] }); lit.push(face) }
        else setAttrs(face.group, { opacity: 0 })
      }
    },
    illuminate(intensity: number) { lit.forEach(face => setAttrs(face.group, { opacity: .25 * intensity })) },
  }
}
