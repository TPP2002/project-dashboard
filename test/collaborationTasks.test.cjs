'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const PASSWORD = 'A-real-password-12345';
const CLI = path.resolve(__dirname, '../cli/collaboration.cjs');
function cli(home, command, payload, args = []) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, command, ...args], {
      env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json') }, windowsHide: true, timeout: 20000,
    }, (err, stdout, stderr) => {
      try { resolve({ code: err ? err.code : 0, ...JSON.parse(stdout), stderr }); } catch { reject(new Error(stderr || stdout || String(err))); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(payload ? JSON.stringify(payload) : '');
  });
}
test('real CLI validates identity and serializes member task ownership', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-tasks-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registryPath = path.join(home, 'registry.json');
  const boardFile = path.join(home, 'board.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { mainRepo: home, board: boardFile }, beta: { mainRepo: home, board: boardFile } } }));
  const board = emptyBoard({ id: 'alpha', name: 'Alpha' });
  board.tasks = ['ONE', 'RACE', 'AI', 'DONE', 'VOID', 'PENDING'].map(id => ({ id, title: id, wave: 1, status: '待开工', percent: 0 }));
  Object.assign(board.tasks[2], { status: '施工中', builder: '派单器', gitBranch: ['ai-work'] });
  board.tasks[3].status = '已完工'; board.tasks[4].status = '已作废'; board.tasks[5].status = '待拍板';
  fs.writeFileSync(boardFile, JSON.stringify(board));
  const auth = createAuth({ home, registryPath });
  const passFile = path.join(home, 'password'); fs.writeFileSync(passFile, PASSWORD + '\n', { mode: 0o600 });
  await t.test('bootstrap CLI reads a protected password file and refuses password argv/re-bootstrap', async () => {
    assert.equal((await cli(home, 'init-owner', null, ['--username', 'owner', '--password-file', passFile])).ok, true);
    assert.equal((await cli(home, 'init-owner', null, ['--username', 'owner', '--password-file', passFile])).status, 409);
    const bad = await cli(home, 'init-owner', null, ['--username', 'owner', '--password', PASSWORD]);
    assert.equal(bad.status, 400); assert.equal(JSON.stringify(bad).includes(PASSWORD), false);
  });
  const owner = await auth.login('owner', PASSWORD, 'task-owner');
  const invite = auth.createInvite(owner.token, { projectIds: ['alpha'], expiresInHours: 1, maxUses: 2 });
  const a = await auth.register({ inviteToken: invite.token, username: 'member-a', password: PASSWORD }, 'task-a');
  const b = await auth.register({ inviteToken: invite.token, username: 'member-b', password: PASSWORD }, 'task-b');
  const payload = (session, taskId, more = {}) => ({ sessionToken: session.token, actorId: session.user.id, projectId: 'alpha', taskId, ...more });
  const read = () => JSON.parse(fs.readFileSync(boardFile));
  await t.test('unverified actor, token, cross-project and injected IDs never write', async () => {
    const before = fs.readFileSync(boardFile, 'utf8');
    assert.equal((await cli(home, 'claim', payload(a, 'ONE', { actorId: owner.user.id }))).status, 403);
    assert.equal((await cli(home, 'claim', payload(a, 'ONE', { sessionToken: 'invalid' }))).status, 401);
    assert.equal((await cli(home, 'claim', payload(a, 'ONE', { projectId: 'beta' }))).status, 404);
    assert.equal((await cli(home, 'claim', payload(a, '../ONE'))).status, 400);
    assert.equal((await cli(home, 'claim', payload(a, 'ONE', { userId: owner.user.id }))).status, 400);
    assert.equal(fs.readFileSync(boardFile, 'utf8'), before);
  });
  await t.test('claim persists human assignee and real user audit without inventing builder', async () => {
    const result = await cli(home, 'claim', payload(a, 'ONE'));
    assert.equal(result.ok, true);
    const current = read(); const task = current.tasks.find(t => t.id === 'ONE');
    assert.equal(task.assigneeUserId, a.user.id); assert.equal(task.assigneeName, a.user.displayName);
    assert.equal(Object.hasOwn(task, 'builder'), false);
    assert.equal(current.activity.at(-1).userId, a.user.id);
    assert.equal((await cli(home, 'claim', payload(a, 'ONE'))).status, 409);
  });
  await t.test('only one of two separate CLI processes wins a concurrent claim', async () => {
    const results = await Promise.all([cli(home, 'claim', payload(a, 'RACE')), cli(home, 'claim', payload(b, 'RACE'))]);
    assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok).status, 409);
    assert.equal(read().activity.filter(a => a.taskId === 'RACE').length, 1);
  });
  await t.test('AI work, terminal cards and unresolved approval cards cannot be claimed', async () => {
    for (const id of ['AI', 'DONE', 'VOID', 'PENDING']) assert.equal((await cli(home, 'claim', payload(a, id))).status, 409);
    assert.equal(read().tasks.find(t => t.id === 'AI').builder, '派单器');
  });
  await t.test('progress accepts only the owner, validates fields, and never approves/dones at 100', async () => {
    assert.equal((await cli(home, 'progress', payload(b, 'ONE', { percent: 25 }))).status, 409);
    assert.equal((await cli(home, 'progress', payload(a, 'ONE', { percent: 101 }))).status, 400);
    assert.equal((await cli(home, 'progress', payload(a, 'ONE', { percent: 100, note: 'ready for review' }))).ok, true);
    const task = read().tasks.find(t => t.id === 'ONE');
    assert.equal(task.percent, 100); assert.equal(task.status, '施工中'); assert.equal(task.dates.done, undefined);
    assert.equal(task.nextMilestone, 'ready for review'); assert.equal(task.builder, undefined);
  });
  await t.test('revoked project access applies in a fresh CLI process before any board mutation', async () => {
    auth.access(owner.token, a.user.id, { projectIds: [], disabled: false });
    const before = fs.readFileSync(boardFile, 'utf8');
    assert.equal((await cli(home, 'progress', payload(a, 'ONE', { percent: 50 }))).status, 404);
    assert.equal(fs.readFileSync(boardFile, 'utf8'), before);
    const task = read().tasks.find(t => t.id === 'ONE'); assert.equal(task.assigneeUserId, a.user.id); assert.equal(task.percent, 100);
  });
});
