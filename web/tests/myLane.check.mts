import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isMine, splitMine, sortMine, readMyLane, writeMyLane } from '../src/collaboration/myLane.ts'
import { readViewPref, writeViewPref } from '../src/collaboration/viewPrefs.ts'
const source = (path: string) => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8')

test('ownership includes collaborators, gives lead precedence and rejects missing identity', () => {
  const task = { assigneeUserId: 'me', collaborators: [{ userId: 'me' }, { userId: 'other' }] }
  assert.equal(isMine(task, 'me'), 'lead')
  assert.equal(isMine(task, 'other'), 'collab')
  assert.equal(isMine(task, 'stranger'), null)
  assert.equal(isMine(task, ''), null)
  assert.equal(isMine({ assigneeUserId: '' }, ''), null)
  assert.equal(isMine({}, 'me'), null)
})
test('split preserves every card exactly once, keeps terminal cards and separates each user view', () => {
  const tasks = [
    { id: 'done', status: '已完工', assigneeUserId: 'me' },
    { id: 'void', status: '已作废', collaborators: [{ userId: 'me' }] },
    { id: 'ask', status: '待拍板', assigneeUserId: 'me' },
    { id: 'work', status: '施工中', collaborators: [{ userId: 'me' }] },
    { id: 'other', status: '施工中', assigneeUserId: 'other' },
    { id: 'paused', status: '暂缓', assigneeUserId: 'me' },
    { id: 'queued', status: '待开工', assigneeUserId: 'me' },
  ]
  const before = structuredClone(tasks)
  const closed = (status: string) => ['已完工', '已作废'].includes(status)
  const { mine, rest } = splitMine(tasks, 'me', closed)
  assert.deepEqual(mine.map(t => t.id), ['ask', 'work', 'paused', 'queued'])
  assert.deepEqual(rest.map(t => t.id), ['done', 'void', 'other'])
  assert.equal(new Set([...mine, ...rest]).size, tasks.length)
  assert.deepEqual([...mine, ...rest].map(t => t.id).sort(), tasks.map(t => t.id).sort())
  assert.deepEqual(tasks, before)
  assert.deepEqual(splitMine(tasks, 'other', closed).mine.map(t => t.id), ['other'])
  assert.deepEqual(splitMine(tasks, '', closed), { mine: [], rest: tasks })
  assert.deepEqual(splitMine([], 'me', closed), { mine: [], rest: [] })
})
test('mine sorts priority then state and preserves ties without mutating the input', () => {
  const tasks = [
    { id: 'paused', status: '暂缓', priority: 'medium' },
    { id: 'ask', status: '待拍板', priority: 'medium' },
    { id: 'collect', status: '待收单', priority: 'medium' },
    { id: 'work1', status: '施工中' },
    { id: 'urgent', status: '待开工', priority: 'urgent' },
    { id: 'work2', status: '施工中', priority: 'medium' },
    { id: 'queued', status: '待开工', priority: 'medium' },
    { id: 'optional', status: '施工中', priority: 'optional' },
    { id: 'high', status: '暂缓', priority: 'high' },
    { id: 'low', status: '施工中', priority: 'low' },
  ]
  const before = structuredClone(tasks)
  assert.deepEqual(sortMine(tasks, 'priority').map(t => t.id), ['urgent', 'high', 'work1', 'work2', 'collect', 'ask', 'paused', 'queued', 'low', 'optional'])
  assert.deepEqual(sortMine(tasks, 'original').map(t => t.id), ['work1', 'work2', 'optional', 'low', 'collect', 'ask', 'paused', 'urgent', 'queued', 'high'])
  assert.deepEqual(tasks, before)
})
test('preferences whitelist only the two view keys and survive storage failures', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  let accesses = 0
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() {
      accesses++
      return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }
    } })
    assert.equal(readMyLane(), 'on')
    writeMyLane('off'); assert.equal(readMyLane(), 'off'); assert.equal(values.get('dashboard.myLane'), 'off')
    writeMyLane('on'); assert.equal(readMyLane(), 'on')
    writeViewPref('dashboard.laneSort', 'original'); assert.equal(readViewPref('dashboard.laneSort', 'priority'), 'original')
    for (const key of ['', 'token', 'session', 'dashboard.myLane.extra', 'dashboard.laneSort ', '__proto__']) {
      const count = accesses
      assert.throws(() => readViewPref(key, 'fallback'), /不支持/)
      assert.throws(() => writeViewPref(key, 'value'), /不支持/)
      assert.equal(accesses, count)
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('disabled') } })
    assert.equal(readMyLane(), 'on')
    assert.equal(readViewPref('dashboard.laneSort', 'fallback'), 'fallback')
    assert.doesNotThrow(() => writeMyLane('off'))
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem() { throw new Error('read failed') }, setItem() { throw new Error('quota') },
    } })
    assert.equal(readViewPref('dashboard.myLane', 'default'), 'default')
    assert.doesNotThrow(() => writeViewPref('dashboard.laneSort', 'priority'))
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
test('both boards gate, split, sort and render the personal lane using existing card interactions', () => {
  const member = source('collaboration/MemberBoard.vue'), owner = source('views/Kanban.vue')
  for (const board of [member, owner]) {
    for (const pattern of [/splitMine\(/, /sortMine\(/, /我在做/, /显示我在做/, /split\.value\.rest/, /if \(split\.value\.mine\.length\)/, /:in-my-lane=/, /:relation="isMine\(/, /readMyLane\(\)/, /writeMyLane\(value \? 'on' : 'off'\)/]) assert.match(board, pattern)
  }
  assert.match(member, /!viewer\.value && props\.user\.role === 'member' && showMyLane\.value/)
  assert.match(member, /v-if="!viewer && canCreate"/)
  assert.match(member, /splitMine\(tasks\.value, props\.user\.id/)
  assert.match(member, /\['已完工', '已作废'\]\.includes\(laneOf\(status\)\)/)
  assert.match(member, /result\.splice\(1, 0/)
  assert.doesNotMatch(member, /localStorage|sessionStorage/)
  assert.match(owner, /isCollaborationOwner\(\) && showMyLane\.value/)
  assert.match(owner, /v-if="isCollaborationOwner\(\)" class="my-lane-toggle"/)
  assert.match(owner, /collaborationOwnerUser\(\)\?\.id/)
  assert.match(owner, /DONE_STATUSES\.has\(status\) \|\| VOID_STATUSES\.has\(status\)/)
  assert.match(owner, /queued \+ 1/)
  for (const file of ['collaboration/MemberTaskCard.vue', 'components/TaskCard.vue']) {
    const card = source(file)
    assert.match(card, /inMyLane\?: boolean/)
    assert.match(card, /statusTone\(task.status\)/)
    assert.match(card, /relation === 'collab'/)
    assert.match(card, /协作/)
    assert.match(card, /@contextmenu="picker\?\.contextmenu/)
  }
  const css = source('styles/base.css')
  assert.match(css, /--my-lane-bg: #eef4ff/)
  assert.match(css, /--my-lane-bg: #1a2333/)
  assert.match(css, /height: 2px/)
  assert.match(css, /var\(--spec-top\)/)
  assert.match(css, /my-lane-enter \.35s/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.member-lanes \.member-lane\.my-lane, \.board-scroll \.column\.my-lane, \.my-lane::before \{ animation: none; \}/)
})
