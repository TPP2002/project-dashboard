/**
 * schedEstimateText.check.mts —— 调度台估时文案的字符级断言(AD-20261116-SCHED-ETA-LEARN)。
 * 旧估值(没有 learned 字段)的输出必须与接入模型前的模板文字逐字相同;学了模型的估值改说「一般跑 a~b」,
 * 超时单说明还要多久。页头小标签只报模型自己的准确度。
 * 【旧源码必须可执行】新增导出经命名空间在运行期取用:基线上它们是 undefined,红在明确断言上,
 * 不靠加载报错糊弄对照。跑法:node --import tsx --test 本文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as format from '../src/components/sched/format.ts'

type EstimateText = { headline: string; detail: string; title: string; warn: boolean }
type Pill = { text: string; title: string; ok: boolean }
const { describeEstimate, etaModelPill, duration, stamp } = format as unknown as {
  describeEstimate?: (estimate: unknown) => EstimateText
  etaModelPill?: (info: unknown) => Pill
  duration: (ms: number | null | undefined) => string
  stamp: (at: string | null | undefined) => string
}

/** 缺导出时红在明确断言上,不抛 TypeError。 */
function requireFn<T>(value: T | undefined, name: string): T {
  assert.equal(typeof value, 'function', `必须导出 ${name}`)
  return value as T
}

const START = '2026-11-16T10:00:00.000Z'
const FINISH = '2026-11-16T10:05:00.000Z'
const describe = (estimate: unknown) => requireFn(describeEstimate, 'describeEstimate')(estimate)
const pill = (info: unknown) => requireFn(etaModelPill, 'etaModelPill')(info)

test('旧估值(未学习):等待与完成两例与旧模板文字逐字相同', () => {
  const wait = describe({ kind: 'wait', startAt: START, waitMs: 60000, machine: 'machine-a', medianMs: 120000, sampleCount: 3 })
  assert.equal(wait.headline, `预计等待 ${duration(60000)}`)
  assert.equal(wait.detail, ` · ${stamp(START)} 开跑 · 预计跑 ${duration(120000)}`)
  assert.equal(wait.title, `同类最近 3 次执行的中位耗时：${duration(120000)}`)
  assert.equal(wait.warn, false)
  const completion = describe({ kind: 'completion', finishAt: FINISH, remainingMs: 300000, overdue: false, medianMs: 600000, sampleCount: 5 })
  assert.equal(completion.headline, `预计完成 ${stamp(FINISH)}`)
  assert.equal(completion.detail, ` · 预计跑 ${duration(600000)}`)
  assert.equal(completion.title, `同类最近 5 次执行的中位耗时：${duration(600000)}`)
  assert.equal(completion.warn, false)
})

test('旧估值(未学习):超时一例仍是「已超出预计耗时」并标警示', () => {
  const overdue = describe({ kind: 'completion', finishAt: FINISH, remainingMs: 0, overdue: true, medianMs: 600000, sampleCount: 5 })
  assert.equal(overdue.headline, '已超出预计耗时')
  assert.equal(overdue.detail, ` · 预计跑 ${duration(600000)}`)
  assert.equal(overdue.warn, true)
})

test('旧估值(未学习):ciAware 一例按倍数说明,实测与估两种措辞都在', () => {
  const estimated = describe({ kind: 'completion', finishAt: FINISH, remainingMs: 1000, overdue: false,
    medianMs: 120000, sampleCount: 5, slowdown: 1.5, slowdownEstimated: true })
  assert.equal(estimated.detail, ` · 预计跑 ${duration(180000)} · 低优先级耗时 1.5 倍（估）`)
  const measured = describe({ kind: 'completion', finishAt: FINISH, remainingMs: 1000, overdue: false,
    medianMs: 120000, sampleCount: 5, slowdown: 2, slowdownEstimated: false })
  assert.equal(measured.detail, ` · 预计跑 ${duration(240000)} · 低优先级耗时 2 倍（实测）`)
})

test('学了模型的等待:说「预计等待」并给出「一般跑 a~b」', () => {
  const result = describe({ kind: 'wait', startAt: START, waitMs: 60000, machine: 'machine-a', medianMs: 10000,
    lowMs: 6000, highMs: 60000, sampleCount: 3, basis: '最近 3 次同命令、同参数', level: 1, learned: true })
  assert.equal(result.headline, `预计等待 ${duration(60000)}`)
  assert.equal(result.detail, ` · ${stamp(START)} 开跑 · 一般跑 ${duration(6000)}~${duration(60000)}`)
  assert.equal(result.title, `依据:最近 3 次同命令、同参数;中位 ${duration(10000)}`)
  assert.equal(result.warn, false)
})

test('学了模型的完成但未超时:说「预计完成」并给出常见范围', () => {
  const result = describe({ kind: 'completion', finishAt: FINISH, remainingMs: 120000, overdue: false, medianMs: 300000,
    lowMs: 180000, highMs: 600000, sampleCount: 7, basis: '最近 7 次同命令、同机器', level: 7, learned: true, tail: false })
  assert.equal(result.headline, `预计完成 ${stamp(FINISH)}`)
  assert.equal(result.detail, ` · 一般跑 ${duration(180000)}~${duration(600000)}`)
  assert.equal(result.title, `依据:最近 7 次同命令、同机器;中位 ${duration(300000)}`)
  assert.equal(result.warn, false)
})

