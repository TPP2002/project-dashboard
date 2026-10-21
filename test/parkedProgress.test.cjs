'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { memberActions, toEsmSource } = require('../core/collaborationRules.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { taskOperation } = require('../cli/collaboration.cjs');

test('parked progress actions preserve role, AI and active blocking boundaries', async () => {
  const users = [
    { id: 'assigned', role: 'member' }, { id: 'owner', role: 'owner' },
    { id: 'collab', role: 'member' }, { id: 'other', role: 'member' },
    { id: 'collab', role: 'viewer' },
  ];
  const esm = await import('data:text/javascript;base64,' + Buffer.from(toEsmSource()).toString('base64'));
  for (const builder of [undefined, '派单器']) {
    const task = { status: '暂缓', blockReason: '等待资料', deps: { blockedBy: ['UPSTREAM'] },
      assigneeUserId: 'assigned', collaborators: [{ userId: 'collab' }], builder };
    const before = structuredClone(task);
    for (const [i, user] of users.entries()) {
      const actions = memberActions(task, user);
      assert.equal(actions.includes('progress'), i < 3);
      assert.equal(actions.filter(a => a === 'progress').length, i < 3 ? 1 : 0);
      assert.deepEqual(esm.memberActions(task, user), actions);
      for (const blocked of [{ blockReason: '受阻' }, { deps: { blockedBy: ['UPSTREAM'] } }]) {
        assert.equal(memberActions({ ...task, status: '施工中', blockReason: undefined, deps: {}, ...blocked }, user).includes('progress'), false);
      }
    }
    assert.deepEqual(task, before);
    assert.ok(memberActions({ ...task, status: '施工中', blockReason: undefined, deps: {} }, users[2]).includes('progress'));
  }
});

test('member progress retains parked state/reason and rejects forbidden writes atomically', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'parked-member-'));
  const registryPath = path.join(home, 'registry.json'), file = path.join(home, 'board.json');
  const previous = process.env.DASHBOARD_REGISTRY;
  process.env.DASHBOARD_REGISTRY = registryPath;
  t.after(() => {
    if (previous === undefined) delete process.env.DASHBOARD_REGISTRY; else process.env.DASHBOARD_REGISTRY = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { mainRepo: home, board: file } } }));
  const auth = createAuth({ home, registryPath });
  const password = 'Parked-progress-password-123';
  await auth.bootstrap('owner', password);
  const owner = await auth.login('owner', password);
  const invite = auth.createInvite(owner.token, { projectIds: ['alpha'], maxUses: 3, expiresInHours: 1 });
  const sessions = [];
  for (const username of ['assigned', 'collaborator', 'unrelated']) {
    sessions.push(await auth.register({ inviteToken: invite.token, username, password }));
  }
  const [assigned, collaborator, unrelated] = sessions;
  const board = emptyBoard({ id: 'alpha', name: 'Alpha' });
  board.tasks = [{ id: 'PARKED', title: '暂缓任务', status: '暂缓', percent: 40, wave: 0,
    builder: '派单器', assigneeUserId: assigned.user.id, blockReason: '等待资料',
    collaborators: [{ userId: collaborator.user.id, name: collaborator.user.displayName, joinedAt: new Date().toISOString() }] }];
  fs.writeFileSync(file, JSON.stringify(board));
  const call = (session, percent) => taskOperation('progress', { sessionToken: session.token,
    actorId: session.user.id, projectId: 'alpha', taskId: 'PARKED', percent }, auth);
  for (const session of [collaborator, assigned, owner]) {
    assert.equal(call(session, 60).ok, true);
    const current = JSON.parse(fs.readFileSync(file));
    assert.equal(current.tasks[0].percent, 60);
    assert.equal(current.tasks[0].status, '暂缓');
    assert.equal(current.tasks[0].blockReason, '等待资料');
    assert.equal(current.activity.at(-1).type, 'collaboration:progress');
    assert.equal(current.activity.at(-1).percent, 60);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => call(session, 100), { status: 409, message: '暂缓的卡进度最多 99%' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => call(unrelated, 60), { status: 409 });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(call(collaborator, 99).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file)).tasks[0].percent, 99);
});

test('CLI park caps only completed progress; progress rejects 100 without writing; done still completes', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'parked-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registryPath = path.join(home, 'registry.json'), file = path.join(home, 'board.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { mainRepo: home, board: file } } }));
  const board = emptyBoard({ id: 'alpha', name: 'Alpha' });
  board.tasks = [['FULL', 100], ['PART', 40], ['ACTIVE', 40]].map(([id, percent]) =>
    ({ id, title: id, status: '施工中', percent, wave: 0 }));
  fs.writeFileSync(file, JSON.stringify(board));
  const cli = (...args) => execFileSync(process.execPath, [path.resolve(__dirname, '../cli/index.cjs'), ...args,
    '--project', 'alpha', '--json'], { windowsHide: true, timeout: 20000, encoding: 'utf8',
    cwd: home, env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: registryPath } });
  const read = () => JSON.parse(fs.readFileSync(file));
  const task = id => read().tasks.find(t => t.id === id);
  for (const [id, expected] of [['FULL', 99], ['PART', 40]]) {
    cli('park', id, '--reason', '等待资料');
    assert.equal(task(id).status, '暂缓');
    assert.equal(task(id).percent, expected);
    assert.equal(task(id).blockReason, '等待资料');
    assert.equal(read().activity.at(-1).type, 'park');
  }
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => cli('progress', 'FULL', '--percent', '100', '--next', '不能落盘'), error => {
    assert.notEqual(error.status, 0);
    assert.match(String(error.stderr) + String(error.stdout), /暂缓的卡进度最多 99%,要完工先复工/);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  cli('progress', 'FULL', '--percent', '80');
  assert.equal(task('FULL').percent, 80);
  assert.equal(task('FULL').status, '暂缓');
  assert.equal(task('FULL').blockReason, '等待资料');
  assert.equal(read().activity.at(-1).type, 'progress');
  cli('progress', 'ACTIVE', '--percent', '100');
  assert.equal(task('ACTIVE').percent, 100);
  assert.equal(task('ACTIVE').status, '施工中');
  cli('unpark', 'FULL', '--reason', '资料齐全');
  cli('cost', 'FULL', '--agents', 'test:1', '--unknown', '隔离测试夹具，没有实际施工开销');
  cli('done', 'FULL');
  assert.equal(task('FULL').status, '已完工');
  assert.equal(task('FULL').percent, 100);
});
