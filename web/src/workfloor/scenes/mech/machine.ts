import type { Height } from '../../types'
import type { Assembly } from './assembly'
import { ORDER, byName, clsFor, seamD } from './geometry'
import { breathe, headAngle, partCenter, posePoint, scenePoint, seamRoute, type Cue } from './pose'
import { ease, required, setAttrs, svg } from './dom'
import { screenPaint, v9 } from './palette'

/** 管机体状态与工位动作；路径弧长只在建立时计算，所有画面节点固定复用。 */
export function createMachine(root: SVGGElement) {
  const parts = new Map(ORDER.map(name => [name, required<SVGGElement>(root, `[data-part="${name}"]`)]))
  const routes = new Map(ORDER.map(name => [name, seamRoute(byName[name])]))
  const mech = required<SVGGElement>(root, '[data-mech]')
  const body = required<SVGGElement>(root, '[data-body]')
  const hover = required<SVGGElement>(root, '[data-hover]')
  const seam = required<SVGPathElement>(root, '[data-seam]')
  const seams = [seam, svg(required<SVGGElement>(root, '[data-mechwrap]'), 'path', { class: 'seam', 'data-seam-ring': 1 })]
  const scan = required<SVGLineElement>(root, '[data-scan]')
  const flash = svg(hover, 'path', { fill: v9.cfff, opacity: 0, 'pointer-events': 'none' })
  const core = required<SVGCircleElement>(root, '[data-part="chest"] .glow')
  const wash = required<SVGRectElement>(root, '.wash')
  const beacons = [...root.querySelectorAll<SVGCircleElement>('.beacon')]
  const ring = [...root.querySelectorAll<SVGRectElement>('[data-seg]')]
  const rgb = required<SVGLineElement>(root, '.rgb')
  const tag = svg(root, 'g', { 'data-inspection-tag': '', opacity: 0, 'pointer-events': 'none' })
  svg(tag, 'path', { d: 'M0 0L20-20', fill: 'none', stroke: 'var(--scene-metal)', 'stroke-width': 1 })
  const paper = svg(tag, 'g', { transform: 'translate(16,-42) rotate(8)' })
  svg(paper, 'rect', { width: 64, height: 26, rx: 1, fill: v9.c1a2440, stroke: screenPaint.pend })
  svg(paper, 'circle', { cx: 4, cy: 22, r: 1.5, fill: v9.c0f1219 })
  const tagText = svg(paper, 'text', { x: 32, y: 16, 'text-anchor': 'middle', 'font-size': 9, fill: screenPaint.pend })
  let lastTarget: string | null = null
  function setAssembly(assembly: Assembly) {
    ORDER.forEach(name => setAttrs(parts.get(name)!, { class: clsFor(name, assembly.parts[name]), opacity: 1 }))
    setAttrs(mech, { class: `mech idle${assembly.mode === 'powered' ? ' powered' : ''}` })
    if (assembly.target !== lastTarget) {
      lastTarget = assembly.target
      const route = assembly.target ? routes.get(assembly.target) : undefined
      seams.forEach((node, i) => setAttrs(node, { d: route?.rings[i]?.path ?? '', pathLength: route?.rings[i]?.length || 1 }))
    }
    const hasSeam = !!assembly.target && ['build', 'pend'].includes(assembly.mode)
    seams.forEach(node => { node.style.display = hasSeam ? '' : 'none' })
    scan.style.display = hasSeam ? '' : 'none'
    ring.forEach((node, i) => setAttrs(node, { fill: i < Math.round(assembly.installed / 29 * 16) ? screenPaint.done : v9.c0b0f18 }))
  }
  function tick(assembly: Assembly, percent: number, elapsed: number, reduced: boolean, height: Height, cue: Cue | null) {
    const dy = breathe(elapsed, reduced), angle = headAngle(elapsed, reduced)
    const pose = (name: string) => name === 'head' ? `rotate(${angle},200,112)` : `translate(0,${dy})`
    setAttrs(body, { transform: `translate(0,${dy})` })
    setAttrs(parts.get('head')!, { transform: pose('head') })
    const powered = assembly.mode === 'powered'
    const lift = powered && !reduced ? 7 * (Math.cos(elapsed / 2400 * Math.PI * 2) - 1) : 0
    setAttrs(hover, { transform: `translate(0,${lift})` })
    setAttrs(core, { opacity: powered && !reduced ? .85 + .15 * Math.cos(elapsed / 1600 * Math.PI * 2) : 1 })
    setAttrs(rgb, { 'stroke-dashoffset': reduced ? 0 : -(elapsed / 9000 * 400) % 400 })
    const alarm = assembly.mode === 'block'
    const blink = reduced ? 1 : .725 + .275 * Math.cos(elapsed / (alarm ? 700 : 1200) * Math.PI * 2)
    if (assembly.target) setAttrs(parts.get(assembly.target)!, { opacity: ['pend', 'block'].includes(assembly.mode) ? blink : 1 })
    setAttrs(wash, { opacity: alarm ? reduced ? .1 : .07 + .03 * blink : 0 })
    beacons.forEach((node, i) => setAttrs(node, { opacity: alarm ? reduced ? 1 : .7 + .3 * Math.cos(elapsed / 450 * Math.PI * 2 + i * .12) : .35 }))
    let weldingPoint: { x: number; y: number } | null = null
    if (assembly.target) {
      const target = assembly.target
      const route = routes.get(target)!, bb = route.bounds
      // SVG 子路径会各自重启虚线；裙甲的两环必须分摊同一份进度弧长。
      seams.forEach((node, i) => {
        const length = route.revealed(percent, i)
        setAttrs(node, { 'stroke-dasharray': `${length} ${(route.rings[i]?.length ?? 0) + 1}`,
          visibility: length > 0 ? 'visible' : 'hidden', transform: pose(target) })
      })
      const y = bb.y + bb.height * (reduced ? .5 : (1 - Math.cos(elapsed / 2800 * Math.PI * 2)) / 2)
      setAttrs(scan, { x1: bb.x - 6, x2: bb.x + bb.width + 6, y1: y, y2: y,
        stroke: assembly.mode === 'pend' ? screenPaint.pend : v9.c7ff0ff, transform: pose(target) })
      weldingPoint = scenePoint(posePoint(route.at(percent), assembly.target, elapsed, reduced), height)
    }
    const fresh = cue?.kind === 'done' && cue.part && !reduced && cue.age < 700
    setAttrs(flash, { d: fresh ? seamD(byName[cue.part!]) : '', opacity: fresh ? .9 * (1 - ease(cue.age / 700)) : 0,
      transform: fresh ? pose(cue.part!) : 'translate(0,0)' })
    const stamping = cue?.kind === 'go' && cue.part && cue.age < 700 && !reduced
    const inspecting = assembly.mode === 'pend' && assembly.target
    if (inspecting || stamping) {
      const name = inspecting ? assembly.target! : cue!.part!
      const center = partCenter(name, height)
      setAttrs(tag, { transform: `translate(${center.x + 20},${center.y})`, opacity: inspecting ? 1 : 1 - ease(cue!.age / 700) })
      tagText.textContent = inspecting ? 'INSPECT?' : 'GO'
      setAttrs(tagText, { fill: inspecting ? screenPaint.pend : screenPaint.powered })
    } else setAttrs(tag, { opacity: 0 })
    return weldingPoint
  }
  return { setAssembly, tick }
}
