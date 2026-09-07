import { cabinet, pg, hi, sh, ln, riv, circ, repeat, rect, txt } from './drawing'
import { BODY_R } from './layout'

/** v10: tip y=0, nozzle y=190; all placements share this hull. */
export function rocketSvg(number: string | number = 1, hullId = '') {
  const fin = (x: number,y: number,w: number,h: number) => rect(x,y,w,h,'gGrey') + `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#pGridFin)"/>` + hi([[x,y],[x+w,y],[x+w,y+1],[x,y+1]])
  return `<g class="rocket" data-rocket><g ${hullId?`id="${hullId}"`:''}>
    ${fin(-23,75,10,13)}${fin(13,75,10,13)}
    ${rect(-13,85,26,94,'gRocket','main')}
    ${hi([[8,86],[11,86],[11,177],[8,177]])}${sh([[-13,85],[-7,85],[-7,177],[-13,179]])}
    ${rect(-13,124,26,13,'gBand')}${hi([[-12,125],[-8,125],[-8,136],[-12,136]])}
    ${rect(-13,78,26,9,'gDark','main')}${repeat(8,i=>ln([[-11+i*3,79],[-11+i*3,85]]))}
    ${rect(-12,38,24,40,'gRocket','main')}${hi([[8,39],[11,39],[11,77],[8,77]])}${sh([[-12,38],[-7,38],[-7,78],[-12,78]])}
    ${pg([[0,0],[-5,7],[-11,21],[-13,30],[-13,38],[13,38],[13,30],[11,21],[5,7]],'gRocket','main')}
    ${hi([[0,2],[4,9],[10,25],[10,36],[7,36],[7,25],[2,9]])}${sh([[-3,8],[-11,21],[-13,30],[-13,38],[-8,38],[-7,25]])}
    ${ln([[0,4],[0,24],[1,31],[1,37]])}${circ(0,27,3.3,'gDark')}${circ(-.5,26.4,1.8,'gVisor')}
    ${ln([[-7,42],[-7,73]])}${ln([[6,42],[6,73]])}${ln([[-12,57],[12,57]])}
    ${repeat(4,i=>ln([[-10+i*6,92],[-10+i*6,122]]))}${ln([[-10,142],[-10,169]])}${ln([[8,141],[8,174]])}
    ${[91,119,140,171].map(y=>[-8,0,8].map(x=>`<g transform="translate(${x},${y}) scale(.42)">${riv(0,0)}</g>`).join('')).join('')}
    ${rect(-5,99,7,10,'gRocket')}${ln([[-3,101],[0,101],[0,106]])}
    ${txt(-6,155,String(number).padStart(2,'0'),8,'serial')}${txt(-6,165,'LC',3)}
    ${fin(-10,80,5,15)}${fin(5,80,5,15)}
    <g class="frost" fill="var(--launch-ice)">
      <path d="M-11 109l3 5 1 18-1 10 2 9-2 23-3-1 1-24-2-12z M-3 116l2 5 1 16-1 17 2 17-2 5-2-5 1-15-2-21z M7 116l2 5 1 22-2 12 2 15-2 5-2-3 1-26z"/>
      ${repeat(12,i=>`<path d="M${i%2?-14:11} ${119+i*4}l${i%2?-2:3} 3 2 4 2-3z" opacity=".65"/>`)}
    </g>
    <g class="frost-ring" fill="var(--launch-ice)" filter="url(#fMist)">${[88,105].map(y=>`<ellipse cy="${y}" rx="13" ry="10" opacity=".2"/>`).join('')}</g>
    ${[-1,1].map(side=>[88,105].map(y=>`<g>${rect(side<0?-16:12,y-1.5,4,3,'gGrey')}<ellipse cx="${side*16}" cy="${y}" rx="1" ry="1.4" fill="var(--launch-ink)"/></g>`).join('')).join('')}
    <ellipse cy="175" rx="${BODY_R+3}" ry="2.2" fill="url(#gRocket)" class="pl"/>
    ${rect(-BODY_R-3,175,(BODY_R+3)*2,5,'gGreyD')}${hi([[-15,175],[15,175],[15,176],[-15,176]])}
    ${[-8,0,8].map((x,i)=>`<g transform="translate(${x},${i===1?1:0})"><path class="pl" d="M-2 180H2Q2 185 4 189H-4Q-2 185-2 180Z" fill="url(#gGrey)"/><ellipse class="pl" cy="189" rx="4" ry="1.4" fill="url(#gDark)"/><path d="M-3 189Q0 187.5 3 189" fill="none" stroke="var(--launch-metal)" stroke-width=".7"/></g>`).join('')}
    </g><g data-rocket-vent></g><g data-rocket-flame></g>
  </g>`
}
