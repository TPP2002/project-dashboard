'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork, execFile, spawnSync } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const { applyOp } = require('../core/syncReplay.cjs');
const CLI = path.resolve(__dirname, '../cli/collaboration.cjs');
const INDEX = path.resolve(__dirname, '../cli/index.cjs');
const SERVER = path.resolve(__dirname, '../server/server.cjs');
const ORIGIN = 'http://127.0.0.1:47123';
const PASSWORD = 'Sync-test-password';
function start(home, mode = 'collaboration') {
  const child = fork(SERVER, [], { silent: true, windowsHide: true, env: { ...process.env,
    DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json'), DASHBOARD_MODE: mode,
    DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1',
    DASHBOARD_POLL_MS: '100', DASHBOARD_EVENT_WEBHOOK: '',
  } });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out: ' + output)); }, 15000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output)); });
    child.on('message', msg => { if (msg.type === 'dashboard-ready') { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${msg.port}`, output: () => output }); } });
  });
}
async function stop(srv) {
  if (srv && srv.child.exitCode === null) await new Promise(resolve => { srv.child.once('exit', resolve); srv.child.kill(); });
}
function cli(home, command, payload, args = []) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, command, ...args], { windowsHide: true, timeout: 60000,
      env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json') },
    }, (err, stdout, stderr) => {
      try { resolve({ ...JSON.parse(stdout), stderr, code: err?.code || 0 }); } catch { reject(new Error('Invalid CLI output')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(payload ? JSON.stringify(payload) : '');
  });
}
test('cloud claim ownership guard through the real service', { timeout: 120000 }, async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-claim-guard-')));
  let srv;
  t.after(async () => { await stop(srv); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const registryPath = path.join(home, 'registry.json'), boardFile = path.join(home, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(emptyBoard({ id: 'alpha', name: 'Alpha' })));
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { name: 'Alpha', mainRepo: home, board: boardFile } } }));
  const auth = createAuth({ home, registryPath });
  await auth.bootstrap('owner', PASSWORD);
  const owner = await auth.login('owner', PASSWORD, 'guard-owner');
  const invite = auth.createInvite(owner.token, { role: 'member', projectIds: ['alpha'], maxUses: 1, expiresInHours: 1 });
  const member = await auth.register({ inviteToken: invite.token, username: 'member', displayName: '小王', password: PASSWORD });
  const tokenFile = path.join(home, 'device-token');
  const created = await cli(home, 'create-device', null, ['--username', 'owner', '--label', 'guard-device', '--token-file', tokenFile]);
  assert.equal(created.ok, true); assert.equal(created.code, 0, created.stderr);
  srv = await start(home);
  async function request(route, session, data) {
    const response = await fetch(srv.base + route, { method: 'POST', headers: {
      Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Dashboard-Request': '1',
      ...(session ? { Cookie: 'dashboard_session=' + session.token, 'X-Dashboard-CSRF': session.csrfToken } : {}),
    }, body: JSON.stringify(data) });
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    return { body: JSON.parse(raw), headers: response.headers };
  }
  const login = await request('/api/auth/device-login', null, { token: fs.readFileSync(tokenFile, 'utf8').trim() });
  const device = { token: login.headers.get('set-cookie').match(/^dashboard_session=([^;]+)/)[1], csrfToken: login.body.csrfToken };
  let seq = 0;
  const op = (command, flags) => ({ v: 1, kind: 'op', opId: crypto.randomUUID(), seq: ++seq,
    project: 'local', remoteProjectId: 'alpha', command, flags, files: {}, author: 'test-ai',
    clientTs: '2026-10-20T00:00:00.000Z', device: '电脑甲' });
  const send = async ops => (await request('/api/sync/projects/alpha/ops', device, { ackSeq: 0, ops })).body.results;
  const add = id => op('add', { _: [id], title: 'Claim guard task', 'plain-title': '认领保护测试', model: 'test' });
  const claim = (id, branch) => op('claim', { _: [id], branch, builder: '派单器' });
  const memberOp = (id, action, session = member, data = {}) =>
    request(`/api/collaboration/projects/alpha/tasks/${id}/${action}`, session, data);
  const read = () => JSON.parse(fs.readFileSync(boardFile, 'utf8'));
  const task = id => read().tasks.find(x => x.id === id);
  async function seedMember(id) {
    assert.equal((await send([add(id)]))[0].status, 'applied');
    await memberOp(id, 'claim');
    assert.equal(task(id).assigneeUserId, member.user.id);
    assert.equal(task(id).assigneeName, '小王');
  }
  await t.test('① member claim rejects device claim without changing any board bytes or activity', async () => {
    await seedMember('X');
    const before = fs.readFileSync(boardFile), beforeBoard = read(), beforeTask = task('X');
    const item = claim('X', 'b1');
    const [receipt] = await send([item]);
    assert.equal(receipt.status, 'rejected');
    assert.equal(receipt.httpStatus, 409);
    assert.equal(receipt.error, '这张卡已被成员 小王 认领(主负责人),云端退回本次认领;要一起干请在网页上改用「加入协作」,或请对方先放弃认领');
    assert.deepEqual(task('X'), beforeTask);
    for (const key of ['assigneeUserId', 'assigneeName', 'builder', 'gitBranch', 'status', 'lastProgressAt']) {
      assert.deepEqual(task('X')[key], beforeTask[key], key);
    }
    assert.equal(read().activity.length, beforeBoard.activity.length);
    assert.deepEqual(fs.readFileSync(boardFile), before);
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'sync-ledger', 'alpha.json'))).receipts[item.opId];
    for (const key of ['status', 'httpStatus', 'error', 'seq']) assert.equal(saved[key], receipt[key]);
  });
  await t.test('② rejected receipt is idempotent and a following note in the same batch applies', async () => {
    await seedMember('RETRY');
    const item = claim('RETRY', 'b1'), before = fs.readFileSync(boardFile);
    const [first] = await send([item]);
    assert.equal(first.status, 'rejected'); assert.equal(first.httpStatus, 409);
    assert.deepEqual(fs.readFileSync(boardFile), before);
    assert.deepEqual((await send([item]))[0], first);
    assert.deepEqual(fs.readFileSync(boardFile), before);
    const note = op('note', { _: ['RETRY'], text: '认领退回后仍可留言' });
    const results = await send([item, note]);
    assert.deepEqual(results[0], first);
    assert.equal(results[1].status, 'applied');
    assert.equal(read().activity.filter(a => a.opId === note.opId).length, 1);
    const freshNote = op('note', { _: ['RETRY'], text: '新拒绝也不阻断后续' });
    assert.deepEqual((await send([claim('RETRY', 'blocked'), freshNote])).map(r => r.status), ['rejected', 'applied']);
  });
  await t.test('③ owner device claims a newly added unassigned task', async () => {
    assert.equal((await send([add('NEW')]))[0].status, 'applied');
    assert.equal(task('NEW').assigneeUserId, undefined);
    assert.equal((await send([claim('NEW', 'new-branch')]))[0].status, 'applied');
    assert.equal(task('NEW').builder, '派单器');
    assert.ok(task('NEW').gitBranch.includes('new-branch'));
  });
  await t.test('④ owner human claim allows the owner device claim', async () => {
    assert.equal((await send([add('Y')]))[0].status, 'applied');
    await memberOp('Y', 'claim', owner);
    assert.equal(task('Y').assigneeUserId, owner.user.id);
    assert.equal((await send([claim('Y', 'b2')]))[0].status, 'applied');
    assert.ok(task('Y').gitBranch.includes('b2'));
    assert.equal(task('Y').builder, '派单器');
    assert.equal(task('Y').assigneeUserId, owner.user.id);
  });
  await t.test('⑤ member unclaim permits a subsequent owner device claim', async () => {
    await seedMember('RELEASED');
    await memberOp('RELEASED', 'unclaim', member, { reason: '交回任务' });
    assert.equal(Object.hasOwn(task('RELEASED'), 'assigneeUserId'), false);
    assert.equal((await send([claim('RELEASED', 'released-branch')]))[0].status, 'applied');
    assert.ok(task('RELEASED').gitBranch.includes('released-branch'));
  });
});

test('⑥ local CLI and replay without actor keep legacy claim behavior', t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'local-claim-guard-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const registryPath = path.join(home, 'registry.json'), boardFile = path.join(home, 'board.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { local: { mainRepo: home, board: boardFile } } }));
  const board = emptyBoard({ id: 'local', name: 'Local' });
  board.tasks.push({ id: 'LOCAL', title: 'Legacy card', status: '施工中', percent: 0, wave: 0,
    assigneeUserId: 'u-other', assigneeName: '其他成员', builder: '自干:例外①', gitBranch: ['old-branch'] });
  const seed = () => fs.writeFileSync(boardFile, JSON.stringify(board));
  const readTask = () => JSON.parse(fs.readFileSync(boardFile)).tasks[0];
  const check = () => {
    assert.equal(readTask().builder, '派单器');
    assert.deepEqual(readTask().gitBranch, ['old-branch', 'local-new']);
    assert.equal(readTask().assigneeUserId, 'u-other');
  };
  seed();
  const result = spawnSync(process.execPath, [INDEX, 'claim', 'LOCAL', '--branch', 'local-new',
    '--builder', '派单器', '--registry', registryPath, '--project', 'local'], {
    windowsHide: true, encoding: 'utf8', timeout: 30000, cwd: home,
    env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: registryPath, CLAUDE_CODE_SESSION_ID: '' },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  check();
  seed();
  const operation = { kind: 'op', command: 'claim', flags: { _: ['LOCAL'], branch: 'local-new', builder: '派单器' }, files: {} };
  assert.equal(applyOp(operation, { registryPath, projectId: 'local' }).ok, true);
  check();
  for (const actorUserId of ['', '   ', null, false, 1, {}, []]) {
    const before = fs.readFileSync(boardFile);
    assert.throws(() => applyOp(operation, { registryPath, projectId: 'local', actorUserId }), { status: 400 });
    assert.deepEqual(fs.readFileSync(boardFile), before);
  }
});
