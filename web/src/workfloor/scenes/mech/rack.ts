import type { SceneState } from '../../types'
import { ORDER, byName, bounds, P, type Points } from './geometry'
import { required, setAttrs, svg } from './dom'
import { screenPaint } from './palette'

const shelfY = (row: number) => 78 + row * 78
const rackCode = (i: number) => String.fromCharCode(65 + Math.floor(i / 4)) + (i % 4 + 1)

export function rackSvg() {
  return `<g data-rack transform="translate(1040,150)">
    <path d="M0 0H292L302-6H10Z" fill="url(#gGrey)" stroke="var(--scene-ink)"/><path d="M292 0L302-6V250L292 256Z" fill="url(#gDark)"/>
    <rect width="292" height="250" fill="url(#gGreyD)" stroke="var(--scene-ink)" stroke-width="2"/><rect x="12" y="8" width="268" height="234" fill="url(#pRackBrush)"/><rect x="12" y="8" width="268" height="234" fill="url(#pPegboard)"/>
    ${[0, 280].map(x => `<g><rect x="${x}" width="12" height="250" fill="url(#gGrey)" stroke="var(--scene-ink)"/><path d="M${x + 2} 1V249" stroke="var(--scene-light)" opacity=".25"/>${Array.from({ length: 10 }, (_, i) => `<rect x="${x + 4}" y="${12 + i * 24}" width="4" height="7" rx="2" fill="url(#gDark)"/><circle cx="${x + 6}" cy="${14 + i * 24}" r="1" fill="var(--scene-ink)"/>`).join('')}</g>`).join('')}
    <path d="M12 4H42L12 30Z M280 4H250L280 30Z" fill="url(#gGrey)" stroke="var(--scene-ink)"/><g fill="url(#gDark)"><circle cx="19" cy="10" r="2"/><circle cx="273" cy="10" r="2"/></g>
    <g transform="translate(38,-42)"><rect width="216" height="34" rx="2" fill="url(#gHousing)" stroke="var(--scene-ink)"/><rect x="2" y="2" width="212" height="30" fill="url(#pPegboard)"/>
      ${[16, 45].map((x, i) => `<g transform="translate(${x},4) rotate(${i ? 12 : -12},6,10)"><path d="M3 1L0 5 3 10 5 10 5 23Q7 27 9 23V10L12 5 9 1 9 6 5 6 5 1Z" fill="url(#gGrey)" stroke="var(--scene-ink)" stroke-width=".8"/><path d="M6 12V22" stroke="var(--scene-light)" opacity=".3"/></g>`).join('')}
      <g fill="none" stroke="var(--scene-metal)" stroke-width="2"><ellipse cx="108" cy="18" rx="17" ry="10"/><ellipse cx="108" cy="18" rx="13" ry="8"/><ellipse cx="108" cy="18" rx="9" ry="6"/><path d="M122 21q14 10 18 3"/></g>
      <path d="M163 11H184L191 16 185 20 176 17 172 29 165 27 168 17H162Z" fill="url(#gGrey)" stroke="var(--scene-ink)"/><path d="M189 17h10l3-5 M165 26q-9 6-19 2" fill="none" stroke="var(--scene-metal)" stroke-width="2"/>
      <path d="M22 2v4 M51 2v4 M108 3v5 M173 2v6" stroke="var(--scene-light)" stroke-width="1.5" opacity=".45"/>
    </g>
    ${[0, 1, 2].map(row => { const y = shelfY(row); return `<path d="M12 ${y + 8}H280V${y + 15}H12Z" fill="url(#gDark)" opacity=".75"/><path d="M12 ${y - 4}H280L288 ${y + 2}H4Z" fill="url(#gGrey)" stroke="var(--scene-ink)"/><rect x="4" y="${y + 2}" width="284" height="9" fill="url(#gHousing)" stroke="var(--scene-ink)"/><path d="M5 ${y + 2}H287" stroke="var(--scene-light)" stroke-width="1" opacity=".55"/>
      ${[0, 1, 2, 3].map(col => `<g transform="translate(${28 + col * 68},${y + 3})"><rect width="39" height="7" rx=".7" fill="url(#gLabel)"/><g stroke="var(--scene-ink)">${[0, 2, 5, 6, 9, 13, 15].map((x, k) => `<path d="M${3 + x} 1V6" stroke-width="${k % 3 === 0 ? 1.6 : .65}"/>`).join('')}</g><text x="23" y="6" font-family="ui-monospace,Consolas,monospace" font-size="7" fill="url(#gDark)">${rackCode(row * 4 + col)}</text></g>`).join('')}` }).join('')}
    <g data-rack-items></g><rect x="-3" y="249" width="298" height="11" fill="url(#gGreyD)" stroke="var(--scene-ink)"/><rect x="6" y="251" width="256" height="6" fill="url(#pHazard)"/>
    <path d="M1 260H22V265H1Z M270 260H292V265H270Z" fill="url(#gDark)"/><circle cx="279" cy="254" r="4" fill="url(#gDark)"/><circle cx="279" cy="253" r="2" fill="var(--console-on)" filter="url(#fglow)"/>
    <text x="12" y="278" font-family="ui-monospace,Consolas,monospace" font-size="11" fill="url(#gGrey)" letter-spacing="3">PARTS / STORES</text><g data-rack-overflow visibility="hidden"><rect x="240" y="3" width="36" height="12" fill="url(#gLabel)"/><text x="258" y="12" text-anchor="middle" font-family="ui-monospace,Consolas,monospace" font-size="9" fill="url(#gDark)" data-rack-extra></text></g>
  </g>`
}

