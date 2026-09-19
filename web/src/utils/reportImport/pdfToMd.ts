/**
 * reportImport/pdfToMd.ts —— 文字版 PDF → markdown(口径见工单第 9 条,只抽文字)。
 *
 *   ① 每页 items 按 y 归行(容差 2pt),行内按 x 排序;块间距 ≥1×字号一律补空格(单元格不粘),不足时只在非中日韩之间补;
 *   ② 全文按字符数加权取字号众数当正文字号;
 *   ③ 行字号 ≥1.6×正文 = 页标题(相邻页标题行合并);1.15×~1.6× 且粗体或短于 40 字 = 三级标题;
 *   ④ 每行里的连续数字整串换成单个 # 后,在 ≥60% 的页重复出现的行整行剔除(页眉页脚;只有 1~2 页时只看上下 8% 区带);
 *   ⑤ 字号相同(差 ≤0.5pt)且行距 ≤1.9×字号的相邻行并成一段;
 *   ⑥ 每页输出「## 第 N 页 · <页标题>」;
 *   ⑦ 表格不还原,只按行保字;疑似表格的页给中文提示;
 *   ⑧ 全文可抽字符 < 20×页数 = 扫描件,抛 SCANNED_PDF;
 *   ⑨ title 取第一页的页标题行。
 *
 * pdfjs 的加载一律经 pdfjsLoader,本文件不感知浏览器 / node 的差异。
 */
import { ImportError } from './types'
import type { ConvertedDoc } from './types'
import { loadPdfjs } from './pdfjsLoader'

/** 归行的 y 容差(pt) */
const ROW_TOLERANCE_PT = 2
/** 页标题字号门槛:≥ 正文字号 × 1.6 */
const HEADING_RATIO = 1.6
/** 三级标题字号下限:≥ 正文字号 × 1.15 */
const SUBHEADING_RATIO = 1.15
/** 三级标题的整行长度上限:短于 40 字才算(粗体判据拿不到时靠它兜底) */
const SUBHEADING_MAX_CHARS = 40
/** 段落:相邻两行字号相同且行距 ≤ 字号 × 1.9 算同一段 */
const PARAGRAPH_LINE_FACTOR = 1.9
/** 「同字号」的容差:相邻两行字号差 ≤ 0.5pt 才有并段资格 */
const SAME_PARAGRAPH_SIZE_TOLERANCE_PT = 0.5
/** 行内补空格的小间距门槛:间距 > 字号 × 0.3 且不都是中日韩时补 */
const SPACE_GAP_FACTOR = 0.3
/** 行内强制补空格的大间距门槛:间距 ≥ 字号 × 1.0 时无论是不是中日韩都补(表格单元格不许粘) */
const SPACE_GAP_FORCED_FACTOR = 1.0
/** 疑似表格:一行里 ≥3 个水平分开的文字块,且 ≥2 行的块起点 x 大致对齐 */
const TABLE_MIN_BLOCKS = 3
/** 块起点 x「大致对齐」的容差:max(3pt, 正文字号 × 0.5) */
const TABLE_ALIGN_MIN_PT = 3
/** 页眉页脚:在 ≥60% 的页重复出现才剔除 */
const HEADER_FOOTER_RATIO = 0.6
/** 全文页数 ≥3 才按跨页重复比例剔除;只有 1~2 页时只看页面顶部/底部 8% 区带 */
const HEADER_FOOTER_MIN_DOC_PAGES = 3
/** 页面顶部/底部区带的宽度占比 */
const BAND_FRACTION = 0.08
/** 扫描件判定:全文可抽字符 < 20×页数 */
const SCANNED_CHARS_PER_PAGE = 20

