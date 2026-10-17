'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const SERVER = path.resolve(__dirname, '../server/server.cjs');
const ORIGIN = 'http://127.0.0.1:47123';
const PASSWORD = 'Health-real-password-123';
const MINIMAL = { ok: true, mode: 'collaboration' };

test('owner settings survive health reload without exposing owner health to other callers', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-health-'));
  const registryPath = path.join(home, 'registry.json');
  const boardFile = path.join(home, 'board.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { privateProject: { mainRepo: home, board: boardFile } } }));
  fs.writeFileSync(boardFile, JSON.stringify(emptyBoard({ id: 'privateProject', name: 'Private project' })));
  const auth = createAuth({ home, registryPath });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  await auth.bootstrap('owner', PASSWORD);
  const env = { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: registryPath,
    DASHBOARD_MODE: 'collaboration', DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1',
    DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1', DASHBOARD_NO_RESTART: '1', DASHBOARD_EVENT_WEBHOOK: '',
    DASHBOARD_SCHED_SHARE: path.join(home, 'share'), DASHBOARD_GLOBAL_SETTINGS: path.join(home, 'global-settings.json'),
    DASHBOARD_CODEX_SESSIONS: path.join(home, 'sessions') };
  // Exercise saved settings, not an environment override forcing all modules on.
  delete env.DASHBOARD_MODULES;
  child = fork(SERVER, [], { env, silent: true, windowsHide: true });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + output)), 15000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output)); });
    child.on('message', msg => { if (msg.type === 'dashboard-ready') { clearTimeout(timer); resolve('http://127.0.0.1:' + msg.port); } });
  });
  async function request(route, { session, data, cookie, headers = {} } = {}) {
    const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(session ? { Cookie: session.cookie, 'X-Dashboard-CSRF': session.csrfToken } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data === undefined ? {} : { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Dashboard-Request': '1' }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const login = await request('/api/auth/login', { data: { username: 'owner', password: PASSWORD } });
  assert.equal(login.status, 200);
  const owner = { cookie: login.headers.get('set-cookie').split(';')[0], csrfToken: login.body.csrfToken };
  const invitation = await request('/api/auth/invites', { session: owner, data: { projectIds: [], maxUses: 1, expiresInHours: 1 } });
  assert.equal(invitation.status, 200);
  const registration = await request('/api/auth/register', { data: { inviteToken: invitation.body.token, username: 'member', password: PASSWORD } });
  assert.equal(registration.status, 200);
  const member = { cookie: registration.headers.get('set-cookie').split(';')[0], csrfToken: registration.body.csrfToken };
  function noCache(response) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('vary'), 'Cookie');
    assert.equal(response.headers.has('etag'), false);
  }

  await t.test('owner receives existing complete health and saved cost/cpu switches on the next GET', async () => {
    const initial = await request('/api/health', { session: owner });
    noCache(initial);
    assert.deepEqual(initial.body.modules, { codex: false, cost: false, cpu: false, reader: false, audition: false });
    assert.equal(initial.body.pid, child.pid);
    assert.equal(initial.body.dataRoot, home);
    assert.deepEqual(initial.body.projects, ['privateProject']);
    const save = await request('/api/settings', { session: owner, data: { modules: { cost: true, cpu: true } } });
    assert.equal(save.status, 200);
    const refreshed = await request('/api/health', { session: owner, headers: { 'If-None-Match': '*' } });
    noCache(refreshed);
    assert.deepEqual(refreshed.body.modules, save.body.settings.modules);
    assert.equal(refreshed.body.modules.cost, true); assert.equal(refreshed.body.modules.cpu, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'))).modules, refreshed.body.modules);
    const disable = await request('/api/settings', { session: owner, data: { modules: { cost: false } } });
    assert.equal(disable.status, 200);
    const next = await request('/api/health', { session: owner });
    assert.equal(next.body.modules.cost, false); assert.equal(next.body.modules.cpu, true);
  });

  await t.test('anonymous, member and invalid session health remain exactly minimal even after owner health', async () => {
    for (const options of [{}, { session: member }, { cookie: 'dashboard_session=' + 'x'.repeat(43) }]) {
      const response = await request('/api/health', { ...options, headers: { 'If-None-Match': '*', 'If-Modified-Since': new Date().toUTCString() } });
      noCache(response); assert.deepEqual(response.body, MINIMAL);
      assert.doesNotMatch(JSON.stringify(response.body), /modules|pid|Root|registry|projects|privateProject/);
    }
  });

  await t.test('logout revokes owner access to complete health immediately', async () => {
    assert.equal((await request('/api/auth/logout', { session: owner, data: {} })).status, 200);
    const response = await request('/api/health', { session: owner });
    noCache(response); assert.deepEqual(response.body, MINIMAL);
  });

  await t.test('offline credential revocation also removes full health access', async () => {
    const loggedIn = await request('/api/auth/login', { data: { username: 'owner', password: PASSWORD } });
    assert.equal(loggedIn.status, 200);
    const cookie = loggedIn.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/api/health', { cookie })).body.pid, child.pid);
    auth.revokeAllCredentials();
    const response = await request('/api/health', { cookie });
    noCache(response); assert.deepEqual(response.body, MINIMAL);
  });
});
