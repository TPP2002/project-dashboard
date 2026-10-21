import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PRIORITIES, rank, comparePriority, sortLaneByPriority, placePicker } from '../src/utils/taskPriority.ts'
import { memberApi } from '../src/collaboration/member.ts'
import { drawerActions } from '../src/collaboration/board.ts'
const source = (path: string) => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8')

test('priority sorting is stable, defaults to medium and preserves terminal lanes', () => {
  const tasks = [{ id: 'low', priority: 'low' }, { id: 'default' }, { id: 'medium', priority: 'medium' }, { id: 'urgent', priority: 'urgent' }, { id: 'optional', priority: 'optional' }, { id: 'high', priority: 'high' }]
  const before = structuredClone(tasks)
  assert.equal(rank({}), 2)
  assert.ok(comparePriority(tasks[3]!, tasks[0]!) < 0)
  assert.equal(comparePriority(tasks[1]!, tasks[2]!), 0)
  assert.deepEqual(sortLaneByPriority(tasks, '待开工').map(t => t.id), ['urgent', 'high', 'default', 'medium', 'low', 'optional'])
  assert.deepEqual(tasks, before)
  assert.deepEqual(sortLaneByPriority(tasks, '施工中', items => items.reverse()).map(t => t.id), ['urgent', 'high', 'medium', 'default', 'low', 'optional'])
  for (const status of ['已完工', '已作废']) assert.equal(sortLaneByPriority(tasks, status, () => { throw new Error('terminal base sort must not run') }), tasks)
  assert.equal(PRIORITIES.length, 5)
})

test('picker fits right or left, clamps vertical bounds, and points at card center', () => {
  const card = { left: 100, right: 300, top: 100, height: 80 }, viewport = { width: 1000, height: 700 }
  const right = placePicker(card, viewport)
  assert.equal(right.side, 'right'); assert.equal(right.left, 312)
  assert.ok(Math.abs(right.top + right.arrow + 5 - (card.top + card.height / 2)) <= 1)
  const left = placePicker({ ...card, left: 740, right: 940 }, viewport)
  assert.equal(left.side, 'left'); assert.equal(left.left, 544)
  assert.equal(placePicker({ ...card, top: -50 }, viewport).top, 8)
  assert.equal(placePicker({ ...card, top: 680 }, viewport).top, 456)
  for (const top of [-50, 680]) { const p = placePicker({ ...card, top }, viewport); assert.ok(p.arrow >= 14 && p.arrow <= 212) }
})

test('both card surfaces wire permission-aware context menus and touch hold', () => {
  const picker = source('components/PriorityPicker.vue')
  for (const pattern of [/Teleport to="body"/, /position: fixed/, /width: 184px/, /height: 236px/, /scroll-snap-type: y mandatory/, /prefers-reduced-motion/, /Escape/, /event\.preventDefault\(\)/, /function contextmenu/, /if \(!props.allowed\) return/, /500\)/, /ArrowUp/, /ArrowDown/, /Enter/, /pointerdown/, /resize/, /pageScroll/]) assert.match(picker, pattern)
  for (const file of ['components/TaskCard.vue', 'collaboration/MemberTaskCard.vue']) {
    const card = source(file)
    assert.match(card, /@contextmenu="picker\?\.contextmenu/)
    assert.match(card, /@touchstart\.passive/); assert.match(card, /PriorityBadge/); assert.match(card, /:allowed=/)
  }
  assert.match(source('components/PriorityBadge.vue'), /v-if="priority && priority !== 'medium'"/)
  assert.match(source('components/PriorityBadge.vue'), /<svg/)
  assert.match(source('components/PriorityBadge.vue'), /prefers-reduced-motion/)
  assert.match(source('components/TaskDrawer.vue'), /PrioritySegment/)
  assert.match(source('collaboration/MemberDrawer.vue'), /PrioritySegment/)
  assert.deepEqual(drawerActions({ actions: ['priority'] }), [])
  for (const file of ['views/Kanban.vue', 'collaboration/MemberBoard.vue']) {
    const board = source(file)
    assert.match(board, /sortLaneByPriority/); assert.match(board, /localStorage.getItem\('dashboard.laneSort'\)/)
    assert.match(board, /localStorage.setItem\('dashboard.laneSort'/); assert.match(board, /try.*localStorage.*catch/)
    assert.match(board, /TransitionGroup name="priority-lane"/)
  }
  const css = source('styles/base.css')
  assert.match(css, /--p0: #e5484d/); assert.match(css, /--p0: #ff6b70/)
  assert.match(css, /:root:not\(\[data-theme="light"\]\)\s*\{\s*--p0: #ff6b70/)
  assert.match(css, /\.column-body\.stagger-list > \.tcard \{ animation-fill-mode: backwards/)
  assert.match(css, /transform \.28s/)
})

test('member API preserves priority through its public-field mapping', async () => {
  const api = memberApi(async <T>() => ({ tasks: [{ id: 'T1', title: '任务', status: '施工中', priority: 'urgent', actions: ['priority'], privateField: 'secret' }] }) as T)
  const [task] = await api.tasks('alpha')
  assert.equal(task?.priority, 'urgent'); assert.deepEqual(task?.actions, ['priority'])
  assert.equal(Object.hasOwn(task!, 'privateField'), false)
})
