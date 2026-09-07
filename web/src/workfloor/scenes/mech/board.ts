import { ORDER, DRAW, P, byName } from './geometry'
import { v9, screenPaint } from './palette'
import type { SceneEvent, SceneState } from '../../types'
import type { Assembly } from './assembly'
import { actionLabel } from './assembly'
import { ease, required, setAttrs, svg, taskLabel } from './dom'

export function consoleSvg() {
  return `<g class="console" data-board transform="translate(92,150)">
    <path d="M4 6H334V220H4Z" fill="url(#gDark)" opacity=".8"/><rect width="330" height="216" rx="5" fill="url(#gHousing)" stroke="var(--scene-ink)" stroke-width="2"/><path d="M5 2H325 M2 5V209" stroke="var(--scene-light)" opacity=".3"/><rect x="8" y="8" width="314" height="194" rx="3" fill="url(#gDark)" stroke="var(--scene-metal)"/>
    <g clip-path="url(#clipConsoleGlass)"><rect x="12" y="12" width="306" height="186" fill="${v9.c070a10}"/><rect x="12" y="12" width="306" height="186" fill="url(#gScreenBloom)"/>
      <g fill="${v9.c34d7ff}"><text class="title" x="20" y="29">ASSEMBLY // BAY 02</text><circle class="rec" cx="226" cy="25" r="2"/><text class="caption" x="232" y="29">REC</text><text class="caption" x="310" y="29" text-anchor="end" data-clock>00:00:00</text>
      <path d="M20 36H310 M113 42V189" fill="none" stroke="var(--scene-light)" opacity=".18"/><rect x="20" y="42" width="85" height="147" fill="url(#pScreenGrid)"/>
      <g transform="translate(20,46) scale(.208)" filter="url(#fglow)" data-sil></g><text class="caption" x="23" y="193">UNIT / 02</text>
      <text x="122" y="82" font-size="48" font-weight="800" data-pct>58%</text><text class="caption" x="306" y="52" text-anchor="end" data-count></text>
      <g data-progress>${ORDER.map((n, i) => `<rect class="progress-segment off" data-progress-part="${n}" x="${122 + i * 6.3}" y="93" width="4.7" height="8" rx=".6" fill="${screenPaint.off}"/>`).join('')}</g>
      <circle cx="125" cy="115" r="2.5" data-status-led/><text x="134" y="119" data-status>STANDBY</text><path d="M122 125H306 M122 172H306" stroke="var(--scene-light)" opacity=".16"/>
      <g clip-path="url(#clipConsoleEvents)"><g transform="translate(123,138)" class="caption" data-events></g></g>
      <g clip-path="url(#clipConsoleScope)"><path d="M122 183H306" stroke="var(--scene-light)" opacity=".13"/><polyline class="scope-wave" data-scope points="122,183 130,183 134,181 138,185 142,183 150,183 153,177 157,190 161,180 164,183 177,183 182,181 186,185 190,183 198,183 202,178 206,189 210,180 214,183 230,183 234,181 238,185 242,183 250,183 254,177 258,190 262,180 266,183 280,183 284,181 288,185 292,183 299,183 302,179 306,183"/></g></g>
      <rect x="12" y="12" width="306" height="186" fill="url(#pScreenLines)" pointer-events="none"/><path d="M12 12H80L226 198H170Z" fill="var(--scene-paper)" opacity=".05" pointer-events="none"/>
    </g>
    ${[[5, 5], [325, 5], [5, 210], [325, 210]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.8" fill="url(#gGrey)" stroke="var(--scene-ink)"/><path d="M${x - 1.5} ${y}h3 M${x} ${y - 1.5}v3" stroke="var(--scene-ink)" stroke-width=".8"/>`).join('')}
    <rect x="18" y="203" width="228" height="10" rx="1" fill="url(#gDark)"/><text class="caption" x="24" y="211" fill="url(#gVisor)">ASSEMBLY CONSOLE · BAY 02</text>
    ${[277, 301].map((x, i) => `<circle cx="${x}" cy="209" r="5" fill="url(#gDark)"/><circle cx="${x}" cy="207" r="4" fill="url(#${i ? 'gVisor' : 'gRed'})" stroke="var(--scene-ink)"/><path d="M${x - 2} 205h4" stroke="var(--scene-light)" opacity=".5"/>`).join('')}
  </g>`
}

/** 大屏只读投影结果。日志池只接实时事件，不伪造历史或计数。 */
export function createBoard(root: SVGGElement) {
  const consoleRoot = required<SVGGElement>(root, '[data-board]')
  const silhouette = required<SVGGElement>(root, '[data-sil]')
  const screen = new Map(DRAW.map(name => [name, svg(silhouette, 'polygon', {
    points: P(byName[name].main), 'data-screen-part': name,
  })]))
  const bars = new Map(ORDER.map(name => [name, required<SVGRectElement>(root, `[data-progress-part="${name}"]`)]))
  const events = required<SVGGElement>(root, '[data-events]')
  const rows = Array.from({ length: 4 }, () => svg(events, 'text', { class: 'console-event', 'xml:space': 'preserve', opacity: 0 }))
  const pct = required<SVGTextElement>(root, '[data-pct]')
  const count = required<SVGTextElement>(root, '[data-count]')
  const status = required<SVGTextElement>(root, '[data-status]')
  const led = required<SVGCircleElement>(root, '[data-status-led]')
  const scope = required<SVGPolylineElement>(root, '[data-scope]')
  const clock = required<SVGTextElement>(root, '[data-clock]')
  const rec = required<SVGCircleElement>(root, '.rec')
  let log: string[] = [], eventAge = 350, lastSecond = -1
  let powered = false, flashing: string | null = null, mode = 'ready'
  function update(state: SceneState, assembly: Assembly) {
    powered = state.complete
    mode = assembly.mode
    flashing = assembly.target
    for (const name of ORDER) {
      const part = assembly.parts[name], color = screenPaint[part]
      setAttrs(screen.get(name)!, { class: `screen-part ${part}`, fill: color, opacity: part === 'off' ? .3 : 1 })
      setAttrs(bars.get(name)!, { class: `progress-segment ${part}`, fill: color, opacity: 1 })
    }
    pct.textContent = `${state.percent}%`
    count.textContent = `PARTS ${assembly.installed}/${ORDER.length}`
    const color = powered ? screenPaint.powered : mode === 'block' ? screenPaint.block
      : mode === 'pend' ? screenPaint.pend : mode === 'park' ? screenPaint.park : screenPaint.done
    status.textContent = actionLabel(assembly)
    setAttrs(status, { fill: color })
    setAttrs(led, { fill: color })
    setAttrs(scope, { stroke: powered ? screenPaint.powered : screenPaint.done })
    setAttrs(consoleRoot, { class: `console${powered ? ' powered' : ''}` })
  }
  function handleEvent(event: SceneEvent, animate: boolean) {
    const labels = { claim: 'CLAIM', progress: 'WELD', hold: 'INSPECT', go: 'RESUME', block: 'JAMMED', park: 'PAUSED', done: 'DONE', complete: 'POWER ON' }
    const detail = event.kind === 'progress' ? ` ${event.percent}%` : ''
    const text = `${labels[event.kind].padEnd(7)} ${event.taskId ? taskLabel(event.taskId) : ''}${detail}`.trimEnd()
    log = [...log, text].slice(-4)
    eventAge = animate ? 0 : 350
    rows.forEach((row, i) => { row.textContent = log[i] ?? '' })
    arrange(!animate)
  }
  function arrange(reduced: boolean) {
    const t = reduced ? 1 : ease(eventAge / 350)
    rows.forEach((row, i) => {
      const slot = i - Math.max(0, log.length - 3)
      setAttrs(row, { transform: `translate(0,${slot * 14 + (1 - t) * 14})`,
        opacity: i >= log.length ? 0 : slot < 0 ? .55 * (1 - t) : (.55 + slot * .2) * (i === log.length - 1 ? t : 1) })
    })
  }
  function tick(dt: number, elapsed: number, reduced: boolean) {
    if (eventAge < 350 || reduced) { eventAge = Math.min(350, eventAge + dt); arrange(reduced) }
    setAttrs(scope, { 'stroke-dashoffset': reduced ? 0 : -(elapsed / 1800 * 106) % 106,
      transform: powered ? 'translate(0,-118.95) scale(1,1.65)' : 'scale(1)' })
    const blink = reduced ? 1 : .725 + .275 * Math.cos(elapsed / (mode === 'block' ? 700 : 1200) * Math.PI * 2)
    setAttrs(rec, { opacity: blink })
    if (flashing && ['build', 'pend'].includes(mode)) {
      setAttrs(screen.get(flashing)!, { opacity: blink })
      setAttrs(bars.get(flashing)!, { opacity: blink })
    }
    const second = Math.floor(elapsed / 1000)
    if (second !== lastSecond) {
      lastSecond = second
      // 墙钟只作展示，不参与焊缝、事件合并或装配真相。
      const now = new Date()
      clock.textContent = [now.getHours(), now.getMinutes(), now.getSeconds()].map(v => String(v).padStart(2, '0')).join(':')
    }
  }
  return { update, handleEvent, tick }
}
