/**
 * reportImport/textToMd.ts —— md / txt 这两种纯文本的转换(最直接的两条路)。
 *
 *   · md:原样保留(去掉 BOM、把 CRLF/CR 统一成 \n),title 取第一个「# 」标题,没有就回落文件名;
 *   · txt:按空行分段,段内单个换行保留为硬换行(行尾两个空格 + 换行),
 *     title 取第一个非空行(截 60 字),没有就回落文件名。
 */
import type { ConvertedDoc } from './types'

/** 去掉 BOM 并统一换行(Windows 上存出来的 txt 常带 \r\n) */
export function normalizeText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return withoutBom.replace(/\r\n?/g, '\n')
}

/**
 * 扫 markdown 里的第一个标题。默认只认一级标题「# 」(md 与 html 的口径);
 * docx 那边 mammoth 会把各级标题都转出来,把 maxLevel 放到 6 就各级都认。
 */
export function firstHeading(md: string, maxLevel = 1): string | null {
  for (const line of md.split('\n')) {
    const m = /^(#{1,6}) +(.+?)(?: +#*)?$/.exec(line)
    if (m && m[1].length <= maxLevel) return m[2].trim()
  }
  return null
}

/** md:原样保留,title 取第一个「# 」标题 */
export function mdFromText(raw: string, fallbackTitle: string): ConvertedDoc {
  const md = normalizeText(raw)
  return { title: firstHeading(md, 1) || fallbackTitle, md, warnings: [] }
}

/** txt:按空行分段,段内单换行写成 markdown 硬换行 */
export function txtFromText(raw: string, fallbackTitle: string): ConvertedDoc {
  const text = normalizeText(raw)
  const paragraphs = text
    // 一个或多个空行 = 段落分隔
    .split(/(?:\n[ \t]*)+\n/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''))
        .filter((line) => line.trim() !== '')
        // 行尾两个空格 + 换行 = markdown 硬换行
        .join('  \n'),
    )
    .filter((paragraph) => paragraph.trim() !== '')
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '') || ''
  return {
    title: firstLine.slice(0, 60) || fallbackTitle,
    md: paragraphs.join('\n\n'),
    warnings: [],
  }
}