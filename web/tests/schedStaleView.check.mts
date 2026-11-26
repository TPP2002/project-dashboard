import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as formatModule from '../src/components/sched/format.ts'

// 复用既有数据仓 harness（只加了可控时钟这一项夹具），不让它的既有用例在本文件里重复注册。
if (!process.argv.includes('--harness-only')) process.argv.push('--harness-only')
const { harness, snapshot } = await import('./schedResourceLifecycle.check.mts')

const dispatcherHealth = (formatModule as any).dispatcherHealth as
  (input: { heartbeatAt: string | null; snapshotAt: number | null; now: number }) =>
    { kind: 'online' | 'lost' | 'stale-view'; heartbeatAgeMs: number | null; viewAgeMs: number | null }

const BASE = Date.parse('2026-11-26T10:00:00.000Z')
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

/** 可控时钟：沙箱里的 Date.now()/new Date() 跟着它走，好把 5 秒一拍推到 20 秒以外。 */
function fakeClock(start: number) {
  let current = start
  class FakeDate extends Date {
    constructor(value?: any) { super(value === undefined ? current : value) }
    static now() { return current }
  }
  return { Date: FakeDate as unknown as DateConstructor, advance: (ms: number) => { current += ms } }
}

const fireIntervals = (intervals: Map<number, any>) => { for (const fn of intervals.values()) fn() }

test('S1 dispatcherHealth 按取快照那一刻算心跳龄，页面自己过期就不对派单员下结论', () => {
  const online = dispatcherHealth({ heartbeatAt: new Date(BASE - 5000).toISOString(), snapshotAt: BASE, now: BASE + 10000 })
  assert.equal(online.kind, 'online')
  assert.equal(online.heartbeatAgeMs, 5000)
  assert.equal(online.viewAgeMs, 10000)

  // 页面 40 秒没取到新数据：即使按 now 算心跳龄已超过 120 秒，也只说数据待刷新。
  const stale = dispatcherHealth({ heartbeatAt: new Date(BASE - 130000).toISOString(), snapshotAt: BASE, now: BASE + 40000 })
  assert.equal(stale.kind, 'stale-view')
  assert.equal(stale.viewAgeMs, 40000)
  assert.equal(stale.heartbeatAgeMs, 130000)

  const lost = dispatcherHealth({ heartbeatAt: new Date(BASE - 130000).toISOString(), snapshotAt: BASE, now: BASE + 1000 })
  assert.equal(lost.kind, 'lost')
  assert.equal(lost.heartbeatAgeMs, 130000)
  assert.equal(lost.viewAgeMs, 1000)

  const noHeartbeat = dispatcherHealth({ heartbeatAt: null, snapshotAt: BASE, now: BASE + 1000 })
  assert.equal(noHeartbeat.kind, 'lost')
  assert.equal(noHeartbeat.heartbeatAgeMs, null)
  assert.equal(noHeartbeat.viewAgeMs, 1000)

  const neverLoaded = dispatcherHealth({ heartbeatAt: new Date(BASE).toISOString(), snapshotAt: null, now: BASE })
  assert.equal(neverLoaded.kind, 'stale-view')
  assert.equal(neverLoaded.heartbeatAgeMs, null)
  assert.equal(neverLoaded.viewAgeMs, null)
})

test('S2 取快照挂住超过 20 秒就放弃重取，被放弃的那次回来不改数据', async () => {
  const clock = fakeClock(BASE)
  const h = harness(undefined, { Date: clock.Date })
  try {
    h.store.start(); await tick()
    assert.equal(h.counters.snapshotFetches, 1)
    assert.equal(h.store.snapshotAt, BASE)

    h.holdSnapshot()
    const abandoned = h.store.refreshSnapshot(); await tick()
    assert.equal(h.counters.snapshotFetches, 2)
    const held = h.snapshotCalls.at(-1)
    assert.equal(held.signal.aborted, false)

    for (let i = 0; i < 5; i++) { clock.advance(5000); fireIntervals(h.intervals) }
    assert.equal(held.signal.aborted, true, '累计 25 秒时挂住的请求已被放弃')
    assert.equal(h.counters.snapshotFetches, 3, '放弃之后又发出了一次新的取快照请求')

    const kept = h.store.snapshot, keptAt = h.store.snapshotAt
    held.resolve(snapshot(['late'])); await abandoned; await tick()
    assert.equal(h.store.snapshot, kept)
    assert.equal(h.store.snapshotAt, keptAt)
  } finally { h.store.stop() }
})

test('S3 排队单详情挂着也挡不住下一次取快照，新快照到达后旧详情请求被取消', async () => {
  const clock = fakeClock(BASE)
  const h = harness(undefined, { Date: clock.Date })
  try {
    h.holdMetadata()
    h.store.start(); await tick()
    assert.equal(h.counters.snapshotFetches, 1)
    assert.ok(h.metadata.length > 0)
    const oldSignals = h.metadata.map(item => item.signal as AbortSignal)

    clock.advance(5000); fireIntervals(h.intervals); await tick()
    assert.equal(h.counters.snapshotFetches, 2)
    assert.ok(oldSignals.every(signal => signal.aborted), '新快照到达后上一路详情请求已取消')
  } finally { h.store.stop() }
})

test('S4 stop 之后 snapshotAt 归零', async () => {
  const h = harness()
  try {
    h.store.start(); await tick()
    assert.ok(h.store.snapshotAt !== null)
    h.store.stop()
    assert.equal(h.store.snapshotAt, null)
  } finally { h.store.stop() }
})