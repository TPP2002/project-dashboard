import { mixDaylight } from '../../paletteTransition'

/** v9 定稿色值；白天只覆盖机库环境，控制台与装甲保留原色。 */
export const v9 = {
  c000: '#000',
  c070a10: '#070a10',
  c0b0e16: '#0b0e16',
  c0b0f18: '#0b0f18',
  c0c1019: '#0c1019',
  c0d1119: '#0d1119',
  c0e121c: '#0e121c',
  c0f1219: '#0f1219',
  c0f131c: '#0f131c',
  c101521: '#101521',
  c111826: '#111826',
  c141a26: '#141a26',
  c161c2a: '#161c2a',
  c171b24: '#171b24',
  c173a6e: '#173a6e',
  c1a2440: '#1a2440',
  c1b2030: '#1b2030',
  c1b2232: '#1b2232',
  c1c2334: '#1c2334',
  c1c2436: '#1c2436',
  c1c4a8f: '#1c4a8f',
  c1f2738: '#1f2738',
  c20252f: '#20252f',
  c222a3a: '#222a3a',
  c243044: '#243044',
  c2a3346: '#2a3346',
  c2a3448: '#2a3448',
  c2a7bff: '#2a7bff',
  c2b303d: '#2b303d',
  c2cb8ff: '#2cb8ff',
  c2f3848: '#2f3848',
  c2f66b4: '#2f66b4',
  c34d7ff: '#34d7ff',
  c3a4152: '#3a4152',
  c3a4458: '#3a4458',
  c3ad0ff: '#3ad0ff',
  c3b7bd6: '#3b7bd6',
  c3d6f96: '#3d6f96',
  c3f4658: '#3f4658',
  c4a86d0: '#4a86d0',
  c4a9eff: '#4a9eff',
  c4ad9c4: '#4ad9c4',
  c4fc3ff: '#4fc3ff',
  c5be3ff: '#5be3ff',
  c6b7488: '#6b7488',
  c6ea6ea: '#6ea6ea',
  c7ff0ff: '#7ff0ff',
  c8affc1: '#8affc1',
  c8b7bf7: '#8b7bf7',
  c8ec0ff: '#8ec0ff',
  c8fe9ff: '#8fe9ff',
  c9aa3b8: '#9aa3b8',
  c9c6f1e: '#9c6f1e',
  ca51f1f: '#a51f1f',
  cc0392b: '#c0392b',
  cc2e0ff: '#c2e0ff',
  cc96bd8: '#c96bd8',
  cc9a227: '#c9a227',
  cd9fbff: '#d9fbff',
  ce2b54c: '#e2b54c',
  cf2f4f8: '#f2f4f8',
  cfbe6a3: '#fbe6a3',
  cff2d3d: '#ff2d3d',
  cff4d5a: '#ff4d5a',
  cff5a5a: '#ff5a5a',
  cff8a8a: '#ff8a8a',
  cffb020: '#ffb020',
  cffe27a: '#ffe27a',
  cffe9b0: '#ffe9b0',
  cfff: '#fff',
  cffffff: '#ffffff',
} as const

export const screenPaint = {
  done: v9.c34d7ff, off: v9.c1a2440, build: v9.cffb020, pend: v9.cffb020,
  block: v9.cff4d5a, park: v9.c3d6f96, powered: v9.c8affc1,
} as const

export const scenePaint = {
  ink: v9.c0f1219, metal: v9.c6b7488, light: v9.cd9fbff,
  paper: v9.cffffff, warm: v9.cffe9b0, project: 'var(--wf-project)',
} as const

export const daylightPaint = {
  wallTop: 'var(--wf-cloud-mid)', wallBottom: 'var(--wf-cloud-body)',
  floorTop: 'var(--wf-metal-mid)', floorBottom: 'var(--wf-cloud-shade)',
  doorway: 'var(--wf-warm)', sky: 'var(--wf-ice-shade)',
} as const

