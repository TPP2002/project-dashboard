// markdown → HTML(报告正文渲染)。报告是仓库自家文件,不做白名单净化;但去掉裸 script 以防手滑。
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: false })

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string
  return html.replace(/<script[\s\S]*?<\/script>/gi, '')
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
