import { ensureDefs } from '../../fx'
import { svg, attributes, noise } from '../../fx/svg'
import type { DayNight, Detail } from '../../types'
import { materials } from './materials'
import { skySeaSvg, lighthouseSvg, groundSvg, roadLightsSvg } from './coast'
import { vabSvg, tanksSvg, commandSvg } from './buildings'
import { foregroundSvg } from './foreground'
import { padSvg } from './pad'
import { rocketSvg } from './rocket'
import { crawlerSvg, supportSvg, truckSvg } from './vehicles'
import { applyPalette } from './palette'
import { SEA_SHAPE, TRUCK_PATH } from './layout'

export type Site = ReturnType<typeof createSite>

/** 首次创建后仅返回现有节点；所有片段引用均在本宿主内独立命名。 */
export function createSite(host: SVGSVGElement) {
  const defs = ensureDefs(host), prefix = defs.id('launch-')
  const root = svg(host, 'g', { 'data-launch-root': prefix, 'data-workfloor-scene': 'launch' })
  const id = (name: string) => prefix + name
  const shared: Record<string, string> = { fglow: defs.id('glow'), fsoft: defs.id('blur6'), fMist: defs.id('blur2'), fReflection: defs.id('water'), gBeam: defs.id('beam') }
  const reference = (name: string) => shared[name] ?? id(name)
  const localize = (value: string) => value.replace(/\bid="([\w-]+)"/g, (_, name: string) => `id="${id(name)}"`)
    .replace(/url\(#([\w-]+)\)/g, (_, name: string) => `url(#${reference(name)})`)
    .replace(/href="#([\w-]+)"/g, (_, name: string) => `href="#${reference(name)}"`)
  const scope = `[data-launch-root="${prefix}"]`
  const rules: Record<string, string> = {
    '.pl': 'stroke:var(--launch-ink);stroke-width:1.1;stroke-linejoin:round;vector-effect:non-scaling-stroke',
    '.pl.main': 'stroke-width:2.2', '.hi': 'fill:var(--launch-paper);fill-opacity:.28;stroke:none',
    '.sh': 'fill:var(--launch-black);fill-opacity:.32;stroke:none',
    '.ln': 'fill:none;stroke:var(--launch-ink);stroke-opacity:.75;stroke-width:1.1;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke',
    '.riv': 'fill:var(--launch-ink);fill-opacity:.8;stroke:none',
    '.edge': 'fill:none;stroke:var(--launch-light);stroke-width:.8;opacity:.28;vector-effect:non-scaling-stroke',
    'text': 'font-family:ui-monospace,Consolas,monospace;fill:var(--launch-muted)',
    '.decal': 'fill:var(--launch-ice);font-weight:700;letter-spacing:.06em',
    '.signal': 'fill:var(--launch-signal,var(--launch-cyan))',
    '.glow': 'filter:url(#fglow)', '.tread': 'stroke-dasharray:2 4',
    'circle[fill="var(--launch-red)"]': 'filter:url(#fglow)',
    'circle[fill="var(--launch-warm)"]': 'filter:url(#fglow)',
    'rect[fill="var(--launch-warm)"]': 'filter:url(#fglow)',
    '.frost': 'opacity:var(--launch-frost,0)', '.frost-ring': 'opacity:var(--launch-frost,0)',
    '.scene-grain': 'opacity:.035;pointer-events:none;mix-blend-mode:overlay',
    '[fill="url(#pPegboard)"]': 'opacity:.08', '[fill="url(#pDiamond)"]': 'opacity:.08',
    '[fill="url(#pHazard)"]': 'opacity:.08', '[stroke="url(#pHazard)"]': 'opacity:.08',
  }
  const style = `<style>${Object.entries(rules).map(([selector, body]) => `${scope} ${selector}{${body}}`).join('\n')}</style>`
  const lightMaterials = `<defs>
    <linearGradient id="gWarmFace" x2="0" y2="1"><stop stop-color="var(--launch-amber)" stop-opacity="0"/><stop offset=".6" stop-color="var(--launch-amber)"/><stop offset="1" stop-color="var(--launch-red)"/></linearGradient>
    <radialGradient id="gLaunchLight"><stop stop-color="var(--launch-warm)"/><stop offset=".2" stop-color="var(--launch-amber)" stop-opacity=".85"/><stop offset=".7" stop-color="var(--launch-red)" stop-opacity=".2"/><stop offset="1" stop-color="var(--launch-red)" stop-opacity="0"/></radialGradient>
  </defs>`
  // 所有输入均为审定几何；实时任务标题和编号由后续 textContent 写入。
  root.innerHTML = localize(style + materials + lightMaterials + skySeaSvg() + lighthouseSvg() + groundSvg() + vabSvg() + tanksSvg() + commandSvg() +
    `<g data-waiting-vehicle>${crawlerSvg()}</g><g data-waiting-rocket>${rocketSvg()}</g>
     <g data-rollout-vehicle>${crawlerSvg()}</g><g data-rollout-rocket>${rocketSvg()}</g>` + padSvg() +
    `<path data-truck-route d="${TRUCK_PATH}" fill="none" visibility="hidden"/><g data-truck>${truckSvg()}</g>` + roadLightsSvg() + foregroundSvg() +
    `<g id="firework-source" data-fireworks/><g data-rain/>
     <g data-water-flash clip-path="url(#clipSea)"/>
     <rect class="scene-grain" width="1400" height="520" fill="url(#pSceneGrain)"/>`)
  function get<T extends SVGElement = SVGGElement>(selector: string, parent: SVGElement = root): T {
    const node = parent.querySelector<T>(selector)
    if (!node) throw new Error(`发射场缺少挂点: ${selector}`)
    return node
  }
  const all = <T extends SVGElement = SVGElement>(selector: string) => Array.from(root.querySelectorAll<T>(selector))
  const stock = get('[data-stock]')
  stock.innerHTML = localize([2, 1, 0].map(i => `<g data-stock-slot="${i}"><ellipse cy="195" rx="26" ry="4" fill="var(--launch-black)" opacity=".35"/>${rocketSvg()}<g transform="translate(0,190)">${supportSvg()}</g></g>`).join(''))
  const stockSlots = all<SVGGElement>('[data-stock-slot]').sort((a,b) => Number(a.dataset.stockSlot) - Number(b.dataset.stockSlot))
  function localSeaClip(name: string, x: number, y: number) {
    const clip = svg(get<SVGDefsElement>('defs'), 'clipPath', { id: id(name), clipPathUnits: 'userSpaceOnUse' })
    svg(clip, 'path', { d: SEA_SHAPE, transform: `translate(${-x},${-y})` })
    return id(name)
  }
  const waves = all('.wave'), stars = all('.star'), beacons = all('.aviation, .buoy-light')
  const windows = all('.windows rect'), flags = all('.flag-cloth'), foam = get('.foam'), rgb = get('.rgb'), dish = get('.dish-turn')
  const moon = get(`#${id('moon-source')}`), halo = get('[data-moon-halo]'), reflections = get('[data-reflections]')
  let dayNight: DayNight = 'night'
  function setDayNight(value: DayNight) {
    dayNight = value; applyPalette(root, value)
    attributes(moon, { opacity: value === 'night' ? 1 : 0 }); attributes(halo, { opacity: value === 'night' ? 1 : 0 })
  }
  function ambient(elapsed: number, reduced: boolean, phase: string) {
    const t = reduced ? 0 : elapsed, night = dayNight === 'night'
    waves.forEach((node, i) => attributes(node, { transform: `translate(${Math.sin(t / [19000,25000,32000][i] + i) * 26},0)` }))
    stars.forEach((node, i) => attributes(node, { opacity: night ? .28 + .5 * (reduced ? noise(i, 9) : .5 + .5 * Math.sin(t / (4100+i*231) + i)) : 0,
      filter: i % 5 === 0 ? defs.url('glow') : 'none' }))
    beacons.forEach((node, i) => attributes(node, { opacity: (night ? 1 : .35) * (reduced ? .6 : .35+.65*Math.max(0,Math.sin(t/600+i*2))) }))
    windows.forEach((node, i) => attributes(node, { fill: phase === 'HOLD' || phase === 'SCRUB' ? 'var(--launch-signal)' : `var(--launch-${i%2?'blue':'cyan'})`,
      opacity: (night ? 1 : .4) * (reduced ? .75 : .6+.3*Math.sin(t/2200+i*1.7)) }))
    flags.forEach((node, i) => attributes(node, { transform: reduced ? '' : `translate(${i?352:40},0) skewY(${Math.sin(t/460+i)*3}) scale(${.95+.05*Math.sin(t/530+i)},1) translate(${i?-352:-40},0)` }))
    attributes(foam, { transform: `translate(${Math.sin(t/4300)*1.5},${-Math.sin(t/3300)})`, opacity: .25+.07*Math.sin(t/3200) })
    attributes(rgb, { 'stroke-dashoffset': reduced ? 0 : -t/35, opacity: night ? .9 : .3 })
    attributes(dish, { transform: `rotate(${Math.sin(t/14000)*9},646,257)` })
  }
  function setDetail(value: Detail) { attributes(reflections, { filter: value === 'ultra' ? defs.url('water') : 'none' }) }
  return { root, id, defs, get, all, stockSlots, localSeaClip, setDayNight, ambient, setDetail, destroy: () => root.remove() }
}
