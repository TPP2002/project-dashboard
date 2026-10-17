import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { apiJson, authFetch, authRequestInit, clearAuthContext, onSessionExpired, responseJson, setAuthContext } from '../src/collaboration/http.ts'
import { canClaim, consumeInvite, inviteLink, inviteState, ownsTask, progressBody, sessionView } from '../src/collaboration/flow.ts'
import { MemberLoader, memberApi } from '../src/collaboration/member.ts'
import type { Session } from '../src/collaboration/types.ts'
import { rememberBrowser } from '../src/collaboration/rememberBrowser.ts'

const member: Session = { ok: true, mode: 'collaboration', user: { id: 'u1', username: 'member', displayName: '成员', role: 'member', projectIds: ['p1'], disabled: false }, csrfToken: 'csrf-for-test' }
const guest: Session = { ok: true, mode: 'collaboration', user: null }
const local: Session = { ok: true, mode: 'local', user: null }

test('invitation secret is consumed before hash routing and removed without adding history', () => {
  const token = 'a+b/字?=&'
  const link = inviteLink('https://board.example', token)
  assert.equal(new URL(link).search, '')
  let replacement: unknown[] = []
  const history = { state: { preserved: true }, replaceState: (...args: unknown[]) => { replacement = args } }
  assert.equal(consumeInvite({ href: link }, history), token)
  assert.deepEqual(replacement, [history.state, '', '/'])
  assert.equal(consumeInvite({ href: 'https://board.example/invite#token=abc' }, history), 'abc')
  assert.equal(replacement[2], '/invite')
  replacement = []
  assert.equal(consumeInvite({ href: 'https://board.example/#/kanban' }, history), '')
  assert.deepEqual(replacement, [])
})

test('mode and identity routing fails closed before session and distinguishes owner/member', () => {
  assert.equal(sessionView(null), 'loading')
  assert.equal(sessionView(local), 'local')
  assert.equal(sessionView(guest), 'login')
  assert.equal(sessionView(member), 'member')
  assert.equal(sessionView({ ...member, user: { ...member.user!, role: 'owner' } }), 'owner')
})

test('local request options are unchanged; collaboration preserves input headers and replaces stale CSRF', () => {
  const init = { method: 'POST', headers: { 'X-Custom': 'kept', 'X-Dashboard-CSRF': 'old' }, body: '{}' }
  assert.equal(authRequestInit(local, '/api/settings', init), init)
  for (const method of ['POST', 'put', 'PATCH', 'DELETE']) {
    const prepared = authRequestInit(member, '/api/settings', { ...init, method })!
    const headers = new Headers(prepared.headers)
    assert.equal(headers.get('X-Custom'), 'kept')
    assert.equal(headers.get('X-Dashboard-Request'), '1')
    assert.equal(headers.get('X-Dashboard-CSRF'), 'csrf-for-test')
    assert.equal(headers.get('Content-Type'), 'application/json')
    assert.equal(prepared.credentials, 'same-origin')
  }
  assert.equal(init.headers['X-Dashboard-CSRF'], 'old')
})

test('login writes have the custom header but no stale session secret; reads do not gain write headers', () => {
  const login = new Headers(authRequestInit(guest, '/api/auth/login', { method: 'POST', headers: { 'X-Dashboard-CSRF': 'stale' } })!.headers)
  assert.equal(login.get('X-Dashboard-Request'), '1')
  assert.equal(login.has('X-Dashboard-CSRF'), false)
  for (const method of ['GET', 'HEAD']) {
    const headers = new Headers(authRequestInit(member, '/api/projects', { method })!.headers)
    assert.equal(headers.has('X-Dashboard-Request'), false)
    assert.equal(headers.has('X-Dashboard-CSRF'), false)
  }
})

test('Request objects inherit method and headers unless init overrides them', () => {
  const request = new Request('https://board.example/api/settings', { method: 'POST', headers: { 'X-From-Request': 'kept' }, body: '{}' })
  const headers = new Headers(authRequestInit(member, request)!.headers)
  assert.equal(headers.get('X-From-Request'), 'kept')
  assert.equal(headers.get('X-Dashboard-CSRF'), member.csrfToken)
  const overridden = new Headers(authRequestInit(member, request, { method: 'GET', headers: { 'X-Override': 'yes' } })!.headers)
  assert.equal(overridden.has('X-Dashboard-CSRF'), false)
  assert.equal(overridden.has('X-From-Request'), false)
})

