import { cabinet, pg, hi, sh, ln, riv, circ, repeat, rect, txt } from './drawing'
import { cabinetFaces } from './layout'

export function vabSvg() {
  const face=cabinetFaces(196,134,134,264),back=face.left[0]
  return `<g>
    <path d="M196 397H330L259 422H117Z" fill="var(--launch-black)" opacity=".3"/>
    ${cabinet(196,134,134,264,'gGrey','gGrey','gGreyD')}
    <g transform="matrix(1 .577350269 0 1 ${back[0]} ${back[1]})">
      <rect width="52" height="264" fill="url(#pRackBrush)"/>
      ${repeat(8,i=>ln([[4+i*6,5],[4+i*6,258]]))}
      ${[40,94,147,201,252].map(y=>ln([[1,y],[51,y]])+riv(4,y+5)+riv(48,y+5)).join('')}
      ${txt(7,91,'VAB',21,'decal')}${txt(6,108,'ASSEMBLY',5)}
      ${rect(8,220,35,22,'gGreyD')}${repeat(5,i=>ln([[11,224+i*3],[39,224+i*3]],'edge'))}
    </g>
    ${cabinet(225,113,40,8,'gGreyD')}${repeat(6,i=>ln([[228+i*6,114],[228+i*6,119]],'edge'))}
    <path class="rgb" d="M196 133H330" fill="none" stroke="url(#gRgb)" stroke-width="2.6" stroke-dasharray="28 8"/>
    ${rect(203,157,119,239,'gDark','main')}<rect x="208" y="166" width="109" height="229" fill="url(#gDoor)"/>
    <g clip-path="url(#clipBay)"><path d="M220 168V395M305 168V395M211 215H316M211 269H316" fill="none" stroke="var(--launch-metal)" opacity=".28"/>
      <g data-stock></g>
      ${repeat(5,i=>`<g data-bay-lamp opacity=".4"><rect x="${215+i*20}" y="169" width="13" height="4" fill="var(--launch-warm)" class="glow"/><path d="M${215+i*20} 173h13l9 40h-31Z" fill="url(#gCone)"/></g>`)}
    </g>
    ${rect(196,148,7,249,'gGrey')}${rect(320,146,9,251,'gGrey')}${ln([[328,148],[328,396]],'edge')}
    ${repeat(17,i=>rect(204,146+i*.8,115,.6,'gGrey'))}
    <text data-queue-extra x="311" y="154" text-anchor="end" font-size="8" class="decal"></text>${rect(195,392,137,9,'gConcrete','main')}${rect(199,393,128,4,'pHazard')}
    ${[[back[0],back[1]],[330,134],[back[0],back[1]+248],[328,382]].map(([x,y],i)=>`<circle class="aviation ${i%2?'alt':''} glow" cx="${x}" cy="${y}" r="2.2" fill="var(--launch-red)"/>`).join('')}
    ${rect(37,310,2,91,'gGrey')}<circle cx="38" cy="309" r="2" fill="var(--launch-warm)"/>
    <path class="flag-cloth" data-flag d="M40 314q14-5 28 0t26 0v19q-13 5-26 0t-28 0Z" fill="url(#gRocket)" stroke="var(--launch-ink)" stroke-width=".8"/>
    ${cabinet(30,401,16,4,'gConcrete')}
    ${rect(348,337,2,59,'gGrey')}<path d="M348 337l3-7" fill="none" stroke="var(--launch-metal)"/>
    <g class="flag-cloth"><path d="M352 328l35 7-1 5-34 1Z" fill="url(#gRed)" class="pl"/><path d="M358 330l4 1v10h-4zM372 333l4 1v7h-4Z" fill="var(--launch-ice)"/></g>
  </g>`
}

