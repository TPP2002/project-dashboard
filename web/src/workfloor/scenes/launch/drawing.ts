import { cabinetFaces, type Vertex } from './layout'

/** 只用于首帧的固定矢量几何；任务文字通过 textContent 写入，不进入模板。 */
export const P = (points: readonly Vertex[]) => points.map(point => point.join(',')).join(' ')
export const pg = (points: readonly Vertex[], gradient: string, cls = '') => `<polygon class="pl ${cls}" points="${P(points)}" fill="url(#${gradient})"/>`
export const hi = (points: readonly Vertex[]) => `<polygon class="hi" points="${P(points)}"/>`
export const sh = (points: readonly Vertex[]) => `<polygon class="sh" points="${P(points)}"/>`
export const ln = (points: readonly Vertex[], cls = 'ln') => `<polyline class="${cls}" points="${P(points)}"/>`
export const riv = (x: number, y: number) => `<circle class="riv" cx="${x}" cy="${y}" r="1.7"/>`
export const circ = (x: number, y: number, r: number, gradient: string, cls = 'pl') => `<circle class="${cls}" cx="${x}" cy="${y}" r="${r}" fill="url(#${gradient})"/>`
export const repeat = (n: number, fn: (i: number) => string) => Array.from({ length: n }, (_, i) => fn(i)).join('')
export const rect = (x: number, y: number, w: number, h: number, gradient: string, cls = '') => pg([[x,y],[x+w,y],[x+w,y+h],[x,y+h]], gradient, cls)
export const txt = (x: number, y: number, text: string | number, size = 9, cls = '') => `<text x="${x}" y="${y}" font-size="${size}" class="${cls}">${text}</text>`
export function cabinet(x: number, y: number, w: number, h: number, front = 'gGrey', top = 'gGrey', side = 'gGreyD') {
  const p = cabinetFaces(x, y, w, h)
  return pg(p.left, side, 'main') + pg(p.top, top) + pg(p.front, front, 'main') + sh(p.left) + ln([[x,y],[x+w,y],[x+w,y+h]], 'edge')
}
