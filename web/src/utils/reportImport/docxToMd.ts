/**
 * reportImport/docxToMd.ts —— docx 走 mammoth:先转 html,再交给与网页同一条 html 路(htmlToMd)。
 *
 * 图片在 mammoth 的图片处理器里丢掉并计数(工单口径),html 路那边只丢不计,免得翻倍;
 * mammoth 自己 messages 里 type=warning 的前 5 条原样并进 warnings。
 * 重库走动态 import(),只在真处理 docx 时才加载。
 */
import { htmlToMd } from './htmlToMd'

export interface DocxToMdOutcome {
  md: string
  imagesDropped: number
  /** mammoth 的解析提醒(type=warning,最多 5 条) */
  mammothWarnings: string[]
}

type MammothModule = typeof import('mammoth')

let mammothPromise: Promise<MammothModule> | null = null

function loadMammoth() {
  if (!mammothPromise) mammothPromise = import('mammoth') as Promise<MammothModule>
  return mammothPromise
}

export async function docxToMd(data: ArrayBuffer): Promise<DocxToMdOutcome> {
  const mammoth = await loadMammoth()
  let imagesDropped = 0
  // mammoth 的 node 构建只认 buffer、浏览器构建只认 arrayBuffer:两把钥匙一起递,
  // 各自取自己认得的那把,转换代码本身不感知环境(单测在 node 下也要能转真 docx)。
  const input = { arrayBuffer: data, buffer: new Uint8Array(data) }
  const result = await mammoth.convertToHtml(input, {
    convertImage: mammoth.images.imgElement(async () => {
      imagesDropped += 1
      return { src: '' }
    }),
  })
  const mammothWarnings = result.messages
    .filter((message) => message.type === 'warning')
    .slice(0, 5)
    .map((message) => message.message)
  // 转出的 html 是干净的(没有 nav/head 这些外壳),走同一条 html 路,图片不再重复计数
  const { md } = await htmlToMd(result.value, { countImages: false })
  return { md, imagesDropped, mammothWarnings }
}