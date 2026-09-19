/**
 * reportImport/types.ts —— 审阅台「本机导入」浏览器端转换器的公共类型(READER-IMPORT-BUTTON T2)。
 *
 * 这里只描述数据形状与错误;转换逻辑在同级各格式模块里。T3 的导入按钮只经 index.ts 的
 * convertFile / detectFormat 进来,失败时按 ImportError.code 分提示,不许去比对 message 文案。
 */

/** 支持导入的格式(与 T1 server 的 format 名单严格一致,不许自行增删) */
export type ImportFormat = 'md' | 'txt' | 'html' | 'docx' | 'pdf'

/**
 * 转换成功的结果:title 交给 server 当报告标题,md 是报告正文,
 * warnings 是给审阅台提示条的一句话(比如「3 张图片未导入」)。
 */
export interface ImportResult {
  title: string
  md: string
  format: ImportFormat
  warnings: string[]
}

/** 转换失败的原因码;每个码都对应一种负责人自己能处理的局面 */
export type ImportErrorCode = 'UNSUPPORTED' | 'EMPTY' | 'SCANNED_PDF' | 'TOO_LARGE' | 'PARSE_FAILED'

/**
 * 转换失败抛出的错误。hint 是写给不懂技术的负责人的一句大白话:
 * 不解释哪里坏了,直接告诉他该怎么办(比如「请先用 OCR 工具转成文字版 PDF 再导入」)。
 */
export class ImportError extends Error {
  code: ImportErrorCode
  hint: string

  constructor(code: ImportErrorCode, hint: string) {
    super(hint)
    this.name = 'ImportError'
    this.code = code
    this.hint = hint
  }
}

/**
 * 各格式转换器的内部返回;format 由 convertFile 统一补上,转换器自己不关心这个字段。
 */
export interface ConvertedDoc {
  title: string
  md: string
  warnings: string[]
}