test('403/409 and HTTP-success failure envelopes cannot become successful mutations', async () => {
  for (const status of [403, 409, 200]) {
    await assert.rejects(responseJson(new Response(JSON.stringify({ ok: false, error: '负责人已移除授权' }), { status })), /负责人已移除授权/)
  }
  await assert.rejects(responseJson(new Response('<html>proxy failure</html>', { status: 502 })), /无法读取/)
  await assert.rejects(responseJson(new Response('null')), /缺少有效数据/)
  assert.deepEqual(await responseJson(new Response('{"ok":true}')), { ok: true })
})

test('claim eligibility excludes busy, terminal, AI-owned and member-owned work; progress never changes status', () => {
  assert.equal(canClaim({ id: 't', title: 'task', status: '待开工' }), true)
  for (const status of ['施工中', '待收单', '已完工', '已作废', '暂缓', '待拍板']) {
    assert.equal(canClaim({ id: 't', title: 'task', status }), false)
  }
  const owned = { id: 't', title: 'task', status: '待开工', assigneeUserId: 'other' }
  assert.equal(canClaim(owned), false)
  assert.equal(ownsTask(owned, 'u1'), false)
  assert.equal(ownsTask(owned, 'other'), true)
  assert.deepEqual(progressBody(100, ' 待验收 '), { percent: 100, note: '待验收' })
  for (const value of [NaN, Infinity, -1, 101]) assert.throws(() => progressBody(value, ''))
  assert.throws(() => progressBody(20, 'x'.repeat(501)))
})

test('invite list distinguishes available, used, expired and revoked credentials', () => {
  const base = { id: 'i', projectIds: ['p1'], expiresAt: '2030-01-02T00:00:00Z', maxUses: 2, uses: 1, revoked: false }
  const now = Date.parse('2030-01-01T00:00:00Z')
  assert.equal(inviteState(base, now), '可使用')
  assert.equal(inviteState({ ...base, uses: 2 }, now), '已用完')
  assert.equal(inviteState(base, Date.parse(base.expiresAt)), '已过期')
  assert.equal(inviteState({ ...base, revoked: true }, now), '已撤销')
})

test('member requests are limited to authorized reads/scoped writes and discard owner data', async () => {
  const calls: { path: string; body?: unknown }[] = []
  const api = memberApi(async <T>(path: string, body?: unknown): Promise<T> => {
    calls.push({ path, body })
    if (path === '/api/projects') return { projects: [{ id: 'p1', name: 'Shared', mainRepo: 'private' }, { id: 'not-granted', name: 'Private' }] } as T
    if (path.startsWith('/api/board/')) return { tasks: [{ id: 't1', title: 'Task', status: '待开工', cost: { secret: true }, worktree: ['private'], collectBrief: 'owner instructions' }] } as T
    return { ok: true } as T
  })
  const snapshot = await new MemberLoader(api).load('not-granted', ['p1'])
  assert.equal(snapshot?.projectId, 'p1')
  assert.deepEqual(snapshot?.projects, [{ id: 'p1', name: 'Shared' }])
  assert.equal('cost' in snapshot!.tasks[0], false)
  assert.equal('worktree' in snapshot!.tasks[0], false)
  assert.equal('collectBrief' in snapshot!.tasks[0], false)
  await api.claim('p/1', 't/1')
  await api.progress('p/1', 't/1', 100, 'done')
  assert.deepEqual(calls.map(call => call.path), ['/api/projects', '/api/board/p1', '/api/collaboration/projects/p%2F1/tasks/t%2F1/claim', '/api/collaboration/projects/p%2F1/tasks/t%2F1/progress'])
  assert.deepEqual(calls[3].body, { percent: 100, note: 'done' })
})

