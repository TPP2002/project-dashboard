import { mechSvg } from './geometry'
import { v9 } from './palette'
import { rackSvg } from './rack'
import { consoleSvg } from './board'
import { DEFS, scenePaint, applyPalette } from './palette'
import { SCENE_DEFS } from './materials'
import { sceneStyles } from './styles'
import { namespaced, required, setAttrs, svg } from './dom'
import { rigTransform } from './pose'
import type { Height } from '../../types'

export function hangarSvg() { return `
  <rect width="1400" height="520" fill="url(#gWall)"/>
  <rect width="1400" height="400" fill="url(#pWallBrush)"/>
  <g fill="none" stroke-width="1">${Array.from({ length: 60 }, (_, i) => { const x = (i % 12) * 120 + 2, row = Math.floor(i / 12), y = [2, 62, 152, 242, 332][row], h = [56, 86, 86, 86, 66][row]; return `<path d="M${x} ${y + h}V${y}H${x + 115}" stroke="var(--scene-light)" opacity=".12"/><path d="M${x + 115} ${y}V${y + h}H${x}" stroke="var(--scene-ink)" opacity=".8"/>` }).join('')}</g>
  <g fill="var(--scene-ink)" opacity=".18">${[[367, 164], [1220, 254], [728, 71], [129, 338], [964, 345]].map(([x, y], i) => `<path d="M${x} ${y}l${22 + i * 3} -5 18 10 -8 17 -19 4 -12 -9 -11 3Z"/>`).join('')}</g>
  <g opacity=".9">${Array.from({ length: 12 }, (_, i) => `<line x1="${i * 120}" y1="0" x2="${i * 120}" y2="400" stroke="${v9.c0c1019}" stroke-width="3"/>`).join('')}${Array.from({ length: 4 }, (_, i) => `<line x1="0" y1="${60 + i * 90}" x2="1400" y2="${60 + i * 90}" stroke="${v9.c0c1019}" stroke-width="2"/>`).join('')}</g>
  <g fill="${v9.c2a3346}">${Array.from({ length: 60 }, (_, i) => `<circle cx="${(i % 12) * 120 + 8}" cy="${Math.floor(i / 12) * 90 + 68}" r="2.2"/><circle cx="${(i % 12) * 120 + 112}" cy="${Math.floor(i / 12) * 90 + 68}" r="2.2"/>`).join('')}</g>
  <text x="40" y="150" font-family="ui-monospace,Consolas,monospace" font-size="120" font-weight="800" fill="${v9.c1c2436}" opacity=".9">BAY 02</text>
  <rect x="0" y="14" width="1400" height="10" fill="${v9.c222a3a}"/><rect x="0" y="24" width="1400" height="4" fill="${v9.c0f131c}"/>
  <line class="rgb" x1="0" y1="30" x2="1400" y2="30" stroke="url(#gRgb)" stroke-width="3" stroke-dasharray="120 60" opacity=".7"/>
  <g stroke="${v9.c3a4458}" stroke-width="6" fill="none"><path d="M0 46 H 520 Q 540 46 540 66 V 96"/><path d="M1400 52 H 980 Q 960 52 960 72 V 96"/></g>
  <g stroke="var(--scene-light)" stroke-width="1" fill="none" opacity=".35"><path d="M0 44H520Q538 44 538 66V96"/><path d="M1400 50H980Q958 50 958 72V96"/></g>
  <g fill="url(#gGrey)" stroke="var(--scene-ink)" stroke-width=".8">${[[130, 46], [360, 46], [1030, 52], [1280, 52]].map(([x, y]) => `<rect x="${x}" y="${y - 5}" width="3" height="10"/><rect x="${x + 7}" y="${y - 5}" width="3" height="10"/>`).join('')}<rect x="534" y="81" width="12" height="3"/><rect x="534" y="88" width="12" height="3"/><rect x="954" y="82" width="12" height="3"/><rect x="954" y="89" width="12" height="3"/></g>
  <g fill="${v9.cc9a227}"><rect x="536" y="70" width="8" height="8"/><rect x="956" y="76" width="8" height="8"/></g>
  <g stroke="${v9.c2a3346}" stroke-width="3" fill="none"><path d="M300 28 q 20 120 -10 260"/><path d="M1120 28 q -30 140 20 260"/></g>
  <g stroke="var(--scene-metal)" stroke-width=".6" fill="none" opacity=".45"><path d="M299 28q20 120-10 260"/><path d="M1119 28q-30 140 20 260"/></g>
  <g>${[[250, 56], [700, 48], [1150, 56]].map(([x, y]) => `<g data-ceiling-beam transform="translate(${x},${y + 20}) rotate(90)"></g><path d="M${x - 26} ${y}h52l-5 22h-42Z" fill="url(#gGreyD)" stroke="var(--scene-ink)"/><path d="M${x - 21} ${y + 4}h42l-4 14h-34Z" fill="url(#gGold)" opacity=".5"/><g data-lamp-emission><rect x="${x - 18}" y="${y + 16}" width="36" height="5" rx="2" fill="var(--scene-warm)"/><ellipse cx="${x}" cy="${y + 18}" rx="10" ry="2" fill="var(--scene-paper)" filter="url(#fglow)"/></g><path d="M${x - 23} ${y + 1}h46" stroke="var(--scene-light)" opacity=".4"/>`).join('')}</g>
  <g><rect x="0" y="112" width="1400" height="6" fill="${v9.c3a4458}"/><rect x="0" y="118" width="1400" height="3" fill="${v9.c161c2a}"/>${Array.from({ length: 36 }, (_, i) => `<rect x="${i * 40 + 6}" y="92" width="3" height="20" fill="${v9.c3a4458}"/>`).join('')}<rect x="0" y="92" width="1400" height="3" fill="${v9.c3a4458}"/></g>
  <g fill="url(#gGreyD)" stroke="var(--scene-ink)" stroke-width=".6">${Array.from({ length: 36 }, (_, i) => `<rect x="${i * 40 + 3}" y="110" width="9" height="4"/><path d="M${i * 40 + 6} 94v15" stroke="var(--scene-metal)"/>`).join('')}</g>
  <g>${[[560, 232], [880, 260], [1330, 240]].map(([x, y]) => `<rect x="${x - 40}" y="${y - 36}" width="80" height="36" fill="${v9.c141a26}" stroke="${v9.c2a3346}"/><rect x="${x - 34}" y="${y - 30}" width="68" height="24" fill="${v9.c0c1019}"/><g fill="${v9.c3ad0ff}" opacity=".8"><rect x="${x - 30}" y="${y - 26}" width="24" height="3"/><rect x="${x - 30}" y="${y - 20}" width="40" height="3"/><rect x="${x - 30}" y="${y - 14}" width="16" height="3"/></g>`).join('')}</g>
  <g data-day-door opacity="var(--mech-daylight)"><path d="M516 400V74H886V400" fill="url(#gDayDoor)" stroke="var(--scene-metal)" stroke-width="5"/><path d="M524 400V82H878V400" fill="none" stroke="var(--scene-light)" stroke-width="2"/><path d="M526 76H876" stroke="var(--scene-ink)" stroke-width="8"/></g>
  <rect x="0" y="400" width="1400" height="120" fill="url(#gFloor)"/>
  <rect x="0" y="407" width="1400" height="113" fill="url(#pDiamond)" opacity=".08"/>
  <path d="M520 400H882L1060 520H348Z" fill="url(#gDayFloor)" opacity="var(--mech-daylight)"/>
  <g fill="none" stroke="var(--scene-light)" stroke-width=".8" opacity=".16">${[[426, 478, 28], [471, 504, 39], [542, 513, 29], [793, 510, 45], [927, 490, 35], [951, 452, 20], [449, 448, 19], [857, 426, 24]].map(([x, y, w]) => `<path d="M${x} ${y}l${w} -3 M${x + 5} ${y + 3}l${w / 2} -2"/>`).join('')}</g>
  <g stroke="${v9.c243044}" stroke-width="1.2">${Array.from({ length: 15 }, (_, i) => `<line x1="${i * 100}" y1="520" x2="${700 + (i * 100 - 700) * .35}" y2="400"/>`).join('')}<line x1="0" y1="430" x2="1400" y2="430"/><line x1="0" y1="470" x2="1400" y2="470"/></g>
  <g>${Array.from({ length: 70 }, (_, i) => `<rect x="${i * 20}" y="400" width="10" height="7" fill="${i % 2 ? v9.cc9a227 : v9.c111826}"/>`).join('')}</g>

  ${[470, 900].map(x => `<g><rect x="${x}" y="60" width="6" height="360" fill="${v9.c3a4458}"/><rect x="${x + 24}" y="60" width="6" height="360" fill="${v9.c3a4458}"/>${Array.from({ length: 9 }, (_, i) => `<line x1="${x + 3}" y1="${60 + i * 40}" x2="${x + 27}" y2="${100 + i * 40}" stroke="${v9.c2f3848}" stroke-width="2"/><line x1="${x + 3}" y1="${60 + i * 40}" x2="${x + 27}" y2="${60 + i * 40}" stroke="${v9.c2f3848}" stroke-width="2"/>`).join('')}<rect x="${x - 6}" y="416" width="42" height="10" fill="${v9.c2a3346}"/><rect x="${x - 10}" y="426" width="50" height="4" fill="${v9.cc9a227}"/><rect x="${x - 2}" y="48" width="34" height="12" fill="${v9.c2a3346}"/><circle class="beacon" cx="${x + 15}" cy="54" r="3" fill="${v9.cff4d5a}" filter="url(#fglow)"/></g>`).join('')}
  <g><rect x="500" y="62" width="96" height="8" fill="${v9.c3a4458}"/><rect x="588" y="70" width="14" height="10" fill="${v9.c2a3346}"/><rect data-lamp-emission x="590" y="80" width="10" height="3" fill="${v9.cffe9b0}"/><g data-gantry-beam transform="translate(595,83) rotate(90)"></g></g>
  <g><rect x="804" y="62" width="96" height="8" fill="${v9.c3a4458}"/><rect x="798" y="70" width="14" height="10" fill="${v9.c2a3346}"/><rect data-lamp-emission x="800" y="80" width="10" height="3" fill="${v9.cffe9b0}"/><g data-gantry-beam transform="translate(805,83) rotate(90)"></g></g>
  <g><rect x="500" y="200" width="44" height="5" fill="${v9.c3a4458}"/><rect x="500" y="184" width="2" height="16" fill="${v9.c3a4458}"/><rect x="542" y="184" width="2" height="16" fill="${v9.c3a4458}"/><rect x="500" y="184" width="44" height="2" fill="${v9.c3a4458}"/><rect x="856" y="300" width="44" height="5" fill="${v9.c3a4458}"/><rect x="856" y="284" width="2" height="16" fill="${v9.c3a4458}"/><rect x="898" y="284" width="2" height="16" fill="${v9.c3a4458}"/><rect x="856" y="284" width="44" height="2" fill="${v9.c3a4458}"/></g>
  <g fill="url(#gGrey)" stroke="var(--scene-ink)" stroke-width=".7">${[[501, 200], [543, 200], [857, 300], [899, 300]].map(([x, y]) => `<rect x="${x - 4}" y="${y - 2}" width="8" height="4"/><circle cx="${x - 2}" cy="${y}" r=".6"/><circle cx="${x + 2}" cy="${y}" r=".6"/>`).join('')}</g>
  <g>${Array.from({ length: 7 }, (_, i) => `<rect x="452" y="${100 + i * 44}" width="14" height="3" fill="${v9.c3a4458}"/>`).join('')}<rect x="452" y="96" width="2" height="300" fill="${v9.c3a4458}"/><rect x="464" y="96" width="2" height="300" fill="${v9.c3a4458}"/></g>
  <g><path d="M1040 440 C 1000 452, 980 468, 950 474" stroke="${v9.c0d1119}" stroke-width="5" fill="none"/><path d="M1040 444 C 1004 456, 986 470, 956 476" stroke="${v9.c2a3346}" stroke-width="2" fill="none"/><path d="M420 470 C 380 462, 340 468, 300 476" stroke="${v9.c0d1119}" stroke-width="4" fill="none"/></g>
  <g><rect x="990" y="432" width="56" height="30" rx="2" fill="${v9.c2a3346}" stroke="${v9.c161c2a}"/><rect x="994" y="437" width="48" height="9" fill="${v9.c1c2334}"/><rect x="994" y="449" width="48" height="9" fill="${v9.c1c2334}"/><rect x="1032" y="440" width="6" height="3" fill="${v9.cc9a227}"/><rect x="1032" y="452" width="6" height="3" fill="${v9.cc9a227}"/><circle cx="998" cy="466" r="4" fill="${v9.c0f131c}"/><circle cx="1038" cy="466" r="4" fill="${v9.c0f131c}"/><rect x="990" y="424" width="56" height="8" fill="${v9.c1c2334}"/></g>
  <g><rect x="1348" y="374" width="10" height="26" rx="2" fill="${v9.cc0392b}"/><rect x="1350" y="368" width="6" height="6" fill="${v9.c0f131c}"/><path d="M1352 372 q -8 4 -6 14" stroke="${v9.c0f131c}" stroke-width="2" fill="none"/></g>
  <g fill="${v9.cc9a227}" opacity=".7">${[400, 414, 428].map(x => `<polygon points="${x},440 ${x + 8},440 ${x + 20},460 ${x + 12},460"/>`).join('')}${[960, 974, 988].map(x => `<polygon points="${x},440 ${x + 8},440 ${x + 20},460 ${x + 12},460"/>`).join('')}</g>
  <text x="700" y="508" text-anchor="middle" font-family="ui-monospace,Consolas,monospace" font-size="22" fill="${v9.c2a3448}" letter-spacing="8">BAY-02</text>
  ${rackSvg()}
  ${consoleSvg()}
  <g data-rig><ellipse cx="700" cy="474" rx="250" ry="38" fill="${v9.c1f2738}" stroke="${v9.c3a4458}" stroke-width="3"/><ellipse cx="700" cy="468" rx="240" ry="32" fill="${v9.c141a26}"/>
  <ellipse cx="700" cy="468" rx="246" ry="35" fill="none" stroke="url(#pHazard)" stroke-width="6"/>
  <g fill="none" stroke="var(--scene-metal)" stroke-width=".8" opacity=".6">${[[214, 27], [176, 22], [134, 17]].map(([rx, ry]) => `<ellipse cx="700" cy="468" rx="${rx}" ry="${ry}"/>`).join('')}</g>
  <path d="M468 464a232 31 0 0 1 464 0" fill="none" stroke="var(--scene-light)" stroke-width="1" opacity=".25"/>
  <g data-ring>${Array.from({ length: 16 }, (_, i) => { const a = i / 16 * Math.PI * 2; return `<rect x="${700 + Math.cos(a) * 236 - 7}" y="${470 + Math.sin(a) * 31 - 2}" width="14" height="4" rx="1" fill="${v9.c0b0f18}" data-seg/>` }).join('')}</g>
  <g data-hologram><polygon points="560,470 840,470 872,40 528,40" fill="${v9.c4fc3ff}" fill-opacity=".045"/>${[80, 140, 200, 260, 320, 380].map(y => `<line x1="${540 + (y - 40) / 430 * 20}" y1="${y}" x2="${860 - (y - 40) / 430 * 20}" y2="${y}" stroke="${v9.c4fc3ff}" stroke-opacity=".07"/>`).join('')}<circle cx="560" cy="467" r="3" fill="${v9.c5be3ff}" filter="url(#fglow)"/><circle cx="840" cy="467" r="3" fill="${v9.c5be3ff}" filter="url(#fglow)"/></g>
  <g data-assembly><g transform="translate(564,34) scale(.68)" data-mechwrap><g data-hover><g data-thrusters></g>${mechSvg('main')}</g><path class="seam" data-seam d="" style="display:none"/><line class="scan" data-scan x1="0" x2="0" y1="0" y2="0" style="display:none"/></g>
  </g></g><rect class="wash" width="1400" height="520"/>
  <g data-sparks></g>
  <g data-welder></g><g data-inspector></g>
  <rect class="scene-grain" width="1400" height="520" fill="url(#pSceneGrain)"/>`
}

