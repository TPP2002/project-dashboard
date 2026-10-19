import { test } from 'node:test'
import assert from 'node:assert/strict'
import { laneOf, groupLanes, cardPrimaryAction, drawerActions, actionPath, avatarStack, relationLabel, slots, passwordProblem, reasonProblem, titleProblem, messageProblem } from '../src/collaboration/board.ts'
import { memberApi } from '../src/collaboration/member.ts'
import type { Collaborator, MemberTask, TaskAction } from '../src/collaboration/types.ts'

const people: Collaborator[] = ['韩梅梅', '周杰', '王芳', '赵敏', '李雷'].map((name, index) => ({ userId: `c${index}`, name, joinedAt: '2026-10-19T01:00:00Z' }))
const task: MemberTask = { id: 'T1', title: '订单筛选', status: '施工中', assigneeUserId: 'u1', assigneeName: '李雷', actions: [], collaborators: [] }

test('lanes preserve every card and original status, with cancelled cards in a separate final group', () => {
  for (const status of ['未开工', '待开工', '可复工', '已拍板', '未来状态', '收官', '压轴', '']) assert.equal(laneOf(status), '待开工')
  for (const status of ['待拍板', '施工中', '待收单', '暂缓', '已完工', '已作废']) assert.equal(laneOf(status), status)
  const input = ['未来状态', '已作废', '已完工', '未开工', '施工中', '待拍板', '暂缓', '待收单', '可复工', '已拍板'].map((status, index) => ({ id: String(index), status }))
  const before = structuredClone(input)
  const grouped = groupLanes(input)
  assert.deepEqual(grouped.map(group => group.name), ['待开工', '待拍板', '施工中', '待收单', '暂缓', '已完工', '已作废'])
  assert.deepEqual(grouped[0]!.tasks.map(item => item.status), ['未来状态', '未开工', '可复工', '已拍板'])
  assert.equal(grouped.at(-1)!.tasks[0]!.status, '已作废')
  assert.deepEqual(grouped.flatMap(group => group.tasks).map(item => item.id).sort(), input.map(item => item.id).sort())
  assert.deepEqual(input, before)
  assert.ok(groupLanes([]).every(group => group.tasks.length === 0))
})

test('card and drawer controls depend only on actions, with no inferred ownership or status permission', () => {
  assert.equal(cardPrimaryAction({ actions: [] }), null)
  assert.deepEqual(drawerActions({ actions: [] }), [])
  assert.equal(cardPrimaryAction({}), null)
  assert.deepEqual(drawerActions({}), [])
  assert.equal(cardPrimaryAction({ actions: ['progress', 'claim'] }), 'claim')
  assert.equal(cardPrimaryAction({ actions: ['progress'] }), 'progress')
  assert.equal(cardPrimaryAction({ actions: ['join', 'note'] }), null)
  assert.deepEqual(drawerActions({ actions: ['note', 'removeCollaborator'] }), [])
  const expected = [
    ['claim', '领取', 'primary', 'none'], ['progress', '更新进度', 'primary', 'progress'],
    ['done', '收官', 'normal', 'confirm'], ['park', '暂缓', 'normal', 'reason'],
    ['unpark', '复工', 'normal', 'reason'], ['unclaim', '放弃认领', 'normal', 'reason'],
    ['cancel', '作废', 'danger', 'reason'], ['reopen', '重开', 'normal', 'reason'],
    ['join', '加入协作', 'primary', 'none'], ['leave', '退出协作', 'normal', 'confirm'],
  ]
  const all = expected.map(row => row[0]) as TaskAction[]
  assert.deepEqual(drawerActions({ actions: [...all].reverse() }).map(({ action, label, kind, needs }) => [action, label, kind, needs]), expected)
  for (const action of all) assert.deepEqual(drawerActions({ actions: [action] }).map(entry => entry.action), [action])
  assert.deepEqual(drawerActions({ ...task, actions: [] }), [])
})

test('action routes encode both IDs and map the collaborator command spelling', () => {
  const prefix = '/api/collaboration/projects/p%2F%3F%23%20%E9%A1%B9/tasks/t%2F%26%20%25/'
  const actions: TaskAction[] = ['claim', 'progress', 'note', 'done', 'park', 'unpark', 'unclaim', 'cancel', 'reopen', 'join', 'leave', 'removeCollaborator']
  for (const action of actions) assert.equal(actionPath('p/?# 项', 't/& %', action), prefix + (action === 'removeCollaborator' ? 'remove-collaborator' : action))
})

test('avatar stack keeps the human or AI lead, limits visible avatars and preserves collaborator order', () => {
  const crowded = { ...task, collaborators: people.slice(0, 4) }
  assert.deepEqual(avatarStack(crowded), { lead: { userId: 'u1', name: '李雷', ai: false }, shown: people.slice(0, 2), more: 2 })
  assert.deepEqual(avatarStack({ aiWork: true, collaborators: [people[2]!] }), { lead: { userId: null, name: 'AI', ai: true }, shown: [people[2]!], more: 0 })
  assert.equal(avatarStack({ ...task, aiWork: true }).lead?.name, '李雷')
  assert.deepEqual(avatarStack({}), { lead: null, shown: [], more: 0 })
  assert.equal(avatarStack({ assigneeUserId: 'u' }).lead?.name, '主负责人')
  assert.equal(avatarStack({ assigneeName: '王芳' }).lead?.name, '王芳')
  assert.deepEqual(avatarStack({ collaborators: people }).shown, people.slice(0, 3))
  assert.deepEqual(avatarStack(crowded, 1).shown, [])
  assert.equal(avatarStack(crowded, 1).more, 4)
  assert.equal(avatarStack(crowded, 6).more, 0)
  assert.equal(avatarStack(crowded, 0).more, 4)
  assert.equal(avatarStack(crowded, -1).more, 4)
  assert.deepEqual(crowded.collaborators, people.slice(0, 4))
})