/** 十二个货位一次建立；更换任务只换轮廓和吊牌，不在刷新或帧内重建。 */
export function createRack(root: SVGGElement, prefix: string) {
  const parent = required<SVGGElement>(root, '[data-rack-items]')
  const url = (id: string) => `url(#${prefix}${id})`
  const slots = Array.from({ length: 12 }, (_, i) => {
    const group = svg(parent, 'g', { 'data-stock-slot': i })
    const shadow = svg(group, 'ellipse', { ry: 2.2, fill: url('gDark'), opacity: .8 })
    const shape = svg(group, 'g')
    const plate = svg(shape, 'polygon', { fill: url('gBlueD'), stroke: 'var(--scene-ink)', 'stroke-width': 1.3, 'vector-effect': 'non-scaling-stroke' })
    const edge = svg(shape, 'polyline', { fill: 'none', stroke: 'var(--scene-light)', 'stroke-width': 1, opacity: .65, 'vector-effect': 'non-scaling-stroke' })
    const cord = svg(group, 'path', { fill: 'none', stroke: 'var(--scene-metal)' })
    const tag = svg(group, 'g')
    const label = svg(tag, 'rect', { width: 10, height: 14, rx: 1, stroke: 'var(--scene-ink)' })
    svg(tag, 'circle', { cx: 3, cy: 3, r: 1, fill: url('gDark') })
    svg(tag, 'path', { d: 'M2 7H8 M2 10H6', stroke: 'var(--scene-light)', 'stroke-width': .6, opacity: .6 })
    return { group, shadow, shape, plate, edge, cord, tag, label }
  })
  const overflow = required<SVGGElement>(root, '[data-rack-overflow]')
  const extra = required<SVGTextElement>(root, '[data-rack-extra]')
  let positions = new Map<string, { x: number; y: number }>()
  let previous = positions
  let fingerprint = ''
  function update(state: SceneState, installed: number) {
    const waiting = state.active.slice(1)
    const tasks = [...waiting, ...state.queued]
    const key = `${installed}|${waiting.length}|${tasks.map(task => task.id).join('|')}`
    if (key === fingerprint) return
    fingerprint = key
    previous = positions
    positions = new Map()
    slots.forEach((slot, i) => {
      const task = tasks[i]
      setAttrs(slot.group, { visibility: task ? 'visible' : 'hidden', 'data-task-id': task?.id ?? '' })
      if (!task) return
      const name = ORDER[(installed + i) % ORDER.length]
      const pts = byName[name].main, bb = bounds(pts)
      const scale = Math.min(49 / bb.width, 54 / bb.height, .9)
      const cx = 48 + i % 4 * 68, base = shelfY(Math.floor(i / 4))
      const edge: Points = pts.map((p, k): Points => [p, pts[(k + 1) % pts.length]])
        .sort((a, b) => a[0][1] + a[1][1] - b[0][1] - b[1][1])[0]
      setAttrs(slot.group, { 'data-stock': name, 'data-waiting': i < waiting.length ? 'true' : 'false' })
      setAttrs(slot.shadow, { cx, cy: base, rx: bb.width * scale / 2 + 3 })
      setAttrs(slot.shape, { transform: `translate(${cx - bb.width * scale / 2},${base - bb.height * scale}) scale(${scale}) translate(${-bb.x},${-bb.y})` })
      setAttrs(slot.plate, { points: P(pts) })
      setAttrs(slot.edge, { points: P(edge) })
      setAttrs(slot.cord, { d: `M${cx + bb.width * scale / 3} ${base - 12}L${cx + 24} ${base - 16}` })
      setAttrs(slot.tag, { transform: `translate(${cx + 22},${base - 18}) rotate(8)` })
      setAttrs(slot.label, { fill: i < waiting.length ? screenPaint.build : url('gGrey') })
      positions.set(task.id, { x: 1040 + cx, y: 150 + base - bb.height * scale / 2 })
    })
    setAttrs(overflow, { visibility: tasks.length > 12 ? 'visible' : 'hidden' })
    extra.textContent = tasks.length > 12 ? `+${tasks.length - 12}` : ''
  }
  return { update, takePoint: (id: string) => previous.get(id) ?? positions.get(id) ?? { x: 1090, y: 200 } }
}
