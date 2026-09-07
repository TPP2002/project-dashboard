const NS = 'http://www.w3.org/2000/svg'

export function svg<K extends keyof SVGElementTagNameMap>(parent: SVGElement, tag: K, attrs: Record<string, string | number> = {}) {
  const node = parent.ownerDocument.createElementNS(NS, tag)
  setAttrs(node, attrs)
  parent.appendChild(node)
  return node
}

/** 与特效各自持有自己的节点；缓存只属于本场景创建的节点。 */
export function setAttrs(node: SVGElement, attrs: Record<string, string | number>) {
  for (const [key, value] of Object.entries(attrs)) {
    const text = String(value)
    if (node.getAttribute(key) !== text) node.setAttribute(key, text)
  }
}

export function required<T extends SVGElement>(parent: SVGElement, selector: string): T {
  const node = parent.querySelector<T>(selector)
  if (!node) throw new Error(`Missing mech scene node: ${selector}`)
  return node
}

/** 仅处理可信的定稿模板；任务标题和事件文字始终用 textContent。 */
export function namespaced(markup: string, prefix: string) {
  return markup.replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
    .replace(/\bhref="#([^"]+)"/g, `href="#${prefix}$1"`)
}

export const clampPercent = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
export const ease = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t) }
export const taskLabel = (value: string) => value.replace(/[^\x20-\x7e]/g, '').slice(0, 12) || 'TASK'
