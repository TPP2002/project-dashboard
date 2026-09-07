import { cabinet, pg, hi, sh, ln, riv, circ, repeat, rect, txt } from './drawing'
import { CRAWLER_PATH } from './layout'

export function skySeaSvg() {
  return `<rect width="1400" height="330" fill="url(#gSky)"/>
    <g data-stars fill="var(--launch-light)">${[[32,44],[144,68],[247,36],[341,84],[456,42],[532,124],[611,65],[705,36],[754,138],[866,89],[975,46],[1074,132],[1264,40],[1360,130],[1321,95]].map(([x,y],i)=>`<circle class="star" cx="${x}" cy="${y}" r="${[.7,1.1,1.6][i%3]}"/>`).join('')}</g>
    <circle data-moon-halo cx="1180" cy="80" r="88" fill="url(#gMoonHalo)"/>
    <g id="moon-source"><circle cx="1180" cy="80" r="20" fill="var(--launch-ice)"/><path d="M1185 62a20 20 0 0 1 10 32 20 20 0 0 0-1-25Z" fill="var(--launch-metal)" opacity=".18"/><g fill="var(--launch-metal)" opacity=".13"><circle cx="1172" cy="76" r="4"/><circle cx="1184" cy="89" r="3"/><circle cx="1188" cy="72" r="2"/></g></g>
    <g id="sun-source" data-sun opacity="0"><circle cx="1180" cy="80" r="86" fill="url(#gSunHalo)"/><circle cx="1180" cy="80" r="20" fill="var(--launch-warm)"/></g>
    <g data-fair-clouds fill="var(--launch-paper)" opacity=".085" filter="url(#fsoft)"><path d="M328 108l42-11 19 4 42-5 45 12-53 5-40-4-23 4Z"/><path d="M727 156l43-9 34 3 58-8 40 11-44 7-64-4-30 5Z"/><path d="M1047 160l25-7 39 3 43-4 53 12-61 5-27-6-45 4Z"/></g>
    <g clip-path="url(#clipSea)"><rect x="988" y="330" width="412" height="190" fill="url(#gSea)"/>
      <g data-reflections opacity=".4" filter="url(#fReflection)">
        <use href="#moon-source" transform="translate(0,442) scale(1,-.45)"/>
        <use href="#sun-source" transform="translate(0,442) scale(1,-.45)"/>
        <use href="#pad-light-source" transform="matrix(1 0 -.85 -.55 348.5 635.5)"/>
        <use href="#lighthouse-light-source" transform="translate(0,575) scale(1,-.64)"/>
        <use href="#firework-source" transform="translate(0,530) scale(1,-.45)"/>
      </g>
      <g data-sea-glints fill="var(--launch-light)">${repeat(29,i=>{const y=345+i*6,w=7+i*.9+(i%4)*7;return `<path d="M${1180-w/2+(i%3-1)*5} ${y}h${w}l-3 1.1h${-w+4}z" opacity="${.09+(i%5)*.025}"/>`})}</g>
      <g fill="none" stroke-width="1">
        <path class="wave" d="M980 361q22-3 44 0t44 0t44 0t44 0t44 0t44 0t44 0t44 0t44 0t44 0 M1000 394q30-3 60 0t60 0t60 0t60 0t60 0t60 0t60 0" stroke="var(--launch-light)" opacity=".18"/>
        <path class="wave two" d="M985 425q24-4 48 0t48 0t48 0t48 0t48 0t48 0t48 0t48 0t48 0 M1010 460q28-3 56 0t56 0t56 0t56 0t56 0t56 0t56 0" stroke="var(--launch-project)" opacity=".33"/>
        <path class="wave three" d="M1000 479q32-5 64 0t64 0t64 0t64 0t64 0t64 0 M1080 511q40-4 80 0t80 0t80 0t80 0t80 0" stroke="var(--launch-metal)" opacity=".5"/>
      </g>
    </g>
    <g data-sky-dark opacity="0"><rect width="1400" height="330" fill="var(--launch-deep)" opacity=".55"/></g>`
}