test('revoked project disappears and its board is not fetched again', async () => {
  let granted = true
  const calls: string[] = []
  const api = memberApi(async <T>(path: string): Promise<T> => {
    calls.push(path)
    return (path === '/api/projects' ? { projects: granted ? [{ id: 'p1', name: 'Shared' }] : [] } : { tasks: [{ id: 't1', title: 'Task', status: '待开工' }] }) as T
  })
  const loader = new MemberLoader(api)
  assert.equal((await loader.load('p1', ['p1']))?.tasks.length, 1)
  granted = false
  assert.deepEqual(await loader.load('p1', ['p1']), { projects: [], projectId: '', tasks: [] })
  assert.deepEqual(calls, ['/api/projects', '/api/board/p1', '/api/projects'])
})

test('late board response after logout or project switch cannot restore old tasks', async () => {
  let finish: (value: { tasks: never[] }) => void = () => { throw new Error('not pending') }
  let started: () => void = () => {}
  const waiting = new Promise<void>(resolve => { started = resolve })
  const api = memberApi(async <T>(path: string): Promise<T> => {
    if (path === '/api/projects') return { projects: [{ id: 'p1', name: 'Shared' }] } as T
    started()
    return new Promise(resolve => { finish = value => resolve(value as T) })
  })
  const loader = new MemberLoader(api)
  const old = loader.load('p1', ['p1'])
  await waiting
  loader.cancel()
  finish({ tasks: [] })
  assert.equal(await old, null)
})

test('member write failures propagate and do not fabricate a result', async () => {
  const api = memberApi(async () => { throw new Error('任务已被领取') })
  await assert.rejects(api.claim('p1', 't1'), /任务已被领取/)
  await assert.rejects(api.progress('p1', 't1', 60, ''), /任务已被领取/)
})

