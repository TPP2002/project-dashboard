/**
 * reportImport/pdfjsLoader.ts —— pdfjs-dist 的加载,全仓唯一允许感知运行环境差异的文件:
 *
 *   · 浏览器:动态 import 现代构建,并用 Vite 的「?url」把 worker 文件变成可访问地址
 *     配给 GlobalWorkerOptions.workerSrc(worker 以 module 方式起,转换走主线程外的小进程);
 *   · node(单测):用 legacy 构建,不起 worker —— pdf.js 在 node 下自动退到 fake worker。
 *
 * pdfToMd 只向这里要一个 getDocument,转换逻辑本身不许出现上面任何一条。
 */

export type PdfjsModule = typeof import('pdfjs-dist')

let cached: Promise<PdfjsModule> | null = null

/** 同一份 pdfjs 只加载一次;失败的加载也记住,免得换页时反复重试 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!cached) cached = load()
  return cached
}

async function load(): Promise<PdfjsModule> {
  if (typeof document === 'undefined') {
    // node 测试环境:legacy 构建 + 不起 worker。@vite-ignore 让打包器别把这条 node 专用的
    // 分支拆进浏览器产物(浏览器永远走不到这里,留下的只是死代码里的一个动态 import)。
    const legacy = (await import(/* @vite-ignore */ 'pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule
    return legacy
  }
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}