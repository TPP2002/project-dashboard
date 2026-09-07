import { attributes, svg } from './svg'
import type { Detail } from '../types'

export interface FxDefs {
  id(name: string): string
  url(name: string): string
  filter(name: 'fire' | 'cloud' | 'vapor', detail?: Detail): string
  tick(elapsed: number, reduced: boolean): void
}
const cache = new WeakMap<SVGSVGElement, { node: SVGDefsElement; value: FxDefs }>()
let serial = 0

/** 每个宿主只建一次；滤镜、渐变、片段引用均带独立 wf 前缀。 */
export function ensureDefs(host: SVGSVGElement): FxDefs {
  const saved = cache.get(host)
  if (saved) return saved.value
  const prefix = `wf-${++serial}-`
  const id = (name: string) => prefix + name
  const url = (name: string) => `url(#${id(name)})`
  const root = svg(host, 'defs', { 'data-workfloor-defs': prefix })
  const paint = (name: string) => `var(--wf-${name})`
  type Stop = [number, string, number?]
  function gradient(name: string, stops: Stop[], radial = false, attrs = {}) {
    const node = svg(root, radial ? 'radialGradient' : 'linearGradient', { id: id(name), ...attrs })
    for (const [offset, color, opacity = 1] of stops) svg(node, 'stop', { offset, 'stop-color': paint(color), 'stop-opacity': opacity })
  }
  gradient('fire-outer', [[0, 'fire-orange', .9], [.5, 'fire-red', .7], [1, 'fire-red', 0]], false, { x2: 0, y2: 1 })
  gradient('fire-mantle', [[0, 'paper'], [.35, 'fire-gold'], [.7, 'fire-orange', .9], [1, 'fire-red', 0]], false, { x2: 0, y2: 1 })
  gradient('fire-core', [[0, 'paper'], [.6, 'warm'], [1, 'fire-gold', 0]], false, { x2: 0, y2: 1 })
  gradient('fire-light', [[0, 'warm', .95], [.35, 'fire-orange', .6], [1, 'fire-red', 0]], true)
  gradient('cloud-body', [[0, 'cloud-light'], [.55, 'cloud-body', .85], [1, 'cloud-mid', 0]], true, { cx: .4, cy: .35, r: .62 })
  gradient('cloud-shadow', [[0, 'cloud-shade'], [.6, 'cloud-dark', .9], [1, 'cloud-deep', 0]], true, { cx: .55, cy: .6, r: .62 })
  gradient('cloud-warm', [[0, 'fire-warm'], [.5, 'fire-orange', .75], [1, 'fire-red', 0]], true)
  gradient('cloud-cool', [[0, 'moon', .9], [1, 'moon-blue', 0]], true)
  gradient('vapor', [[0, 'paper', .95], [.5, 'ice', .55], [1, 'ice-edge', 0]], true, { cx: .45, cy: .4, r: .6 })
  gradient('vapor-shade', [[0, 'ice-shade', .7], [1, 'ice-shade', 0]], true)
  gradient('beam', [[0, 'warm', .55], [.35, 'lamp', .32], [1, 'fire-gold', 0]])
  gradient('beam-wide', [[0, 'lamp', .22], [1, 'lamp', 0]])
  gradient('lamp', [[0, 'paper'], [.3, 'lamp'], [.65, 'fire-gold', .5], [1, 'fire-gold', 0]], true)
  gradient('flash', [[0, 'paper'], [.2, 'ice', .8], [.55, 'moon-blue', .3], [1, 'moon-blue', 0]], true)
  gradient('metal', [[0, 'metal-dark'], [.18, 'metal-light'], [.55, 'metal'], [.85, 'metal-mid'], [1, 'metal-dark']])
  gradient('glass', [[0, 'metal-dark'], [.4, 'project'], [.48, 'ice'], [.55, 'metal-dark'], [1, 'moon-blue']])
  gradient('sky', [[0, 'sky'], [.7, 'sky-mid'], [1, 'horizon']], false, { x2: 0, y2: 1 })
  // 新名称仅供场景选择；原有滤镜与渐变的默认画法保持不变。
  gradient('rain-tail', [[0, 'ice', 0], [1, 'ice', .7]], false, { x2: 0, y2: 1 })
  for (const color of ['project', 'paper', 'fire-gold']) {
    gradient(`comet-${color}`, [[0, color, 0], [1, color]])
    gradient(`comet-${color}-reverse`, [[0, color, 0], [1, color]], false, { x1: 1, x2: 0 })
  }
  const glow = svg(root, 'filter', { id: id('glow'), x: '-70%', y: '-70%', width: '240%', height: '240%' })
  svg(glow, 'feGaussianBlur', { stdDeviation: 2.2, result: 'bloom' })
  const merge = svg(glow, 'feMerge')
  svg(merge, 'feMergeNode', { in: 'bloom' })
  svg(merge, 'feMergeNode', { in: 'SourceGraphic' })
  const water = svg(root, 'filter', { id: id('water'), x: '-10%', y: '-10%', width: '120%', height: '120%' })
  svg(water, 'feTurbulence', { type: 'fractalNoise', baseFrequency: '.012 .15', numOctaves: 1, seed: 31, result: 'water' })
  svg(water, 'feDisplacementMap', { in: 'SourceGraphic', in2: 'water', scale: 8, xChannelSelector: 'R', yChannelSelector: 'G' })
  for (const [name, radius] of [['soft', .8], ['blur2', 2], ['blur4', 4], ['blur6', 6], ['blur9', 9], ['blur16', 16]] as const) {
    const filter = svg(root, 'filter', { id: id(name), x: '-60%', y: '-60%', width: '220%', height: '220%' })
    svg(filter, 'feGaussianBlur', { stdDeviation: radius })
  }
  const noises: SVGFETurbulenceElement[] = []
  for (const [name, frequency, octaves, scale, seed] of [
    ['fire', '.05 .11', 2, 9, 2], ['cloud', '.016 .022', 4, 22, 11], ['vapor', '.03 .045', 3, 12, 4],
  ] as const) {
    for (const detail of ['ultra', 'standard'] as const) {
      const filter = svg(root, 'filter', { id: id(`${name}-${detail}`), x: '-40%', y: '-40%', width: '180%', height: '180%', 'color-interpolation-filters': 'sRGB' })
      const turbulence = svg(filter, 'feTurbulence', { type: 'fractalNoise', baseFrequency: frequency, numOctaves: octaves, seed, result: 'noise' })
      noises.push(turbulence)
      let input = 'SourceGraphic'
      if (name !== 'fire') {
        svg(filter, 'feColorMatrix', { in: 'noise', type: 'matrix', values: `0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 ${name === 'cloud' ? '4.2 -1.5' : '5 -2.1'}`, result: 'mask' })
        svg(filter, 'feComposite', { in: input, in2: 'mask', operator: 'in', result: 'shape' })
        input = 'shape'
      }
      if (detail === 'ultra') {
        svg(filter, 'feDisplacementMap', { in: input, in2: 'noise', scale, xChannelSelector: 'R', yChannelSelector: 'G', result: 'edge' })
        input = 'edge'
      }
      svg(filter, 'feGaussianBlur', { in: input, stdDeviation: name === 'vapor' ? 1.1 : .8 })
    }
  }
  let lastStep = -1
  const value: FxDefs = {
    id, url, filter: (name, detail = 'ultra') => url(`${name}-${detail}`),
    tick(elapsed, reduced) {
      const step = reduced ? 0 : Math.floor(elapsed / 75)
      if (step === lastStep) return
      lastStep = step
      noises.slice(0, 2).forEach(node => attributes(node, { seed: reduced ? 2 : 1 + step % 8 }))
      const wave = reduced ? 0 : Math.sin(elapsed / 1600)
      noises.slice(2, 4).forEach(node => attributes(node, { baseFrequency: `${.016 + wave * .0015} ${.022 - wave * .002}` }))
      noises.slice(4).forEach(node => attributes(node, { baseFrequency: `${.03 + wave * .003} ${.045 - wave * .003}` }))
    },
  }
  cache.set(host, { node: root, value })
  return value
}

export function removeDefs(host: SVGSVGElement) {
  cache.get(host)?.node.remove()
  cache.delete(host)
}

export function defsFor(host: SVGGElement) {
  if (!host.ownerSVGElement) throw new Error('特效宿主必须挂在 SVG 内')
  return ensureDefs(host.ownerSVGElement)
}
