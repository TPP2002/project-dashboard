import { cabinet, rect, ln } from './drawing'
import { PAD_X, ROCKET_Y, TOWER_X, TOWER_Y, MASTS } from './layout'
import { mountSvg, clampSvg } from './mount'
import { towerSvg } from './tower'
import { rocketSvg } from './rocket'

/** 静态实体与特效挂点分开；光束在实体后方，受光只落在实体剪影内。 */
export function padSvg() {
  const mast = (x: number, y: number) => `<g>${cabinet(x-6,414,12,7,'gConcrete')}${rect(x-1,y+6,3,408-y,'gGrey')}${ln([[x,y+8],[x,412]],'edge')}${cabinet(x-8,y-2,17,8,'gGreyD')}${rect(x-6,y,13,4,'gRocket')}</g>`
  return `<g data-assembly>
    <defs>
      <clipPath id="tower-clip" clipPathUnits="userSpaceOnUse"/>
      <clipPath id="rocket-clip" clipPathUnits="userSpaceOnUse"/>
      <clipPath id="warm-clip" clipPathUnits="userSpaceOnUse"/>
      <clipPath id="storm-clip" clipPathUnits="userSpaceOnUse"/>
    </defs>
    <g id="pad-light-source" data-pad-lights>${MASTS.map(([x,y])=>`<g data-mast-beam transform="translate(${x},${y})"/>`).join('')}</g>
    <g id="main-mount">${mountSvg()}</g>
    ${MASTS.map(([x,y])=>mast(x,y)).join('')}
    <g id="main-tower-solid" transform="translate(${TOWER_X},${TOWER_Y})" data-main-tower>${towerSvg()}</g>
    ${clampSvg('main', false)}
    <g data-pad-rocket transform="translate(${PAD_X},${ROCKET_Y})">${rocketSvg(1, 'main-rocket-hull')}</g>
    ${clampSvg('main', true)}
    <g data-warm-surfaces opacity="0" clip-path="url(#warm-clip)">
      <rect x="764" y="300" width="320" height="150" fill="url(#gWarmFace)"/>
    </g>
    <ellipse data-warm-ground cx="927" cy="429" rx="144" ry="24" fill="url(#gLaunchLight)" opacity="0" filter="url(#fsoft)"/>
    <g data-storm-cloud opacity="0">
      <path d="M743 53C737 31 755 18 777 23C788 1 819 6 832 19C860 4 889 24 884 44C910 51 899 71 869 68C823 77 777 73 743 53Z" fill="url(#gGreyD)" filter="url(#fsoft)"/>
      <ellipse data-cloud-light cx="824" cy="58" rx="72" ry="18" fill="url(#gMoonHalo)" opacity="0" filter="url(#fsoft)"/>
    </g>
    <g data-lightning transform="translate(${TOWER_X},65)"/>
    <g data-smoke/>
    <g data-frost transform="translate(${PAD_X},${ROCKET_Y+141})"/>
    <text data-pad-label x="864" y="464" font-size="10" letter-spacing="3">LAUNCH / 02</text>
  </g>`
}