export function lighthouseSvg() {
  return `<g>
    ${repeat(27,i=>cabinet(1080+i*12,350,12,14,i%2?'gGrey':'gGreyD','gConcrete'))}
    ${[1120,1192,1262,1370].map(x=>`<g>${cabinet(x-3,350,8,3)}${rect(x,330,2,18,'gGrey')}<path d="M${x-3} 330h9" stroke="var(--launch-metal)" stroke-width="2"/><g data-night-light><circle cx="${x+1}" cy="330" r="1.6" fill="var(--launch-warm)" class="glow"/><ellipse cx="${x+3}" cy="351" rx="11" ry="2" fill="var(--launch-warm)" opacity=".08"/></g></g>`).join('')}
    <g id="lighthouse-light-source"><g data-lighthouse-beam></g></g>
    <g>${cabinet(1303,347,35,5,'gConcrete')}
      ${pg([[1311,284],[1329,284],[1335,347],[1305,347]],'gRocket','main')}
      ${pg([[1309,304],[1331,304],[1332,314],[1308,314]],'gRed')}${pg([[1307,329],[1333,329],[1334,339],[1306,339]],'gRed')}
      ${hi([[1324,286],[1327,286],[1332,345],[1328,345]])}${sh([[1311,285],[1316,285],[1313,347],[1305,347]])}
      ${rect(1316,332,8,15,'gDark')}${ln([[1317,333],[1317,345]],'edge')}${rect(1317,293,5,8,'gVisor')}
      ${cabinet(1305,282,30,5)}<rect x="1310" y="263" width="20" height="19" fill="url(#gVisor)" fill-opacity=".28" class="pl"/>
      <circle data-night-light cx="1320" cy="270" r="3.5" fill="var(--launch-warm)" class="glow"/>
      <path d="M1310 264v18M1315 264v18M1320 264v18M1325 264v18M1330 264v18M1303 277v7h34v-7" fill="none" stroke="var(--launch-metal)" stroke-width="1.4"/>
      ${pg([[1305,262],[1320,250],[1335,262]],'gRed','main')}${hi([[1320,250],[1334,261],[1329,261],[1318,253]])}${rect(1319,245,2,6,'gGrey')}
    </g>
    ${[[1248,429],[1372,389]].map(([x,y],i)=>`<g transform="translate(${x},${y})"><ellipse cy="8" rx="14" ry="2" fill="var(--launch-project)" opacity=".16"/>${pg([[-6,0],[6,0],[9,5],[-9,5]],'gRed')}${rect(-1,-12,2,12,'gGrey')}<circle class="buoy-light glow" cx="0" cy="-13" r="2" fill="var(--launch-red)" style="animation-delay:-${i}s"/></g>`).join('')}
  </g>`
}

export function groundSvg() {
  return `<g clip-path="url(#clipLand)">
    <rect y="330" width="1400" height="190" fill="url(#gFloor)"/><rect y="330" width="1400" height="190" fill="url(#pSlabs)"/>
    <path d="M102 364l31 3 8 12 26-3 17 13 M353 460l34-5 12 8 23-6 M683 493l23-11 18 7 23-4 M937 457l20 4 10-6" fill="none" stroke="var(--launch-ink)" stroke-width="1.2"/>
    <path d="M166 477q68-28 143-15 M170 485q68-28 143-15 M667 459q78-26 137-9 M671 465q78-26 137-9" fill="none" stroke="var(--launch-black)" stroke-width="5" opacity=".16" stroke-dasharray="2 2"/>
    <path data-crawler-route d="${CRAWLER_PATH}" fill="none" stroke="var(--launch-floor)" stroke-width="27" stroke-linecap="round"/>
    <path d="${CRAWLER_PATH}" fill="none" stroke="url(#pGravel)" stroke-width="23"/>
    <path d="${CRAWLER_PATH}" fill="none" stroke="var(--launch-metal)" stroke-width=".7" stroke-dasharray="10 16" opacity=".4"/>
    <g data-puddles opacity="0" fill="var(--launch-light)"><path d="M346 447q30-10 65-4l8 4-23 4-33-1z" opacity=".1"/><path d="M655 438q34-8 59-1l-6 5-42 1z" opacity=".1"/><path d="M874 479q40-9 77-3l-6 8-55-1z" opacity=".1"/><path d="M356 446h39 M362 449h26 M667 438h34 M892 479h38" stroke="var(--launch-red)" stroke-width="1" opacity=".2"/></g>
  </g>
  <path d="M1000 330L1040 376 1075 414 1107 447 1138 476 1180 520" fill="none" stroke="url(#gGrey)" stroke-width="10"/>
  <g class="foam" fill="none" stroke="var(--launch-light)" stroke-width="1" opacity=".25"><path d="M1004 332q15 15 23 33t25 28 24 29 30 29 29 28 42 41"/><path d="M1007 334q9 21 28 38t20 28 27 27 27 29 28 26 43 38" stroke-dasharray="13 7 4 8"/><path d="M1011 337q10 18 27 35t25 31 26 26 28 31 35 38 36 26" stroke-dasharray="5 14 9 18"/></g>
  ${[[1055,397],[1118,461],[1167,510]].map(([x,y])=>pg([[x-12,y],[x-6,y-8],[x+5,y-10],[x+15,y],[x+11,y+6],[x-8,y+4]],'gGrey','main')+hi([[x-11,y],[x-5,y-7],[x+4,y-9],[x+7,y-5],[x,y-2]])+sh([[x,y-2],[x+15,y],[x+11,y+6],[x-8,y+4]])).join('')}`
}

export function roadLightsSvg() {
  return [358,448,538,628,718,808].map((x,i)=>{const y=426+i*3;return `<g>${cabinet(x-4,y,9,4,'gGreyD')}${rect(x,y-31,2,31,'gGrey')}<path d="M${x} ${y-31}l5-3h8" fill="none" stroke="var(--launch-metal)" stroke-width="2"/>${rect(x+5,y-36,11,3,'gGreyD')}<g data-night-light><ellipse cx="${x+14}" cy="${y+5}" rx="29" ry="6" fill="var(--launch-warm)" opacity=".065"/><rect x="${x+7}" y="${y-33}" width="7" height="1.5" fill="var(--launch-warm)"/><path d="M${x+6} ${y-32}h9l16 37h-36Z" fill="url(#gCone)"/></g>${riv(x+1,y+2)}</g>`}).join('')
}
