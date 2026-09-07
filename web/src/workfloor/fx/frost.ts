/** v10 碎霜（Q7）：不规则双面碎片、重力与阻力、自转、落地只弹一次，然后渐隐。 */
import { attributes, noise, quantity, smooth, svg, type FxHandle, type FxParams } from './svg'

export interface FrostParams extends FxParams { floor?: number; burstId?: number; repeat?: boolean }

export function create(host: SVGGElement, initial: FrostParams): FxHandle<FrostParams> {
  const root = svg(host, 'g', { 'data-fx': 'frost' })
  const pieces = Array.from({ length: 32 }, (_, i) => {
    const node = svg(root, 'g')
    const points = Array.from({ length: 4 + i % 2 }, (_, j) => {
      const angle = j / (4 + i % 2) * Math.PI * 2, radius = 2.5 + noise(i * 7 + j, 71) * 3
      return `${Math.cos(angle) * radius},${Math.sin(angle) * radius}`
    })
    svg(node, 'polygon', { points: points.join(' '), fill: 'var(--wf-ice)' })
    svg(node, 'polygon', { points: points.slice(0, 3).join(' '), fill: 'var(--wf-moon-blue)', opacity: .65 })
    return { node, x: (noise(i, 81) - .5) * 20, y: noise(i, 82) * 36,
      vx: (noise(i, 83) - .5) * 50, vy: -noise(i, 84) * 40, angle: noise(i, 85) * 360,
      spin: (i % 2 ? 1 : -1) * (70 + noise(i, 86) * 180), age: -i * .095, bounced: false, landed: false }
  })
  function reset(piece: typeof pieces[number], i: number) {
    Object.assign(piece, { x: (noise(i, 81) - .5) * 20, y: noise(i, 82) * 36,
      vx: (noise(i, 83) - .5) * 50, vy: -noise(i, 84) * 40, age: 0, bounced: false, landed: false })
  }
  let lastBurst = initial.burstId
  function update(dt: number, p: FrostParams) {
    if (p.burstId !== lastBurst) {
      lastBurst = p.burstId
      pieces.forEach((piece, i) => { reset(piece, i); piece.age = -i * .025; piece.angle = noise(i, 85) * 360 })
    }
    const delta = p.reducedMotion || p.enabled === false ? 0 : Math.max(0, Math.min(dt, 100)) / 1000
    const count = quantity(32, p.detail), floor = p.floor ?? 135
    attributes(root, { opacity: p.enabled === false ? 0 : 1 })
    pieces.forEach((piece, i) => {
      piece.age += delta
      if (piece.age > 3.1 && p.repeat !== false) reset(piece, i)
      if (piece.age >= 0 && !piece.landed) {
        piece.vx *= Math.exp(-delta * 1.2)
        piece.vy = piece.vy * Math.exp(-delta * .6) + 160 * delta
        piece.x += piece.vx * delta
        piece.y += piece.vy * delta
        piece.angle += piece.spin * delta
        if (piece.y >= floor) {
          piece.y = floor
          if (!piece.bounced) { piece.vy *= -.3; piece.bounced = true }
          else { piece.landed = true; piece.vy = 0 }
        }
      }
      const still = p.reducedMotion
      attributes(piece.node, { visibility: i < count && (still || piece.age >= 0) ? 'visible' : 'hidden',
        opacity: still ? .75 : smooth(piece.age / .12) * (1 - smooth((piece.age - 2.3) / .8)),
        transform: `translate(${piece.x},${still ? floor : piece.y}) rotate(${piece.angle})` })
    })
  }
  update(0, initial)
  return { update, destroy() { root.remove() } }
}
