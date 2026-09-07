/** Static v9 materials; the grain filter is confined to a reusable tile. */
export const SCENE_DEFS = `<defs>
  <pattern id="pWallBrush" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><path d="M1 0V7 M4 0V7" stroke="var(--scene-light)" stroke-width=".6" opacity=".05"/></pattern>
  <pattern id="pRackBrush" width="6" height="12" patternUnits="userSpaceOnUse"><path d="M1 0V12 M4 0V12" stroke="var(--scene-light)" stroke-width=".6" opacity=".07"/></pattern>
  <pattern id="pPegboard" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5.6" r="1.8" fill="url(#gGrey)"/><circle cx="5" cy="5" r="1.6" fill="url(#gDark)"/></pattern>
  <pattern id="pDiamond" width="32" height="16" patternUnits="userSpaceOnUse"><path d="M2 5l6-3 2 1-6 3z M18 13l6-3 2 1-6 3z" fill="url(#gVisor)"/><path d="M4 7l6-3 M20 15l6-3" stroke="var(--scene-ink)" stroke-width="1"/></pattern>
  <pattern id="pHazard" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)"><rect width="16" height="16" fill="url(#gDark)"/><rect width="8" height="16" fill="url(#gGold)"/></pattern>
  <pattern id="pScreenLines" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 .5H4" stroke="var(--scene-light)" stroke-width="1" opacity=".065"/></pattern>
  <pattern id="pScreenGrid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="var(--scene-light)" stroke-width=".5" opacity=".13"/></pattern>
  <linearGradient id="gHousing" href="#gGreyD" x1="0" y1="0" x2="0" y2="1"/>
  <linearGradient id="gLabel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scene-paper)"/><stop offset="1" stop-color="var(--scene-paper)" stop-opacity=".72"/></linearGradient>
  <radialGradient id="gScreenBloom" cx=".35" cy=".2" r=".9"><stop offset="0" stop-color="var(--console-cyan)" stop-opacity=".13"/><stop offset="1" stop-color="var(--console-cyan)" stop-opacity="0"/></radialGradient>
  <filter id="fSceneGrain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="17"/><feColorMatrix type="saturate" values="0"/></filter>
  <clipPath id="clipConsoleGlass"><rect x="12" y="12" width="306" height="186" rx="2"/></clipPath>
  <clipPath id="clipConsoleEvents"><rect x="122" y="128" width="184" height="42"/></clipPath>
  <clipPath id="clipConsoleScope"><rect x="122" y="174" width="184" height="20"/></clipPath>
<pattern id="pSceneGrain" width="128" height="128" patternUnits="userSpaceOnUse"><rect width="128" height="128" filter="url(#fSceneGrain)"/></pattern></defs>`
