/**
 * readerImportFlow.check.mts —— 「导入报告」对话框纯函数辅助(READER-IMPORT-BUTTON T3)的字符级断言。
 * 文件故意不放 test/ 目录、也不叫 *.test.*:CI 的全量 `node --test` 会自动扫这两类并用普通 node 跑
 * (与 readerImportConverters.check.mts 同理由)。用 `npm run test:reader-import-flow` 单独跑。
 *
 * 全部输入都是定长造出来的确定性字节(种子固定的线性同余),不用 Math.random / Date.now。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bytesToBase64, ORIGINAL_MAX_BYTES, shouldKeepOriginal, summarizeImport } from '../src/utils/reportImport/importFlow.ts'

/** 种子固定的线性同余发生器:同 seed 必须同结果 */
function patternBytes(count: number, seed = 1): ArrayBuffer {
  const bytes = new Uint8Array(count)
  let state = seed >>> 0
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    bytes[i] = state & 0xff
  }
  return bytes.buffer
}

function textBytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

function expectSameAsBuffer(buf: ArrayBuffer): void {
  assert.equal(bytesToBase64(buf), Buffer.from(new Uint8Array(buf)).toString('base64'))
}

test('ORIGINAL_MAX_BYTES 与 server 契约一致:30MB', () => {
  assert.equal(ORIGINAL_MAX_BYTES, 30 * 1024 * 1024)
})

test('bytesToBase64:空串、ASCII、中文、边界块长,全部与 Buffer 对拍一致', () => {
  expectSameAsBuffer(new ArrayBuffer(0))
  expectSameAsBuffer(textBytes('abc'))
  assert.equal(bytesToBase64(textBytes('abc')), 'YWJj')
  expectSameAsBuffer(textBytes('ab'))
  assert.equal(bytesToBase64(textBytes('ab')), 'YWI=')
  expectSameAsBuffer(textBytes('a'))
  assert.equal(bytesToBase64(textBytes('a')), 'YQ==')
  expectSameAsBuffer(textBytes('审阅台导入报告'))
  // 块边界(3×16384=49152)前后各一个字节:边界上不能多出一个填充字符
  expectSameAsBuffer(patternBytes(49151))
  expectSameAsBuffer(patternBytes(49152))
  expectSameAsBuffer(patternBytes(49153))
})

test('bytesToBase64:5MB 的缓冲不爆栈,结果仍与 Buffer 对拍一致', () => {
  expectSameAsBuffer(patternBytes(5 * 1024 * 1024))
})

test('shouldKeepOriginal:没超过 30MB 就带原件,恰好 30MB 也带,超 1 字节就不带', () => {
  assert.equal(shouldKeepOriginal(0), true)
  assert.equal(shouldKeepOriginal(1), true)
  assert.equal(shouldKeepOriginal(ORIGINAL_MAX_BYTES - 1), true)
  assert.equal(shouldKeepOriginal(ORIGINAL_MAX_BYTES), true)
  assert.equal(shouldKeepOriginal(ORIGINAL_MAX_BYTES + 1), false)
})

test('summarizeImport:只数成功的;有重份才带后半句;全失败直说没有', () => {
  assert.equal(summarizeImport([]), '没有导入成功的文件')
  assert.equal(summarizeImport([{ ok: false, duplicate: false }]), '没有导入成功的文件')
  assert.equal(summarizeImport([{ ok: false, duplicate: false }, { ok: true, duplicate: true }]), '已导入 1 份,其中 1 份此前已导入')
  assert.equal(
    summarizeImport([{ ok: true, duplicate: false }, { ok: true, duplicate: false }, { ok: true, duplicate: false }]),
    '已导入 3 份',
  )
  assert.equal(
    summarizeImport([
      { ok: true, duplicate: true },
      { ok: false, duplicate: false },
      { ok: true, duplicate: false },
      { ok: true, duplicate: true },
    ]),
    '已导入 3 份,其中 2 份此前已导入',
  )
})