test('学了模型的超时:尾巴规则说明还要多久并注明把握不大', () => {
  const result = describe({ kind: 'completion', finishAt: FINISH, remainingMs: 30000, overdue: true, medianMs: 12000,
    lowMs: 8000, highMs: 20000, remainingLowMs: 5000, remainingHighMs: 60000, sampleCount: 3,
    basis: '最近 3 次同命令', level: 8, learned: true, tail: true })
  assert.equal(result.headline, '已超出常见耗时')
  assert.equal(result.detail, ` · 按已跑时长估,还要约 ${duration(30000)}(把握不大)`)
  assert.equal(result.title, `依据:最近 3 次同命令;中位 ${duration(12000)}`)
  assert.equal(result.warn, true)
})

test('学了模型的超时:按同类更慢的几次续估时不提把握不大', () => {
  const result = describe({ kind: 'completion', finishAt: FINISH, remainingMs: 15000, overdue: true, medianMs: 40000,
    lowMs: 20000, highMs: 60000, sampleCount: 5, basis: '最近 5 次同命令、同参数', level: 4, learned: true, tail: false })
  assert.equal(result.headline, '已超出常见耗时')
  assert.equal(result.detail, ` · 按同类活里更慢的几次估,还要约 ${duration(15000)}`)
  assert.equal(result.warn, true)
})

test('页头小标签:没读到模型状态时为空,页面不显示', () => {
  assert.deepEqual(pill(undefined), { text: '', title: '', ok: false })
  assert.deepEqual(pill(null), { text: '', title: '', ok: false })
})

test('页头小标签:模型未就绪时说明暂用旧口径并保留原因', () => {
  const result = pill({ loaded: false, reason: '估时模型文件还没生成' })
  assert.equal(result.text, '估时模型未就绪 · 暂用旧口径')
  assert.equal(result.title, '估时模型文件还没生成')
  assert.equal(result.ok, false)
})

test('页头小标签:模型刚起步没有对照数据时说明已学几组', () => {
  const result = pill({ loaded: true, updatedAt: null, buckets: 12,
    accuracy: { n: 0, medianApe: null, within30: null, within50: null, intervalHit: null, scale: 1, updatedAt: null } })
  assert.equal(result.text, '估时模型刚起步 · 还没有对照数据')
  assert.equal(result.title, '已学 12 组')
  assert.equal(result.ok, true)
})

test('页头小标签:正常时按四舍五入的百分比报最近准确度', () => {
  const updatedAt = '2026-11-16T09:30:00.000Z'
  const result = pill({ loaded: true, updatedAt, buckets: 42,
    accuracy: { n: 500, medianApe: 0.34, within30: 0.44, within50: 0.62, intervalHit: 0.81, scale: 1.2, updatedAt } })
  assert.ok(result.text.includes('误差 30% 内 44%'), result.text)
  assert.ok(result.text.includes('近 500 次'), result.text)
  assert.ok(result.title.includes('范围命中 81%'), result.title)
  assert.ok(result.title.includes('误差 50% 内 62%'), result.title)
  assert.ok(result.title.includes(`学习于 ${stamp(updatedAt)}`), result.title)
  assert.equal(result.ok, true)
})

test('宽范围的等待只说明耗时差别大', () => {
  const result = describe({ kind: 'wait', learned: true, startAt: START, waitMs: 60000, lowMs: 1, highMs: 29220000 })
  assert.equal(result.detail, ` · ${stamp(START)} 开跑 · 这类活耗时差别很大，只能给个大概`)
})

test('宽范围的完成保留低优先级说明', () => {
  const result = describe({ kind: 'completion', learned: true, finishAt: FINISH, lowMs: 54000, highMs: 29220000, slowdown: 1.5 })
  assert.equal(result.detail, ' · 这类活耗时差别很大，完成时刻只能给个大概 · 低优先级耗时 1.5 倍（估）')
})

test('范围恰好二十倍不算宽，多一毫秒算宽', () => {
  const base = { kind: 'completion', learned: true, finishAt: FINISH, lowMs: 60000 }
  assert.equal(describe({ ...base, highMs: 1200000 }).detail, ` · 一般跑 ${duration(60000)}~${duration(1200000)}`)
  assert.equal(describe({ ...base, highMs: 1200001 }).detail, ' · 这类活耗时差别很大，完成时刻只能给个大概')
  assert.equal(describe({ ...base, highMs: undefined }).detail, ` · 一般跑 ${duration(60000)}~${duration(undefined)}`)
})

test('常驻占用直接显示不会自己结束', () => {
  assert.deepEqual(describe({ kind: 'unavailable', code: 'resident', reason: '常驻占用，不会自己结束' }),
    { headline: '常驻占用，不会自己结束', detail: '', title: '', warn: false })
})

test('宽范围超时的两种说明保持不变', () => {
  const base = { kind: 'completion', learned: true, overdue: true, remainingMs: 30000, lowMs: 1, highMs: 29220000 }
  assert.equal(describe({ ...base, tail: true }).detail, ` · 按已跑时长估,还要约 ${duration(30000)}(把握不大)`)
  assert.equal(describe({ ...base, tail: false }).detail, ` · 按同类活里更慢的几次估,还要约 ${duration(30000)}`)
})
