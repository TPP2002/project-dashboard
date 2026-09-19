/**
 * reportImport/shims.d.ts —— 无自带类型的转换库补最小声明。
 * turndown 7.x 与 turndown-plugin-gfm 都不带类型;这里只声明本单真正用到的那一小面。
 */

declare module 'turndown' {
  /** 只声明用到的选项与方法;filter 支持标签名与谓词,replacement 返回 markdown 片段 */
  export default class TurndownService {
    constructor(options?: Record<string, unknown>)
    /** 挂 turndown-plugin-gfm 的规则集(表格/删除线/任务清单) */
    use(plugin: unknown): this
    /** 整个元素连同内容一起丢弃(script/style/nav 这些外壳) */
    remove(tags: string[]): this
    addRule(
      key: string,
      rule: {
        filter: string | string[] | ((node: unknown) => boolean)
        replacement: (content: string, node: unknown) => string
      },
    ): this
    turndown(html: string): string
  }
}

// turndown-plugin-gfm 只被 turndown 的 use() 消费,保持无类型即可(gfm 具名导入按 any 用)
declare module 'turndown-plugin-gfm'