'use strict';
// Follow-up acceptance coverage. Synthetic fixtures only; production scrypt,
// real HTTP server/CLI children, expiry simulated by editing private fixtures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork, execFile } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const PASSWORD = 'Real-scrypt-password-12345';
const ORIGIN = 'https://collaboration.example';
const DAY = 86400000;
const ROOT = path.resolve(__dirname, '..');

function start(home, origin) {
  const child = fork(path.join(ROOT, 'server/server.cjs'), [], { silent: true, windowsHide: true,
    env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json'),
      DASHBOARD_MODE: 'collaboration', DASHBOARD_PUBLIC_ORIGIN: origin, DASHBOARD_HOST: '127.0.0.1',
      DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1', DASHBOARD_POLL_MS: '500', DASHBOARD_EVENT_WEBHOOK: '' } });
  let logs = '';
  child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out: ' + logs)); }, 15000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + logs)); });
    child.on('message', msg => { if (msg.type === 'dashboard-ready') { clearTimeout(timer); resolve({ child, port: msg.port, logs: () => logs }); } });
  });
}
async function stop(server) {
  if (!server || server.child.exitCode !== null) return;
  await new Promise(resolve => { server.child.once('exit', resolve); server.child.kill(); });
}
function cookieValue(response, name) {
  const item = (response.cookies || []).find(c => c.startsWith(name + '='));
  return item ? item.slice(name.length + 1).split(';')[0] : '';
}
function request(server, route, { session, device, data, headers = {}, origin = ORIGIN } = {}) {
  const cookies = [];
  if (session) cookies.push('dashboard_session=' + session.token);
  if (device) cookies.push('dashboard_device=' + device);
  const post = data !== undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path: route, method: post ? 'POST' : 'GET', headers: {
      ...(cookies.length ? { Cookie: cookies.join('; ') } : {}),
      ...(post ? { Origin: origin, 'Content-Type': 'application/json', 'X-Dashboard-Request': '1',
        ...(session ? { 'X-Dashboard-CSRF': session.csrfToken } : {}) } : {}), ...headers,
    } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', d => { raw += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw), raw, cookies: res.headers['set-cookie'] || [] }); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('HTTP timeout')));
    req.end(post ? JSON.stringify(data) : undefined);
  });
}
function offline(home, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'cli/collaboration.cjs'), ...args], { windowsHide: true,
      env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json') }, timeout: 15000,
    }, (err, stdout, stderr) => { try { resolve({ code: err ? err.code : 0, body: JSON.parse(stdout), stdout, stderr }); } catch { reject(new Error(stderr || stdout)); } });
  });
}

