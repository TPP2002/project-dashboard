'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard, validate } = require('../core/boardSchema.cjs');
const { memberActions } = require('../core/collaborationRules.cjs');
const { taskView } = require('../core/collaborationPublic.cjs');
const CLI = path.resolve(__dirname, '../cli/collaboration.cjs');
const PASSWORD = 'Collaborators-password-12345';
function cli(home, command, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, command], { windowsHide: true, timeout: 20000,
      env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json') } }, (err, stdout, stderr) => {
      try { resolve({ code: err ? err.code : 0, ...JSON.parse(stdout) }); }
      catch { reject(new Error(stderr || stdout || String(err))); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
  });
}

test('collaborators use real CLI transactions and retain existing ownership rules', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-collaborators-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'alpha.json'); const registryPath = path.join(home, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: {
    alpha: { mainRepo: home, board: file }, beta: { mainRepo: home, board: path.join(home, 'beta.json') },
  } }));
  for (const id of ['alpha', 'beta']) fs.writeFileSync(path.join(home, id + '.json'), JSON.stringify(emptyBoard({ id, name: id })));
  const auth = createAuth({ home, registryPath }); await auth.bootstrap('owner', PASSWORD);
  const owner = await auth.login('owner', PASSWORD);
  const register = async (username, role = 'member', projectIds = ['alpha']) => {
    const invite = auth.createInvite(owner.token, { role, projectIds, expiresInHours: 1, maxUses: 1 });
    return auth.register({ inviteToken: invite.token, username, displayName: username + ' display', password: PASSWORD });
  };
  const a = await register('primary'); const b = await register('helper-b'); const c = await register('helper-c');
  const outsider = await register('outsider', 'member', ['beta']); const viewer = await register('viewer', 'viewer');
  const read = () => JSON.parse(fs.readFileSync(file));
  const task = id => read().tasks.find(t => t.id === id);
  const entry = user => ({ userId: user.id, name: user.displayName, joinedAt: '2026-10-19T00:00:00.000Z' });
  const seed = (id, more = {}) => {
    const board = read(); const value = { id, title: id, wave: 0, status: '施工中', percent: 20,
      assigneeUserId: a.user.id, assigneeName: a.user.displayName, ...more };
    board.tasks = board.tasks.filter(t => t.id !== id); board.tasks.push(value);
    fs.writeFileSync(file, JSON.stringify(board)); return task(id);
  };
  const call = (command, session, taskId, more = {}) => cli(home, command, {
    sessionToken: session.token, actorId: session.user.id, projectId: 'alpha', taskId, ...more,
  });
  const denied = async (command, session, id, more = {}, status = 409) => {
    const before = fs.readFileSync(file, 'utf8'); const other = fs.readFileSync(path.join(home, 'beta.json'), 'utf8');
    const r = await call(command, session, id, more);
    assert.equal(r.status, status, command + ': ' + JSON.stringify(r));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(home, 'beta.json'), 'utf8'), other);
  };
  const audit = (type, session, targetUserId) => {
    const event = read().activity.at(-1);
    assert.equal(event.type, 'collaboration:' + type); assert.equal(event.userId, session.user.id);
    assert.equal(event.author, session.user.displayName); assert.equal(event.targetUserId, targetUserId);
  };

  await t.test('join, duplicate/self/full/unclaimed/terminal refusal, and leave', async () => {
    seed('JOIN');
    const r = await call('join', b, 'JOIN'); assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(task('JOIN').collaborators[0]).sort(), ['joinedAt', 'name', 'userId']);
    const joined = task('JOIN').collaborators[0];
    assert.equal(joined.userId, b.user.id); assert.equal(joined.name, b.user.displayName);
    assert.equal(new Date(joined.joinedAt).toISOString(), joined.joinedAt);
    assert.deepEqual(r.task.collaborators, [joined]); assert.ok(r.task.actions.includes('leave'));
    assert.ok(r.task.actions.includes('progress')); assert.equal(r.task.actions.includes('join'), false);
    audit('join', b);
    await denied('join', b, 'JOIN'); await denied('join', a, 'JOIN'); await denied('leave', c, 'JOIN');
    seed('FULL', { collaborators: Array.from({ length: 5 }, (_, n) => entry({ id: 'full-' + n, displayName: 'Full ' + n })) });
    await denied('join', b, 'FULL');
    assert.equal(memberActions(task('FULL'), b.user).includes('join'), false);
    seed('UNCLAIMED', { status: '待开工', assigneeUserId: undefined, assigneeName: undefined });
    await denied('join', b, 'UNCLAIMED');
    for (const [n, status] of ['已完工', '收官', '已作废'].entries()) {
      seed('CLOSED-' + n, { status }); await denied('join', b, 'CLOSED-' + n);
      assert.equal(memberActions(task('CLOSED-' + n), b.user).includes('join'), false);
    }
    assert.equal((await call('leave', b, 'JOIN')).ok, true); assert.deepEqual(task('JOIN').collaborators, []);
    audit('leave', b); await denied('leave', b, 'JOIN');
    assert.equal((await call('join', b, 'JOIN')).ok, true);
  });
  await t.test('only primary or owner can remove, including after terminal state', async () => {
    seed('REMOVE', { collaborators: [entry(b.user), entry(c.user)] });
    for (const s of [b, c]) await denied('remove-collaborator', s, 'REMOVE', { userId: b.user.id });
    assert.ok(memberActions(task('REMOVE'), a.user).includes('removeCollaborator'));
    assert.equal((await call('remove-collaborator', a, 'REMOVE', { userId: b.user.id })).ok, true);
    audit('remove-collaborator', a, b.user.id);
    assert.deepEqual(task('REMOVE').collaborators, [entry(c.user)]);
    await denied('remove-collaborator', a, 'REMOVE', { userId: 'absent' });
    await denied('remove-collaborator', a, 'REMOVE', { userId: a.user.id });
    assert.equal((await call('remove-collaborator', owner, 'REMOVE', { userId: c.user.id })).ok, true);
    audit('remove-collaborator', owner, c.user.id);
    await denied('progress', c, 'REMOVE', { percent: 40 });
    for (const status of ['已完工', '已作废', '收官']) {
      seed('TERMINAL-EXIT', { status, collaborators: [entry(b.user), entry(c.user)] });
      assert.equal((await call('leave', b, 'TERMINAL-EXIT')).ok, true);
      assert.equal((await call('remove-collaborator', a, 'TERMINAL-EXIT', { userId: c.user.id })).ok, true);
    }
  });
  await t.test('viewer, cross-project, spoofed actor, invalid body and revoked grants never write', async () => {
    seed('BOUND', { collaborators: [entry(b.user)] });
    for (const [command, data] of [['join', {}], ['leave', {}], ['remove-collaborator', { userId: b.user.id }]]) {
      await denied(command, viewer, 'BOUND', data, 403);
      await denied(command, outsider, 'BOUND', data, 404);
      await denied(command, b, 'BOUND', { ...data, projectId: 'beta' }, 404);
      await denied(command, b, 'BOUND', { ...data, actorId: a.user.id }, 403);
      await denied(command, b, 'BOUND', { ...data, sessionToken: 'invalid' }, 401);
      await denied(command, b, 'BOUND', { ...data, builder: '派单器' }, 400);
    }
    for (const userId of [undefined, null, '', ' ', 42, 'x'.repeat(129)]) await denied('remove-collaborator', a, 'BOUND', { userId }, 400);
    await denied('join', c, 'MISSING', {}, 404);
    await denied('join', c, '../BOUND', {}, 400);
    auth.access(owner.token, b.user.id, { projectIds: [], disabled: false });
    await denied('leave', b, 'BOUND', {}, 404); await denied('progress', b, 'BOUND', { percent: 40 }, 404);
    auth.access(owner.token, b.user.id, { projectIds: ['alpha'], disabled: false, role: 'viewer' });
    await denied('leave', b, 'BOUND', {}, 403);
    auth.access(owner.token, b.user.id, { projectIds: ['alpha'], disabled: false, role: 'member' });
  });
  await t.test('collaborator may progress and note but gains no lifecycle authority', async () => {
    seed('WORK', { collaborators: [entry(b.user)] });
    const r = await call('progress', b, 'WORK', { percent: 55, note: 'Testing complete' });
    assert.equal(r.ok, true); assert.equal(task('WORK').percent, 55); assert.equal(task('WORK').status, '施工中');
    audit('progress', b); assert.equal(read().activity.at(-1).percent, 55);
    assert.equal((await call('note', b, 'WORK', { text: 'Checked' })).ok, true);
    assert.equal(read().activity.at(-1).userId, b.user.id); assert.equal(read().activity.at(-1).kind, 'message');
    for (const [command, status] of [['done', '施工中'], ['park', '施工中'], ['unclaim', '施工中'], ['cancel', '施工中'], ['unpark', '暂缓'], ['reopen', '已完工']]) {
      seed('DENY-' + command.toUpperCase(), { status, collaborators: [entry(b.user)] });
      await denied(command, b, 'DENY-' + command.toUpperCase(), command === 'done' ? {} : { reason: 'No authority' });
    }
    for (const more of [{ status: '暂缓' }, { status: '已完工' }, { blockReason: 'Blocked' }, { deps: { blockedBy: ['WORK'] } }]) {
      seed('NO-PROGRESS', { collaborators: [entry(b.user)], ...more });
      await denied('progress', b, 'NO-PROGRESS', { percent: 65 });
    }
    seed('CREATOR', { createdByUserId: b.user.id, collaborators: [entry(b.user)] });
    assert.equal((await call('cancel', b, 'CREATOR', { reason: 'Creator cancellation' })).ok, true);
    assert.equal((await call('reopen', b, 'CREATOR', { reason: 'Creator reopening' })).ok, true);
    assert.deepEqual(task('CREATOR').collaborators, [entry(b.user)]);
  });
  await t.test('AI collaboration preserves every recorded AI field', async () => {
    const metadata = { builder: '派单器', gitBranch: ['ai-branch'], prNumbers: [123], commitShas: ['abcdef1'],
      worktree: ['C:\\path\\to\\worker'], sessionId: 'ai-session', collectBrief: { text: 'Keep', updatedAt: '2026-10-19T00:00:00.000Z' } };
    const original = seed('AI', { assigneeUserId: undefined, assigneeName: undefined, ...metadata });
    assert.equal((await call('join', b, 'AI')).ok, true);
    const afterJoin = task('AI'); delete afterJoin.collaborators; assert.deepEqual(afterJoin, original);
    assert.equal((await call('progress', b, 'AI', { percent: 45 })).ok, true);
    for (const [key, value] of Object.entries(metadata)) assert.deepEqual(task('AI')[key], value, key);
    for (const command of ['claim', 'done', 'park', 'cancel', 'unclaim']) await denied(command, b, 'AI', ['claim', 'done'].includes(command) ? {} : { reason: 'No' });
    assert.equal((await call('leave', b, 'AI')).ok, true);
    for (const [key, value] of Object.entries(metadata)) assert.deepEqual(task('AI')[key], value, key);
    for (const [n, only] of [{ builder: '派单器' }, { gitBranch: ['ai'] }, { prNumbers: [1] }, { commitShas: ['abcdef1'] }].entries()) {
      seed('AI-KIND-' + n, { assigneeUserId: undefined, assigneeName: undefined, ...only });
      assert.equal((await call('join', c, 'AI-KIND-' + n)).ok, true);
    }
  });
  await t.test('unclaim, done and cancel retain collaborators; claiming removes only the new primary', async () => {
    for (const command of ['unclaim', 'done', 'cancel']) {
      seed('KEEP-' + command.toUpperCase(), { collaborators: [entry(b.user), entry(c.user)] });
      assert.equal((await call(command, a, 'KEEP-' + command.toUpperCase(), command === 'done' ? {} : { reason: 'Finish' })).ok, true);
      assert.deepEqual(task('KEEP-' + command.toUpperCase()).collaborators, [entry(b.user), entry(c.user)]);
    }
    const r = await call('claim', b, 'KEEP-UNCLAIM'); assert.equal(r.ok, true);
    assert.equal(task('KEEP-UNCLAIM').assigneeUserId, b.user.id);
    assert.deepEqual(task('KEEP-UNCLAIM').collaborators, [entry(c.user)]);
    assert.equal(r.task.actions.includes('leave'), false); assert.ok(r.task.actions.includes('done'));
  });
  await t.test('two CLI children compete for the final slot: exactly one write succeeds', async () => {
    const existing = Array.from({ length: 4 }, (_, n) => entry({ id: 'race-' + n, displayName: 'Race ' + n }));
    seed('RACE', { collaborators: existing }); const before = read().activity.length;
    const results = await Promise.all([b, c].map(s => call('join', s, 'RACE')));
    assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok).status, 409);
    const stored = task('RACE').collaborators;
    assert.equal(stored.length, 5); assert.equal(new Set(stored.map(c => c.userId)).size, 5);
    assert.deepEqual(stored.slice(0, 4), existing); assert.equal(read().activity.length, before + 1);
    assert.equal(read().activity.at(-1).userId, stored[4].userId);
  });
  await t.test('member/viewer projections scrub collaborator identity and keep only public fields', () => {
    const value = seed('VIEW', { collaborators: [{ ...entry(b.user), userId: 'C:\\path\\to\\user', name: 'Name /home/private/name', secret: 'hidden' }] });
    for (const user of [b.user, viewer.user]) {
      const view = taskView(value, user);
      assert.deepEqual(view.collaborators, [{ userId: '[private path]', name: 'Name [private path]', joinedAt: '2026-10-19T00:00:00.000Z' }]);
      if (user.role === 'viewer') assert.deepEqual(view.actions, []);
    }
    const old = seed('OLD'); assert.equal(Object.hasOwn(old, 'collaborators'), false);
    assert.deepEqual(taskView(old, b.user).collaborators, []); assert.equal(Object.hasOwn(task('OLD'), 'collaborators'), false);
  });
});

test('schema accepts old cards and validates optional collaborator invariants', () => {
  const board = emptyBoard({ id: 'alpha' });
  const task = { id: 'ONE', title: 'One', status: '施工中', wave: 0, assigneeUserId: 'primary' };
  board.tasks = [task]; assert.equal(validate(board).ok, true);
  const entry = { userId: 'helper', name: 'Helper', joinedAt: '2026-10-19T00:00:00.000Z' };
  for (const collaborators of [[], [entry]]) { task.collaborators = collaborators; assert.equal(validate(board).ok, true); }
  for (const collaborators of [null, {}, [null], [entry, entry], [{ ...entry, userId: 'primary' }],
    [{ ...entry, userId: '' }], [{ ...entry, name: 1 }], [{ ...entry, joinedAt: 'yesterday' }],
    Array.from({ length: 6 }, (_, n) => ({ ...entry, userId: 'helper-' + n }))]) {
    task.collaborators = collaborators; assert.equal(validate(board).ok, false, JSON.stringify(collaborators));
  }
});
