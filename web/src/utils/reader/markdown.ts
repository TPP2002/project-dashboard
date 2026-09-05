// markdown → HTML(报告正文渲染)。报告是仓库自家文件,不做白名单净化;但去掉裸 script 以防手滑。
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: false })

/**
 * 退化表格 → 提示块。
 *
 * 外脑报告是 docx 转出来的,里面的「提示框」被转成了这种畸形表格(分隔行写在内容行**下面**):
 *   |  | 为什么仅加强新闻条还不够 …… |
 *   |---|---|
 * GFM 于是把这整段正文当成**表头**塞进 <th>,而表头样式是给看板数据表的列头用的
 * (11px + 弱灰 + 等宽大写),一整段正文用它渲染几乎没法读——负责人 2026-09-05 实测反馈。
 *
 * 判据干净利落:**tbody 里一行数据都没有的表,根本不是表**,按提示块渲染。
 * 光靠调样式治不了本:那些字本来就不该是表头。
 */
function unwrapDegenerateTables(doc: Document): void {
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    if (table.querySelector('tbody tr')) continue // 有数据行 = 真表格,不动
    const filled = Array.from(table.querySelectorAll('th, td')).filter((c) => (c.textContent || '').trim() !== '')
    if (!filled.length) { table.remove(); continue }
    const box = doc.createElement('div')
    box.className = 'callout'
    filled.forEach((cell, i) => {
      const p = doc.createElement('p')
      // 两格以上时首格通常是「本版用途」这类小标题,加粗当标题使
      if (i === 0 && filled.length > 1) { const b = doc.createElement('b'); b.innerHTML = cell.innerHTML; p.appendChild(b) }
      else p.innerHTML = cell.innerHTML
      box.appendChild(p)
    })
    table.replaceWith(box)
  }
}

export function renderMarkdown(md: string): string {
  const html = (marked.parse(md, { async: false }) as string).replace(/<script[\s\S]*?<\/script>/gi, '')
  if (typeof DOMParser === 'undefined') return html // 非浏览器环境(类型检查/预渲染)按原样返回
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  unwrapDegenerateTables(doc)
  return doc.body.innerHTML
}

/** 报告顶部的「状态:…」仓库状态行(docs 状态行规范),从正文里摘出来放到头部,不当正文读 */
export function extractStatusLine(blocks: string[]): { status: string | null; rest: string[] } {
  const rest: string[] = []
  let status: string | null = null
  for (let i = 0; i < blocks.length; i++) {
    const s = blocks[i].trim()
    if (status === null && i < 4 && /^>?\s*状态[:：]/.test(s)) { status = s.replace(/^>\s*/, ''); continue }
    rest.push(blocks[i])
  }
  return { status, rest }
}