test('authFetch expires sessions on 401, cancels stale responses and refuses foreign origins', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: new URL('https://board.example/') } })
  let expired = 0
  const unsubscribe = onSessionExpired(() => { expired++ })
  try {
    setAuthContext(member)
    let sent: RequestInit | undefined
    globalThis.fetch = async (_input, init) => { sent = init; return new Response('{"ok":false,"error":"过期"}', { status: 401 }) }
    const response = await authFetch('/api/collaboration/projects/p1/tasks/t1/claim', { method: 'POST', body: '{}' })
    assert.equal(response.status, 401)
    assert.equal(expired, 1)
    assert.equal(new Headers(sent?.headers).get('X-Dashboard-CSRF'), member.csrfToken)
    await assert.rejects(authFetch('/api/projects'), /请先登录/)
    setAuthContext(member)
    await assert.rejects(authFetch('https://elsewhere.example/api/projects'), /本站接口/)
    globalThis.fetch = async () => new Response('{"unexpected":true}')
    await assert.rejects(apiJson('/api/collaboration/projects/p1/tasks/t1/claim', {}), /未确认操作成功/)
    globalThis.fetch = async () => new Response('{"projects":[]}')
    const unread = await authFetch('/api/projects')
    clearAuthContext()
    await assert.rejects(responseJson(unread), { name: 'AbortError' })
    setAuthContext(member)
    let finish: (response: Response) => void = () => {}
    globalThis.fetch = () => new Promise(resolve => { finish = resolve })
    const stale = authFetch('/api/projects')
    clearAuthContext()
    finish(new Response('{"projects":[]}'))
    await assert.rejects(stale, { name: 'AbortError' })
  } finally {
    unsubscribe(); setAuthContext(null); globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('entrypoint does not install the owner router/store before authentication', async () => {
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
  assert.match(main, /createApp\(CollaborationRoot\)/)
  assert.doesNotMatch(main, /createPinia|\.use\(router\)|from ['"]\.\/App\.vue/)
  const memberView = await readFile(new URL('../src/collaboration/MemberBoard.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(memberView, /useBoardStore|\/api\/(cost|sched|health|codex)|localStorage|sessionStorage/)
})

test('browser trust posts only a label with session headers, never accesses token storage, and refreshes before success', async () => {
  const originalFetch = globalThis.fetch
  const keys = ['window', 'localStorage', 'sessionStorage', 'document'] as const
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: new URL('https://board.example/') } })
  for (const key of ['localStorage', 'sessionStorage', 'document']) {
    Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error('must not access browser credential storage') } })
  }
  const events: string[] = []
  let sent: RequestInit | undefined
  try {
    setAuthContext({ ...member, user: { ...member.user!, role: 'owner' } })
    globalThis.fetch = async (input, init) => {
      assert.equal(input, '/api/auth/remember-device')
      sent = init; events.push('request')
      return new Response(JSON.stringify({ ok: true, device: { id: 'device1', label: '我的常用浏览器', createdAt: '2030-01-01T00:00:00Z', expiresAt: '2030-04-01T00:00:00Z', revoked: false } }))
    }
    const notice = await rememberBrowser('  ', async () => { events.push('refresh') }, new AbortController().signal)
    events.push('success')
    assert.deepEqual(events, ['request', 'refresh', 'success'])
    assert.deepEqual(JSON.parse(String(sent?.body)), { label: '我的常用浏览器' })
    assert.equal(sent?.method, 'POST')
    assert.equal(sent?.credentials, 'same-origin')
    assert.equal(new Headers(sent?.headers).get('X-Dashboard-CSRF'), member.csrfToken)
    assert.equal(new Headers(sent?.headers).get('X-Dashboard-Request'), '1')
    assert.match(notice, /^已设置此浏览器信任；到期：/)
  } finally {
    setAuthContext(null); globalThis.fetch = originalFetch
    for (const key of keys) {
      const descriptor = originals.get(key)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('remember action uses public device metadata only and preserves a chosen label', async () => {
  const response = { ok: true, device: { id: 'd', label: '工作浏览器', createdAt: '2030-01-01T00:00:00Z', revoked: false } }
  Object.defineProperty(response, 'token', { get() { throw new Error('must not collect a token') } })
  const notice = await rememberBrowser(' 工作浏览器 ', async () => {}, new AbortController().signal, async <T>(path: string, body?: unknown): Promise<T> => {
    assert.equal(path, '/api/auth/remember-device')
    assert.deepEqual(body, { label: '工作浏览器' })
    return response as T
  })
  assert.equal(notice, '已设置此浏览器信任，有效期90天。')
})

test('remember rejection or failed refresh cannot produce a completion message', async () => {
  for (const status of [403, 409, 200]) {
    let refreshed = false
    let notice = ''
    await assert.rejects(async () => {
      notice = await rememberBrowser('test', async () => { refreshed = true }, new AbortController().signal,
        <T>() => responseJson<T>(new Response('{"ok":false,"error":"不能信任此浏览器"}', { status })))
    }, /不能信任此浏览器/)
    assert.equal(refreshed, false)
    assert.equal(notice, '')
  }
  let notice = ''
  await assert.rejects(async () => {
    notice = await rememberBrowser('test', async () => { throw new Error('设备列表刷新失败') }, new AbortController().signal,
      async <T>() => ({ ok: true, device: {} }) as T)
  }, /设备列表刷新失败/)
  assert.equal(notice, '')
})

test('remember is explicit owner-only UI wiring and does not initialize on member or login paths', async () => {
  const root = await readFile(new URL('../src/collaboration/CollaborationRoot.vue', import.meta.url), 'utf8')
  const admin = await readFile(new URL('../src/collaboration/AdminPanel.vue', import.meta.url), 'utf8')
  const memberView = await readFile(new URL('../src/collaboration/MemberBoard.vue', import.meta.url), 'utf8')
  assert.match(root, /const AdminPanel = defineAsyncComponent\(\(\) => import\('\.\/AdminPanel\.vue'\)\)/)
  assert.match(root, /<AdminPanel v-if="view === 'owner' && adminOpen"/)
  assert.doesNotMatch(memberView, /AdminPanel|rememberBrowser|remember-device|trustBrowser/)
  assert.match(admin, /type="button"[^>]*@click="trustBrowser">信任此浏览器90天/)
  assert.match(admin, /notice\.value = await rememberBrowser\(label\.value, load, controller\.signal\)/)
  assert.match(admin, /onMounted\(refresh\)/)
  assert.doesNotMatch(admin, /onMounted\(trustBrowser\)|onMounted\(rememberBrowser\)/)
  assert.match(admin, /apiJson<\{ device: Device; token: string \}>\('\/api\/auth\/devices'/)
  assert.match(admin, /主动退出会取消此浏览器信任/)
})
