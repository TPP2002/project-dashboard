/**
 * reportImport/importFlow.ts —— 「导入报告」对话框的纯函数辅助(READER-IMPORT-BUTTON T3)。
 *
 * 只放与界面无关、可以单测的小件:原件转 base64(分块,几 MB 的原件也不爆栈)、
 * 原件要不要随导入保存的大小口径、一轮导入的结果汇总成一句给负责人看的话。
 * 不做界面、不发请求 —— 那些在 ImportDialog.vue;转换本身在 T2 的 index.ts。
 */

/** 原件随导入保存的上限(字节),与 server 契约一致:解码后超 30MB server 回 413,所以超限就不带 */
export const ORIGINAL_MAX_BYTES = 30 * 1024 * 1024

/** 每块多少字节转一段 base64:取 3 的倍数,块边界正好落在 base64 字符的整边界上,各块结果可以首尾相接 */
const B64_CHUNK = 3 * 16384

/**
 * 字节 → base64:分块过 btoa,几 MB 的缓冲也不会把调用栈压爆(一口气 String.fromCharCode(...全部)
 * 会爆)。结果与 Node 的 Buffer.from(buf).toString('base64') 逐字符一致,有单测对拍。
 */
export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const parts: string[] = []
  for (let start = 0; start < bytes.length; start += B64_CHUNK) {
    const end = Math.min(start + B64_CHUNK, bytes.length)
    let binary = ''
    for (let i = start; i < end; i++) binary += String.fromCharCode(bytes[i])
    parts.push(btoa(binary))
  }
  return parts.join('')
}

/** 原件要不要随导入保存:不超过上限就带;超了只导入文字,对话框里给负责人一句提示 */
export function shouldKeepOriginal(byteLength: number): boolean {
  return byteLength <= ORIGINAL_MAX_BYTES
}

/**
 * 一轮导入(逐份 POST 的回包)汇总成一行提示:N=导入成功份数,M=其中此前已导入(同内容同 key)
 * 的份数;M 为 0 时省略后半句,一份都没成功时直接说没有。
 */
export function summarizeImport(results: { duplicate: boolean; ok: boolean }[]): string {
  const okResults = results.filter((r) => r.ok)
  if (!okResults.length) return '没有导入成功的文件'
  const duplicates = okResults.filter((r) => r.duplicate).length
  const base = `已导入 ${okResults.length} 份`
  return duplicates ? `${base},其中 ${duplicates} 份此前已导入` : base
}