/** 中日韩字符(汉字/假名/谚文/全角符号),用于决定块间要不要补空格 */
const CJK_RE = /[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/

interface PdfItem {
  text: string
  x: number
  y: number
  width: number
  /** 字号(用 pdfjs 给的排版高度近似) */
  size: number
  bold: boolean
}

interface PdfLine {
  y: number
  text: string
  size: number
  bold: boolean
  /** 行内的文字块起点 x(供疑似表格的对齐判断) */
  xs: number[]
}

const round1 = (n: number): number => Math.round(n * 10) / 10
const lastChar = (s: string): string => s.slice(-1)
const firstChar = (s: string): string => s.slice(0, 1)
const isCjk = (ch: string): boolean => !!ch && CJK_RE.test(ch)

/** 两段文字拼接:两侧都是中日韩就直接拼,否则补一个空格 */
function smartJoin(a: string, b: string): string {
  return isCjk(lastChar(a)) && isCjk(firstChar(b)) ? a + b : `${a} ${b}`
}

/** 页眉页脚的行钥匙:连续数字(半/全角)整串换成一个 # ——「5 / 51」和「12 / 51」必须落在同一把钥匙上 */
export function digitsToHash(text: string): string {
  return text.replace(/[0-9０-９]+/g, '#')
}

/**
 * 把同一条基线上的 items 拼成一行文本(纯函数,可测;内部按 x 排,入参不限顺序):
 * 间距 ≥ 1×字号 → 无论中日韩都补空格(表格单元格不许粘);间距 > 0.3×字号且不都是中日韩 → 补空格;否则直接拼。
 */
export function joinRow(row: Pick<PdfItem, 'text' | 'x' | 'width' | 'size'>[]): string {
  let text = ''
  let prev: (typeof row)[number] | null = null
  for (const item of [...row].sort((a, b) => a.x - b.x)) {
    if (prev) {
      const gap = item.x - (prev.x + prev.width)
      const bothCjk = isCjk(lastChar(prev.text)) && isCjk(firstChar(item.text))
      const maxSize = Math.max(prev.size, item.size)
      if (gap >= SPACE_GAP_FORCED_FACTOR * maxSize || (gap > SPACE_GAP_FACTOR * maxSize && !bothCjk)) text += ' '
    }
    text += item.text
    prev = item
  }
  return text.replace(/[ \t]+/g, ' ').trim()
}

/**
 * ⑤ 并段(纯函数,可测):相邻两行字号相同(差 ≤0.5pt)且行距 ≤1.9×字号(按较小的一行算)→ 同一段,
 * 否则断段。返回分好的段落(每段是行文本数组,保序),调用方用 smartJoin 把段内行拼成一段文字。
 */
export function splitParagraphs(lines: { y: number; size: number; text: string }[]): string[][] {
  const paragraphs: string[][] = []
  let current: string[] = []
  let prev: { y: number; size: number } | null = null
  for (const line of lines) {
    const sameParagraph =
      current.length > 0 && prev !== null && Math.abs(prev.size - line.size) <= SAME_PARAGRAPH_SIZE_TOLERANCE_PT && Math.abs(prev.y - line.y) <= PARAGRAPH_LINE_FACTOR * Math.min(prev.size, line.size)
    if (sameParagraph) current.push(line.text)
    else {
      if (current.length) paragraphs.push(current)
      current = [line.text]
    }
    prev = { y: line.y, size: line.size }
  }
  if (current.length) paragraphs.push(current)
  return paragraphs
}

export async function pdfToMd(data: ArrayBuffer, fallbackTitle: string): Promise<ConvertedDoc> {
  const pdfjs = await loadPdfjs()
  // 文档的关闭挂在加载任务上(关闭后同一份数据不能再用,所以固定在本函数末尾收尾)
  const loadingTask = pdfjs.getDocument({ data, useWorkerFetch: false, disableFontFace: true })
  const doc = await loadingTask.promise
  const numPages = doc.numPages

  const warnings: string[] = []
  /** 每页的行(自上而下);剔除页眉页脚前后的中间结果都挂在 pageRows 里 */
  const pageRows: PdfLine[][] = []
  const pageHeights: number[] = []
  let totalChars = 0
  /** 字号 → 字符数,供加权众数 */
  const sizeWeights = new Map<number, number>()

  for (let n = 1; n <= numPages; n++) {
    const page = await doc.getPage(n)
    pageHeights.push(page.getViewport({ scale: 1 }).height)
    const content = await page.getTextContent()
    const items: PdfItem[] = []
    for (const raw of content.items) {
      if (!('str' in raw)) continue
      if (!raw.str || !raw.str.trim()) continue
      items.push({
        text: raw.str,
        x: raw.transform[4],
        y: raw.transform[5],
        width: raw.width,
        size: raw.height,
        // 纯文字抽取拿不到可靠字重,styles.fontFamily 里带粗体字样时尽力认一下
        bold: /bold|black|heavy/i.test(String(content.styles[raw.fontName]?.fontFamily || '')),
      })
      totalChars += raw.str.replace(/\s+/g, '').length
      if (raw.height > 0) {
        const key = round1(raw.height)
        sizeWeights.set(key, (sizeWeights.get(key) || 0) + raw.str.length)
      }
    }
    pageRows.push(groupRows(items))
  }
  await loadingTask.destroy().catch(() => {})

  // ⑧ 扫描件:全文可抽出的字符太少
  if (totalChars < SCANNED_CHARS_PER_PAGE * numPages) {
    throw new ImportError('SCANNED_PDF', '这份 PDF 是扫描图片，里面没有可复制的文字，请先用 OCR 工具转成文字版 PDF 再导入')
  }

  // ② 正文字号 = 按字符数加权的字号众数
  let bodySize = 0
  let bodyWeight = 0
  for (const [size, weight] of sizeWeights) {
    if (weight > bodyWeight) {
      bodySize = size
      bodyWeight = weight
    }
  }
  bodySize = bodySize || 1

  removeHeadersFooters(pageRows, pageHeights, numPages)
  detectTables(pageRows, bodySize, warnings)

  // ③+⑤+⑥ 每页:页标题行 → 页头;三级标题 → 「### 」;其余行按行距并段
  const pageTitleLines = new Set<PdfLine>()
  for (const rows of pageRows) {
    for (const line of rows) {
      if (line.size >= bodySize * HEADING_RATIO) pageTitleLines.add(line)
    }
  }

  const pageParts: string[][] = []
  let firstPageTitle = ''
  pageRows.forEach((rows, index) => {
    // 相邻页标题行合并成一行(如跨行的长标题),中日韩之间直接拼
    const titleGroups: PdfLine[][] = []
    for (let i = 0; i < rows.length; i++) {
      const line = rows[i]
      if (!pageTitleLines.has(line)) continue
      const lastGroup = titleGroups[titleGroups.length - 1]
      if (lastGroup && lastGroup[lastGroup.length - 1] === rows[i - 1]) lastGroup.push(line)
      else titleGroups.push([line])
    }
    const pageTitle = titleGroups.length ? titleGroups[0].map((line) => line.text).reduce((acc, text) => smartJoin(acc, text)) : ''
    if (index === 0) firstPageTitle = pageTitle

    const parts: string[] = []
    // ⑥ 每页一个页头;同页还有别的页标题组时降成三级标题,内容不丢
    parts.push(pageTitle ? `## 第 ${index + 1} 页 · ${pageTitle}` : `## 第 ${index + 1} 页`)
    for (const group of titleGroups.slice(1)) {
      parts.push(`### ${group.map((line) => line.text).reduce((acc, text) => smartJoin(acc, text))}`)
    }

    // ⑤ 正文并段:攒下的正文行交给 splitParagraphs 分段;三级标题打断分段
    let chunk: { y: number; size: number; text: string }[] = []
    const flushChunk = () => {
      for (const paragraph of splitParagraphs(chunk)) parts.push(paragraph.reduce((acc, text) => smartJoin(acc, text)))
      chunk = []
    }
    for (const line of rows) {
      if (pageTitleLines.has(line)) continue
      if (line.size >= bodySize * SUBHEADING_RATIO && line.size < bodySize * HEADING_RATIO && (line.bold || line.text.length < SUBHEADING_MAX_CHARS)) {
        flushChunk()
        parts.push(`### ${line.text}`)
        continue
      }
      chunk.push({ y: line.y, size: line.size, text: line.text })
    }
    flushChunk()
    pageParts.push(parts)
  })

  const md = pageParts.map((parts) => parts.join('\n\n')).join('\n\n')
  return { title: firstPageTitle || fallbackTitle, md, warnings }
}

/** ① 按基线 y 归行(容差 2pt),行内按 x 排序后拼文本 */
function groupRows(items: PdfItem[]): PdfLine[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const rows: PdfItem[][] = []
  for (const item of sorted) {
    const current = rows[rows.length - 1]
    if (current && Math.abs(current[0].y - item.y) <= ROW_TOLERANCE_PT) current.push(item)
    else rows.push([item])
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x)
    return {
      y: row[0].y,
      text: joinRow(row),
      size: row.reduce((max, item) => Math.max(max, item.size), 0),
      bold: row.every((item) => item.bold),
      xs: row.map((item) => item.x),
    }
  })
}

