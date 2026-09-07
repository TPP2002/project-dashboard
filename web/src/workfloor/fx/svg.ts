import type { Detail } from '../types'

export interface FxParams { detail?: Detail; reducedMotion?: boolean; enabled?: boolean }
export interface FxHandle<P extends FxParams> {
  /** dt 为毫秒；仅改已有节点属性，参数变动也由这个入口应用。 */
  update(dt: number, params: P): void
  destroy(): void
}
export interface Point { x: number; y: number }
export type Attributes = Record<string, string | number>
const NS = 'http://www.w3.org/2000/svg'
const previous = new WeakMap<SVGElement, Record<string, string>>()

export function svg<K extends keyof SVGElementTagNameMap>(host: SVGElement, tag: K, attrs: Attributes = {}): SVGElementTagNameMap[K] {
  const node = host.ownerDocument.createElementNS(NS, tag)
  attributes(node, attrs)
  host.appendChild(node)
  return node
}
export function attributes(node: SVGElement, attrs: Attributes) {
  let stored = previous.get(node)
  if (!stored) { stored = {}; previous.set(node, stored) }
  for (const [key, value] of Object.entries(attrs)) {
    const text = String(value)
    if (stored[key] === text) continue
    node.setAttribute(key, text)
    stored[key] = text
  }
}
export const clamp = (value: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t) }
/** 只用于画面变异，固定序号与种子可重放，不读取业务时钟或随机源。 */
export function noise(index: number, seed = 1): number {
  let x = Math.imul(index + 1, 374761393) ^ Math.imul(seed, 668265263)
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}
export function advance(time: number, dt: number, params: FxParams): number {
  return params.reducedMotion || params.enabled === false ? time : time + Math.max(0, Math.min(dt, 100))
}
export function quantity(ultra: number, detail?: Detail) { return detail === 'standard' ? Math.ceil(ultra / 2) : ultra }