/** 宿主只有一个 SVG；局部 defs 随场景销毁，共享特效 defs 留给总运行器。 */
export function createHangar(host: SVGSVGElement, prefix: string) {
  const root = svg(host, 'g', { 'data-mech-scene': prefix, 'data-scene': 'mech' })
  root.innerHTML = namespaced(DEFS + SCENE_DEFS + sceneStyles(prefix) + hangarSvg(), prefix)
  Object.entries(scenePaint).forEach(([key, value]) => root.style.setProperty(`--scene-${key}`, value))
  root.style.setProperty('--console-cyan', v9.c34d7ff)
  root.style.setProperty('--console-on', v9.c8affc1)
  const rig = required<SVGGElement>(root, '[data-rig]')
  const emitters = [...root.querySelectorAll<SVGElement>('[data-lamp-emission]')]
  const flameHost = required<SVGGElement>(root, '[data-thrusters]')
  // 原稿的三角喷焰轮廓保留在几何声明中；实际喷口只挂 fx/flame。
  for (const [x, y, sx, sy] of [[40, 198, .45, .5], [360, 198, .45, .5],
    [115, 640, .5, .275], [175, 640, .5, .275], [225, 640, .5, .275], [285, 640, .5, .275]]) {
    svg(flameHost, 'g', { 'data-thruster': `${x}-${y}`, transform: `translate(${x},${y}) scale(${sx},${sy})` })
  }
  required<SVGGElement>(root, '[data-mech]').setAttribute('shape-rendering', 'geometricPrecision')
  return {
    root,
    paintDaylight(daylight: number) {
      applyPalette(root, daylight)
      emitters.forEach(node => setAttrs(node, { opacity: 1 - daylight }))
    },
    setHeight(value: Height) {
      setAttrs(host, { viewBox: value === 'compact' ? '0 80 1400 360' : '0 0 1400 520' })
      setAttrs(rig, { transform: rigTransform(value) })
    },
    destroy() { root.remove() },
  }
}
