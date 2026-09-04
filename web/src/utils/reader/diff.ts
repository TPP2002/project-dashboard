// 报告新旧版的段级对齐 + 改动段的字级对照。
// 为什么自己写而不引库:段落数三百量级、改动段几十个,朴素 LCS 足够;零依赖也省掉一份包体。
import { plainText } from './anchors'

export type BlockKind = 'same' | 'changed' | 'added' | 'removed'

export interface CharDiff {
  /** 新文 HTML:新增/改写的字包在 <ins> 里(已转义) */
  newHtml: string
  /** 旧文 HTML:被删/被改的字包在 <del> 里(已转义) */
  oldHtml: string
  /** 改动幅度 0~1(1=面目全非)。超过 0.5 前端就不划字,整段灰显旧文更好读 */
  ratio: number
}

export interface DocBlock {
  id: string
  kind: BlockKind
  /** 当前版 markdown(removed 时为空串) */
  md: string
  /** 上一版 markdown(changed / removed 时有) */
  old?: string
  heading?: { level: number; text: string }
  charDiff?: CharDiff
}

const HTML_COMMENT = /^\s*<!--[\s\S]*?-->\s*$/

/** 按空行切段;丢掉整段 HTML 注释(docx 转换器留下的来源注记,不是报告内容) */
export function splitBlocks(md: string): string[] {
  return md
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+$/, ''))
    .filter((s) => s.trim() && !HTML_COMMENT.test(s))
}

/** 对齐用的归一键:去空白与常见标点,让「只改了标点/空格」的段算作同段 */
function normKey(s: string): string {
  return s.replace(/[\s　]/g, '').replace(/[,.;:!?，。;:!?、「」“”‘’()（）\[\]【】《》—-]/g, '')
}

function headingOf(md: string): { level: number; text: string } | undefined {
  const m = /^\s{0,3}(#{1,6})\s*(.+)$/m.exec(md.split('\n')[0] || '')
  return m ? { level: m[1].length, text: plainText(m[2]) } : undefined
}

/** 序列 LCS → opcodes(equal / replace / delete / insert),与 Python difflib 的 get_opcodes 同形 */
type Op = ['equal' | 'replace' | 'delete' | 'insert', number, number, number, number]
function opcodes<T>(a: T[], b: T[]): Op[] {
  const n = a.length, m = b.length
  // dp[i][j] = LCS 长度 of a[i:], b[j:]
  const dp: Uint16Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0, j = 0
  let ai = 0, bj = 0 // 待处理的不等区间起点
  const flush = (ie: number, je: number) => {
    if (ie > ai && je > bj) ops.push(['replace', ai, ie, bj, je])
    else if (ie > ai) ops.push(['delete', ai, ie, bj, je])
    else if (je > bj) ops.push(['insert', ai, ie, bj, je])
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush(i, j)
      let i2 = i, j2 = j
      while (i2 < n && j2 < m && a[i2] === b[j2]) { i2++; j2++ }
      ops.push(['equal', i, i2, j, j2])
      i = i2; j = j2; ai = i; bj = j
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  flush(n, m)
  return ops
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

/** 字级对照(纯文本);太长的段(表格等)跳过——O(n·m) 会卡 */
export function charDiff(oldMd: string, newMd: string, cap = 1600): CharDiff | undefined {
  const o = plainText(oldMd), n = plainText(newMd)
  if (!o || !n) return undefined
  if (o.length > cap || n.length > cap) return { newHtml: esc(n), oldHtml: esc(o), ratio: 1 }
  const ops = opcodes([...o], [...n])
  const oc = [...o], nc = [...n]
  let newHtml = '', oldHtml = '', same = 0
  for (const [tag, i1, i2, j1, j2] of ops) {
    if (tag === 'equal') { newHtml += esc(nc.slice(j1, j2).join('')); oldHtml += esc(oc.slice(i1, i2).join('')); same += i2 - i1; continue }
    if (j2 > j1) newHtml += '<ins>' + esc(nc.slice(j1, j2).join('')) + '</ins>'
    if (i2 > i1) oldHtml += '<del>' + esc(oc.slice(i1, i2).join('')) + '</del>'
  }
  const ratio = 1 - (2 * same) / (oc.length + nc.length)
  return { newHtml, oldHtml, ratio: Math.round(ratio * 1000) / 1000 }
}

/** 主入口:没有上一版 → 全部 same;有 → 段级对齐后给改动段补字级对照 */
export function diffBlocks(prevMd: string | null | undefined, md: string): DocBlock[] {
  const B = splitBlocks(md)
  const mk = (idx: number, kind: BlockKind, cur: string, old?: string): DocBlock => {
    const b: DocBlock = { id: `b${idx}`, kind, md: cur }
    if (old !== undefined) b.old = old
    const h = headingOf(cur || old || '')
    if (h) b.heading = h
    return b
  }
  if (!prevMd) return B.map((s, i) => mk(i, 'same', s))
  const A = splitBlocks(prevMd)
  const ops = opcodes(A.map(normKey), B.map(normKey))
  const out: DocBlock[] = []
  let idx = 0
  for (const [tag, i1, i2, j1, j2] of ops) {
    if (tag === 'equal') { for (let j = j1; j < j2; j++) out.push(mk(idx++, 'same', B[j])) }
    else if (tag === 'replace') {
      const len = Math.max(i2 - i1, j2 - j1)
      for (let k = 0; k < len; k++) {
        const nb = j1 + k < j2 ? B[j1 + k] : undefined
        const ob = i1 + k < i2 ? A[i1 + k] : undefined
        if (nb === undefined) out.push(mk(idx++, 'removed', '', ob))
        else if (ob === undefined) out.push(mk(idx++, 'added', nb))
        else {
          const b = mk(idx++, 'changed', nb, ob)
          if (!b.heading) b.charDiff = charDiff(ob, nb)
          out.push(b)
        }
      }
    } else if (tag === 'delete') { for (let i = i1; i < i2; i++) out.push(mk(idx++, 'removed', '', A[i])) }
    else if (tag === 'insert') { for (let j = j1; j < j2; j++) out.push(mk(idx++, 'added', B[j])) }
  }
  return out
}

export function diffStats(blocks: DocBlock[]) {
  let changed = 0, added = 0, removed = 0
  for (const b of blocks) { if (b.kind === 'changed') changed++; else if (b.kind === 'added') added++; else if (b.kind === 'removed') removed++ }
  return { changed, added, removed, total: blocks.length }
}