test('remembered owner browser lifecycle, HTTP and offline credential revocation', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-remember-'));
  const registryPath = path.join(home, 'registry.json');
  const file = path.join(home, 'private', 'collaboration-auth.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { mainRepo: home } } }));
  const auth = createAuth({ home, registryPath });
  await auth.bootstrap('owner', PASSWORD);
  const owner = await auth.login('owner', PASSWORD, 'remember-owner');
  const invite = auth.createInvite(owner.token, { projectIds: ['alpha'], expiresInHours: 1, maxUses: 10 });
  const member = await auth.register({ inviteToken: invite.token, username: 'member', password: PASSWORD }, 'remember-member');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = db => fs.writeFileSync(file, JSON.stringify(db), { mode: 0o600 });
  // A second synthetic owner permits testing the first owner's disabled state
  // without violating the existing last-owner protection.
  const initial = read();
  initial.users.push({ ...initial.users[0], id: 'second-owner', username: 'second-owner', displayName: 'Second owner' });
  write(initial);
  const secondDevice = auth.localDevice('second-owner', 'other owner device');
  const secondOwner = auth.deviceLogin(secondDevice.token, 'remember-second');
  const baseline = fs.readFileSync(file, 'utf8');
  let server = await start(home, ORIGIN);
  let localServer;
  t.after(async () => { await stop(server); await stop(localServer); fs.rmSync(home, { recursive: true, force: true }); });
  const reset = () => fs.writeFileSync(file, baseline);
  async function remember(session = owner, srv = server, origin = ORIGIN) {
    return request(srv, '/api/auth/remember-device', { session, data: { label: 'This browser' }, origin });
  }
  function expireSession(id) {
    const db = read(); db.sessions.find(s => s.id === id).expiresAt = '2000-01-01T00:00:00.000Z'; write(db);
  }
  async function recover(device, extra = {}) {
    return request(server, '/api/auth/session', { device, ...extra });
  }

  await t.test('default password login creates no trusted device and disabled is explicit', async () => {
    reset(); const before = read().devices.length;
    const login = await request(server, '/api/auth/login', { data: { username: 'owner', password: PASSWORD } });
    assert.equal(login.status, 200); assert.equal(login.body.user.disabled, false);
    assert.equal(login.cookies.length, 1); assert.equal(cookieValue(login, 'dashboard_device'), '');
    assert.equal(read().devices.length, before);
    const admin = await request(server, '/api/auth/admin', { session: owner });
    assert.ok(admin.body.users.every(u => typeof u.disabled === 'boolean'));
  });
  await t.test('remember requires owner, strict origin, JSON fixed header and session CSRF', async () => {
    reset(); const before = fs.readFileSync(file, 'utf8');
    assert.equal((await request(server, '/api/auth/remember-device', { data: { label: 'anonymous' } })).status, 401);
    assert.equal((await remember(member)).status, 403);
    for (const headers of [{ Origin: 'https://evil.example' }, { 'Content-Type': 'text/plain' }, { 'X-Dashboard-Request': '' }, { 'X-Dashboard-CSRF': 'forged' }, { 'X-Forwarded-Proto': 'https' }]) {
      assert.equal((await request(server, '/api/auth/remember-device', { session: owner, data: { label: 'bad' }, headers })).status, 403);
    }
    assert.equal((await request(server, '/api/auth/remember-device', { session: owner, data: { label: 'bad', userId: member.user.id } })).status, 400);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
  await t.test('remember sets fixed 90-day protected cookie; JSON, ledger and logs exclude its plaintext', async () => {
    reset(); const r = await remember(); assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['device', 'ok']);
    const secret = cookieValue(r, 'dashboard_device'); assert.ok(secret);
    const header = r.cookies.find(c => c.startsWith('dashboard_device='));
    for (const pattern of [/HttpOnly/, /SameSite=Strict/, /Secure/, /Path=\//, /Max-Age=7776000/]) assert.match(header, pattern);
    assert.equal(Date.parse(r.body.device.expiresAt) - Date.parse(r.body.device.createdAt), 90 * DAY);
    for (const text of [r.raw, fs.readFileSync(file, 'utf8'), server.logs()]) assert.equal(text.includes(secret), false);
    assert.equal(Object.hasOwn(r.body.device, 'tokenHash'), false);
    const manual = await request(server, '/api/auth/devices', { session: owner, data: { label: 'manual API compatibility' } });
    assert.equal(manual.status, 200); assert.equal(typeof manual.body.token, 'string');
  });
  await t.test('missing or expired session restores and persists a bounded device-linked session without renewing device', async () => {
    reset(); const remembered = await remember(); const device = cookieValue(remembered, 'dashboard_device');
    expireSession(owner.sessionId);
    const r = await recover(device, { session: owner }); assert.equal(r.status, 200); assert.equal(r.body.user.id, owner.user.id);
    const restoredToken = cookieValue(r, 'dashboard_session'); assert.ok(restoredToken);
    const restored = auth.session(restoredToken); assert.equal(restored.deviceId, remembered.body.device.id);
    const current = await recover(device, { session: { token: restoredToken } }); assert.equal(current.cookies.length, 0);
    for (let n = 0; n < 12; n++) assert.equal((await recover(device)).status, 200);
    const db = read();
    assert.ok(db.sessions.filter(s => s.deviceId === remembered.body.device.id).length <= 4);
    assert.ok(db.sessions.filter(s => s.userId === owner.user.id).length <= 32);
    assert.equal(db.devices.find(d => d.id === remembered.body.device.id).expiresAt, remembered.body.device.expiresAt);
    await stop(server); server = await start(home, ORIGIN);
    assert.equal((await recover(device)).body.user.id, owner.user.id);
  });
  await t.test('unknown, duplicated, cross-origin and forged forwarding cookies cannot recover another identity', async () => {
    reset(); const remembered = await remember(); const device = cookieValue(remembered, 'dashboard_device');
    const before = read().sessions.length;
    for (const headers of [{ 'X-Forwarded-For': '127.0.0.1' }, { 'X-Forwarded-User': 'second-owner' }, { Forwarded: 'for=127.0.0.1' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await recover(device, { headers })).status, 403);
    }
    assert.equal((await recover('a'.repeat(43))).body.user, null);
    const duplicated = await recover(device, { headers: { Cookie: `dashboard_device=${device}; dashboard_device=${secondDevice.token}` } });
    assert.equal(duplicated.body.user, null);
    assert.equal((await recover('')).body.user, null, 'loopback alone must never authenticate');
    assert.equal(read().sessions.length, before);
    const stillMember = await recover(device, { session: member }); assert.equal(stillMember.body.user.id, member.user.id);
  });
  await t.test('device deadline invalidates its unexpired derived sessions and prevents restoration', async () => {
    reset(); const remembered = await remember(); const device = cookieValue(remembered, 'dashboard_device');
    const recovered = await recover(device); const sessionToken = cookieValue(recovered, 'dashboard_session');
    const db = read(); db.devices.find(d => d.id === remembered.body.device.id).expiresAt = '2000-01-01T00:00:00.000Z'; write(db);
    assert.equal(auth.session(sessionToken), null);
    assert.equal((await recover(device)).body.user, null);
    assert.equal((await request(server, '/api/auth/admin', { session: { token: sessionToken } })).status, 401);
    assert.throws(() => auth.deviceLogin(device), e => e.status === 401);
  });
  await t.test('revoked and disabled owner devices cannot restore; admin displays disabled truth', async () => {
    reset(); let remembered = await remember(); let device = cookieValue(remembered, 'dashboard_device');
    assert.equal((await request(server, `/api/auth/devices/${remembered.body.device.id}/revoke`, { session: secondOwner, data: {} })).status, 200);
    assert.equal((await recover(device)).body.user, null);
    reset(); remembered = await remember(); device = cookieValue(remembered, 'dashboard_device');
    const disabled = await request(server, `/api/auth/users/${owner.user.id}/access`, { session: secondOwner, data: { projectIds: ['alpha'], disabled: true } });
    assert.equal(disabled.status, 200); assert.equal(disabled.body.user.disabled, true);
    assert.equal((await recover(device)).body.user, null);
    assert.equal((await recover(device, { session: owner })).body.user, null);
    const admin = await request(server, '/api/auth/admin', { session: secondOwner });
    assert.equal(admin.body.users.find(u => u.id === owner.user.id).disabled, true);
  });
  await t.test('password reset invalidates remembered and derived credentials', async () => {
    reset(); const remembered = await remember(); const device = cookieValue(remembered, 'dashboard_device');
    const derived = await recover(device); const raw = cookieValue(derived, 'dashboard_session');
    await auth.resetOwner('owner', 'Another-real-password-12345');
    assert.equal(auth.session(raw), null); assert.equal((await recover(device)).body.user, null);
    assert.equal((await recover(device, { session: owner })).body.user, null);
  });
  await t.test('logout revokes this device and all derived sessions, clears both cookies and cannot auto-login', async () => {
    reset(); const remembered = await remember(); const device = cookieValue(remembered, 'dashboard_device');
    const a = await recover(device); const b = await recover(device);
    const logout = await request(server, '/api/auth/logout', { session: owner, device, data: {} }); assert.equal(logout.status, 200);
    assert.equal(logout.cookies.length, 2);
    for (const name of ['dashboard_session', 'dashboard_device']) assert.match(logout.cookies.find(c => c.startsWith(name + '=')), /Max-Age=0/);
    assert.equal(auth.session(cookieValue(a, 'dashboard_session')), null); assert.equal(auth.session(cookieValue(b, 'dashboard_session')), null);
    assert.equal((await recover(device)).body.user, null); assert.equal((await recover('')).body.user, null);
    assert.equal(read().devices.find(d => d.id === remembered.body.device.id).revoked, true);
  });
  await t.test('logout does not revoke a different owner or different device; invalid cookies clear safely', async () => {
    reset(); const ownDevice = await remember();
    const unrelated = auth.createDevice(owner.token, 'other browser for same owner');
    let logout = await request(server, '/api/auth/logout', { session: owner, device: unrelated.token, data: {} });
    assert.equal(logout.status, 200); assert.equal(read().devices.find(d => d.id === unrelated.device.id).revoked, false);
    assert.equal(read().devices.find(d => d.id === ownDevice.body.device.id).revoked, false);
    reset(); await remember();
    logout = await request(server, '/api/auth/logout', { session: owner, device: secondDevice.token, data: {} });
    assert.equal(logout.status, 200); assert.ok(auth.session(secondOwner.token));
    assert.equal(read().devices.find(d => d.id === secondDevice.device.id).revoked, false);
    for (const device of ['', 'invalid-cookie']) {
      reset(); const r = await request(server, '/api/auth/logout', { session: owner, device, data: {} });
      assert.equal(r.status, 200); assert.equal(r.cookies.length, 2);
    }
    const stale = await request(server, '/api/auth/logout', { session: { token: 'invalid', csrfToken: 'invalid' }, device: 'invalid', data: {} });
    assert.equal(stale.status, 401); assert.equal(stale.cookies.length, 2);
  });
  await t.test('logout with valid session still rejects missing CSRF and forged origin', async () => {
    reset(); const remembered = await remember(); const device = cookieValue(remembered, 'dashboard_device');
    for (const headers of [{ 'X-Dashboard-CSRF': '' }, { Origin: 'https://evil.example' }]) {
      const r = await request(server, '/api/auth/logout', { session: owner, device, data: {}, headers });
      assert.equal(r.status, 403); assert.equal(r.cookies.length, 0); assert.ok(auth.session(owner.token));
    }
  });
  await t.test('password login with existing browser trust binds logout to that device without creating new trust', async () => {
    reset(); const remembered = await remember(); const device = cookieValue(remembered, 'dashboard_device');
    const count = read().devices.length;
    const login = await request(server, '/api/auth/login', { device, data: { username: 'owner', password: PASSWORD } });
    const session = { token: cookieValue(login, 'dashboard_session'), csrfToken: login.body.csrfToken };
    assert.equal(read().devices.length, count); assert.equal(auth.session(session.token).deviceId, remembered.body.device.id);
    assert.equal((await request(server, '/api/auth/logout', { session, device, data: {} })).status, 200);
    assert.equal((await recover(device)).body.user, null);
  });
  await t.test('explicit loopback HTTP cookie omits Secure, never inferred from proxy headers', async () => {
    reset(); localServer = await start(home, 'http://127.0.0.1:47123');
    const r = await remember(owner, localServer, 'http://127.0.0.1:47123'); assert.equal(r.status, 200);
    assert.doesNotMatch(r.cookies[0], /Secure/); assert.match(r.cookies[0], /HttpOnly/);
    await stop(localServer); localServer = null;
  });
  await t.test('offline revoke-all after full backup restore preserves users and grants, invalidates old credentials', async () => {
    reset(); const remembered = await remember(); const device = cookieValue(remembered, 'dashboard_device');
    const restored = await recover(device); const restoredToken = cookieValue(restored, 'dashboard_session');
    const historical = fs.readFileSync(file, 'utf8'); const users = read().users;
    await stop(server); server = null;
    const refused = await offline(home, ['revoke-all-credentials']); assert.equal(refused.body.ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), historical);
    // Simulate an operator restoring a full old backup, not restore-auth-backup.
    fs.writeFileSync(file, historical);
    const result = await offline(home, ['revoke-all-credentials', '--confirm-revoke']);
    assert.equal(result.code, 0); assert.equal(result.body.ok, true);
    const db = read(); assert.deepEqual(db.users, users); assert.deepEqual(db.sessions, []);
    assert.ok(db.devices.every(d => d.revoked)); assert.ok(db.invites.every(i => i.revoked));
    assert.equal(auth.session(owner.token), null); assert.equal(auth.session(restoredToken), null);
    assert.equal(auth.restoreSession(device), null);
    await assert.rejects(() => auth.register({ inviteToken: invite.token, username: 'old-invite', password: PASSWORD }), e => e.status === 400);
    const login = await auth.login('owner', PASSWORD, 'after-revoke-all'); assert.equal(login.user.id, owner.user.id);
    server = await start(home, ORIGIN);
  });
  await t.test('offline revoke-all fails closed for corrupt or missing auth without rebuilding', async () => {
    await stop(server); server = null;
    fs.writeFileSync(file, '{corrupt');
    const bad = await offline(home, ['revoke-all-credentials', '--confirm-revoke']);
    assert.equal(bad.code, 1); assert.equal(bad.body.status, 503); assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt');
    fs.unlinkSync(file);
    const missing = await offline(home, ['revoke-all-credentials', '--confirm-revoke']);
    assert.equal(missing.body.status, 503); assert.equal(fs.existsSync(file), false);
  });
});
