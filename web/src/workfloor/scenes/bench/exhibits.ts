import { beam, drone, flame, frost, lightning, path, smoke, sparks, vent, ensureDefs } from '../../fx'
import { attributes, svg, type FxParams } from '../../fx/svg'
import { palette } from './palette'

/** 九个展位都在紧凑中段内，主体坐标保持稳定；每个特效仍可被世界单独调用。 */
export function createExhibits(host: SVGGElement, initial: FxParams) {
  const defs = ensureDefs(host.ownerSVGElement!)
  const labels = ['01 FLAME', '02 SMOKE', '03 VENT', '04 BEAM', '05 LIGHTNING', '06 FROST', '07 SPARKS', '08 DRONE', '09 PATH']
  const groups = labels.map((label, i) => {
    const cell = svg(host, 'g', { transform: `translate(${30 + i * 150},210)` })
    svg(cell, 'path', { d: 'M0 171H138V180H0Z', fill: palette.floor, stroke: palette.line, 'stroke-width': .6 })
    svg(cell, 'path', { d: 'M3 171H135M12 177H32M97 177H125', fill: 'none', stroke: palette.edge, opacity: .18, 'stroke-width': .7 })
    const text = svg(cell, 'text', { x: 0, y: 198, fill: palette.muted, 'font-size': 12 })
    text.textContent = label
    return cell
  })
  const at = (index: number, x: number, y: number, scale = 1) => svg(groups[index], 'g', { transform: `translate(${x},${y}) scale(${scale})` })
  // 喷口、受光面与载具是场景实体；不是给界面新增图标。
  svg(groups[0], 'path', { d: 'M53 6H85L91 34H47Z', fill: defs.url('metal'), stroke: palette.ink, 'stroke-width': 1.2 })
  svg(groups[0], 'ellipse', { cx: 69, cy: 34, rx: 22, ry: 4, fill: palette.ink })
  const flameLight = svg(groups[0], 'path', { d: 'M47 33H91L88 39H50Z', fill: 'var(--wf-fire-gold)', opacity: .5 })
  const ventTube = svg(groups[2], 'g', { 'shape-rendering': 'geometricPrecision' })
  svg(ventTube, 'path', { d: 'M4 3Q16-4 28 3V148Q16 155 4 148Z', fill: defs.url('metal'), stroke: palette.ink, 'stroke-width': 1.3 })
  svg(ventTube, 'path', { d: 'M28 24H42V31H28M10 12V138', fill: defs.url('metal'), stroke: palette.edge, 'stroke-width': 1 })
  const fixture = svg(groups[3], 'g')
  svg(fixture, 'path', { d: 'M10 44H23L28 166H6Z', fill: defs.url('metal'), stroke: palette.ink, 'stroke-width': 1 })
  svg(fixture, 'rect', { x: 6, y: 30, width: 22, height: 15, rx: 2, fill: palette.ink, stroke: palette.line })
  // 光束受光终点处的墙面先画；体积光在墙面前截断。
  svg(groups[3], 'path', { d: 'M130 44L138 48V171H130Z', fill: palette.line })
  const surface = svg(host.ownerSVGElement!.querySelector('defs')!, 'clipPath', { id: defs.id('bench-beam-surface') })
  svg(surface, 'rect', { x: 109, y: 7, width: 8, height: 127 })
  const clip = svg(host.ownerSVGElement!.querySelector('defs')!, 'clipPath', { id: defs.id('bench-silhouette') })
  svg(clip, 'path', { d: 'M-35 117L-28 67H-17L-12 117ZM15 117V40H25L33 117Z' })
  const sil = at(4, 69, 18)
  svg(sil, 'path', { d: 'M-35 117L-28 67H-17L-12 117ZM15 117V40H25L33 117Z', fill: palette.line, stroke: palette.ink, 'stroke-width': 1 })
  let light = .8
  const effects = {
    flame: flame.create(at(0, 69, 36, .85), { ...initial, onLight: value => { light = value; attributes(flameLight, { opacity: value * .55 }) } }),
    smoke: smoke.create(at(1, 69, 156, .9), initial),
    vent: vent.create(at(2, 42, 28), initial),
    beam: beam.create(at(3, 21, 37), { ...initial, length: 170, angle: 32, sweep: 16, surfaceX: 109, surfaceClip: defs.id('bench-beam-surface') }),
    lightning: lightning.create(sil, { ...initial, length: 130, silhouetteClip: defs.id('bench-silhouette') }),
    frost: frost.create(at(5, 69, 22), { ...initial, floor: 145 }),
    sparks: sparks.create(at(6, 69, 90), initial),
    drone: drone.create(at(7, 69, 75), { ...initial, working: true, mode: 'weld' }),
  }
  const route = svg(groups[8], 'path', { d: 'M26 135C115 140 122 110 78 104S19 74 105 71', fill: 'none', stroke: palette.line, 'stroke-width': 5, 'stroke-linecap': 'round' })
  svg(groups[8], 'path', { d: route.getAttribute('d')!, fill: 'none', stroke: palette.muted, 'stroke-width': .6, 'stroke-dasharray': '4 7', opacity: .45 })
  const truck = path.create(groups[8], { ...initial, path: route, kind: 'fuel' })
  return {
    update(dt: number, elapsed: number, params: FxParams) {
      effects.flame.update(dt, { ...params, onLight: value => { light = value; attributes(flameLight, { opacity: value * .55 }) } })
      effects.smoke.update(dt, { ...params, fireLight: light, moonLight: .7 })
      effects.vent.update(dt, params)
      effects.beam.update(dt, { ...params, length: 170, angle: 32, sweep: 16, surfaceX: 109, surfaceClip: defs.id('bench-beam-surface') })
      effects.lightning.update(dt, { ...params, length: 130, period: 6000, silhouetteClip: defs.id('bench-silhouette') })
      effects.frost.update(dt, { ...params, floor: 145 })
      effects.sparks.update(dt, params)
      effects.drone.update(dt, { ...params, mode: Math.floor(elapsed / 9000) % 2 ? 'inspect' : 'weld', working: true,
        target: { x: Math.sin(elapsed / 2800) * 18, y: Math.sin(elapsed / 3300) * 9 } })
      truck.update(dt, { ...params, path: route, kind: Math.floor(elapsed / 12800) % 2 ? 'crawler' : 'fuel' })
    },
    destroy() { Object.values(effects).forEach(effect => effect.destroy()); truck.destroy(); clip.remove(); surface.remove() },
  }
}
