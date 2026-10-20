'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuth } = require('../core/collaborationAuth.cjs');
const PASSWORD = 'A-real-password-12345';
const rejects = (fn, status) => assert.rejects(async () => fn(), e => e.status === status);

test('persistent authentication and atomic invitation lifecycle (production scrypt)', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-auth-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registryPath = path.join(home, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { mainRepo: home }, beta: { mainRepo: home } } }));
  const file = path.join(home, 'private', 'collaboration-auth.json');
  const auth = createAuth({ home, registryPath });
  let owner, member, invite;
  await t.test('bootstrap once, normalize usernames, hash asynchronously and protect files', async () => {
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 5);
    const user = await auth.bootstrap(' Owner ', PASSWORD);
    clearTimeout(timer);
    assert.equal(timerRan, true, 'scrypt must not block the event loop');
    assert.equal(user.username, 'owner'); assert.equal(user.role, 'owner');
    assert.equal('passwordHash' in user, false);
    await rejects(() => auth.bootstrap('another', PASSWORD), 409);
    const persisted = fs.readFileSync(file, 'utf8');
    assert.equal(persisted.includes(PASSWORD), false);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
  });
  await t.test('wrong password fails and valid login survives fresh auth instance', async () => {
    await rejects(() => auth.login('owner', 'wrong-password-1234', 'auth-wrong'), 401);
    owner = await auth.login('OWNER', PASSWORD, 'auth-owner');
    assert.equal(createAuth({ home, registryPath }).session(owner.token).user.id, owner.user.id);
    assert.equal(auth.session('not-a-token'), null);
  });
  await t.test('password boundaries and invalid usernames reject before hashing', async () => {
    await rejects(() => auth.login('owner', 'short'), 400);
    await rejects(() => auth.login('owner', 'a'.repeat(129)), 400);
    await rejects(() => auth.login('../owner', PASSWORD), 400);
  });
  await t.test('registration requires an invite and only existing project grants', async () => {
    await rejects(() => auth.register({ username: 'member', password: PASSWORD }), 400);
    assert.throws(() => auth.createInvite(owner.token, { projectIds: ['missing'], expiresInHours: 1, maxUses: 1 }), e => e.status === 400);
    invite = auth.createInvite(owner.token, { projectIds: ['alpha'], expiresInHours: 1, maxUses: 1 });
  });
  await t.test('two concurrent registrations consume a single-use invite exactly once', async () => {
    const results = await Promise.allSettled(['member-a', 'member-b'].map(username => auth.register({ inviteToken: invite.token, username, password: PASSWORD }, username)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    member = results.find(r => r.status === 'fulfilled').value;
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 400);
    assert.equal(auth.admin(owner.token).invites[0].uses, 1);
    assert.deepEqual(member.user.projectIds, ['alpha']); assert.equal(member.user.role, 'member');
  });
  await t.test('exhausted, revoked and expired invites fail without consuming another hash', async () => {
    await rejects(() => auth.register({ inviteToken: invite.token, username: 'exhausted', password: PASSWORD }), 400);
    const revoked = auth.createInvite(owner.token, { projectIds: ['alpha'], expiresInHours: 1, maxUses: 1 });
    auth.revokeInvite(owner.token, revoked.invite.id);
    await rejects(() => auth.register({ inviteToken: revoked.token, username: 'revoked', password: PASSWORD }), 400);
    const expired = auth.createInvite(owner.token, { projectIds: ['alpha'], expiresInHours: 1, maxUses: 1 });
    const db = JSON.parse(fs.readFileSync(file));
    db.invites.find(i => i.id === expired.invite.id).expiresAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(file, JSON.stringify(db));
    await rejects(() => auth.register({ inviteToken: expired.token, username: 'expired', password: PASSWORD }), 400);
  });
  await t.test('duplicate normalized username does not spend an invite', async () => {
    const other = auth.createInvite(owner.token, { projectIds: ['beta'], expiresInHours: 1, maxUses: 2 });
    await rejects(() => auth.register({ inviteToken: other.token, username: member.user.username.toUpperCase(), password: PASSWORD }), 409);
    assert.equal(auth.admin(owner.token).invites.find(i => i.id === other.invite.id).uses, 0);
    const races = await Promise.allSettled([1, 2].map(n => auth.register({ inviteToken: other.token, username: 'same-name', password: PASSWORD }, 'duplicate-' + n)));
    assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(races.find(r => r.status === 'rejected').reason.status, 409);
    assert.equal(auth.admin(owner.token).invites.find(i => i.id === other.invite.id).uses, 1);
  });
  await t.test('revoking an invitation while hashing prevents its commit', async () => {
    const pending = auth.createInvite(owner.token, { projectIds: ['alpha'], expiresInHours: 1, maxUses: 1 });
    const registering = auth.register({ inviteToken: pending.token, username: 'revoked-during-hash', password: PASSWORD }, 'revoked-during-hash');
    auth.revokeInvite(owner.token, pending.invite.id);
    await rejects(() => registering, 400);
    assert.equal(auth.admin(owner.token).invites.find(i => i.id === pending.invite.id).uses, 0);
  });
  await t.test('production password hashing has one active job and a bounded waiting queue', async () => {
    // Nine may run (one active plus eight waiting); the tenth must be refused.
    // Every accepted operation uses the real production scrypt parameters.
    const pending = Array.from({ length: 10 }, (_, n) => auth.login('owner', PASSWORD, 'queue-' + n));
    const results = await Promise.allSettled(pending);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 9);
    assert.equal(results.filter(r => r.status === 'rejected' && r.reason.status === 429).length, 1);
  });
  await t.test('members cannot administer and current grants apply to old sessions immediately', () => {
    assert.throws(() => auth.admin(member.token), e => e.status === 403);
    assert.throws(() => auth.access(member.token, member.user.id, { projectIds: ['beta'], disabled: false }), e => e.status === 403);
    auth.access(owner.token, member.user.id, { projectIds: ['beta'], disabled: false });
    assert.deepEqual(createAuth({ home, registryPath }).session(member.token).user.projectIds, ['beta']);
    assert.throws(() => auth.access(owner.token, owner.user.id, { projectIds: [], disabled: true }), e => e.status === 409);
  });
  await t.test('device revocation revokes all derived sessions without revoking password sessions', () => {
    const device = auth.createDevice(owner.token, 'test device');
    const one = auth.deviceLogin(device.token, 'device-one');
    const two = auth.deviceLogin(device.token, 'device-two');
    assert.equal(auth.session(one.token).user.id, owner.user.id);
    auth.revokeDevice(owner.token, device.device.id);
    assert.equal(auth.session(one.token), null); assert.equal(auth.session(two.token), null);
    assert.throws(() => auth.deviceLogin(device.token), e => e.status === 401);
    assert.ok(auth.session(owner.token));
    const persisted = fs.readFileSync(file, 'utf8');
    for (const secret of [owner.token, member.token, invite.token, device.token, one.token, two.token]) assert.equal(persisted.includes(secret), false);
    const admin = JSON.stringify(auth.admin(owner.token));
    assert.equal(/passwordHash|tokenHash|salt/.test(admin), false);
  });
  await t.test('disable, logout, and seven-day expiry revoke persisted sessions', () => {
    auth.access(owner.token, member.user.id, { projectIds: [], disabled: true });
    assert.equal(auth.session(member.token), null);
    const device = auth.createDevice(owner.token, 'expiry');
    const login = auth.deviceLogin(device.token, 'expiry');
    let db = JSON.parse(fs.readFileSync(file));
    const s = db.sessions.find(s => s.id === login.sessionId);
    assert.ok(Date.parse(s.expiresAt) > Date.now() + 6.99 * 86400000);
    s.expiresAt = '2000-01-01T00:00:00.000Z'; fs.writeFileSync(file, JSON.stringify(db));
    assert.equal(auth.session(login.token), null);
    const logout = auth.deviceLogin(device.token, 'logout');
    auth.logout(logout.token); assert.equal(auth.session(logout.token), null);
  });
  await t.test('bounded failed login rate limiting rejects further work', async () => {
    // Invalid tokens cost no password hashes but still exercise the same bounded limiter.
    for (let n = 0; n < 10; n++) assert.throws(() => auth.deviceLogin('invalid', 'limited'), e => e.status === 401);
    assert.throws(() => auth.deviceLogin('invalid', 'limited'), e => e.status === 429);
    for (let n = 0; n < 10; n++) await rejects(() => auth.login('owner', 'short', 'login-limited'), 400);
    await rejects(() => auth.login('owner', PASSWORD, 'login-limited'), 429);
  });
  await t.test('corrupt and missing auth fails closed, explicit recovery clears credentials', async () => {
    fs.writeFileSync(file, '{broken');
    assert.throws(() => auth.session(owner.token), e => e.status === 503);
    await rejects(() => auth.bootstrap('replacement', PASSWORD), 409);
    auth.restoreBackup(); assert.equal(auth.session(owner.token), null);
    fs.unlinkSync(file);
    assert.throws(() => auth.session(owner.token), e => e.status === 503);
    await rejects(() => auth.bootstrap('replacement', PASSWORD), 409);
  });
});

test('existing empty or semantically broken authentication file cannot bootstrap', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-broken-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'private'); fs.mkdirSync(dir);
  const file = path.join(dir, 'collaboration-auth.json'); fs.writeFileSync(file, '');
  const auth = createAuth({ home });
  await rejects(() => auth.bootstrap('owner', PASSWORD), 409);
  fs.writeFileSync(file, JSON.stringify({ version: 1, users: [], sessions: [], invites: [], devices: [] }));
  assert.throws(() => auth.session(''), e => e.status === 503);
});
