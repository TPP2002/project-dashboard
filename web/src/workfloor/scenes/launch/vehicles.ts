import { cabinet, pg, hi, sh, ln, riv, circ, repeat, rect, txt } from './drawing'

export function supportSvg() {
  return `<g>${[[-25,-5,-10,-38],[22,-5,9,-38],[-18,0,-8,-27],[17,0,7,-27]].map(([x,y,ex,ey])=>pg([[x,y],[x+3,y],[ex+2,ey],[ex,ey]],'gGrey')+ln([[x+1,y],[ex+1,ey]],'edge')).join('')}${rect(-29,0,58,5,'gGreyD')}${rect(-26,0,52,3,'pHazard')}</g>`
}

export function crawlerSvg() {
  return `<g class="crawler" data-crawler>
    <g data-crawler-heading>
      <ellipse cx="-8" cy="23" rx="53" ry="8" fill="var(--launch-black)" opacity=".3"/>
      ${[-38,21].map(x=>`<g><rect x="${x}" y="6" width="29" height="16" rx="6" fill="url(#gDark)" class="pl main"/>${repeat(5,i=>circ(x+4+i*5.2,14,3.6,'gGrey'))}<rect class="tread" x="${x+1}" y="7" width="27" height="14" rx="5" fill="none" stroke="var(--launch-metal)" stroke-width="2"/></g>`).join('')}
      ${cabinet(-40,0,80,11)}${rect(-35,7,55,3,'pHazard')}${cabinet(25,-7,12,12,'gBlue','gBlueL')}${rect(27,-5,8,5,'gVisor')}
      ${[-29,17,37].map(x=>riv(x,7)).join('')}
      <g class="headlight"><path d="M37 5L145 8 137 27 37 8Z" fill="url(#gCone)" filter="url(#fMist)"/><path d="M37 5L108 10 102 18 37 8Z" fill="var(--launch-warm)" opacity=".08" filter="url(#fMist)"/></g>
      <rect x="37" y="5" width="3" height="3" fill="var(--launch-warm)"/><circle data-reverse-lamp cx="-41" cy="6" r="2" fill="var(--launch-amber)" opacity="0"/>
    </g>
    <g data-crawler-deck>${supportSvg()}</g>
  </g>`
}

export function truckSvg() {
  return `<g>      <path d="M31-13L110-25V6L31-9Z" fill="url(#gBeam)" opacity=".12" filter="url(#fMist)"/>
      <ellipse cx="0" cy="6" rx="36" ry="5" fill="var(--launch-black)" opacity=".3"/>
      ${cabinet(-25,-10,55,9,'gGreyD')}${cabinet(14,-26,18,21,'gBlue','gBlueL')}${rect(18,-24,12,9,'gVisor')}
      <rect x="-26" y="-29" width="37" height="19" rx="9" fill="url(#gRocket)" class="pl"/>
      <path d="M-17-28v17 M3-28v17" class="ln"/>${ln([[-20,-26],[5,-26]],'edge')}${txt(-18,-17,'FUEL',5)}
      ${[-18,23].map(x=>`<g transform="translate(${x},1)">${circ(0,0,5.5,'gDark')}${circ(0,0,3.4,'gGrey')}<g data-wheel><path d="M-3 0H3M0-3V3M-2-2L2 2M-2 2L2-2" class="ln"/></g></g>`).join('')}
      <path data-hose class="ln" d="M-23-8h-3" stroke-width="2"/>
      <rect data-brake x="-28" y="-9" width="3" height="4" fill="var(--launch-red)" opacity=".2"/>
      <rect x="31" y="-14" width="2" height="4" fill="var(--launch-warm)"/>
      <circle data-beacon cx="21" cy="-29" r="2.2" fill="var(--launch-amber)" filter="url(#fglow)"/>
</g>`
}
