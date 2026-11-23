import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { patchMemberTasks, applyOwnerEcho } from '../src/collaboration/writeEcho.ts'
import { memberApi, MemberLoader } from '../src/collaboration/member.ts'
import { actionPath } from '../src/collaboration/board.ts'

test('member patches preserve other references and append', () => {
  const a = { id: 'T1' }, b = { id: 'T2' }, replacement = { id: 'T1' }
  const input = [a, b]
  const result = patchMemberTasks(input, replacement)
  assert.notEqual(result, input); assert.equal(result[0], replacement); assert.equal(result[1], b); assert.equal(input[0], a)
  assert.deepEqual(patchMemberTasks(input, { id: 'T3' }).map(t => t.id), ['T1', 'T2', 'T3'])
  assert.deepEqual(patchMemberTasks([], replacement), [replacement])
})

test('member writes return cleaned task and preserve requests', async () => {
  const calls: Array<[string, unknown]> = []
  let response: unknown = { ok: true, task: { id: 'T1', title: 'Task', status: '待开工', secret: 'hidden' } }
  const api = memberApi(async <T>(path: string, body?: unknown): Promise<T> => { calls.push([path, body]); return response as T })
  const invoke = () => [api.act('demo', 'T1', 'claim', { x: 1 }), api.claim('demo', 'T1'), api.progress('demo', 'T1', 20, ' note '), api.create('demo', { title: 'Task' })]
  for (const task of await Promise.all(invoke())) { assert.equal(task?.id, 'T1'); assert.equal('secret' in task!, false) }
  assert.deepEqual(calls, [[actionPath('demo', 'T1', 'claim'), { x: 1 }], [actionPath('demo', 'T1', 'claim'), {}], [actionPath('demo', 'T1', 'progress'), { percent: 20, note: 'note' }], ['/api/collaboration/projects/demo/tasks', { title: 'Task' }]])
  for (response of [{ ok: true }, { task: { id: 12 } }]) assert.deepEqual(await Promise.all(invoke()), [null, null, null, null])
})

test('member loader invalidates patched version', async () => {
  const calls: string[] = []
  const api = memberApi(async <T>(path: string): Promise<T> => {
    calls.push(path)
    if (path === '/api/projects') return { projects: [{ id: 'demo', name: 'Demo' }] } as T
    return { version: 'v1', tasks: [{ id: 'T1', title: 'server', status: '待开工' }] } as T
  })
  const loader = new MemberLoader(api)
  assert.equal(loader.patch('demo', { id: 'T1', title: 'echo', status: '待开工' }), null)
  await loader.load('demo', ['demo']); assert.equal(calls.at(-1), '/api/board/demo')
  const patched = loader.patch('demo', { id: 'T1', title: 'echo', status: '待开工' })!
  assert.equal(patched[0].title, 'echo')
  const loaded = await loader.load('demo', ['demo'])
  assert.notEqual(calls.at(-1), '/api/board/demo?since=v1'); assert.equal(loaded?.tasks[0].title, 'server')
})

test('owner echo merges only allowed fields without mutation', () => {
  const extra = { value: 1 }, dates = { start: 'old', other: 'kept' }
  const task = { id: 'T1', status: '待开工', title: 'private', description: 'private', blockReason: 'private', cancelReason: 'private', messages: extra, actions: extra, gitBranch: extra, builder: extra, decisions: extra, deps: extra, nextMilestone: extra, assigneeUserId: 'old', assigneeName: 'old', percent: 0, dates }
  const echo = { id: 'T1', status: '进行中', assigneeUserId: 'u', assigneeName: '成员甲', lastProgressAt: 'today', priority: 'high', percent: 30, dates: { start: 'today' }, collaborators: [{ userId: 'u', name: '成员甲', joinedAt: 'today', secret: 1 }], title: 'redacted', description: 'redacted', blockReason: 'redacted', cancelReason: 'redacted', messages: [], actions: [] }
  const result = applyOwnerEcho(task, echo)
  assert.equal(result.status, '进行中'); assert.equal(result.assigneeUserId, 'u'); assert.equal(result.assigneeName, '成员甲'); assert.equal(result.lastProgressAt, 'today'); assert.equal(result.priority, 'high'); assert.equal(result.percent, 30)
  assert.deepEqual(result.dates, { start: 'today', other: 'kept' }); assert.deepEqual(result.collaborators, [{ userId: 'u', name: '成员甲', joinedAt: 'today' }])
  for (const key of ['title', 'description', 'blockReason', 'cancelReason', 'messages', 'actions', 'gitBranch', 'builder', 'decisions', 'deps', 'nextMilestone'] as const) assert.equal(result[key], task[key])
  const released = applyOwnerEcho(result, { id: 'T1', status: '待开工', collaborators: [] })
  assert.equal('assigneeUserId' in released, false); assert.equal('assigneeName' in released, false); assert.equal('collaborators' in released, false)
  for (const invalid of [null, [], { id: 'T2', status: '进行中' }, { id: 'T1' }]) assert.equal(applyOwnerEcho(task, invalid), task)
  assert.equal(task.status, '待开工'); assert.equal(task.dates, dates); assert.equal(task.assigneeUserId, 'old')
})

test('components connect echo without owner store in member view', () => {
  const member = readFileSync(new URL('../src/collaboration/MemberBoard.vue', import.meta.url), 'utf8')
  const owner = readFileSync(new URL('../src/collaboration/OwnerTaskActions.vue', import.meta.url), 'utf8')
  assert.match(member, /loader\.patch\(/); assert.doesNotMatch(member, /useBoardStore/); assert.match(owner, /applyTaskEcho\(/)
})
