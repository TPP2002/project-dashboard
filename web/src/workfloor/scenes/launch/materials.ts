/** Fixed v10 gradient stops, surface patterns and geographic clips. */
export const materials = `<defs>
  <linearGradient id="gBlue" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--launch-gBlue-stop-0)"/><stop offset=".45" stop-color="var(--launch-gBlue-stop-1)"/><stop offset="1" stop-color="var(--launch-gBlue-stop-2)"/></linearGradient>
  <linearGradient id="gBlueL" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--launch-gBlueL-stop-0)"/><stop offset=".5" stop-color="var(--launch-gBlueL-stop-1)"/><stop offset="1" stop-color="var(--launch-gBlueL-stop-2)"/></linearGradient>
  <linearGradient id="gBlueD" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--launch-gBlueD-stop-0)"/><stop offset="1" stop-color="var(--launch-gBlueD-stop-1)"/></linearGradient>
  <linearGradient id="gGrey" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--launch-gGrey-stop-0)"/><stop offset=".5" stop-color="var(--launch-gGrey-stop-1)"/><stop offset="1" stop-color="var(--launch-gGrey-stop-2)"/></linearGradient>
  <linearGradient id="gGreyD" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--launch-gGreyD-stop-0)"/><stop offset="1" stop-color="var(--launch-gGreyD-stop-1)"/></linearGradient>
  <linearGradient id="gDark" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--launch-gDark-stop-0)"/><stop offset="1" stop-color="var(--launch-gDark-stop-1)"/></linearGradient>
  <linearGradient id="gGold" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--launch-gGold-stop-0)"/><stop offset=".5" stop-color="var(--launch-gGold-stop-1)"/><stop offset="1" stop-color="var(--launch-gGold-stop-2)"/></linearGradient>
  <linearGradient id="gRed" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--launch-gRed-stop-0)"/><stop offset="1" stop-color="var(--launch-gRed-stop-1)"/></linearGradient>
  <linearGradient id="gVisor" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--launch-gVisor-stop-0)"/><stop offset="1" stop-color="var(--launch-gVisor-stop-1)"/></linearGradient>
  <linearGradient id="gFlame" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--launch-gFlame-stop-0)"/><stop offset=".35" stop-color="var(--launch-gFlame-stop-1)"/><stop offset="1" stop-color="var(--launch-gFlame-stop-2)" stop-opacity="0"/></linearGradient>
  <linearGradient id="gWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--launch-gWall-stop-0)"/><stop offset="1" stop-color="var(--launch-gWall-stop-1)"/></linearGradient>
  <linearGradient id="gFloor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--launch-gFloor-stop-0)"/><stop offset="1" stop-color="var(--launch-gFloor-stop-1)"/></linearGradient>
  <linearGradient id="gCone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--launch-gCone-stop-0)" stop-opacity=".22"/><stop offset="1" stop-color="var(--launch-gCone-stop-0)" stop-opacity="0"/></linearGradient>
  <linearGradient id="gRgb" x1="0" x2="1"><stop offset="0" stop-color="var(--launch-gRgb-stop-0)"/><stop offset=".33" stop-color="var(--launch-gRgb-stop-1)"/><stop offset=".66" stop-color="var(--launch-gRgb-stop-2)"/><stop offset="1" stop-color="var(--launch-gRgb-stop-3)"/></linearGradient>


</defs><defs>
<pattern id="pWallBrush" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><path d="M1 0V7 M4 0V7" stroke="var(--launch-scene-light)" stroke-width=".6" opacity=".05"/></pattern>
<pattern id="pRackBrush" width="6" height="12" patternUnits="userSpaceOnUse"><path d="M1 0V12 M4 0V12" stroke="var(--launch-scene-light)" stroke-width=".6" opacity=".07"/></pattern>
<pattern id="pPegboard" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5.6" r="1.8" fill="url(#gGrey)"/><circle cx="5" cy="5" r="1.6" fill="url(#gDark)"/></pattern>
<pattern id="pDiamond" width="32" height="16" patternUnits="userSpaceOnUse"><path d="M2 5l6-3 2 1-6 3z M18 13l6-3 2 1-6 3z" fill="url(#gVisor)"/><path d="M4 7l6-3 M20 15l6-3" stroke="var(--launch-scene-ink)" stroke-width="1"/></pattern>
<pattern id="pHazard" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)"><rect width="16" height="16" fill="url(#gDark)"/><rect width="8" height="16" fill="url(#gGold)"/></pattern>
<pattern id="pScreenLines" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 .5H4" stroke="var(--launch-scene-light)" stroke-width="1" opacity=".065"/></pattern>
  <pattern id="pSceneGrain" width="19" height="17" patternUnits="userSpaceOnUse"><path d="M2 3h1M7 14h1M11 7h1M17 2h1M16 12h1" stroke="var(--launch-ice)" stroke-width=".65"/></pattern>
  <linearGradient id="gSky" x1="0" y1="0" x2="0" y2="1"><stop stop-color="var(--launch-deep)"/><stop offset=".65" stop-color="var(--launch-sky-mid)"/><stop offset="1" stop-color="var(--launch-horizon)"/></linearGradient>
  <linearGradient id="gSea" x1="0" y1="0" x2=".35" y2="1"><stop stop-color="var(--launch-horizon)"/><stop offset=".35" stop-color="var(--launch-ocean)"/><stop offset="1" stop-color="var(--launch-sea-deep)"/></linearGradient>
  <linearGradient id="gConcrete" x1="1" y1="0" x2="0" y2="1"><stop stop-color="var(--launch-metal)"/><stop offset="1" stop-color="var(--launch-floor)"/></linearGradient>
  <linearGradient id="gRocket" x1="0" y1=".15" x2="1" y2="0"><stop stop-color="var(--launch-metal)"/><stop offset=".22" stop-color="var(--launch-muted)"/><stop offset=".65" stop-color="var(--launch-ice)"/><stop offset=".82" stop-color="var(--launch-paper)"/><stop offset="1" stop-color="var(--launch-muted)"/></linearGradient>
  <linearGradient id="gBand" x1="0" y1="0" x2="1" y2=".1"><stop stop-color="var(--launch-light)"/><stop offset=".32" stop-color="var(--launch-project)"/><stop offset=".7" stop-color="var(--launch-blue)"/><stop offset="1" stop-color="var(--launch-ocean)"/></linearGradient>
  <linearGradient id="gWarmFlame" x1="0" y1="0" x2="0" y2="1"><stop stop-color="var(--launch-paper)"/><stop offset=".2" stop-color="var(--launch-warm)"/><stop offset=".55" stop-color="var(--launch-amber)"/><stop offset=".86" stop-color="var(--launch-red)" stop-opacity=".65"/><stop offset="1" stop-color="var(--launch-red)" stop-opacity="0"/></linearGradient>
  <radialGradient id="gMoonHalo"><stop stop-color="var(--launch-light)" stop-opacity=".18"/><stop offset="1" stop-color="var(--launch-light)" stop-opacity="0"/></radialGradient>
  <radialGradient id="gSunHalo"><stop stop-color="var(--launch-warm)" stop-opacity=".6"/><stop offset=".3" stop-color="var(--launch-warm)" stop-opacity=".25"/><stop offset="1" stop-color="var(--launch-warm)" stop-opacity="0"/></radialGradient>
  <radialGradient id="gSphere" cx=".7" cy=".24" r=".78"><stop stop-color="var(--launch-light)"/><stop offset=".4" stop-color="var(--launch-muted)"/><stop offset=".8" stop-color="var(--launch-metal)"/><stop offset="1" stop-color="var(--launch-floor)"/></radialGradient>
  <linearGradient id="gDoor" x1="0" y1="0" x2="0" y2="1"><stop stop-color="var(--launch-warm)" stop-opacity=".25"/><stop offset="1" stop-color="var(--launch-warm)" stop-opacity=".02"/></linearGradient>
  <pattern id="pSlabs" width="100" height="45" patternUnits="userSpaceOnUse" patternTransform="matrix(1 0 1.732050808 1 0 0)"><path d="M0 0H100V45" fill="none" stroke="var(--launch-ink)" stroke-width="1.3"/><path d="M2 2H98V44" fill="none" stroke="var(--launch-light)" opacity=".05"/></pattern>
  <pattern id="pGravel" width="11" height="9" patternUnits="userSpaceOnUse"><path d="M1 2l3-1 1 2-2 2z M7 6l3-1-1 2z" fill="var(--launch-metal)" opacity=".6"/></pattern>
  <pattern id="pGridFin" width="3" height="3" patternUnits="userSpaceOnUse"><path d="M0 0H3V3" fill="none" stroke="var(--launch-ink)" stroke-width=".6"/></pattern>
  <clipPath id="clipSea"><path d="M1000 330H1400V520H1180L1138 476 1107 447 1075 414 1040 376Z"/></clipPath>
  <clipPath id="clipLand"><path d="M0 330H1000L1040 376 1075 414 1107 447 1138 476 1180 520H0Z"/></clipPath>
  <clipPath id="clipBay"><rect x="208" y="166" width="109" height="229"/></clipPath>


</defs>`
