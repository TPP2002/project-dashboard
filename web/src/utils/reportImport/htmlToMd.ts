/**
 * reportImport/htmlToMd.ts —— html → markdown 的唯一一条路。
 *
 * 网页文件走这里;docx 经 mammoth 转出的 html 也走这里(只是外壳标签与图片计数不同,见选项)。
 * turndown 在浏览器里用自带 DOM 解析、在 node 里用内置 domino,两边都不需要 DOM 垫片。
 * 重库走动态 import(),只在真处理 html/docx 时才加载,主包体积不因本单变大。
 */

/** turndown 实例是带规则状态的,每次转换现开一个,免得上一份文件删过的标签影响下一份 */
interface HtmlToMdOptions {
  /** 真网页才有导航/页脚这些外壳要删;docx 转出的 html 是干净的,不删(工单口径:docx 不再删 nav 等) */
  stripChrome?: boolean
  /** 图片丢弃算在哪边:html 文件由这里数;docx 由 mammoth 的图片处理器数,这里只丢不计免得翻倍 */
  countImages?: boolean
}

export interface HtmlToMdOutcome {
  md: string
  imagesDropped: number
}

let libsPromise: Promise<{ TurndownService: typeof import('turndown').default; gfm: unknown }> | null = null

/** turndown 与 gfm 插件只加载一次,失败的加载也要记住,免得每次转换都重试一遍 */
function loadLibs() {
  if (!libsPromise) {
    libsPromise = Promise.all([import('turndown'), import('turndown-plugin-gfm')]).then(([turndown, gfmMod]) => ({
      TurndownService: turndown.default,
      gfm: (gfmMod as { gfm?: unknown }).gfm,
    }))
  }
  return libsPromise
}

/** 把图片一律丢掉;要不要计数由选项决定(docx 那边已经在 mammoth 里数过了) */
function dropImagesRule(countImages: boolean, counter: { n: number }) {
  return {
    filter: 'img',
    replacement: (): string => {
      if (countImages) counter.n += 1
      return ''
    },
  }
}

/** html 转 markdown:外壳标签按选项删、图片一律丢掉并计数 */
export async function htmlToMd(html: string, options: HtmlToMdOptions = {}): Promise<HtmlToMdOutcome> {
  const { stripChrome = false, countImages = false } = options
  const { TurndownService, gfm } = await loadLibs()
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
  if (gfm) service.use(gfm)
  if (stripChrome) {
    service.remove(['script', 'style', 'noscript', 'iframe', 'nav', 'header', 'footer', 'aside', 'head'])
  }
  const counter = { n: 0 }
  service.addRule('dropImages', dropImagesRule(countImages, counter))
  const md = service.turndown(html)
  return { md, imagesDropped: counter.n }
}