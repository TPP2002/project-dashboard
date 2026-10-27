'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const PASSWORD = 'Member-device-fixture-123456';
const ORIGIN = 'http://127.0.0.1:47123';
async function start(home) {
  const child = fork(path.resolve(__dirname, '../server/server.cjs'), [], { windowsHide: true, silent: true,
    env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json'),
      DASHBOARD_MODE: 'collaboration', DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1',
      DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1', DASHBOARD_EVENT_WEBHOOK: '', DASHBOARD_POLL_MS: '500' } });
  let logs = ''; child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out')); }, 15000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited')); });
    child.on('message', m => { if (m.type === 'dashboard-ready') { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${m.port}`, logs: () => logs }); } });
  });
}
async function stop(s) {
  if (s?.child.exitCode === null) await new Promise(resolve => { s.child.once('exit', resolve); s.child.kill(); });
}
test('member and viewer devices use current account authority, never owner sync authority', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'member-devices-'));
  let srv; t.after(async () => { await stop(srv); fs.rmSync(home, { recursive: true, force: true }); });
  const registryPath = path.join(home, 'registry.json'); const ledger = path.join(home, 'private', 'collaboration-auth.json');
  const projects = {};
  for (const id of ['alpha', 'beta']) {
    const board = path.join(home, id + '.json'); projects[id] = { mainRepo: home, board, name: id };
    const b = emptyBoard({ id, name: id }); b.tasks.push({ id: 'ONE', title: 'One', status: '待开工', wave: 0, percent: 0 });
    fs.writeFileSync(board, JSON.stringify(b));
  }
  fs.writeFileSync(registryPath, JSON.stringify({ projects }));
  const auth = createAuth({ home, registryPath }); await auth.bootstrap('owner', PASSWORD);
  const owner = await auth.login('owner', PASSWORD);
  async function register(name, role) {
    const i = auth.createInvite(owner.token, { role, projectIds: ['alpha'], maxUses: 1, expiresInHours: 1 });
    return auth.register({ inviteToken: i.token, username: name, password: PASSWORD });
  }
  const member = await register('member', 'member'), viewer = await register('viewer', 'viewer');
  const secrets = [PASSWORD, owner.token, member.token, viewer.token]; const responses = [];
  const read = () => JSON.parse(fs.readFileSync(ledger));
  const baseline = fs.readFileSync(ledger, 'utf8');
  const reset = () => fs.writeFileSync(ledger, baseline);
  srv = await start(home);
  async function request(route, session, data, headers = {}) {
    const r = await fetch(srv.base + route, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(session ? { Cookie: 'dashboard_session=' + session.token } : {}),
        ...(data === undefined ? {} : { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Dashboard-Request': '1',
          'X-Dashboard-CSRF': session?.csrfToken || '' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    const body = await r.json();
    const raw = r.headers.get('set-cookie')?.match(/^dashboard_session=([^;]+)/)?.[1];
    if (raw) secrets.push(raw);
    if (body.token) secrets.push(body.token);
    // The enrollment token appears only in its one intended response; cookies
    // remain in HTTP headers, never in response JSON, errors or logs.
    responses.push(JSON.stringify({ ...body, token: undefined }));
    assert.doesNotMatch(JSON.stringify(body), /tokenHash|passwordHash|"salt"/);
    return { status: r.status, body, session: raw ? { token: raw, csrfToken: body.csrfToken, user: body.user } : null };
  }
  async function enrolled(session = member, label = 'Laptop') {
    const r = await request('/api/auth/my-devices', session, { label }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body;
  }
  async function derived(d) {
    const r = await request('/api/auth/device-login', null, { token: d.token }); assert.equal(r.status, 200); return r.session;
  }
  async function invalid(d, s) {
    assert.equal((await request('/api/auth/device-login', null, { token: d.token })).status, 401);
    assert.equal((await request('/api/projects', s)).status, 401);
    assert.equal(auth.session(s.token), null);
  }
  await t.test('anonymous, owner-only routes and every write guard retain their boundaries', async () => {
    reset();
    assert.equal((await request('/api/auth/my-devices')).status, 401);
    assert.equal((await request('/api/auth/my-devices', null, { label: 'anonymous' })).status, 401);
    for (const s of [member, viewer]) {
      for (const route of ['/api/auth/devices', '/api/auth/remember-device']) assert.equal((await request(route, s, { label: 'No' })).status, 403);
      for (const headers of [{ Origin: 'https://evil.example' }, { 'X-Dashboard-Request': '' }, { 'Content-Type': 'text/plain' },
        { 'X-Dashboard-CSRF': '' }, { Forwarded: 'for=unknown' }, { 'X-Forwarded-Host': 'evil.example' }]) {
        assert.equal((await request('/api/auth/my-devices', s, { label: 'Bad' }, headers)).status, 403);
      }
    }
    for (const label of ['', ' ', 'x'.repeat(129), null]) assert.equal((await request('/api/auth/my-devices', member, { label })).status, 400);
    assert.equal((await request('/api/auth/my-devices', member, { label: 'x', userId: owner.user.id })).status, 400);
    assert.equal(read().devices.length, 0);
  });
  await t.test('own sorted history, ten active devices, hash-only ledger and password-only enrollment', async () => {
    reset(); const all = [];
    for (let i = 0; i < 10; i++) all.push(await enrolled(member, 'Laptop ' + i));
    const denied = await request('/api/auth/my-devices', member, { label: 'Eleven' });
    assert.equal(denied.status, 409); assert.equal(denied.body.error, 'Too many devices');
    const s = await derived(all[0]);
    assert.equal((await request('/api/auth/my-devices', s, { label: 'No renewal' })).status, 403);
    assert.equal((await request('/api/auth/my-devices/' + all[0].device.id + '/revoke', s, {})).status, 200);
    await invalid(all[0], s);
    await enrolled();
    const db = read(); db.devices[1].expiresAt = '2000-01-01T00:00:00.000Z'; fs.writeFileSync(ledger, JSON.stringify(db));
    await enrolled();
    const list = await request('/api/auth/my-devices', member);
    assert.equal(list.body.devices.length, 12); assert.equal(list.body.devices[0].revoked, true);
    assert.deepEqual(list.body.devices.map(d => d.createdAt), list.body.devices.map(d => d.createdAt).sort());
    assert.ok(list.body.devices.every(d => !('token' in d) && !('tokenHash' in d)));
    assert.deepEqual((await request('/api/auth/my-devices', owner)).body.devices, []);
    for (const d of all) assert.equal(fs.readFileSync(ledger, 'utf8').includes(d.token), false);
    assert.ok(read().devices.every(d => /^[a-f0-9]{64}$/.test(d.tokenHash)));
  });
  await t.test('member devices cannot use sync, cross-project reads/writes, or revoke others', async () => {
    reset(); const d = await enrolled(); const s = await derived(d); const foreign = await enrolled(owner);
    for (const id of [foreign.device.id, 'missing']) assert.equal((await request(`/api/auth/my-devices/${id}/revoke`, s, {})).status, 404);
    for (const [route, data] of [['/api/sync/projects', undefined], ['/api/sync/projects/alpha/snapshot', undefined],
      ['/api/sync/projects/alpha/ops', { ackSeq: 0, ops: [] }]]) assert.equal((await request(route, s, data)).status, 403);
    for (const session of [s, member]) {
      assert.equal((await request('/api/board/beta', session)).status, 404);
      assert.equal((await request('/api/collaboration/projects/beta/tasks/ONE/claim', session, {})).status, 404);
    }
    const before = fs.readFileSync(projects.alpha.board, 'utf8');
    assert.equal((await request('/api/collaboration/projects/alpha/tasks/ONE/claim', s, {})).status, 200);
    assert.notEqual(fs.readFileSync(projects.alpha.board, 'utf8'), before);
    const admin = (await request('/api/auth/admin', owner)).body;
    assert.equal(admin.devices.find(x => x.id === d.device.id).userId, member.user.id);
    assert.deepEqual(Object.keys(admin.devices[0]), ['id', 'label', 'createdAt', 'expiresAt', 'revoked', 'userId']);
    assert.equal((await request(`/api/auth/devices/${d.device.id}/revoke`, owner, {})).status, 200);
    await invalid(d, s);
  });
  await t.test('viewer devices read granted projects and follow live role changes', async () => {
    reset(); const d = await enrolled(viewer); const s = await derived(d);
    assert.equal((await request('/api/board/alpha', s)).status, 200);
    assert.equal((await request('/api/board/beta', s)).status, 404);
    assert.equal((await request('/api/collaboration/projects/alpha/tasks/ONE/note', s, { text: 'No' })).status, 403);
    assert.equal((await request('/api/auth/my-devices', s, { label: 'No' })).status, 403);
    auth.access(owner.token, viewer.user.id, { projectIds: ['alpha'], disabled: false, role: 'member' });
    assert.equal(auth.session(s.token).user.role, 'member');
    assert.equal((await request('/api/collaboration/projects/alpha/tasks/ONE/note', s, { text: 'Promoted' })).status, 200);
    auth.access(owner.token, viewer.user.id, { projectIds: ['alpha'], disabled: false, role: 'viewer' });
    assert.equal((await request('/api/collaboration/projects/alpha/tasks/ONE/note', s, { text: 'No' })).status, 403);
    assert.equal((await request(`/api/auth/my-devices/${d.device.id}/revoke`, s, {})).status, 200);
    await invalid(d, s);
  });
  await t.test('disabled, expired, password-changed and reset credentials immediately stop derived sessions', async () => {
    for (const scenario of ['disabled', 'expired', 'password', 'reset']) {
      reset(); const d = await enrolled(); const s = await derived(d);
      if (scenario === 'disabled') auth.access(owner.token, member.user.id, { projectIds: ['alpha'], disabled: true });
      if (scenario === 'expired') {
        const db = read(); db.devices.find(x => x.id === d.device.id).expiresAt = '2000-01-01T00:00:00.000Z'; fs.writeFileSync(ledger, JSON.stringify(db));
      }
      if (scenario === 'password') assert.equal((await request('/api/auth/password', member, { currentPassword: PASSWORD, newPassword: PASSWORD + '-new' })).status, 200);
      if (scenario === 'reset') {
        const r = await request(`/api/auth/users/${member.user.id}/reset`, owner, {});
        assert.equal((await request('/api/auth/reset-password', null, { resetToken: r.body.resetToken, newPassword: PASSWORD + '-reset' })).status, 200);
      }
      await invalid(d, s);
    }
  });
  await t.test('device metadata, ordinary responses, errors, backup and logs contain no bearer plaintext', () => {
    for (const secret of secrets) {
      assert.equal(responses.some(r => r.includes(secret)), false);
      assert.equal(srv.logs().includes(secret), false);
      for (const file of [ledger, ledger + '.bak']) assert.equal(fs.readFileSync(file, 'utf8').includes(secret), false);
    }
  });
});