export function tanksSvg() {
  function sphere(x: number,y: number,r: number) {
    return `<g>${[-r*.65,r*.65].map(dx=>rect(x+dx-2,y+r*.55,4,r*.9,'gGrey')+rect(x+dx-5,y+r*1.4,11,3,'gConcrete')).join('')}${circ(x,y,r,'gSphere','pl main')}
      <path d="M${x-r*.78} ${y-r*.2}a${r*.8} ${r*.8} 0 0 1 ${r*.86} ${-r*.62}" class="edge" stroke-width="2"/>
      <ellipse cx="${x}" cy="${y+3}" rx="${r+4}" ry="6" fill="none" stroke="var(--launch-metal)" stroke-width="2"/>
      <ellipse cx="${x}" cy="${y-3}" rx="${r+4}" ry="7" fill="none" stroke="var(--launch-metal)" stroke-width="1"/>
      ${repeat(7,i=>`<path d="M${x-r+4+i*(r-4)/3} ${y-3}v8" stroke="var(--launch-ink)" stroke-width=".8"/>`)}
      <path d="M${x-r*.65} ${y+r+15}V${y-4} M${x-r*.65+5} ${y+r+15}V${y-4}" fill="none" stroke="var(--launch-metal)" stroke-width="1"/>
      ${repeat(8,i=>ln([[x-r*.65,y+i*5],[x-r*.65+5,y+i*5]]))}
      ${rect(x-2,y-r-6,4,6,'gGrey')}<circle cx="${x}" cy="${y-r-7}" r="1.7" fill="var(--launch-red)"/>
      ${txt(x-10,y+15,'LOX',7)}${ln([[x-8,y+r*.6],[x+8,y+r*.6]])}</g>`
  }
  return `<g><ellipse cx="463" cy="393" rx="99" ry="13" fill="var(--launch-black)" opacity=".3"/>
    ${cabinet(371,400,184,5,'gConcrete')}
    ${sphere(412,340,27)}${sphere(476,334,31)}
    ${rect(516,305,24,75,'gRocket','main')}<ellipse cx="528" cy="305" rx="12" ry="5" fill="url(#gSphere)" class="pl"/>
    ${sh([[533,307],[540,307],[540,380],[533,380]])}${rect(516,375,24,6,'gGrey')}
    <path d="M516 314q26 5 24 12t-24 12 24 12-24 12 24 12 M513 314q30 4 30 12t-30 12 30 12-30 12 30 12" fill="none" stroke="var(--launch-metal)" stroke-width="1.4"/>
    ${rect(527,297,2,5,'gGrey')}<circle cx="528" cy="296" r="1.7" fill="var(--launch-red)"/>
    <path d="M412 377V388H548 M476 376V391H520 M535 377V387" fill="none" stroke="var(--launch-ink)" stroke-width="6"/>
    <path d="M412 377V387H548 M476 376V390H520 M535 377V386" fill="none" stroke="var(--launch-metal)" stroke-width="3"/>
    ${[434,499,539].map(x=>`<g>${rect(x,383,3,9,'gGreyD')}${circ(x+1,380,4,'gRed')}${ln([[x-2,377],[x+4,383]])}${ln([[x-2,383],[x+4,377]])}${rect(x,377,2,7,'gGrey')}</g>`).join('')}

  </g>`
}

export function commandSvg() {
  return `<g><ellipse cx="662" cy="397" rx="108" ry="12" fill="var(--launch-black)" opacity=".28"/>
    ${cabinet(573,317,163,81)}
    ${rect(573,317,163,81,'gGrey','main')}${rect(576,319,157,76,'pWallBrush')}${hi([[574,318],[735,318],[735,321],[574,321]])}${sh([[574,391],[736,391],[736,398],[574,398]])}
    ${rect(570,355,168,5,'gGreyD')}${hi([[571,355],[737,355],[737,356],[571,356]])}
    <g class="windows">${repeat(16,i=>`<rect x="${580+(i%8)*19}" y="${329+Math.floor(i/8)*37}" width="13" height="13" fill="var(--launch-${i%2?'blue':'cyan'})" stroke="var(--launch-ink)" stroke-width="1"/>`)}</g>
    <g stroke="var(--launch-light)" opacity=".15">${repeat(8,i=>`<path d="M${580+i*19} 331l8 9 M${580+i*19} 368l8 9"/>`)}</g>
    ${rect(625,377,21,21,'gDark')}${ln([[635,379],[635,395]],'edge')}${rect(620,398,32,4,'gConcrete')}
    ${[580,729].map(x=>riv(x,320)+riv(x,394)).join('')}
    ${pg([[638,304],[653,304],[649,255],[645,255]],'gGrey')}
    <g class="dish-turn"><path class="pl main" d="M628 246Q646 276 664 246Q646 253 628 246Z" fill="url(#gRocket)"/>
      <path d="M646 256L641 239 M638 241h6" stroke="var(--launch-metal)" stroke-width="1.6"/>${ln([[630,247],[646,257],[660,248]])}</g>
    ${rect(707,278,2,26,'gGrey')}<path d="M703 282h10 M704 287h8" stroke="var(--launch-metal)" stroke-width="1"/>
    ${rect(582,279,153,29,'gGreyD','main')}${hi([[583,280],[734,280],[734,281],[583,281]])}${rect(586,283,145,21,'gDark')}
    <rect x="586" y="283" width="145" height="21" fill="url(#pScreenLines)"/>
    <text data-screen x="658.5" y="297" text-anchor="middle" font-size="11" class="signal" letter-spacing=".7">READY</text>
    ${riv(583,281)}${riv(734,306)}<text data-countdown x="735" y="317" text-anchor="end" font-size="7.5" class="signal"></text>
    ${rect(662,382,72,13,'gDark')}<text x="666" y="391" font-size="8" data-missions class="decal">MISSIONS 0</text>
    <text x="541" y="300" font-size="6" transform="rotate(90,541,300)">LAUNCH CONTROL</text>
  </g>`
}
