/** v10 闪电：三层通道和分叉、局部爆闪、余辉；剪影受光沿场景的 clipPath 裁切。 */
import { defsFor } from './defs'
import { advance, attributes, clamp, noise, svg, type Attributes, type FxHandle, type FxParams } from './svg'

export interface LightningParams extends FxParams {
  period?: number
  length?: number
  silhouetteClip?: string
  onLight?: (intensity: number) => void
}

export function create(host: SVGGElement, initial: LightningParams): FxHandle<LightningParams> {
  const defs = defsFor(host)
  const root = svg(host, 'g', { 'data-fx': 'lightning' })
  const channel = svg(root, 'g', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  const layers: Attributes[] = [
    { stroke: 'var(--wf-moon-blue)', 'stroke-width': 8, opacity: .55, filter: defs.url('blur4') },
    { stroke: 'var(--wf-ice)', 'stroke-width': 3 }, { stroke: 'var(--wf-paper)', 'stroke-width': 1.3 },
  ]
  const strokes = layers.map(attrs => ({ bolt: svg(channel, 'path', attrs), branch: svg(channel, 'path', { ...attrs, 'stroke-width': Number(attrs['stroke-width']) * .6 }) }))
  const flash = svg(root, 'ellipse', { rx: 50, ry: 35, fill: defs.url('flash') })
  const after = svg(root, 'circle', { r: 8, fill: defs.url('flash') })
  const face = svg(root, 'rect', { x: -65, y: 0, width: 130, height: 180, fill: 'var(--wf-ice)' })
  let time = 0, lastKey = ''
  function update(dt: number, p: LightningParams) {
    time = advance(time, dt, p)
    const period = Math.max(1000, p.period ?? 6000), age = time % period, cycle = Math.floor(time / period)
    const length = p.length ?? 140, key = `${cycle}:${age >= 140}:${length}`
    if (key !== lastKey) {
      lastKey = key
      const points = Array.from({ length: 14 }, (_, i) => [i && i < 13 ? (noise(i + cycle * 19, age >= 140 ? 93 : 91) - .5) * 28 : 0, i / 13 * length])
      const d = 'M' + points.map(p => p.join(' ')).join('L')
      const branch = [4, 6, 8].map((i, k) => `M${points[i].join(' ')}l${(k % 2 ? -1 : 1) * 18} 12 -5 14 10 9`).join(' ')
      strokes.forEach(nodes => { attributes(nodes.bolt, { d }); attributes(nodes.branch, { d: branch }) })
    }
    const pulse = p.reducedMotion ? .35 : age < 100 ? 1 - age / 500 : age < 140 ? 0 : age < 240 ? .8 : .24 * clamp(1 - (age - 240) / 240)
    attributes(root, { opacity: p.enabled === false ? 0 : 1 })
    attributes(channel, { opacity: pulse })
    attributes(flash, { cy: length, opacity: pulse * .8 })
    attributes(after, { cy: length, opacity: p.reducedMotion ? .2 : .4 * clamp(1 - age / 1500) })
    attributes(face, { opacity: p.silhouetteClip ? pulse * .32 : 0, 'clip-path': p.silhouetteClip ? `url(#${p.silhouetteClip})` : 'none' })
    p.onLight?.(p.enabled === false ? 0 : pulse)
  }
  update(0, initial)
  return { update, destroy() { initial.onLight?.(0); root.remove() } }
}
