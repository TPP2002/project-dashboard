// 边注锚定:把「3.2」「第十六部分」「附录A」「全篇」这类锚,对到报告标题上。
// 规则与旧阅读台(build_reader.py 的 anchor_match)一致,保证两层边注文件不用改就能用。

/** 标题开头的数字节号,如 "3.2 风向的建议状态词" → "3.2";"§ 4.1" 也认;没有则 null */
export function numberPrefix(text: string): string | null {
  const m = /^\s*(?:§\s*)?(\d+(?:\.\d+)*)(?!\d)/.exec(text)
  return m ? m[1] : null
}

export function anchorMatch(anchor: string, headingText: string): boolean {
  const hn = headingText.replace(/[\s　]/g, '')
  const a = anchor.replace(/\s/g, '')
  if (!a) return false
  if (/^\d+(\.\d+)*$/.test(a)) return numberPrefix(headingText) === a
  if (a.startsWith('附录')) return hn.startsWith(a) || hn.startsWith('附录' + a.slice(2).replace(/^[:：]/, ''))
  return hn.includes(a)
}

/** markdown 段落 → 纯文本(去标题井号、强调、引用、表格竖线),用于词级对照与批注摘录 */
export function plainText(md: string): string {
  return md
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\|/g, ' | ')
    .replace(/\s+/g, ' ')
    .trim()
}
