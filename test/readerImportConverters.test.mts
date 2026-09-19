/**
 * readerImportConverters.test.mts —— 审阅台导入转换器(READER-IMPORT-BUTTON T2)的字符级断言。
 *
 * 夹具全部是虚构样稿(test/fixtures/reader-import/),期望值清单在 expected.json。
 * 比较口径:结果与期望都去掉全部空白之后做「包含」判断(工单第 11 条)。
 * 跑法:npm run test:reader-import(node --import tsx --test 本文件)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { convertFile, detectFormat, ImportError } from '../web/src/utils/reportImport/index.ts'
import type { ImportErrorCode } from '../web/src/utils/reportImport/types.ts'
import { digitsToHash, joinRow, splitParagraphs } from '../web/src/utils/reportImport/pdfToMd.ts'

/** 夹具与期望值:全部虚构,直接按相对路径读 */
const FIXTURES = 'fixtures/reader-import/'
const fixtureUrl = (name: string) => new URL(FIXTURES + name, import.meta.url)
const expected = JSON.parse(readFileSync(fixtureUrl('expected.json'), 'utf8')) as {
  pdfMustContain: string[]
  pdfMustNotContain: string[]
  pdfHeadings: string[]
  docxMustContain: string[]
  htmlMustContain: string[]
  htmlMustNotContain: string[]
}