/** ④ 页眉页脚:整行连续数字换成单个 # 后跨页重复出现的行整行剔除 */
function removeHeadersFooters(pageRows: PdfLine[][], pageHeights: number[], numPages: number): void {
  const keyPages = new Map<string, Set<number>>()
  pageRows.forEach((rows, index) => {
    for (const line of rows) {
      const key = digitsToHash(line.text)
      if (!keyPages.has(key)) keyPages.set(key, new Set())
      keyPages.get(key)!.add(index)
    }
  })
  const repeated = numPages === 1 ? 1 : Math.max(2, Math.ceil(numPages * HEADER_FOOTER_RATIO))
  const bandOnly = numPages < HEADER_FOOTER_MIN_DOC_PAGES
  pageRows.forEach((rows, index) => {
    const height = pageHeights[index]
    for (let i = rows.length - 1; i >= 0; i--) {
      const line = rows[i]
      const key = digitsToHash(line.text)
      const repeatedEnough = (keyPages.get(key)?.size || 0) >= repeated
      const inBand = bandOnly ? line.y > height * (1 - BAND_FRACTION) || line.y < height * BAND_FRACTION : true
      if (repeatedEnough && inBand) rows.splice(i, 1)
    }
  })
}

/** ⑦ 疑似表格:≥2 行各含 ≥3 个水平分开的文字块,且各行块起点 x 大致对齐 → 每页记一条提醒 */
function detectTables(pageRows: PdfLine[][], bodySize: number, warnings: string[]): void {
  const tolerance = Math.max(TABLE_ALIGN_MIN_PT, bodySize * 0.5)
  pageRows.forEach((rows, index) => {
    const candidates = rows.filter((line) => line.xs.length >= TABLE_MIN_BLOCKS)
    for (const line of candidates) {
      const aligned = candidates.some((other) => other !== line && other.xs.length === line.xs.length && other.xs.every((x, i) => Math.abs(x - line.xs[i]) <= tolerance))
      if (aligned) {
        warnings.push(`第 ${index + 1} 页疑似含表格，已按文字行保留，版式没有还原，请对照原件`)
        return
      }
    }
  })
}