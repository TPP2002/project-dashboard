import { bounds, byName, P, type Part, type Point } from './geometry'
import type { Height } from '../../types'

export interface Cue {
  kind: 'claim' | 'hold' | 'go' | 'block' | 'park' | 'done' | 'complete'
  taskId: string
  part: string | null
  age: number
  pickup: { x: number; y: number }
}

/** 紧凑档缩放整座装配平台，v9 的所有点阵、固定横移及机体比例保持不变。 */
export const rigTransform = (height: Height) => height === 'compact' ? 'translate(182,54.84) scale(.74)' : 'translate(0,0)'
export function scenePoint(point: Point, height: Height) {
  const x = 564 + point[0] * .68, y = 34 + point[1] * .68
  return height === 'compact' ? { x: 182 + x * .74, y: 54.84 + y * .74 } : { x, y }
}
export function partCenter(name: string, height: Height) {
  const points = byName[name].main
  return scenePoint([points.reduce((sum, p) => sum + p[0], 0) / points.length,
    points.reduce((sum, p) => sum + p[1], 0) / points.length], height)
}

/** 预计算闭合多环弧长；逐帧不调用 getBBox/getTotalLength 或触发布局查询。 */
export function seamRoute(part: Part) {
  let total = 0
  const segments: { a: Point; b: Point; start: number; length: number }[] = []
  const rings: { path: string; start: number; length: number }[] = []
  for (const ring of part.rings ?? [part.main]) {
    const start = total
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length], length = Math.hypot(b[0] - a[0], b[1] - a[1])
      segments.push({ a, b, start: total, length })
      total += length
    })
    rings.push({ path: `M${P(ring)}Z`, start, length: total - start })
  }
  return { bounds: bounds(part.main), rings, length: total,
    revealed(percent: number, ringIndex: number) {
      const ring = rings[ringIndex]
      return ring ? Math.min(ring.length, Math.max(0, total * percent / 100 - ring.start)) : 0
    }, at(percent: number): Point {
    const distance = Math.min(1, Math.max(0, percent / 100)) * total
    const segment = segments.find(value => value.start + value.length >= distance) ?? segments[segments.length - 1]
    const t = segment.length ? (distance - segment.start) / segment.length : 0
    return [segment.a[0] + (segment.b[0] - segment.a[0]) * t, segment.a[1] + (segment.b[1] - segment.a[1]) * t]
  } }
}

export function breathe(elapsed: number, reduced: boolean) { return reduced ? 0 : Math.cos(elapsed / 3400 * Math.PI * 2) - 1 }
export function headAngle(elapsed: number, reduced: boolean) { return reduced ? 0 : Math.sin(elapsed / 6000 * Math.PI * 2) * 1.3 }
export function posePoint(point: Point, name: string, elapsed: number, reduced: boolean): Point {
  if (name !== 'head') return [point[0], point[1] + breathe(elapsed, reduced)]
  const angle = headAngle(elapsed, reduced) * Math.PI / 180, x = point[0] - 200, y = point[1] - 112
  return [200 + x * Math.cos(angle) - y * Math.sin(angle), 112 + x * Math.sin(angle) + y * Math.cos(angle)]
}