/** 读夹具字节,转成 convertFile 要的 ArrayBuffer */
function fixtureBytes(name: string): ArrayBuffer {
  const buffer = readFileSync(fixtureUrl(name))
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

/** 文本 → ArrayBuffer(造不支持的格式、超限文件、损坏文件用) */
function textBytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

/** 去掉全部空白再比较,口径与工单一致 */
function squish(text: string): string {
  return text.replace(/\s+/g, '')
}

function expectContained(md: string, list: string[]): void {
  const flat = squish(md)
  for (const want of list) assert.ok(flat.includes(squish(want)), `转换结果里应出现:「${want}」`)
}

function expectAbsent(md: string, list: string[]): void {
  const flat = squish(md)
  for (const banned of list) assert.ok(!flat.includes(squish(banned)), `转换结果里不该出现:「${banned}」`)
}

/** 断言 promise 以指定 code 的 ImportError 拒绝,hint 里带着给负责人看的应对话术 */
async function expectImportError(promise: Promise<unknown>, code: ImportErrorCode, hintPart?: string): Promise<void> {
  let raised: unknown
  try {
    await promise
  } catch (error) {
    raised = error
  }
  assert.ok(raised !== undefined, `应当抛 ${code},却正常返回了`)
  assert.ok(raised instanceof ImportError, `应当抛 ImportError,实际:${String(raised)}`)
  assert.equal((raised as ImportError).code, code)
  if (hintPart) assert.ok((raised as ImportError).hint.includes(hintPart), `hint 应含「${hintPart}」,实际:${(raised as ImportError).hint}`)
}

test('detectFormat:扩展名为主、mime 为辅,名单外一律不认', () => {
  assert.equal(detectFormat('报告.MD'), 'md')
  assert.equal(detectFormat('a.markdown'), 'md')
  assert.equal(detectFormat('a.txt'), 'txt')
  assert.equal(detectFormat('a.htm'), 'html')
  assert.equal(detectFormat('a.html'), 'html')
  assert.equal(detectFormat('a.docx'), 'docx')
  assert.equal(detectFormat('a.pdf'), 'pdf')
  // 名单外:.doc/.pages/.rtf/图片/无扩展名 → null(交给 convertFile 抛 UNSUPPORTED)
  assert.equal(detectFormat('a.doc'), null)
  assert.equal(detectFormat('a.pages'), null)
  assert.equal(detectFormat('a.rtf'), null)
  assert.equal(detectFormat('a.png'), null)
  assert.equal(detectFormat('noext'), null)
  // 扩展名认不出来时才看 mime;认得出来时扩展名优先
  assert.equal(detectFormat('noext', 'text/html'), 'html')
  assert.equal(detectFormat('a.bin', 'application/pdf'), 'pdf')
  assert.equal(detectFormat('a.md', 'text/html'), 'md')
  assert.equal(detectFormat('a.bin', 'weird/mime'), null)
  assert.equal(detectFormat('a.bin'), null)
})

test('md:原样保留(去 BOM、统一换行),title 取第一个一级标题', async () => {
  const r = await convertFile({ name: 'sample.md', data: fixtureBytes('sample.md') })
  assert.equal(r.format, 'md')
  assert.equal(r.title, '示例 Markdown 报告')
  assert.deepEqual(r.warnings, [])
  assert.ok(r.md.includes('正文一段。'))
  assert.ok(r.md.includes('| 甲 | 乙 |'))
  const bom = 0xfeff
  const withBom = await convertFile({ name: 'bom.md', data: textBytes(String.fromCharCode(bom) + '# 备忘\r\n\r\n第一段。\r\n') })
  assert.equal(withBom.title, '备忘')
  assert.ok(withBom.md.includes('# 备忘\n\n第一段。'), 'CRLF 应统一成 LF')
  assert.ok(!withBom.md.includes('\r'), '不该再剩回车符')
})

test('md:没有标题时 title 回落文件名(去扩展名)', async () => {
  const r = await convertFile({ name: '周报.md', data: textBytes('正文一段,没有标题。') })
  assert.equal(r.title, '周报')
})

test('txt:按空行分段,段内单个换行保留为硬换行', async () => {
  const r = await convertFile({ name: 'sample.txt', data: fixtureBytes('sample.txt') })
  assert.equal(r.format, 'txt')
  assert.equal(r.title, '示例纯文本报告')
  assert.ok(r.md.includes('示例纯文本报告\n\n第一段。'), '空行应变成段落分隔')
  assert.ok(r.md.includes('第一段。  \n第一段的第二行。'), '段内换行应写成行尾两个空格的硬换行')
  assert.ok(r.md.trimEnd().endsWith('第二段。'))
})

test('html:正文/清单/表格转 markdown,脚本、样式与导航外壳一律剔除', async () => {
  const r = await convertFile({ name: 'sample.html', data: fixtureBytes('sample.html') })
  assert.equal(r.format, 'html')
  assert.equal(r.title, '示例网页报告', 'title 应取原始 html 里的 <title>')
  assert.deepEqual(r.warnings, [])
  expectContained(r.md, expected.htmlMustContain)
  expectAbsent(r.md, expected.htmlMustNotContain)
})

test('html:图片一律丢掉并计数提醒;没有 <title> 时 title 回落到正文标题', async () => {
  const withImages = '<html><body><p>开头</p><img src="a.png"><img src="b.png"><p>结尾</p></body></html>'
  const r = await convertFile({ name: '带图.html', data: textBytes(withImages) })
  assert.deepEqual(r.warnings, ['2 张图片未导入'])
  expectAbsent(r.md, ['a.png'])
  assert.ok(r.md.includes('开头'))
  const noTitle = await convertFile({ name: '无标题.html', data: textBytes('<h1>正文里的标题</h1><p>一段</p>') })
  assert.equal(noTitle.title, '正文里的标题')
})

test('docx:mammoth 转 html 后走同一条 html 路,标题/正文/列表/表格文字都保住', async () => {
  const r = await convertFile({ name: 'sample.docx', data: fixtureBytes('sample.docx') })
  assert.equal(r.format, 'docx')
  assert.equal(r.title, '示例产品审阅', 'title 应取第一个标题(各级标题都认)')
  expectContained(r.md, expected.docxMustContain)
}, { timeout: 30000 })

test('pdf:三页文字版转 markdown,页标题/三级标题/页眉页脚/表格行都按口径处理', async () => {
  const r = await convertFile({ name: 'sample.pdf', data: fixtureBytes('sample.pdf') })
  assert.equal(r.format, 'pdf')
  assert.equal(r.title, expected.pdfHeadings[0], 'title 应取第一页的页标题行')
  expectContained(r.md, expected.pdfMustContain)
  expectAbsent(r.md, expected.pdfMustNotContain)
  // 页标题按「## 第 N 页 · 页标题」输出;第二页跨行的长标题要合并成一行
  const pageHeads = [...r.md.matchAll(/^## 第 (\d+) 页(?: · (.+))?$/gm)]
  assert.equal(pageHeads.length, 3, `应有三页页头,实际:${JSON.stringify(pageHeads)}`)
  assert.deepEqual(pageHeads.map((m) => Number(m[1])), [1, 2, 3])
  assert.deepEqual(pageHeads.map((m) => m[2]), expected.pdfHeadings)
  // 三级标题:字号中等的短行(先看这两点/建议做法/D1/D2)
  assert.ok(r.md.includes('### 先看这两点'))
  assert.ok(r.md.includes('### 建议做法'))
  assert.ok(r.md.includes('### D1 · 是否先只做两条主路线'))
  // 表格不还原:第一页的表按行保字,并给中文提醒
  assert.deepEqual(r.warnings, ['第 1 页疑似含表格，已按文字行保留，版式没有还原，请对照原件'])
}, { timeout: 60000 })

test('不支持的格式与超大文件在转换开始前就被拦下', async () => {
  await expectImportError(convertFile({ name: '老文档.doc', data: textBytes('正文') }), 'UNSUPPORTED', '另存为 docx 或 pdf')
  await expectImportError(convertFile({ name: 'a.pages', data: textBytes('正文') }), 'UNSUPPORTED')
  await expectImportError(convertFile({ name: 'a.rtf', data: textBytes('正文') }), 'UNSUPPORTED')
  const oversized = new Uint8Array(30 * 1024 * 1024 + 1)
  await expectImportError(convertFile({ name: '太大.pdf', data: oversized.buffer as ArrayBuffer }), 'TOO_LARGE')
})

test('转出来没有文字 → EMPTY', async () => {
  await expectImportError(convertFile({ name: '空白.md', data: textBytes('   \n  \n') }), 'EMPTY')
  await expectImportError(convertFile({ name: '空段.html', data: textBytes('<html><body><p>   </p></body></html>') }), 'EMPTY')
})

test('损坏的文件 → PARSE_FAILED,提示换一份', async () => {
  await expectImportError(convertFile({ name: '坏.docx', data: textBytes('这不是真的 docx,是冒充的纯文本。') }), 'PARSE_FAILED', '文件可能已损坏')
})

test('扫描件 PDF(抽不出文字)→ SCANNED_PDF,提示先做 OCR', async () => {
  await expectImportError(convertFile({ name: '扫描件.pdf', data: blankPdf() }), 'SCANNED_PDF', 'OCR')
})

test('pdf 纯函数:页脚钥匙数字整串归一、行内大间距强制补空格、并段看字号与行距', () => {
  // 页眉页脚钥匙:连续数字整串换一个 # ——「5 / 51」和「12 / 51」必须同一把钥匙(逐字替换会让个位数页码的页脚漏剔)
  assert.equal(digitsToHash('负责人审阅版 | 非施工指令 5 / 51'), digitsToHash('负责人审阅版 | 非施工指令 12 / 51'))
  assert.equal(digitsToHash('页脚 5 / 51'), '页脚 # / #')

  // 行内空格:同是中文、水平间距 ≥1×字号也要补一个空格(表格单元格不许粘);间距很小则直接拼
  const cell = (text: string, x: number) => ({ text, x, width: 20, size: 10 })
  assert.equal(joinRow([cell('甲乙', 40), cell('甲乙', 0)]), '甲乙 甲乙', '间距 2×字号,中文之间也要补空格')
  assert.equal(joinRow([cell('甲乙', 0), cell('甲乙', 21)]), '甲乙甲乙', '间距 0.1×字号,直接拼')

  // 并段:字号相同、行距 1.6×字号 → 一段;行距 2.5×字号 → 两段;字号突变 → 两段
  const line = (y: number, size: number, text: string) => ({ y, size, text })
  assert.deepEqual(splitParagraphs([line(100, 10, '第一行'), line(84, 10, '第二行')]), [['第一行', '第二行']])
  assert.deepEqual(splitParagraphs([line(100, 10, '第一行'), line(75, 10, '第二行')]), [['第一行'], ['第二行']])
  assert.deepEqual(splitParagraphs([line(100, 10, '第一行'), line(85, 12, '第二行')]), [['第一行'], ['第二行']])
})

/** 现造一份合法但没有文字的单页 PDF(纯手工字节,内容确定,不依赖随机与时间) */
function blankPdf(): ArrayBuffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((entry, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${entry}\nendobj\n`
  })
  const xrefStart = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return textBytes(body)
}