export function applyPalette(root: SVGGElement, daylight: number) {
  const surfaces = {
    'wall-top': [v9.c101521, daylightPaint.wallTop], 'wall-bottom': [v9.c1b2232, daylightPaint.wallBottom],
    'floor-top': [v9.c1c2334, daylightPaint.floorTop], 'floor-bottom': [v9.c0b0e16, daylightPaint.floorBottom],
  }
  for (const [key, [night, day]] of Object.entries(surfaces)) root.style.setProperty(`--mech-${key}`, mixDaylight(night, day, daylight))
  root.style.setProperty('--mech-doorway', daylightPaint.doorway)
  root.style.setProperty('--mech-day-sky', daylightPaint.sky)
  root.style.setProperty('--mech-daylight', String(daylight))
  root.style.setProperty('--mech-lamps', String(1 - daylight))
  root.style.setProperty('--mech-hologram', String(1 - daylight * .65))
  root.style.setProperty('--mech-ghost', String(.14 - daylight * .065))
}

export const DEFS = `<defs>
  <linearGradient id="gBlue" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8ec0ff"/><stop offset=".45" stop-color="#3b7bd6"/><stop offset="1" stop-color="#1c4a8f"/></linearGradient>
  <linearGradient id="gBlueL" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c2e0ff"/><stop offset=".5" stop-color="#6ea6ea"/><stop offset="1" stop-color="#2f66b4"/></linearGradient>
  <linearGradient id="gBlueD" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a86d0"/><stop offset="1" stop-color="#173a6e"/></linearGradient>
  <linearGradient id="gGrey" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b7488"/><stop offset=".5" stop-color="#3a4152"/><stop offset="1" stop-color="#20252f"/></linearGradient>
  <linearGradient id="gGreyD" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3f4658"/><stop offset="1" stop-color="#171b24"/></linearGradient>
  <linearGradient id="gDark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b303d"/><stop offset="1" stop-color="#0f1219"/></linearGradient>
  <linearGradient id="gGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbe6a3"/><stop offset=".5" stop-color="#e2b54c"/><stop offset="1" stop-color="#9c6f1e"/></linearGradient>
  <linearGradient id="gRed" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a8a"/><stop offset="1" stop-color="#a51f1f"/></linearGradient>
  <linearGradient id="gVisor" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d9fbff"/><stop offset="1" stop-color="#2cb8ff"/></linearGradient>
  <linearGradient id="gFlame" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="#8fe9ff"/><stop offset="1" stop-color="#2a7bff" stop-opacity="0"/></linearGradient>
  <linearGradient id="gWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--mech-wall-top)"/><stop offset="1" stop-color="var(--mech-wall-bottom)"/></linearGradient>
  <linearGradient id="gFloor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--mech-floor-top)"/><stop offset="1" stop-color="var(--mech-floor-bottom)"/></linearGradient>
  <linearGradient id="gDayDoor" x2="0" y2="1"><stop stop-color="var(--mech-doorway)"/><stop offset="1" stop-color="var(--mech-day-sky)"/></linearGradient>
  <linearGradient id="gDayFloor" x2="0" y2="1"><stop stop-color="var(--mech-doorway)" stop-opacity=".6"/><stop offset="1" stop-color="var(--mech-doorway)" stop-opacity="0"/></linearGradient>
  <linearGradient id="gCone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe9b0" stop-opacity=".22"/><stop offset="1" stop-color="#ffe9b0" stop-opacity="0"/></linearGradient>
  <linearGradient id="gRgb" x1="0" x2="1"><stop offset="0" stop-color="#4ad9c4"/><stop offset=".33" stop-color="#4a9eff"/><stop offset=".66" stop-color="#8b7bf7"/><stop offset="1" stop-color="#c96bd8"/></linearGradient>
  <filter id="fglow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <filter id="fsoft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>
</defs>`
