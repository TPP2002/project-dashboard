import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memberApi, MemberLoader } from '../src/collaboration/member.ts'

test('member polling keeps versions per project and preserves unchanged arrays', async () => {
  const calls: string[] = []
  const versions: Record<string, string> = { a: 'v1', b: 'b1' }
  let forceUnchanged = false
  const api = memberApi(async <T>(path: string): Promise<T> => {
    calls.push(path)
    if (path === '/api/projects') return { projects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } as T
    const url = new URL(path, 'https://example.test')
    const id = url.pathname.split('/').at(-1)!
    const since = url.searchParams.get('since')
    if (forceUnchanged || (since !== null && since === versions[id])) return { ok: true, unchanged: true, version: versions[id] } as T
    return { tasks: [{ id, title: versions[id], status: '待开工', secret: 'hidden' }], ...(since === null ? {} : { version: versions[id] }) } as T
  })
  const loader = new MemberLoader(api)
  const load = async (id: string, allowed = ['a', 'b']) => {
    const start = calls.length
    const result = await loader.load(id, allowed)
    assert.equal(calls[start], '/api/projects')
    return result!
  }
  const first = await load('a')
  assert.equal(calls.at(-1), '/api/board/a')
  assert.equal('secret' in first.tasks[0], false)
  const second = await load('a')
  assert.equal(calls.at(-1), '/api/board/a?since=')
  const third = await load('a')
  assert.equal(calls.at(-1), '/api/board/a?since=v1')
  assert.equal(third.tasks, second.tasks)
  loader.cancel()
  assert.equal((await load('a')).tasks, second.tasks)
  assert.equal(calls.at(-1), '/api/board/a?since=v1')
  versions.a = 'v2'
  const updated = await load('a')
  assert.notEqual(updated.tasks, third.tasks)
  await load('a')
  assert.equal(calls.at(-1), '/api/board/a?since=v2')
  await load('b')
  assert.equal(calls.at(-1), '/api/board/b')
  await load('b')
  assert.equal(calls.at(-1), '/api/board/b?since=')
  await load('a')
  assert.equal(calls.at(-1), '/api/board/a?since=v2')
  await load('b', ['b'])
  await load('a')
  assert.equal(calls.at(-1), '/api/board/a')
  const direct = await api.tasks('a')
  assert.equal(calls.at(-1), '/api/board/a')
  assert.equal('secret' in direct[0], false)
  const result = await api.board('a', '')
  assert.equal('tasks' in result && 'secret' in result.tasks[0], false)
  forceUnchanged = true
  const fallbackApi = memberApi(async <T>(path: string): Promise<T> => {
    calls.push(path)
    if (path === '/api/projects') return { projects: [{ id: 'a', name: 'A' }] } as T
    if (forceUnchanged) { forceUnchanged = false; return { ok: true, unchanged: true, version: 'v2' } as T }
    return { tasks: [{ id: 'a', title: 'A', status: '待开工' }] } as T
  })
  const recovered = await new MemberLoader(fallbackApi).load('a', ['a'])
  assert.equal(recovered?.tasks.length, 1)
  assert.deepEqual(calls.slice(-2), ['/api/board/a', '/api/board/a'])
})
