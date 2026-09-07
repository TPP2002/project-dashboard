import { attributes, svg } from '../../fx/svg'
import { TOWER_X } from './layout'
import type { Site } from './site'

/** clipPath 的 use 必须指向实体图元；引用整个 g 在部分浏览器里会得到空剪影。 */
export function bindSurfaces(site: Site) {
  let serial = 0, lastMechanics = '', lastRocket = ''
  const bindings: { use: SVGUseElement; parents: SVGElement[]; origin: string; movingRocket: boolean }[] = []
  const tower = site.get('[data-main-tower]'), rocket = site.get(`#${site.id('main-rocket-hull')}`)
  const fixed = [tower, site.get(`#${site.id('main-mount')}`), site.get(`#${site.id('main-front-clamps')}`), site.get(`#${site.id('main-rear-clamps')}`)]
  function bind(name: string, groups: SVGElement[], origin = '') {
    const clip = site.get<SVGClipPathElement>(`#${site.id(name)}`)
    for (const group of groups) for (const shape of group.querySelectorAll<SVGElement>('.pl')) {
      if (!shape.id) attributes(shape, { id: site.id(`lit-${serial++}`) })
      const use = svg(clip, 'use', { href: '#' + shape.id })
      const parents: SVGElement[] = []
      for (let parent: Element | null = shape.parentElement; parent && parent !== site.root; parent = parent.parentElement) {
        if (parent instanceof SVGElement) parents.unshift(parent)
      }
      bindings.push({ use, parents, origin, movingRocket: group === rocket })
    }
  }
  bind('tower-clip', [tower]); bind('rocket-clip', [rocket]); bind('warm-clip', fixed)
  bind('storm-clip', [tower, rocket], `translate(${-TOWER_X},-65)`)
  return (mechanics: string, rocketPose: string) => {
    const moved = rocketPose !== lastRocket, hinged = mechanics !== lastMechanics
    if (!moved && !hinged) return
    lastMechanics = mechanics; lastRocket = rocketPose
    const transforms = new Map<SVGElement, string>()
    for (const { use, parents, origin, movingRocket } of bindings) {
      if (!(movingRocket ? moved : hinged)) continue
      const matrix = parents.map(parent => {
        if (!transforms.has(parent)) transforms.set(parent, parent.getAttribute('transform') ?? '')
        return transforms.get(parent)!
      })
      attributes(use, { transform: [origin, ...matrix].join(' ') })
    }
  }
}
