'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const { memberActions } = require('../core/collaborationRules.cjs');
const { taskTransition } = require('../cli/commands.cjs');
const CLI = path.resolve(__dirname, '../cli/collaboration.cjs');
const PASSWORD = 'Member-ops-password-12345';
function cli(home, command, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, command], { windowsHide: true, timeout: 20000,
      env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json') } }, (err, stdout, stderr) => {
      try { resolve({ code: err ? err.code : 0, ...JSON.parse(stdout) }); } catch { reject(new Error(stderr || stdout || String(err))); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(payload));
  });
}
test('member operations authorize and mutate in real CLI children', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-member-ops-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registryPath = path.join(home, 'registry.json'); const file = path.join(home, 'alpha.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { mainRepo: home, board: file }, beta: { mainRepo: home, board: path.join(home, 'beta.json') } } }));
  fs.writeFileSync(file, JSON.stringify(emptyBoard({ id: 'alpha', name: 'Alpha' })));
  fs.writeFileSync(path.join(home, 'beta.json'), JSON.stringify(emptyBoard({ id: 'beta', name: 'Beta' })));
  const auth = createAuth({ home, registryPath }); await auth.bootstrap('owner', PASSWORD);
  const owner = await auth.login('owner', PASSWORD);
  const join = async (username, role = 'member') => {
    const invite = auth.createInvite(owner.token, { projectIds: ['alpha'], expiresInHours: 1, maxUses: 1, role });
    return auth.register({ inviteToken: invite.token, username, displayName: username + ' display', password: PASSWORD });
  };
  const a = await join('member-a'); const b = await join('member-b'); const viewer = await join('viewer', 'viewer');
  const read = () => JSON.parse(fs.readFileSync(file));
  const seed = (id, more = {}) => {
    const board = read(); const task = { id, title: id, status: '施工中', wave: 0, percent: 25, assigneeUserId: a.user.id, assigneeName: a.user.displayName, ...more };
    board.tasks = board.tasks.filter(t => t.id !== id); board.tasks.push(task); fs.writeFileSync(file, JSON.stringify(board)); return task;
  };
  const payload = (session, taskId, data = {}) => ({ sessionToken: session.token, actorId: session.user.id, projectId: 'alpha', ...(taskId ? { taskId } : {}), ...data });
  const call = (command, session, id, data = {}) => cli(home, command, payload(session, id, data));
  const unchanged = async (command, session, id, data, status) => {
    const before = fs.readFileSync(file, 'utf8'); const r = await call(command, session, id, data);
    assert.equal(r.status, status, command + ': ' + JSON.stringify(r)); assert.equal(fs.readFileSync(file, 'utf8'), before);
  };
  await t.test('create generates unique IDs, fixes state/creator, and rejects fields and cross-project writes', async () => {
    const result = await call('create', a, null, { title: 'New task', plainTitle: 'Readable task', description: 'details' });
    assert.equal(result.ok, true); assert.match(result.task.id, /^M\d{8}-[A-Z0-9]{6}$/);
    assert.equal(result.task.status, '未开工'); assert.equal(result.task.createdByUserId, a.user.id);
    const stored = read().tasks.find(t => t.id === result.task.id);
    assert.equal(stored.title, 'New task'); assert.equal(stored.plainTitle, 'Readable task'); assert.equal(stored.description, 'details');
    for (const field of ['builder', 'status', 'assigneeUserId', 'createdByUserId', 'gitBranch', 'prNumbers', 'commitShas', 'wave', 'taskId']) {
      await unchanged('create', a, null, { title: 'bad', [field]: 'injected' }, 400);
    }
    for (const data of [{}, { title: '' }, { title: 'x'.repeat(201) }, { title: 'ok', plainTitle: 'x'.repeat(201) }, { title: 'ok', description: 'x'.repeat(4001) }]) await unchanged('create', a, null, data, 400);
    await unchanged('create', a, null, { title: 'cross', projectId: 'beta' }, 404);
    const concurrent = await Promise.all([a, b].map(s => call('create', s, null, { title: 'Concurrent' })));
    assert.ok(concurrent.every(r => r.ok)); assert.equal(new Set(concurrent.map(r => r.task.id)).size, 2);
  });
  await t.test('notes on any granted card carry kind/message and user identity, without changing task', async () => {
    for (const [id, fields] of [['OTHER', { assigneeUserId: b.user.id }], ['AI-NOTE', { builder: '派单器', gitBranch: ['private-branch'] }], ['CLOSED-NOTE', { status: '已完工' }]]) {
      const task = seed(id, fields);
      const r = await call('note', a, id, { text: 'Hello C:\\path\\to\\private-file' }); assert.equal(r.ok, true);
      assert.deepEqual(read().tasks.find(t => t.id === id), task);
      assert.deepEqual(Object.keys(r.task.messages[0]).sort(), ['author', 'text', 'ts', 'userId']);
      assert.equal(r.task.messages[0].text, 'Hello [private path]');
      const activity = read().activity.at(-1);
      assert.equal(activity.type, 'note'); assert.equal(activity.kind, 'message'); assert.equal(activity.userId, a.user.id); assert.equal(activity.author, a.user.displayName);
    }
    for (const text of ['', ' ', 'x'.repeat(2001)]) await unchanged('note', a, 'OTHER', { text }, 400);
    await unchanged('note', a, 'OTHER', { text: 'hello', projectId: 'beta' }, 404);
  });
  const operations = [
    ['unclaim', '施工中', '待开工', '未开工'], ['park', '施工中', '暂缓', '已完工'], ['unpark', '暂缓', '可复工', '施工中'],
    ['done', '施工中', '已完工', '已完工'], ['cancel', '施工中', '已作废', '已作废'], ['reopen', '已完工', '待开工', '施工中'],
  ];
  for (const [command, initial, expected, invalid] of operations) {
    await t.test(command + ': own allowed, other/AI/invalid/project denied, owner allowed, audit preserved', async () => {
      const data = command === 'done' ? {} : { reason: 'reason for ' + command };
      seed('OWN', { status: initial });
      const r = await call(command, a, 'OWN', data); assert.equal(r.ok, true, JSON.stringify(r));
      const task = read().tasks.find(t => t.id === 'OWN'); assert.equal(task.status, expected);
      assert.equal(read().activity.at(-1).type, command); assert.equal(read().activity.at(-1).userId, a.user.id); assert.equal(read().activity.at(-1).author, a.user.displayName);
      for (const k of ['builder', 'gitBranch', 'prNumbers', 'commitShas', 'worktree', 'sessionId']) assert.equal(Object.hasOwn(task, k), false, k);
      if (command === 'unclaim') { assert.equal(task.assigneeUserId, undefined); assert.equal(task.assigneeName, undefined); assert.equal(task.percent, 25); }
      if (command === 'done') { assert.equal(task.percent, 100); assert.match(task.dates.done, /^\d{4}-\d{2}-\d{2}$/); }
      seed('OTHER-OP', { status: initial, assigneeUserId: b.user.id, createdByUserId: b.user.id });
      await unchanged(command, a, 'OTHER-OP', data, 409);
      seed('INVALID', { status: invalid }); await unchanged(command, a, 'INVALID', data, 409);
      seed('CROSS', { status: initial }); await unchanged(command, a, 'CROSS', { ...data, projectId: 'beta' }, 404);
      for (const metadata of [{ builder: '派单器' }, { gitBranch: ['private'] }, { prNumbers: [42] }, { commitShas: ['abcdef1'] }]) {
        seed('AI-OP', { status: initial, ...metadata }); await unchanged(command, a, 'AI-OP', data, 409);
      }
      if (command !== 'done') for (const reason of ['', ' ', 'x'.repeat(501)]) await unchanged(command, a, 'CROSS', { reason }, 400);
      seed('OWNER-OP', { status: initial, assigneeUserId: b.user.id, builder: '派单器' });
      assert.equal((await call(command, owner, 'OWNER-OP', data)).ok, true);
    });
  }
  await t.test('pending decisions block done and cancel even for owner; creators may cancel/reopen unassigned cards', async () => {
    seed('PENDING', { decisions: [{ id: 'd1', question: 'Choose', options: ['yes'], recommended: 'yes', answer: null }] });
    for (const s of [a, owner]) for (const command of ['done', 'cancel']) await unchanged(command, s, 'PENDING', command === 'done' ? {} : { reason: 'stop' }, 409);
    seed('CREATED', { status: '未开工', assigneeUserId: undefined, assigneeName: undefined, createdByUserId: a.user.id });
    assert.equal((await call('cancel', a, 'CREATED', { reason: 'unneeded' })).ok, true);
    assert.equal((await call('reopen', a, 'CREATED', { reason: 'needed again' })).ok, true);
    seed('AI-CLAIM', { status: '未开工', assigneeUserId: undefined, gitBranch: ['ai'] });
    await unchanged('claim', a, 'AI-CLAIM', {}, 409);
    seed('AI-PROGRESS', { builder: '派单器' }); await unchanged('progress', a, 'AI-PROGRESS', { percent: 30 }, 409);
  });
  await t.test('viewer denied every write with board bytes unchanged; role change and grant revocation reach CLI', async () => {
    seed('VIEWER');
    const commands = { create: { title: 'No' }, note: { text: 'No' }, claim: {}, progress: { percent: 1 }, unclaim: { reason: 'No' }, park: { reason: 'No' }, unpark: { reason: 'No' }, done: {}, cancel: { reason: 'No' }, reopen: { reason: 'No' } };
    for (const [command, data] of Object.entries(commands)) await unchanged(command, viewer, command === 'create' ? null : 'VIEWER', data, 403);
    auth.access(owner.token, a.user.id, { projectIds: ['alpha'], disabled: false, role: 'viewer' });
    await unchanged('note', a, 'VIEWER', { text: 'role changed' }, 403);
    auth.access(owner.token, a.user.id, { projectIds: [], disabled: false, role: 'member' });
    await unchanged('note', a, 'VIEWER', { text: 'revoked' }, 404);
    auth.access(owner.token, a.user.id, { projectIds: ['alpha'], disabled: false, role: 'member' });
  });
  await t.test('two members racing to finish one task produce exactly one successful write', async () => {
    seed('RACE', { createdByUserId: b.user.id });
    const before = read().activity.length;
    const results = await Promise.all([a, b].map(s => call('done', s, 'RACE')));
    assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok).status, 409);
    assert.equal(read().activity.length, before + 1); assert.equal(read().tasks.find(t => t.id === 'RACE').status, '已完工');
    seed('SAME-USER');
    const same = await Promise.all([1, 2].map(() => call('done', a, 'SAME-USER')));
    assert.equal(same.filter(r => r.ok).length, 1); assert.equal(same.find(r => !r.ok).status, 409);
  });
  await t.test('shared transition is pure and presentation actions agree with CLI constraints', () => {
    const task = { id: 'PURE', status: '施工中', percent: 10, assigneeUserId: a.user.id, nextMilestone: 'finish' };
    const original = structuredClone(task);
    const done = taskTransition(task, 'done', { date: '2026-10-19', now: '2026-10-19T00:00:00.000Z' });
    assert.deepEqual(task, original); assert.equal(done.task.nextMilestone, undefined);
    assert.ok(memberActions(task, a.user).includes('done')); assert.equal(memberActions(done.task, a.user).includes('done'), false);
    assert.deepEqual(memberActions(task, viewer.user), []);
    assert.deepEqual(memberActions({ ...task, builder: '派单器' }, a.user), ['note']);
  });
});
