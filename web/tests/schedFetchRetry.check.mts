import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchSnapshotWithRetry } from '../src/api/sched.ts'
import type { SchedSnapshot } from '../src/api/sched.ts'

// 造一个会按计数失败若干次、之后成功的 fetch 桩；并捕获 onRetry 回调序列。
function flakyFetch(failTimes: number, data: SchedSnapshot): { fetch: (signal?: AbortSignal) => Promise<SchedSnapshot>; getCalls: () => number } {
  let calls = 0
  const fetch = async (_signal?: AbortSignal): Promise<SchedSnapshot> => {
    calls += 1
    if (calls <= failTimes) throw new Error(`读不到（第 ${calls} 次）`)
    return data
  }
  return { fetch, getCalls: () => calls }
}

const SNAP: SchedSnapshot = {
  ok: true, readable: true, share: 'S', format: { formatVersion: 1, capabilities: [], createdAt: '2026-10-29T00:00:00Z' },
  dispatcher: { config: { machine: 'm', createdAt: 'x', createdBy: 'y' }, heartbeatAgeMs: 0,
    heartbeat: { machine: 'm', pid: 1, protocol: 1, head: 'h', at: '2026-10-29T00:00:00Z', tick: 1, cursorSeq: 1, queued: 0, granted: 1 } },
  machines: [], queue: [], locks: [], running: [], registerOnly: [], recentReceipts: [],
  estimates: {}, estimatesAt: '2026-10-29T00:00:00Z', historyError: null,
  connectedProjects: { readable: true, names: [], reason: null },
}

test('重试：前两次失败、第三次成功 → 返回数据、onRetry 呈「重连中→恢复」、fetch 共 3 次', async () => {
  const { fetch, getCalls } = flakyFetch(2, SNAP)
  const onRetry: number[] = []
  const result = await fetchSnapshotWithRetry(fetch, { delays: [1, 2, 3], onRetry: (n) => onRetry.push(n) })
  assert.deepEqual(result, SNAP)
  // onRetry 序列：(1)(2) 表示两次重连中，(0) 表示恢复 —— 页面的 reconnecting 由 n>0 置真、n=0 置假。
  assert.deepEqual(onRetry, [1, 2, 0], '重连横幅应经历「第1次重连→第2次重连→已恢复」')
  assert.equal(getCalls(), 3, '前两次失败各重试一次、第三次成功即返回')
})

test('重试：三次都失败 → 抛错、onRetry 经历 1/2/3 但永不恢复、fetch 共 4 次', async () => {
  const { fetch, getCalls } = flakyFetch(99, SNAP)
  const onRetry: number[] = []
  await assert.rejects(
    fetchSnapshotWithRetry(fetch, { delays: [1, 2, 3], onRetry: (n) => onRetry.push(n) }),
    /读不到/,
  )
  // 三次重试都失败：onRetry 收到 1/2/3（页面据此保持 reconnecting 并停在「第 3/3 次」），但没有 0（不恢复），
  // 调用方据此置 snapshotError。期间函数从不返回，调用方不会改变既有 snapshot（保留上一拍快照）。
  assert.deepEqual(onRetry, [1, 2, 3])
  assert.ok(!onRetry.includes(0), '不应有恢复回调')
  assert.equal(getCalls(), 4, '首次 + 三次重试，共读取 4 次后才放弃')
})

test('重试：已取消（signal 已 aborted）→ 不发起读取、直接抛 AbortError', async () => {
  let calls = 0
  const fetch = async () => { calls += 1; return SNAP }
  const ac = new AbortController()
  ac.abort()
  const onRetry: number[] = []
  await assert.rejects(
    fetchSnapshotWithRetry(fetch, { delays: [1, 2, 3], signal: ac.signal, onRetry: (n) => onRetry.push(n) }),
    (err) => err instanceof DOMException && err.name === 'AbortError',
  )
  assert.equal(calls, 0, '取消后不应再读调度台')
  assert.deepEqual(onRetry, [], '取消不应触发任何重连回调')
})

test('重试：三次都失败 → 函数抛错不返回，调用方据此保留上一拍快照（页面不空白）', async () => {
  const { fetch } = flakyFetch(99, SNAP)
  const prior: SchedSnapshot = { ...SNAP, share: 'OLD' }
  // 模拟调用方语义：只有函数成功返回才覆盖本地 snapshot，失败路径不返回就不会覆盖。
  let local: SchedSnapshot | null = prior
  let threw = false
  try {
    local = await fetchSnapshotWithRetry(fetch, { delays: [1, 2, 3] })
  } catch {
    threw = true
  }
  assert.equal(threw, true, '三次失败应抛错')
  assert.deepEqual(local, prior, '失败期间本地快照保持为上一拍（函数不返回 = 调用方不清空）')
  assert.equal((local as SchedSnapshot).share, 'OLD')
})
