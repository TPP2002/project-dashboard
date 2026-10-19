'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAuth, authenticationCapacity } = require('../core/collaborationAuth.cjs');
const PASSWORD = 'Original-password-12345';
const NEXT = 'Changed-password-12345';
const rejects = (fn, status) => assert.rejects(async () => fn(), e => e.status === status);

test('account roles, password changes and one-time recovery use the real ledger', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-accounts-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registryPath = path.join(home, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { mainRepo: home } } }));
  const file = path.join(home, 'private', 'collaboration-auth.json');
  const auth = createAuth({ home, registryPath });
  const read = () => JSON.parse(fs.readFileSync(file));
  const write = db => fs.writeFileSync(file, JSON.stringify(db));
  await auth.bootstrap('owner', PASSWORD);
  const owner = await auth.login('owner', PASSWORD);
  const invite = role => auth.createInvite(owner.token, { projectIds: ['alpha'], expiresInHours: 1, maxUses: 3, ...(role ? { role } : {}) });
  const memberInvite = invite(); const viewerInvite = invite('viewer');
  const member = await auth.register({ inviteToken: memberInvite.token, username: 'member', password: PASSWORD });
  const viewer = await auth.register({ inviteToken: viewerInvite.token, username: 'viewer', password: PASSWORD });
  const secrets = [PASSWORD, NEXT, owner.token, member.token, viewer.token, memberInvite.token, viewerInvite.token];
  await t.test('invitations specify exactly member or viewer; existing sessions see role changes immediately', async () => {
    assert.equal(memberInvite.invite.role, 'member'); assert.equal(viewerInvite.invite.role, 'viewer');
    assert.equal(viewer.user.role, 'viewer');
    for (const role of ['owner', '', null, 'admin']) await rejects(() => invite(role === '' ? 'invalid' : role || 'owner'), 400);
    auth.access(owner.token, member.user.id, { projectIds: ['alpha'], disabled: false, role: 'viewer' });
    assert.equal(auth.session(member.token).user.role, 'viewer');
    auth.access(owner.token, member.user.id, { projectIds: ['alpha'], disabled: false, role: 'member' });
    assert.equal(auth.session(member.token).user.role, 'member');
    await rejects(() => auth.access(owner.token, member.user.id, { projectIds: [], disabled: false, role: 'owner' }), 400);
    await rejects(() => auth.access(owner.token, owner.user.id, { projectIds: [], disabled: false, role: 'member' }), 403);
    for (const s of [member, viewer]) await rejects(() => auth.access(s.token, member.user.id, { projectIds: [], disabled: false, role: 'viewer' }), 403);
  });
  await t.test('wrong current password is 400 and preserves session; all roles can change their own password', async () => {
    for (const session of [owner, member, viewer]) {
      const other = await auth.login(session.user.username, PASSWORD);
      await rejects(() => auth.changePassword(session.token, { currentPassword: 'wrong-password-12345', newPassword: NEXT }), 400);
      assert.ok(auth.session(session.token)); assert.ok(auth.session(other.token));
      await auth.changePassword(session.token, { currentPassword: PASSWORD, newPassword: NEXT });
      assert.ok(auth.session(session.token)); assert.equal(auth.session(other.token), null);
      const login = await auth.login(session.user.username, NEXT); secrets.push(login.token);
    }
  });
  await t.test('password change keeps only the current bound device and current session', async () => {
    const currentDevice = auth.rememberDevice(owner.token, 'this browser');
    const otherDevice = auth.createDevice(owner.token, 'another browser');
    const derived = auth.deviceLogin(otherDevice.token);
    const sibling = auth.deviceLogin(currentDevice.token);
    await auth.changePassword(owner.token, { currentPassword: NEXT, newPassword: PASSWORD });
    assert.ok(auth.session(owner.token)); assert.equal(auth.session(derived.token), null); assert.equal(auth.session(sibling.token), null);
    const db = read();
    assert.equal(db.devices.find(d => d.id === currentDevice.device.id).revoked, false);
    assert.equal(db.devices.find(d => d.id === otherDevice.device.id).revoked, true);
    secrets.push(currentDevice.token, otherDevice.token, derived.token, sibling.token);
  });
  await t.test('only owner issues reset codes and owner cannot be a reset target', async () => {
    for (const s of [member, viewer]) await rejects(() => auth.createReset(s.token, member.user.id), 403);
    await rejects(() => auth.createReset(owner.token, owner.user.id), 403);
    await rejects(() => auth.createReset(owner.token, 'missing'), 404);
    const first = auth.createReset(owner.token, member.user.id); secrets.push(first.resetToken);
    assert.ok(Math.abs(Date.parse(first.reset.expiresAt) - Date.now() - 86400000) < 5000);
    assert.deepEqual(Object.keys(first.reset).sort(), ['expiresAt', 'id', 'used', 'userId']);
    assert.equal(first.reset.used, false);
    const second = auth.createReset(owner.token, member.user.id); secrets.push(second.resetToken);
    assert.equal(auth.admin(owner.token).resets.find(r => r.id === first.reset.id).used, true);
    await rejects(() => auth.resetPassword({ resetToken: first.resetToken, newPassword: PASSWORD }), 400);
    const admin = JSON.stringify(auth.admin(owner.token));
    assert.equal(admin.includes(second.resetToken), false); assert.doesNotMatch(admin, /passwordHash|tokenHash|salt/);
    for (const r of auth.admin(owner.token).resets) assert.deepEqual(Object.keys(r).sort(), ['expiresAt', 'id', 'used', 'userId']);
    const db = read(); db.resets.find(r => r.id === second.reset.id).expiresAt = '2000-01-01T00:00:00.000Z'; write(db);
    await rejects(() => auth.resetPassword({ resetToken: second.resetToken, newPassword: PASSWORD }), 400);
  });
  await t.test('disabled target is rejected, including disable while hashing', async () => {
    const code = auth.createReset(owner.token, viewer.user.id); secrets.push(code.resetToken);
    const pending = auth.resetPassword({ resetToken: code.resetToken, newPassword: PASSWORD });
    auth.access(owner.token, viewer.user.id, { projectIds: ['alpha'], disabled: true });
    await rejects(() => pending, 403);
    await rejects(() => auth.resetPassword({ resetToken: code.resetToken, newPassword: PASSWORD }), 403);
    assert.equal(read().resets.find(r => r.id === code.reset.id).used, false);
    auth.access(owner.token, viewer.user.id, { projectIds: ['alpha'], disabled: false });
  });
  await t.test('reset is atomic single-use, revokes all old sessions/devices, and issues a new session', async () => {
    for (const user of [member.user, viewer.user]) {
      const old = await auth.login(user.username, NEXT);
      const db = read();
      // Legacy imported member devices must also be revoked, even though only
      // owners can currently create/restore a remembered device.
      const id = crypto.randomUUID();
      db.devices.push({ id, userId: user.id, label: 'legacy device', tokenHash: 'a'.repeat(64), createdAt: new Date().toISOString(), revoked: false }); write(db);
      const code = auth.createReset(owner.token, user.id); secrets.push(code.resetToken);
      const results = await Promise.allSettled([1, 2].map(() => auth.resetPassword({ resetToken: code.resetToken, newPassword: PASSWORD })));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.find(r => r.status === 'rejected').reason.status, 400);
      const session = results.find(r => r.status === 'fulfilled').value; secrets.push(session.token, old.token);
      assert.equal(auth.session(old.token), null); assert.ok(auth.session(session.token));
      assert.equal(read().devices.find(d => d.id === id).revoked, true);
      assert.deepEqual(read().sessions.filter(s => s.userId === user.id).map(s => s.id), [session.sessionId]);
      await rejects(() => auth.resetPassword({ resetToken: code.resetToken, newPassword: NEXT }), 400);
    }
    for (const secret of secrets) assert.equal(fs.readFileSync(file, 'utf8').includes(secret), false);
  });
  await t.test('old ledger fields are optional on read and normalized only on write; corrupt fields fail closed', async () => {
    const db = read(); delete db.resets; db.invites.forEach(i => { delete i.role; }); write(db);
    const before = fs.readFileSync(file, 'utf8');
    assert.ok(auth.session(owner.token));
    assert.deepEqual(auth.admin(owner.token).resets, []);
    assert.ok(auth.admin(owner.token).invites.every(i => i.role === 'member'));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    invite(); assert.ok(Array.isArray(read().resets)); assert.ok(read().invites.every(i => i.role === 'member'));
    const valid = read();
    for (const bad of [null, {}, [null], [{ id: 'x', userId: member.user.id, tokenHash: 'bad', expiresAt: new Date().toISOString(), used: false }],
      [{ id: 'x', userId: 'absent', tokenHash: 'a'.repeat(64), expiresAt: new Date().toISOString(), used: false }]]) {
      write({ ...valid, resets: bad }); await rejects(() => auth.session(owner.token), 503);
    }
    for (const role of ['owner', null, 42]) { const broken = structuredClone(valid); broken.invites[0].role = role; write(broken); await rejects(() => auth.session(owner.token), 503); }
    fs.writeFileSync(file, '{broken'); await rejects(() => auth.session(owner.token), 503); write(valid);
  });
  await t.test('password and valid reset attempts are limited per user/record', async () => {
    const m = await auth.login('member', PASSWORD);
    // Use invalid new passwords to exercise admission without expensive hashing.
    for (let n = 0; n < 10; n++) {
      try { await auth.changePassword(m.token, { currentPassword: PASSWORD, newPassword: 'short' }); }
      catch (e) { assert.ok([400, 429].includes(e.status)); }
    }
    await rejects(() => auth.changePassword(m.token, { currentPassword: PASSWORD, newPassword: NEXT }), 429);
    const code = auth.createReset(owner.token, m.user.id);
    for (let n = 0; n < 10; n++) await rejects(() => auth.resetPassword({ resetToken: code.resetToken, newPassword: 'short' }), 400);
    await rejects(() => auth.resetPassword({ resetToken: code.resetToken, newPassword: NEXT }), 429);
  });
  await t.test('invalid reset guesses use a separate bounded limiter, leaving legitimate login usable', async () => {
    for (let n = 0; n < 10; n++) await rejects(() => auth.resetPassword({ resetToken: 'invalid', newPassword: PASSWORD }), 400);
    await rejects(() => auth.resetPassword({ resetToken: 'invalid', newPassword: PASSWORD }), 429);
    for (let n = 0; n < 2050; n++) {
      try { await auth.resetPassword({ resetToken: 'guess-' + n, newPassword: PASSWORD }); assert.fail('guess accepted'); }
      catch (e) { assert.ok([400, 429].includes(e.status)); }
    }
    assert.ok(authenticationCapacity().invalidResetEntries <= 2048);
    assert.ok((await auth.login('owner', PASSWORD)).token);
  });
});
