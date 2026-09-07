import { cabinet, pg, hi, sh, ln, riv, circ, repeat, rect, txt } from './drawing'

export function foregroundSvg() {
  return `<g>
    <g>${cabinet(95,453,123,46,'gBlue','gBlueL','gBlueD')}${hi([[96,454],[201,454],[201,456],[96,456]])}${sh([[96,491],[202,491],[202,499],[96,499]])}${repeat(12,i=>ln([[103+i*8,458],[103+i*8,490]])+ln([[104+i*8,458],[104+i*8,489]],'edge'))}${txt(116,480,'PROJECT / 02',9,'decal')}${riv(99,457)}${riv(199,494)}</g>
    <g transform="translate(232,472)">${cabinet(0,0,85,27)}${repeat(10,i=>ln([[5+i*8,3],[5+i*8,24]]))}${rect(14,12,21,8,'gDark')}${txt(17,18,'TOOLS',5)}</g>
    <g transform="translate(398,483)"><ellipse cx="0" cy="11" rx="35" ry="7" fill="var(--launch-black)" opacity=".3"/>
      ${cabinet(-29,-8,47,16,'gGold','gGold')}${hi([[-28,-7],[17,-7],[17,-4],[-28,-4]])}
      ${rect(18,-40,4,51,'gGreyD')}${rect(25,-40,3,51,'gGrey')}${ln([[20,-29],[27,-29]])}${ln([[20,-19],[27,-19]])}<path d="M22 5h27v3H22" stroke="var(--launch-metal)" fill="none" stroke-width="2"/>
      <path d="M-13-9V-33H13V-9 M-16-34H16" stroke="var(--launch-metal)" fill="none" stroke-width="2.2"/>
      ${rect(-7,-19,7,8,'gDark')}${ln([[-1,-20],[9,-14]])}${[-19,12].map(x=>circ(x,7,7,'gDark')+circ(x,7,3,'gGrey')).join('')}${txt(-23,0,'02',6)}</g>
    <g>${[530,593,656,719,782].map(x=>`${cabinet(x-5,493,12,5,'gGreyD')}${rect(x,465,3,30,'gGrey')}${riv(x+1,495)}`).join('')}<path d="M531 467H784 M531 480H784" fill="none" stroke="var(--launch-metal)" stroke-width="3"/><path d="M532 466H784" class="edge"/></g>
    <path d="M452 508h402 M837 479h133l39 28" fill="none" stroke="url(#pHazard)" stroke-width="5"/>
    <path d="M470 512h365" fill="none" stroke="var(--launch-light)" opacity=".14"/>
    <g transform="translate(1039,412)"><ellipse cy="4" rx="24" ry="6" fill="var(--launch-black)" opacity=".32"/>
      ${cabinet(-18,0,36,4,'gConcrete')}
      <g data-monument opacity="0" transform="scale(1,0)">${cabinet(-9,-37,21,37)}${rect(-7,-34,14,3,'gBand')}
        <circle cx="0" cy="-40" r="2.2" fill="var(--launch-project)" class="glow"/>${txt(-6,-22,'100%',5,'decal')}${txt(-6,-13,'COMPLETE',2.7)}${ln([[-5,-7],[7,-7]],'edge')}
      </g>
    </g>
  </g>`
}