test('relation labels follow the five mockup viewpoints and retain names for observers', () => {
  assert.equal(relationLabel({ ...task, collaborators: people.slice(0, 2) }, 'u1'), '我 + 2 人协作')
  assert.equal(relationLabel({ ...task, assigneeName: '韩梅梅', collaborators: [{ ...people[0]!, userId: 'me' }] }, 'me'), '韩梅梅 · 我协作')
  assert.equal(relationLabel({ aiWork: true, collaborators: [people[2]!] }, 'observer'), 'AI 施工 · 王芳协作')
  assert.equal(relationLabel({ ...task, assigneeName: '王芳', collaborators: people.slice(0, 4) }, 'observer'), '王芳 + 4 人')
  assert.equal(relationLabel(task, 'u1'), '我')
  assert.equal(relationLabel(task, 'observer'), '李雷')
  assert.equal(relationLabel({ ...task, collaborators: [people[0]!] }, ''), '李雷 · 韩梅梅协作')
  assert.equal(relationLabel({}, ''), '未领取')
  assert.equal(relationLabel({ aiWork: true }, ''), 'AI 施工')
})

test('five collaboration slots exclude the lead', () => {
  assert.equal(slots(task), 0)
  assert.equal(slots({}), 0)
  for (let count = 1; count <= 5; count++) assert.equal(slots({ ...task, collaborators: people.slice(0, count) }), count)
  assert.equal(slots({ collaborators: [...people, people[0]!] }), 5)
})

test('password boundaries and confirmation: six to 128 characters without composition rules', () => {
  for (const count of [0, 5, 129]) assert.notEqual(passwordProblem('a'.repeat(count), 'a'.repeat(count)), '')
  for (const count of [6, 128]) assert.equal(passwordProblem('1'.repeat(count), '1'.repeat(count)), '')
  assert.equal(passwordProblem('密码长度六位', '密码长度六位'), '')
  assert.match(passwordProblem('123456', '654321'), /不一致/)
  assert.notEqual(passwordProblem('123456', ''), '')
})

test('reason, title and message trim whitespace and enforce both inclusive boundaries', () => {
  for (const [check, limit] of [[reasonProblem, 500], [titleProblem, 200], [messageProblem, 2000]] as const) {
    assert.notEqual(check(''), ''); assert.notEqual(check(' \n '), '')
    assert.equal(check('好'), ''); assert.equal(check(' 好 '), '')
    assert.equal(check('字'.repeat(limit)), '')
    assert.notEqual(check('字'.repeat(limit + 1)), '')
  }
})

test('member whitelist retains collaboration data but drops builder, branch, PR and nested unknown fields', async () => {
  const api = memberApi(async <T>(): Promise<T> => ({ tasks: [{
    ...task, actions: ['note', 'join'], aiWork: true, blockReason: '等待', cancelReason: '旧理由', createdByUserId: 'creator',
    dates: { design: '2026-10-17', start: '2026-10-18', done: '2026-10-19', secret: 'not public' },
    messages: [{ ts: 'now', author: '韩梅梅', text: '留言', userId: 'c0', secret: true }],
    collaborators: [{ ...people[0], secret: true }], builder: 'private', gitBranch: ['private'], prNumbers: [42], unknown: 'drop',
  }] }) as T)
  const received = (await api.tasks('p'))[0]!
  assert.deepEqual(received.actions, ['note', 'join'])
  assert.equal(received.aiWork, true); assert.equal(received.blockReason, '等待'); assert.equal(received.cancelReason, '旧理由'); assert.equal(received.createdByUserId, 'creator')
  assert.deepEqual(received.dates, { design: '2026-10-17', start: '2026-10-18', done: '2026-10-19' })
  assert.deepEqual(received.messages, [{ ts: 'now', author: '韩梅梅', text: '留言', userId: 'c0' }])
  assert.deepEqual(received.collaborators, [people[0]])
  for (const field of ['builder', 'gitBranch', 'prNumbers', 'unknown']) assert.equal(field in received, false)
})

test('create and act use scoped endpoints and propagate server refusals', async () => {
  const calls: { path: string; body: unknown }[] = []
  const api = memberApi(async <T>(path: string, body?: unknown): Promise<T> => { calls.push({ path, body }); return { ok: true } as T })
  await api.create('p/1', { title: '卡片', description: '说明' })
  await api.act('p/1', 't/1', 'removeCollaborator', { userId: 'c0' })
  await api.act('p/1', 't/1', 'join')
  assert.deepEqual(calls, [
    { path: '/api/collaboration/projects/p%2F1/tasks', body: { title: '卡片', description: '说明' } },
    { path: '/api/collaboration/projects/p%2F1/tasks/t%2F1/remove-collaborator', body: { userId: 'c0' } },
    { path: '/api/collaboration/projects/p%2F1/tasks/t%2F1/join', body: {} },
  ])
  const refused = memberApi(async () => { throw new Error('协作名额已满') })
  await assert.rejects(refused.act('p', 't', 'join'), /协作名额已满/)
  await assert.rejects(refused.create('p', { title: '卡片' }), /协作名额已满/)
})
