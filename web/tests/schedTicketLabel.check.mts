/**
 * schedTicketLabel.check.mts —— 调度台单子状态文案与配色的字符级断言(DASH-SCHED-RESIDENT-LABEL-1009)。
 * 常驻服务的长期占用单(request.resident === true 且 state === 'granted')显示「常驻占用中」并配运行中的绿色;
 * 普通单的「已授予，等待开跑」与其余所有状态的文字、颜色一字不变;撤单优先级与暂停原因拼接照旧。
 * 跑法:node --import tsx --test 本文件(node:test + assert/strict,写法对齐 readerImportConverters.check.mts,
 * 用带 .ts 扩展名的相对路径引源码)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TicketState } from '../src/api/sched.ts'
import { stateLabels, ticketLabel, ticketTone } from '../src/components/sched/format.ts'

/** 造一张最小单子:只有文案/配色消费的字段,其余一概不带 */
function ticket(state: TicketState, options: { resident?: boolean; cancelRequested?: boolean; pauseReasons?: string[] } = {}) {
  return { state, cancelRequested: options.cancelRequested ?? false, pauseReasons: options.pauseReasons ?? [], resident: options.resident }
}

test('常驻长期占用单:granted + resident 显示「常驻占用中」,配色为运行中的 ok 绿', () => {
  assert.equal(ticketLabel(ticket('granted', { resident: true })), '常驻占用中')
  assert.equal(ticketTone(ticket('granted', { resident: true })), 'ok')
})

test('普通单不受影响:resident 缺省或 false 的 granted 仍是「已授予，等待开跑」info 色', () => {
  for (const resident of [undefined, false]) {
    assert.equal(ticketLabel(ticket('granted', { resident })), '已授予，等待开跑')
    assert.equal(ticketTone(ticket('granted', { resident })), 'info')
  }
})

test('撤单优先:resident 的 granted 单被撤单时仍恰为「撤单处理中」', () => {
  assert.equal(ticketLabel(ticket('granted', { resident: true, cancelRequested: true })), '撤单处理中')
})

test('暂停原因照旧用「 · 」接在常驻占用中后面', () => {
  assert.equal(ticketLabel(ticket('granted', { resident: true, pauseReasons: ['manual'] })), '常驻占用中 · 手动暂停')
})

test('只有 granted 才换说法:常驻的 passed/failed/cancelled 文字与颜色和非常驻完全相同', () => {
  const expected: [TicketState, string, string][] = [['passed', '通过', 'ok'], ['failed', '失败', 'bad'], ['cancelled', '已撤单', 'muted']]
  for (const [state, label, toneValue] of expected) {
    assert.equal(ticketLabel(ticket(state, { resident: true })), label)
    assert.equal(ticketTone(ticket(state, { resident: true })), toneValue)
    assert.equal(ticketLabel(ticket(state, { resident: true })), ticketLabel(ticket(state)))
    assert.equal(ticketTone(ticket(state, { resident: true })), ticketTone(ticket(state)))
  }
})

test('stateLabels 十个键的文字逐字不变(防误改)', () => {
  assert.deepEqual(stateLabels, { queued: '排队中', granted: '已授予，等待开跑', running: '运行中', paused: '暂停中',
    slow: '低速继续', unsatisfiable: '无法满足', passed: '通过', failed: '失败', cancelled: '已撤单', voided: '已作废' })
})
