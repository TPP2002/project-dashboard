import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { applyBoardDelta } from '../src/utils/boardDelta.ts'
import { createReloadQueue } from '../src/utils/reloadQueue.ts'

const require = createRequire(import.meta.url)
const { snapshotBoard, makeDelta } = require('../../core/boardDelta.cjs')
const initial = () => ({ schemaVersion: '1', project: { id: 'demo', name: 'demo' }, tasks: [{ id: 'T1', title: 'one', status: '未开工' }, { id: 'T2', title: 'two', status: '未开工' }], activity: [] } as any)

test('apply preserves unchanged objects, ordering, additions and limits', () => {
  const old = initial()
  old.activity = Array.from({ length: 200 }, (_, i) => ({ text: String(i) }))
  const next = { ...old, tasks: [{ ...old.tasks[1], title: 'changed' }, old.tasks[0], { id: 'T3' }], activity: [...old.activity, { text: 'new' }] }
  const delta = makeDelta(snapshotBoard(old), next)
  const actual = applyBoardDelta(old, delta, 200)!
  assert.equal(actual.tasks[1], old.tasks[0])
  assert.notEqual(actual.tasks[0], old.tasks[1])
  assert.deepEqual(actual.tasks, next.tasks)
  assert.deepEqual(actual.activity, next.activity.slice(-200))
  assert.deepEqual(applyBoardDelta(old, delta)!.activity, next.activity)
  assert.equal(applyBoardDelta(old, { ...delta, order: ['missing'] }), null)
  assert.deepEqual(applyBoardDelta(old, { ...delta, order: ['T1'] })!.tasks, [old.tasks[0]])
})

test('pending reloads coalesce and failure does not block subsequent work', async () => {
  const queue = createReloadQueue()
  let release!: () => void
  let calls = 0
  const first = queue('demo', false, async () => { calls++; await new Promise<void>(resolve => { release = resolve }); throw new Error('first') })
  await new Promise(resolve => setImmediate(resolve))
  const later = Array.from({ length: 5 }, (_, i) => queue('demo', i === 2, async detect => { calls++; return detect ? 42 : 0 }))
  release()
  await assert.rejects(first)
  assert.deepEqual(await Promise.all(later), [42, 42, 42, 42, 42])
  assert.equal(calls, 2)
})

test('seeded sequence preserves whole-board equality for both activity windows', () => {
  let seed = 123456
  const rand = (n: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n)
  for (const limit of [undefined, 200]) {
    let current = initial()
    current.activity = Array.from({ length: 210 }, (_, i) => ({ text: String(i) }))
    let local = { ...current, activity: limit ? current.activity.slice(-limit) : current.activity.slice() }
    for (let i = 0; i < 200; i++) {
      const old = snapshotBoard(current)
      current = structuredClone(current)
      const operation = rand(5)
      if (operation === 0 && current.tasks.length) current.tasks[rand(current.tasks.length)].title = String(i)
      if (operation === 1) current.tasks.push({ id: `T${i + 10}`, title: String(i), status: '未开工' })
      if (operation === 2 && current.tasks.length) current.tasks.splice(rand(current.tasks.length), 1)
      if (operation === 3) current.tasks.reverse()
      if (operation === 4) current.activity.push({ text: `a${i}` })
      if (i % 31 === 0) {
        const inserted = structuredClone(current)
        inserted.activity.splice(1, 0, { text: `insert${i}` })
        assert.equal(makeDelta(old, inserted), null)
      }
      const delta = makeDelta(old, current)
      assert.ok(delta)
      local = applyBoardDelta(local, delta, limit)!
      assert.deepEqual(local, { ...current, activity: limit ? current.activity.slice(-limit) : current.activity })
    }
  }
})
