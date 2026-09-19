/**
 * reportImport/index.ts —— 审阅台「本机导入」的浏览器端转换入口(READER-IMPORT-BUTTON T2)。
 *
 * T3 的导入按钮只依赖这里的 detectFormat / convertFile:给文件名与内容,拿回可直接交给
 * server 的 markdown、标题与提醒。五种格式各走各的模块;重库(pdfjs-dist / mammoth /
 * turndown)全部动态 import(),只在真用到对应格式时才加载,主包体积不因本单变大。
 *
 * 不做界面、不调接口 —— 那是 T1 / T3 的活。
 */
import type { ConvertedDoc, ImportFormat, ImportResult } from './types'
import { ImportError } from './types'
// 转换失败时 T3 只需要认识 ImportError,顺手从这里再导一份,免得调用方记两个出处
export { ImportError } from './types'
import { firstHeading, mdFromText, txtFromText } from './textToMd'
import { htmlToMd } from './htmlToMd'
import { docxToMd } from './docxToMd'
import { pdfToMd } from './pdfToMd'

// 与 T1 server 的 original 上限一致:超了在浏览器端就直接拒,免得白转一趟
const MAX_BYTES = 30 * 1024 * 1024

/** 扩展名 → 格式(主判据;.markdown 归 md,.htm 归 html) */
const EXT_FORMATS: Record<string, ImportFormat> = {
  md: 'md',
  markdown: 'md',
  txt: 'txt',
  html: 'html',
  htm: 'html',
  docx: 'docx',
  pdf: 'pdf',
}

/** MIME → 格式(辅判据;只在扩展名认不出来时看) */
const MIME_FORMATS: Record<string, ImportFormat> = {
  'text/markdown': 'md',
  'text/plain': 'txt',
  'text/html': 'html',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
}

/** 按扩展名为主、mime 为辅判断格式;名单外(.doc/.pages/.rtf/图片等)一律 null */
export function detectFormat(fileName: string, mime?: string): ImportFormat | null {
  const dot = fileName.lastIndexOf('.')
  if (dot >= 0) {
    const ext = fileName.slice(dot + 1).toLowerCase()
    if (EXT_FORMATS[ext]) return EXT_FORMATS[ext]
  }
  if (mime) return MIME_FORMATS[mime.split(';')[0].trim().toLowerCase()] || null
  return null
}

/** 文件名去扩展名,作为 title 的兜底 */
function baseName(fileName: string): string {
  const trimmed = fileName.trim().replace(/[\\/]+$/, '')
  const dot = trimmed.lastIndexOf('.')
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed
  return base.trim() || trimmed
}

function decodeText(data: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(data)
}

/** 从原始 html 字符串里取 <title>(没有就返回空串;常见的几个实体顺手解掉) */
function htmlTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!m) return ''
  const text = m[1]
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:#39|apos);/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, '&')
  return text.replace(/\s+/g, ' ').trim()
}

/** 图片被丢掉时的统一提醒文案 */
function imageWarnings(imagesDropped: number): string[] {
  return imagesDropped > 0 ? [`${imagesDropped} 张图片未导入`] : []
}

async function convertByFormat(format: ImportFormat, name: string, data: ArrayBuffer): Promise<ConvertedDoc> {
  switch (format) {
    case 'md':
      return mdFromText(decodeText(data), baseName(name))
    case 'txt':
      return txtFromText(decodeText(data), baseName(name))
    case 'html': {
      const html = decodeText(data)
      const { md, imagesDropped } = await htmlToMd(html, { stripChrome: true, countImages: true })
      // title:原始 html 的 <title> → 转出 md 里第一个「# 」标题 → 文件名
      const title = htmlTitle(html) || firstHeading(md, 1) || baseName(name)
      return { title, md, warnings: imageWarnings(imagesDropped) }
    }
    case 'docx': {
      const { md, imagesDropped, mammothWarnings } = await docxToMd(data)
      // title 取第一个标题(mammoth 会把各级标题都转成 markdown 标题)
      return { title: firstHeading(md, 6) || baseName(name), md, warnings: [...imageWarnings(imagesDropped), ...mammothWarnings] }
    }
    case 'pdf':
      return pdfToMd(data, baseName(name))
    default:
      throw new ImportError('UNSUPPORTED', '这种格式暂时不能导入。请把它另存为 docx 或 pdf 再导入')
  }
}

/**
 * 把用户拖进来的一个文件转成审阅台能读的 markdown。
 * 失败一律抛 ImportError,hint 是写给不懂技术的负责人的一句话。
 */
export async function convertFile(input: { name: string; data: ArrayBuffer }): Promise<ImportResult> {
  const format = detectFormat(input.name)
  if (!format) {
    throw new ImportError('UNSUPPORTED', '这种格式暂时不能导入。请把它另存为 docx 或 pdf 再导入;纯文字的内容也可以存成 txt 或 md')
  }
  if (input.data.byteLength > MAX_BYTES) {
    throw new ImportError('TOO_LARGE', '这个文件超过 30MB,太大了。请先把它拆小或压缩后再导入')
  }
  let doc: ConvertedDoc
  try {
    doc = await convertByFormat(format, input.name, input.data)
  } catch (error) {
    if (error instanceof ImportError) throw error
    // 库解析报错统一包成「文件可能已损坏」,不让库自己的英文报错漏到负责人眼前
    throw new ImportError('PARSE_FAILED', '这份文件读不出来,文件可能已损坏,请换一份试试')
  }
  if (!doc.md.replace(/\s+/g, '')) {
    throw new ImportError('EMPTY', '转换之后没有读到任何文字。请确认这份文件里有内容;如果它是扫描件或纯图片,请先转成带文字的版本')
  }
  return { title: doc.title || baseName(input.name), md: doc.md, format, warnings: doc.warnings }
}