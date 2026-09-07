import { cabinet, pg, hi, sh, ln, riv, circ, repeat, rect } from './drawing'
import { cabinetFaces, PAD_X, MOUNT_TOP, ROCKET_Y } from './layout'

export function clampSvg(prefix: string,front: boolean) {
  return `<g id="${prefix}-${front?'front':'rear'}-clamps">${[-1,1].map(side=>{
    const px=PAD_X+side*27-(front?0:5),py=MOUNT_TOP-2-(front?0:3)
    const dx=PAD_X+side*(front?15:12)-px,dy=ROCKET_Y+175-(front?0:1)-py
    return `<g transform="translate(${px},${py})"><g data-clamp data-side="${side}" transform="rotate(${side*35})">
      ${pg([[-4,3],[4,3],[4,-4],[dx+side*3,dy-3],[dx,dy-3],[dx,dy],[dx+side*2,dy+1],[-3,-3]],'gGrey','main')}
      ${ln([[3,-2],[dx+side*3,dy-2],[dx,dy-2]],'edge')}${circ(0,0,3,'gGold')}${circ(0,0,1,'gDark')}
    </g></g>`
  }).join('')}</g>`
}

export function mountSvg() {
  const top=cabinetFaces(PAD_X-54,MOUNT_TOP,128,8)
  return `<g>
    <path d="M836 418H980L927 447H780Z" fill="var(--launch-black)" opacity=".35"/>
    ${pg(top.left,'gGreyD','main')}${pg(top.top,'gConcrete','main')}${sh(top.left)}
    ${rect(PAD_X-54,MOUNT_TOP,38,8,'gGrey','main')}${rect(PAD_X+16,MOUNT_TOP,58,8,'gGrey','main')}
    ${pg([[PAD_X-28,MOUNT_TOP-7],[PAD_X+4,MOUNT_TOP-7],[PAD_X+16,MOUNT_TOP],[PAD_X-16,MOUNT_TOP]],'gDark')}
    ${rect(PAD_X-16,MOUNT_TOP,32,8,'gDark')}${ln([[PAD_X-54,MOUNT_TOP],[PAD_X-16,MOUNT_TOP]],'edge')}${ln([[PAD_X+16,MOUNT_TOP],[PAD_X+74,MOUNT_TOP]],'edge')}
    ${cabinet(PAD_X+24,437,142,8,'gConcrete')}
    ${pg([[PAD_X+24,431],[PAD_X+166,431],[PAD_X+116,402],[PAD_X-26,402]],'gDark')}
    <path d="M${PAD_X+24} 435H${PAD_X+166}M${PAD_X-26} 400H${PAD_X+116}" fill="none" stroke="var(--launch-metal)" stroke-width="3"/>
    <path d="M${PAD_X+116} 402l50 29v9l-50-29Z" fill="url(#gDark)"/>
    ${ln([[PAD_X+119,401],[PAD_X+169,430]],'edge')}
    ${rect(PAD_X-51,MOUNT_TOP+1,32,3,'pHazard')}${rect(PAD_X+19,MOUNT_TOP+1,53,3,'pHazard')}
    ${[-48,-20,20,68].map(dx=>riv(PAD_X+dx,MOUNT_TOP+5)).join('')}
    ${[-1,1].map(side=>cabinet(PAD_X+side*18-2,MOUNT_TOP-4,4,4,'gGreyD')).join('')}
  </g>`
}
