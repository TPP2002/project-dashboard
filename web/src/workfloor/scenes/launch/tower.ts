import { cabinet, pg, hi, sh, ln, riv, circ, repeat, rect, txt } from './drawing'
import { cabinetFaces, TOWER_Y, ARM_LENGTH, ARM1_Y, ARM2_Y } from './layout'

export function towerSvg() {
  const depth=cabinetFaces(-16,10,32,234),back=depth.left[0][0],backY=depth.left[0][1]-10
  const platform=(y: number)=>cabinet(-22,y,49,4)+`<path d="M-21 ${y}v-11H26v11M-7 ${y-11}v11M12 ${y-11}v11" class="ln"/>`+
    pg([[-15,y+4],[-6,y+4],[-15,y+14]],'gGreyD')+pg([[16,y+4],[7,y+4],[16,y+14]],'gGreyD')
  const arm=(globalY: number,type: 'fuel' | 'crew')=>{
    const localY=globalY-TOWER_Y,len=ARM_LENGTH
    return `<g transform="translate(16,${localY})">${cabinet(-5,-6,9,12,'gGreyD')}
      <g class="arm" data-arm="${type}" transform="rotate(-60)">
        ${cabinet(0,-4,len,8)}${rect(2,-3,len-4,6,'pPegboard')}
        ${repeat(4,i=>ln([[3+i*11,-3],[12+i*11,3],[14+i*11,-3]]))}${ln([[0,-4],[len,-4]],'edge')}
        <path d="M0-4v-6H${len-1}v6M12-10v6M26-10v6" class="ln"/>
        ${type==='fuel'?`${rect(len-3,-6,3,12,'gDark')}<path d="M${len-2} 4q-5 8-3 19M${len-5} 4q-8 8-6 17" fill="none" stroke="var(--launch-ink)" stroke-width="2"/><path d="M${len-2} 4q-5 8-3 19" class="edge"/>`:
          `${cabinet(len-13,-4,13,14,'gRocket')}${rect(len-9,-1,7,6,'gVisor')}${ln([[len,0],[len,10]])}`}
      </g>${circ(0,0,4.5,'gGold')}${circ(0,0,1.8,'gDark')}
    </g>`
  }
  return `<g class="tower">
    <ellipse cx="-13" cy="257" rx="49" ry="8" fill="var(--launch-black)" opacity=".4"/>
    ${cabinet(-32,250,64,8,'gConcrete')}
    <g>${pg([[back,10+backY],[back+4,10+backY],[back+4,244+backY],[back,244+backY]],'gGreyD')}
      ${repeat(10,i=>{const y=10+i*23;return pg([[back+1,y+backY],[-15,y+21],[-15,y+23],[back+1,y+2+backY]],'gGrey')+pg([[-16,y],[back+2,y+22+backY],[back,y+22+backY],[-16,y+2]],'gGreyD')})}
      <path d="M${back} ${10+backY}V${244+backY}" class="ln"/>
    </g>
    ${[-16,10].map(x=>rect(x,10,6,234,'gGrey','main')+ln([[x+5,11],[x+5,243]],'edge')).join('')}
    ${repeat(10,i=>{const y=10+i*23;return pg([[-10,y],[-8,y],[10,y+21],[8,y+21]],'gGrey')+pg([[8,y],[10,y],[-8,y+21],[-10,y+21]],'gGreyD')+rect(-11,y,23,3,'gGrey')+riv(-13,y+1)+riv(13,y+1)})}
    ${[21,65,109,153,197].map(platform).join('')}
    <path d="M-8 14V240M-2 14V240M3 13V241M13 13V241" class="ln"/>
    ${repeat(36,i=>ln([[-8,18+i*6],[-2,18+i*6]]))}
    <g data-elevator transform="translate(1,181)">${cabinet(0,0,13,20)}${rect(2,3,9,10,'gVisor')}${rect(1,16,11,3,'pHazard')}${ln([[6,3],[6,13]])}</g>
    ${cabinet(-24,6,48,7)}${rect(-1.5,-12,3,18,'gGrey')}
    <path d="M0-12V-28M0-18L-5-12M0-18L5-12" fill="none" stroke="var(--launch-metal)" stroke-width="1.3"/>
    <circle class="aviation glow" data-tower-lamp cx="0" cy="-12" r="2.6" fill="var(--launch-red)"/>
    ${arm(ARM2_Y,'crew')}${arm(ARM1_Y,'fuel')}
    <g transform="translate(-43,92)">${rect(-4,-13,28,12,'gDark')}<text x="-1" y="-4" font-size="8" class="signal" data-level-label>0%</text>${rect(0,0,7,105,'gDark')}
      <rect x="1.4" y="104" width="4.2" height="0" fill="var(--launch-cyan)" data-liquid/>
      ${repeat(11,i=>`<path d="M9 ${i*10.3}h${i%5===0?7:4}" stroke="var(--launch-metal)" stroke-width=".8"/>${i%5===0?txt(18,i*10.3+3,100-i*10,6):''}`)}
    </g>
    ${[-27,27].map(x=>circ(x,254,2.2,'gDark')+ln([[x-1,254],[x+1,254]],'edge')).join('')}
  </g>`
}
