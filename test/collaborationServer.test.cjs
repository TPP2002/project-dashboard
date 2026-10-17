'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const SERVER = path.resolve(__dirname, '../server/server.cjs');
const ORIGIN = 'http://127.0.0.1:47123';
const PASSWORD = 'A-real-password-12345';

function start(home, overrides = {}) {
  const child = fork(SERVER, [], { silent: true, windowsHide: true, env: { ...process.env,
    DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json'), DASHBOARD_MODE: 'collaboration',
    DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1',
    DASHBOARD_POLL_MS: '500', DASHBOARD_EVENT_WEBHOOK: '', ...overrides,
  } });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out: ' + output)); }, 15000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output)); });
    child.on('message', msg => { if (msg.type === 'dashboard-ready') { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${msg.port}`, port: msg.port }); } });
  });
}
async function stop(srv) {
  if (!srv || srv.child.exitCode !== null) return;
  await new Promise(resolve => { srv.child.once('exit', resolve); srv.child.kill(); });
}
function cookie(session) { return 'dashboard_session=' + session.token; }
function stream(base, session) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + '/api/stream', { headers: { Cookie: cookie(session) } }, res => {
      let buffer = ''; const events = []; const waiters = [];
      let ended = false;
      const closed = new Promise(done => res.on('end', () => { ended = true; done(); }));
      const api = { events, closed, close: () => req.destroy(), wait: name => {
        if (events.some(e => e.event === name)) return Promise.resolve(events.find(e => e.event === name));
        return new Promise((done, fail) => {
          const timer = setTimeout(() => fail(new Error('Missing SSE ' + name)), 5000);
          waiters.push({ name, done: e => { clearTimeout(timer); done(e); } });
        });
      }, untilClosed: () => ended ? Promise.resolve() : Promise.race([closed, new Promise((_, fail) => { const timer = setTimeout(() => fail(new Error('SSE did not close')), 5000); closed.then(() => clearTimeout(timer)); })]) };
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        while (buffer.includes('\n\n')) {
          const i = buffer.indexOf('\n\n'); const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
          const name = block.match(/^event: (.+)$/m)?.[1]; const data = block.match(/^data: (.+)$/m)?.[1];
          if (!name || !data) continue;
          const e = { event: name, data: JSON.parse(data) }; events.push(e);
          for (let n = waiters.length - 1; n >= 0; n--) if (waiters[n].name === name) waiters.splice(n, 1)[0].done(e);
        }
      });
      res.on('error', reject);
      if (res.statusCode !== 200) { req.destroy(); reject(new Error('SSE status ' + res.statusCode)); } else resolve(api);
    });
    req.on('error', reject);
  });
}

test('HTTP collaboration authorization, revocation, persistence and local compatibility', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-http-'));
  let srv, local;
  t.after(async () => { await stop(srv); await stop(local); fs.rmSync(home, { recursive: true, force: true }); });
  const registryPath = path.join(home, 'registry.json');
  const reg = { projects: {} };
  for (const id of ['alpha', 'beta']) {
    const file = path.join(home, id + '.json'); reg.projects[id] = { mainRepo: home, board: file, name: id };
    const board = emptyBoard({ id, name: id, mainRepo: home });
    board.tasks = [{ id: 'ONE', title: 'Work at C:\\private\\root and /home/secret/file', plainTitle: 'Shared work', wave: 1, status: '待开工',
      collectBrief: { text: 'OWNER COLLECT SECRET', updatedAt: new Date().toISOString() }, cost: { entries: [{ tokens: 987654 }] },
      worktree: ['C:\\private\\tree'], decisions: [{ id: 'd1', question: 'OWNER QUESTION', options: ['yes'], recommended: 'yes', answer: 'yes' }] },
    { id: 'RACE', title: 'Race', wave: 1, status: '待开工' }];
    board.activity = [{ ts: new Date().toISOString(), taskId: 'ONE', type: 'message', author: 'owner', text: 'OWNER MESSAGE' }];
    fs.writeFileSync(file, JSON.stringify(board));
  }
  fs.writeFileSync(registryPath, JSON.stringify(reg));
  const auth = createAuth({ home, registryPath });
  await auth.bootstrap('owner', PASSWORD);
  let owner = await auth.login('owner', PASSWORD, 'http-owner');
  const initialInvite = auth.createInvite(owner.token, { projectIds: ['alpha'], expiresInHours: 1, maxUses: 2 });
  const member = await auth.register({ inviteToken: initialInvite.token, username: 'member', password: PASSWORD }, 'http-member');
  const other = await auth.register({ inviteToken: initialInvite.token, username: 'other', password: PASSWORD }, 'http-other');
  srv = await start(home);
  async function request(route, { session, data, headers = {}, method = data === undefined ? 'GET' : 'POST', base = srv.base } = {}) {
    const h = { ...(session ? { Cookie: cookie(session) } : {}), ...(method === 'POST' ? {
      Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Dashboard-Request': '1', ...(session ? { 'X-Dashboard-CSRF': session.csrfToken } : {}),
    } : {}), ...headers };
    const res = await fetch(base + route, { method, headers: h, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  await t.test('public health/session expose no local identity, other anonymous APIs return 401', async () => {
    const page = await fetch(srv.base + '/');
    assert.doesNotMatch(await page.text(), /cloud-collab-auth-1018|dashboard-release|registryPath|buildRoot/);
    const health = await request('/api/health'); assert.deepEqual(health.body, { ok: true, mode: 'collaboration' });
    const session = await request('/api/auth/session'); assert.equal(session.body.user, null);
    for (const route of ['/api/projects', '/api/board/alpha', '/api/stream', '/api/doc?projectId=alpha&path=x', '/api/cost', '/api/auth/admin']) {
      assert.equal((await request(route)).status, 401, route);
    }
    assert.equal((await request('/api/decide/alpha/ONE', { data: {} })).status, 401);
  });
  await t.test('HTTP wrong login, uninvited registration, and owner spoofing fail', async () => {
    assert.equal((await request('/api/auth/login', { data: { username: 'owner', password: 'wrong-password-12345' } })).status, 401);
    assert.equal((await request('/api/auth/register', { data: { username: 'new-user', password: PASSWORD } })).status, 400);
    assert.equal((await request('/api/auth/register', { data: { username: 'new-user', password: PASSWORD, role: 'owner' } })).status, 400);
  });
  await t.test('HTTP login sets HttpOnly SameSite cookie and returns only public session fields', async () => {
    const response = await request('/api/auth/login', { data: { username: 'owner', password: PASSWORD } });
    assert.equal(response.status, 200);
    const set = response.headers.get('set-cookie'); assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/); assert.doesNotMatch(set, /Secure/);
    owner = { token: set.match(/^dashboard_session=([^;]+)/)[1], user: response.body.user, csrfToken: response.body.csrfToken };
    assert.equal(response.body.user.role, 'owner'); assert.doesNotMatch(JSON.stringify(response.body), /passwordHash|tokenHash|salt|private/);
  });
  await t.test('origin, JSON, request header, CSRF and proxy spoofing are rejected', async () => {
    const route = '/api/auth/invites'; const data = { projectIds: ['alpha'], expiresInHours: 1, maxUses: 1 };
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: '' }, { 'Content-Type': 'text/plain' },
      { 'X-Dashboard-Request': '' }, { 'X-Dashboard-CSRF': 'forged' }, { 'X-Forwarded-Proto': 'https' },
      { 'X-Forwarded-Host': 'trusted.example' }, { Forwarded: 'for=127.0.0.1;proto=https' }]) {
      assert.equal((await request(route, { session: owner, data, headers })).status, 403);
    }
    assert.equal((await request('/api/task/alpha/ONE/note', { session: owner, data: { text: 'bad' }, headers: { 'X-Dashboard-CSRF': '' } })).status, 403);
  });
  await t.test('members see only authorized projects and whitelisted board, never owner cache', async () => {
    const projects = await request('/api/projects', { session: member });
    assert.deepEqual(projects.body.projects.map(p => p.id), ['alpha']);
    const ownerBoard = await request('/api/board/alpha', { session: owner }); assert.equal(ownerBoard.status, 200);
    const view = await request('/api/board/alpha', { session: member, headers: { 'If-None-Match': ownerBoard.headers.get('etag') || '*' } });
    assert.equal(view.status, 200); assert.match(view.headers.get('cache-control'), /private, no-store/); assert.equal(view.headers.has('etag'), false);
    assert.doesNotMatch(JSON.stringify(view.body), /OWNER|987654|collectBrief|worktree|C:\\|\/home\/secret|mainRepo|passwordHash/);
    assert.deepEqual(view.body.activity, []);
    const denied = await request('/api/board/beta', { session: member });
    const missing = await request('/api/board/missing', { session: member });
    assert.equal(denied.status, 404); assert.deepEqual(denied.body, missing.body);
  });
  await t.test('all old management routes deny members even with valid write headers', async () => {
    for (const route of ['/api/doc?projectId=alpha&path=README.md', '/api/activity/alpha', '/api/cost', '/api/parallel?project=alpha', '/api/settings', '/api/codex/jobs', '/api/sched/status', '/api/reader/list', '/api/audition/list']) {
      assert.equal((await request(route, { session: member })).status, 403, route);
    }
    for (const route of ['/api/decide/alpha/ONE', '/api/undecide/alpha/ONE', '/api/task/alpha/ONE/note', '/api/mark-landed/alpha/ONE', '/api/dispatch', '/api/dispatch-task', '/api/cpu', '/api/settings', '/api/auth/invites', '/api/auth/devices', `/api/auth/users/${member.user.id}/access`]) {
      assert.equal((await request(route, { session: member, data: {} })).status, 403, route);
    }
  });
  await t.test('HTTP invitation issuance, registration and revoke follow the exact public contract', async () => {
    const created = await request('/api/auth/invites', { session: owner, data: { projectIds: [], expiresInHours: 1, maxUses: 1 } });
    assert.equal(created.status, 200); assert.deepEqual(Object.keys(created.body.invite).sort(), ['expiresAt', 'id', 'maxUses', 'projectIds', 'revoked', 'uses']);
    const registered = await request('/api/auth/register', { data: { inviteToken: created.body.token, username: 'http-created', password: PASSWORD, displayName: 'New member' } });
    assert.equal(registered.status, 200); assert.equal(registered.body.user.role, 'member');
    assert.equal((await request(`/api/auth/invites/${created.body.invite.id}/revoke`, { session: owner, data: {} })).status, 200);
    const admin = await request('/api/auth/admin', { session: owner }); assert.equal(admin.status, 200);
    assert.doesNotMatch(JSON.stringify(admin.body), /tokenHash|passwordHash|salt/);
  });
  await t.test('member claim/progress run through CLI and reject body identity and other owners', async () => {
    const route = '/api/collaboration/projects/alpha/tasks/ONE';
    assert.equal((await request(route + '/claim', { session: member, data: { userId: owner.user.id } })).status, 400);
    assert.equal((await request(route + '/claim', { session: member, data: {} })).status, 200);
    assert.equal((await request(route + '/progress', { session: other, data: { percent: 12 } })).status, 409);
    assert.equal((await request(route + '/progress', { session: member, data: { percent: 100, note: 'ready' } })).status, 200);
    assert.equal((await request('/api/collaboration/projects/beta/tasks/ONE/claim', { session: member, data: {} })).status, 404);
    const board = JSON.parse(fs.readFileSync(path.join(home, 'alpha.json')));
    assert.equal(board.tasks[0].assigneeUserId, member.user.id); assert.equal(board.tasks[0].status, '施工中'); assert.equal(board.tasks[0].builder, undefined);
    assert.equal(board.activity.at(-1).userId, member.user.id);
  });
  await t.test('two simultaneous HTTP claimants cannot both win', async () => {
    const route = '/api/collaboration/projects/alpha/tasks/RACE/claim';
    const results = await Promise.all([member, other].map(session => request(route, { session, data: {} })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  });
  await t.test('session, authorization and task ownership survive an actual server restart', async () => {
    await stop(srv); srv = await start(home);
    const session = await request('/api/auth/session', { session: member }); assert.equal(session.body.user.id, member.user.id);
    const board = await request('/api/board/alpha', { session: member });
    assert.equal(board.body.tasks[0].assigneeUserId, member.user.id); assert.equal(board.body.tasks[0].percent, 100);
  });
  await t.test('SSE hello and board events filter projects; permission removal closes existing stream', async () => {
    const s = await stream(srv.base, member); t.after(() => s.close());
    const hello = await s.wait('hello'); assert.deepEqual(hello.data.projects, ['alpha']); assert.equal('pid' in hello.data, false);
    for (const id of ['beta', 'alpha']) {
      const file = path.join(home, id + '.json'); const b = JSON.parse(fs.readFileSync(file)); b.project.updatedAt = new Date().toISOString(); fs.writeFileSync(file, JSON.stringify(b));
    }
    const event = await s.wait('board:changed'); assert.equal(event.data.projectId, 'alpha');
    assert.equal(s.events.some(e => e.data.projectId === 'beta'), false);
    assert.equal((await request(`/api/auth/users/${member.user.id}/access`, { session: owner, data: { projectIds: [], disabled: false } })).status, 200);
    await s.untilClosed();
    assert.equal((await request('/api/board/alpha', { session: member })).status, 404);
    assert.equal((await request('/api/collaboration/projects/alpha/tasks/ONE/progress', { session: member, data: { percent: 5 } })).status, 404);
  });
  await t.test('device revoke invalidates HTTP derived session and its active SSE', async () => {
    const created = await request('/api/auth/devices', { session: owner, data: { label: 'HTTP device' } });
    assert.equal(created.status, 200);
    const login = await request('/api/auth/device-login', { data: { token: created.body.token } });
    const derived = { token: login.headers.get('set-cookie').match(/^dashboard_session=([^;]+)/)[1], csrfToken: login.body.csrfToken };
    const s = await stream(srv.base, derived); t.after(() => s.close()); await s.wait('hello');
    assert.equal((await request(`/api/auth/devices/${created.body.device.id}/revoke`, { session: owner, data: {} })).status, 200);
    await s.untilClosed(); assert.equal((await request('/api/projects', { session: derived })).status, 401);
    assert.equal((await request('/api/auth/device-login', { data: { token: created.body.token } })).status, 401);
  });
  await t.test('logout and disabled users lose existing cookie access', async () => {
    assert.equal((await request('/api/auth/logout', { session: other, data: {} })).status, 200);
    assert.equal((await request('/api/projects', { session: other })).status, 401);
    assert.equal((await request(`/api/auth/users/${member.user.id}/access`, { session: owner, data: { projectIds: ['alpha'], disabled: true } })).status, 200);
    assert.equal((await request('/api/projects', { session: member })).status, 401);
  });
  await t.test('occupied collaboration port fails without replacing the existing server', async () => {
    await assert.rejects(() => start(home, { DASHBOARD_PORT: String(srv.port) }), /Server exited/);
    assert.equal((await request('/api/health')).status, 200); assert.equal(srv.child.exitCode, null);
  });
  await t.test('corrupt auth never becomes anonymous trusted access', async () => {
    fs.writeFileSync(path.join(home, 'private', 'collaboration-auth.json'), '{corrupt');
    for (const route of ['/api/auth/session', '/api/projects', '/api/auth/admin']) {
      const result = await request(route, { session: owner }); assert.equal(result.status, 503); assert.doesNotMatch(JSON.stringify(result.body), /collaboration-auth|private|C:|F:/);
    }
  });
  await t.test('default local mode still serves original APIs without an auth ledger', async () => {
    local = await start(home, { DASHBOARD_MODE: '', DASHBOARD_PUBLIC_ORIGIN: '' });
    const session = await request('/api/auth/session', { base: local.base }); assert.deepEqual(session.body, { ok: true, mode: 'local', user: null });
    const health = await request('/api/health', { base: local.base }); assert.equal(typeof health.body.pid, 'number');
    const projects = await request('/api/projects', { base: local.base }); assert.equal(projects.body.projects.length, 2);
    const board = await request('/api/board/alpha', { base: local.base }); assert.ok(board.body.tasks[0].collectBrief);
    const written = await request('/api/task/alpha/ONE/note', { base: local.base, data: { text: 'local mode note' }, headers: { Origin: local.base } });
    assert.equal(written.status, 200);
    const denied = await request('/api/task/alpha/ONE/note', { base: local.base, data: { text: 'bad origin' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(denied.status, 403);
  });
});
