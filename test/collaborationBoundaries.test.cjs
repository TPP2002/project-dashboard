'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuth, createAttemptLimiter, authenticationCapacity } = require('../core/collaborationAuth.cjs');
const { taskOperation } = require('../cli/collaboration.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const PASSWORD = 'Boundary-real-password-123';

test('proxy isolation, bounded authentication and current member work state', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-boundaries-'));
  const registryPath = path.join(home, 'registry.json'), boardFile = path.join(home, 'board.json');
  const previous = process.env.DASHBOARD_REGISTRY;
  process.env.DASHBOARD_REGISTRY = registryPath;
  t.after(() => {
    if (previous === undefined) delete process.env.DASHBOARD_REGISTRY; else process.env.DASHBOARD_REGISTRY = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { mainRepo: home, board: boardFile } } }));
  const auth = createAuth({ home, registryPath });
  await auth.bootstrap('owner', PASSWORD);
  const owner = await auth.login('owner', PASSWORD, 'one-proxy');
  const invite = auth.createInvite(owner.token, { projectIds: ['alpha'], maxUses: 30, expiresInHours: 1 });
  const member = await auth.register({ inviteToken: invite.token, username: 'member-a', password: PASSWORD }, 'one-proxy');

  await t.test('ten failures against A do not lock B behind the same proxy; A remains limited', async () => {
    // Include a real wrong-password hash, followed by the reported cheap attack.
    await assert.rejects(auth.login('member-a', 'Wrong-password-123', 'one-proxy'), { status: 401 });
    for (let i = 0; i < 9; i++) await assert.rejects(auth.login('member-a', 'x', 'one-proxy'), { status: 400 });
    await assert.rejects(auth.login(' MEMBER-A ', PASSWORD, 'different-source'), { status: 429 });
    assert.equal((await auth.login('owner', PASSWORD, 'one-proxy')).user.id, owner.user.id);
    assert.equal(authenticationCapacity().active, 0);
  });

  await t.test('invitation failures are isolated from another invitation on the same proxy', async () => {
    const attacked = auth.createInvite(owner.token, { projectIds: ['alpha'], maxUses: 20, expiresInHours: 1 });
    for (let i = 0; i < 10; i++) await assert.rejects(auth.register({ inviteToken: attacked.token, username: 'new-user', password: 'x' }, 'one-proxy'), { status: 400 });
    await assert.rejects(auth.register({ inviteToken: attacked.token, username: 'new-user', password: PASSWORD }, 'one-proxy'), { status: 429 });
    const good = await auth.register({ inviteToken: invite.token, username: 'member-b', password: PASSWORD }, 'one-proxy');
    assert.equal(good.user.username, 'member-b');
    const count = authenticationCapacity().attemptEntries;
    for (let i = 0; i < 15; i++) await assert.rejects(auth.register({ inviteToken: 'invalid-' + i, username: 'bad-user', password: 'x' }, 'one-proxy'), { status: 400 });
    assert.equal(authenticationCapacity().attemptEntries, count, 'unknown invitations cannot fill the map');
  });

  await t.test('repeated invalid device guesses stay limited without locking valid devices behind that proxy', () => {
    const device = auth.createDevice(owner.token, 'valid device');
    for (let i = 0; i < 10; i++) assert.throws(() => auth.deviceLogin('invalid-device', 'one-proxy'), { status: 401 });
    assert.throws(() => auth.deviceLogin('invalid-device', 'one-proxy'), { status: 429 });
    assert.equal(auth.deviceLogin(device.token, 'one-proxy').user.id, owner.user.id);
    assert.ok(authenticationCapacity().invalidDeviceEntries <= 2048);
  });

  await t.test('attempt map has a hard 2048-entry ceiling and expires without extending the window', () => {
    let now = 0;
    const limiter = createAttemptLimiter(() => now);
    for (let i = 0; i < 2048; i++) limiter.take(String(i));
    assert.equal(limiter.size, 2048);
    assert.throws(() => limiter.take('overflow'), { status: 429 });
    now = 15 * 60000;
    limiter.take('new'); assert.equal(limiter.size, 1);
    for (let i = 0; i < 9; i++) limiter.take('new');
    assert.throws(() => limiter.take('new'), { status: 429 });
  });

  await t.test('a group can register more than ten users through one proxy and invitation', async () => {
    for (let i = 0; i < 11; i++) {
      const result = await auth.register({ inviteToken: invite.token, username: 'group-' + i, password: PASSWORD }, 'one-proxy');
      assert.equal(result.user.username, 'group-' + i);
    }
  });

  await t.test('real production scrypt admits one active and eight queued, rejects excess, then recovers', async () => {
    const jobs = Array.from({ length: 10 }, (_, i) => auth.login('unknown-user-' + i, PASSWORD, 'one-proxy'));
    const settled = Promise.allSettled(jobs); // Attach rejection handlers before yielding.
    const capacity = authenticationCapacity();
    assert.equal(capacity.active, 1); assert.equal(capacity.queued, 8); assert.equal(capacity.queueLimit, 8);
    const results = await settled;
    assert.equal(results.filter(r => r.status === 'rejected' && r.reason.status === 429).length, 1);
    assert.equal(results.filter(r => r.status === 'rejected' && r.reason.status === 401).length, 9);
    assert.equal(authenticationCapacity().active, 0); assert.equal(authenticationCapacity().queued, 0);
    assert.equal((await auth.login('owner', PASSWORD, 'one-proxy')).user.id, owner.user.id);
  });

  await t.test('parked, blocked, released, approval and terminal states reject a stale member assignee under lock', () => {
    const board = emptyBoard({ id: 'alpha', name: 'Alpha' });
    board.tasks = [{ id: 'ONE', title: 'One', wave: 1, status: '施工中', percent: 20,
      assigneeUserId: member.user.id, assigneeName: member.user.displayName },
      { id: 'UPSTREAM', title: 'Upstream', wave: 1, status: '待开工', percent: 0 }];
    const input = { sessionToken: member.token, actorId: member.user.id, projectId: 'alpha', taskId: 'ONE', percent: 80 };
    for (const status of ['暂缓', '压轴', '待开工', '未开工', '可复工', '已拍板', '待拍板', '待收单', '收官', '已完工', '已作废']) {
      board.tasks[0].status = status;
      fs.writeFileSync(boardFile, JSON.stringify(board));
      const before = fs.readFileSync(boardFile, 'utf8');
      assert.throws(() => taskOperation('progress', input, auth), { status: 409 }, status);
      assert.equal(fs.readFileSync(boardFile, 'utf8'), before);
    }
    board.tasks[0].status = '施工中';
    // The existing block command deliberately leaves status unchanged.
    for (const patch of [{ blockReason: 'Blocked by owner' }, { deps: { blockedBy: ['UPSTREAM'] } }]) {
      Object.assign(board.tasks[0], patch); fs.writeFileSync(boardFile, JSON.stringify(board));
      const before = fs.readFileSync(boardFile, 'utf8');
      assert.throws(() => taskOperation('progress', input, auth), { status: 409 });
      assert.equal(fs.readFileSync(boardFile, 'utf8'), before);
      delete board.tasks[0].blockReason; delete board.tasks[0].deps;
    }
    fs.writeFileSync(boardFile, JSON.stringify(board));
    assert.equal(taskOperation('progress', input, auth).task.percent, 80);
    const saved = JSON.parse(fs.readFileSync(boardFile));
    assert.equal(saved.tasks[0].status, '施工中'); assert.equal(saved.activity.at(-1).userId, member.user.id);
  });
});
