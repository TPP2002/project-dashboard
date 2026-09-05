// 选区标记(READER-USABILITY-ROUND2):荧光笔与框选批注共用的一套「纯文本偏移 ⇄ DOM」换算。
//
// 为什么存偏移而不存 DOM 路径:报告正文每次都是 markdown 现渲染的,DOM 结构会随读法
// (干净/标记改动/并排)变;而「这段纯文本的第 42~78 个字」跟渲染方式无关,换个读法照样标得回来。
//
// 口径必须两头一致:算偏移用 Range.toString().length,回标用文本节点长度累加——
// 两者都只数 Text 节点里的字符,不数标签,所以对得上。

export interface MarkSpan {
  id: string
  start: number
  end: number
  /** 加在 <mark> 上的 class(荧光笔是颜色,批注锚是虚线下划) */
  cls: string
  title?: string
}

/** 选区端点在容器纯文本里的偏移 */
export function offsetIn(root: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange()
  r.selectNodeContents(root)
  try { r.setEnd(node, offset) } catch { return -1 } // 端点不在本容器内
  return r.toString().length
}

function textNodes(root: HTMLElement): Text[] {
  const out: Text[] = []
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let n: Node | null
  while ((n = w.nextNode())) out.push(n as Text)
  return out
}

/** 撤掉本容器里所有我们打过的标,并把 splitText 拆散的文本节点合回去(不合的话下一轮偏移就飘了) */
export function clearMarks(root: HTMLElement): void {
  for (const m of Array.from(root.querySelectorAll('mark[data-mark-id]'))) {
    const parent = m.parentNode
    if (!parent) continue
    while (m.firstChild) parent.insertBefore(m.firstChild, m)
    parent.removeChild(m)
  }
  root.normalize()
}

function wrapSpan(root: HTMLElement, s: MarkSpan): void {
  let pos = 0
  const pieces: { node: Text; from: number; to: number }[] = []
  for (const t of textNodes(root)) {
    const len = t.data.length
    const a = Math.max(s.start, pos)
    const b = Math.min(s.end, pos + len)
    if (a < b) pieces.push({ node: t, from: a - pos, to: b - pos })
    pos += len
    if (pos >= s.end) break
  }
  for (const p of pieces) {
    let node = p.node
    if (p.to < node.data.length) node.splitText(p.to)
    if (p.from > 0) node = node.splitText(p.from)
    const el = document.createElement('mark')
    el.className = s.cls
    el.dataset.markId = s.id
    if (s.title) el.title = s.title
    node.parentNode?.replaceChild(el, node)
    el.appendChild(node)
  }
}

/** 重画本容器的全部标记(先清后画;跨行、跨加粗/链接的选区会拆成多段 <mark>,视觉上仍连续) */
export function applyMarks(root: HTMLElement, spans: MarkSpan[]): void {
  clearMarks(root)
  for (const s of spans) {
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.end <= s.start) continue
    wrapSpan(root, s)
  }
}
