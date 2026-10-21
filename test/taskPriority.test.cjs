'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { emptyBoard, validate } = require('../core/boardSchema.cjs');
const { PRIORITIES, LABELS, normalizePriority, rank } = require('../core/taskPriority.cjs');
const { memberActions, toEsmSource } = require('../core/collaborationRules.cjs');
const { taskView } = require('../core/collaborationPublic.cjs');
const { applyOp } = require('../core/syncReplay.cjs');
const { createAuth } = require('../core/collaborationAuth.cjs');
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'http://127.0.0.1:47123';
const PASSWORD = 'Priority-test-password';

function fixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'task-priority-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const registry = path.join(home, 'registry.json'), file = path.join(home, 'board.json');
  fs.writeFileSync(registry, JSON.stringify({ projects: { alpha: { mainRepo: home, board: file }, beta: { mainRepo: home, board: path.join(home, 'beta.json') } } }));
  const board = emptyBoard({ id: 'alpha', name: '优先级测试', mainRepo: home });
  board.tasks = [{ id: 'T1', title: '任务', status: '施工中', percent: 0, wave: 0 },
    { id: 'AI', title: '派单任务', status: '施工中', builder: '派单器', percent: 0, wave: 0 },
    { id: 'DONE', title: '已完成', status: '已完工', percent: 100, wave: 0 },
    { id: 'VOID', title: '已作废', status: '已作废', percent: 0, wave: 0 }];
  fs.writeFileSync(file, JSON.stringify(board));
  fs.writeFileSync(path.join(home, 'beta.json'), JSON.stringify(emptyBoard({ id: 'beta', name: '其他项目' })));
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const cli = args => spawnSync(process.execPath, [path.join(ROOT, 'cli/index.cjs'), ...args, '--project', 'alpha', '--registry', registry, '--json'],
    { cwd: home, windowsHide: true, encoding: 'utf8', timeout: 30000, env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: registry } });
  return { home, registry, file, read, cli };
}

test('priority schema, normalization and shared generated rules', async () => {
  const board = emptyBoard({ id: 'alpha', name: 'test' });
  const task = { id: 'T1', title: '任务', status: '施工中', percent: 0, wave: 0 };
  for (const priority of [...PRIORITIES, undefined]) {
    board.tasks = [{ ...task, ...(priority === undefined ? {} : { priority }) }];
    assert.equal(validate(board).ok, true, String(priority));
  }
  for (const priority of ['bad', '高', '', null, 2, {}, []]) {
    board.tasks = [{ ...task, priority }];
    assert.equal(validate(board).ok, false, JSON.stringify(priority));
    assert.ok(validate(board).errors.some(message => message.includes('priority')));
  }
  for (const p of PRIORITIES) { assert.equal(normalizePriority(p), p); assert.equal(normalizePriority(LABELS[p]), p); }
  assert.equal(normalizePriority('bad'), null); assert.equal(rank({}), 2);
  const generated = await import('data:text/javascript,' + encodeURIComponent(toEsmSource()));
  for (const role of ['owner', 'member', 'viewer']) for (const status of ['施工中', '已完工', '已作废']) {
    const input = { ...task, status, builder: '派单器' }, user = { id: 'u', role };
    const expected = role !== 'viewer' && status === '施工中';
    assert.equal(memberActions(input, user).includes('priority'), expected);
    assert.deepEqual(generated.memberActions(input, user), memberActions(input, user));
  }
  assert.equal(taskView({ ...task, priority: 'urgent' }, { id: 'v', role: 'viewer' }).priority, 'urgent');
});

test('CLI add/batch/edit preserve priority, reject invalid values atomically and record exact changes', t => {
  const f = fixture(t);
  const added = f.cli(['add', 'NEW', '--title', '测试', '--plain-title', '任务优先级', '--model', '负责人本人办', '--priority', '高']);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(f.read().tasks.find(task => task.id === 'NEW').priority, 'high');
  const batch = path.join(f.home, 'batch.json');
  fs.writeFileSync(batch, JSON.stringify([{ id: 'BATCH', title: '测试', plainTitle: '批量任务', model: '负责人本人办', priority: '低' }]));
  const result = f.cli(['add', '--json-file', batch]); assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read().tasks.find(task => task.id === 'BATCH').priority, 'low');
  const count = f.read().activity.length;
  assert.equal(f.cli(['edit', 'T1', '--priority', '高']).status, 0);
  assert.equal(f.read().tasks[0].priority, 'high');
  assert.equal(f.read().activity.length, count + 1);
  assert.equal(f.read().activity.at(-1).text, '优先级 中 → 高');
  const same = f.cli(['edit', 'T1', '--priority', 'high']); assert.equal(same.status, 0, same.stderr);
  assert.deepEqual(JSON.parse(same.stdout).changed, []); assert.equal(f.read().activity.length, count + 1);
  const defaultSame = f.cli(['edit', 'AI', '--priority', 'medium']);
  assert.deepEqual(JSON.parse(defaultSame.stdout).changed, []); assert.equal(f.read().activity.length, count + 1);
  for (const args of [
    ['edit', 'T1', '--priority', 'invalid'], ['edit', 'T1', '--priority'],
    ['add', 'BAD', '--title', 'bad', '--plain-title', 'bad', '--model', '负责人本人办', '--priority', 'invalid'],
  ]) {
    const before = fs.readFileSync(f.file, 'utf8');
    assert.notEqual(f.cli(args).status, 0); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  }
  fs.writeFileSync(batch, JSON.stringify([{ id: 'BAD-BATCH', title: '测试', plainTitle: '批量任务', model: '负责人本人办', priority: 'bad' }]));
  const before = fs.readFileSync(f.file, 'utf8');
  assert.notEqual(f.cli(['add', '--json-file', batch]).status, 0); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('sync replay retains add/edit priority flags without altering protocol', t => {
  const f = fixture(t);
  const replay = (command, flags) => applyOp({ kind: 'op', command, flags, files: {} }, { registryPath: f.registry, projectId: 'alpha' });
  replay('edit', { _: ['T1'], priority: '紧急' });
  assert.equal(f.read().tasks[0].priority, 'urgent');
  replay('add', { _: ['SYNC'], title: '同步', 'plain-title': '同步优先级', model: '负责人本人办', priority: 'optional' });
  assert.equal(f.read().tasks.find(task => task.id === 'SYNC').priority, 'optional');
});

test('recorded CLI operations reach cloud and cloud priority pulls back through the existing sync agent', async t => {
  const local = fixture(t), cloud = fixture(t);
  const registry = JSON.parse(fs.readFileSync(local.registry, 'utf8'));
  registry.projects.alpha.cloud = { enabled: true, remoteProjectId: 'alpha' };
  fs.writeFileSync(local.registry, JSON.stringify(registry));
  for (const args of [
    ['edit', 'T1', '--priority', 'high'],
    ['add', 'QUEUED', '--title', '同步任务', '--plain-title', '同步优先级', '--model', '负责人本人办', '--priority', 'urgent'],
  ]) { const result = local.cli(args); assert.equal(result.status, 0, result.stderr); }
  const { resolveProject } = require('../core/resolveProject.cjs');
  const { readOutbox } = require('../core/syncOutbox.cjs');
  const rows = readOutbox(resolveProject('alpha', { registryPath: local.registry }));
  assert.deepEqual(rows.map(row => [row.command, row.flags.priority]), [['edit', 'high'], ['add', 'urgent']]);
  const agent = require('../core/syncAgent.cjs').createSyncAgent({ registryPath: local.registry, client: {
    sendOps: async (projectId, ack, operations) => ({ results: operations.map(op => {
      applyOp(op, { registryPath: cloud.registry, projectId });
      return { opId: op.opId, seq: op.seq, status: 'applied' };
    }) }),
    snapshot: async () => ({ etag: 'priority-cloud', board: cloud.read() }),
  } });
  await agent.sendPending('alpha');
  assert.equal(cloud.read().tasks[0].priority, 'high');
  assert.equal(cloud.read().tasks.find(task => task.id === 'QUEUED').priority, 'urgent');
  require('../cli/commands.cjs').edit({ registry: cloud.registry, project: 'alpha', _: ['T1'], priority: 'optional' });
  await agent.pull('alpha');
  assert.equal(local.read().tasks[0].priority, 'optional');
  assert.equal(local.read().tasks.find(task => task.id === 'QUEUED').priority, 'urgent');
});

async function server(t, f, collaboration) {
  const child = fork(path.join(ROOT, 'server/server.cjs'), [], { silent: true, windowsHide: true, env: { ...process.env,
    DASHBOARD_HOME: f.home, DASHBOARD_REGISTRY: f.registry, DASHBOARD_MODE: collaboration ? 'collaboration' : 'local',
    DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1',
    DASHBOARD_NO_RESTART: '1', DASHBOARD_POLL_MS: '500', DASHBOARD_EVENT_WEBHOOK: '',
  } });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server startup timeout: ' + output)); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exit ' + code + ': ' + output)); });
    child.on('message', message => { if (message.type === 'dashboard-ready') { clearTimeout(timer); resolve(`http://127.0.0.1:${message.port}`); } });
  });
  return async (route, body, session) => {
    const headers = { 'content-type': 'application/json' };
    if (session) Object.assign(headers, { origin: ORIGIN, 'x-dashboard-request': '1', 'x-dashboard-csrf': session.csrfToken, cookie: 'dashboard_session=' + session.token });
    const response = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
}

test('local HTTP priority action persists and attributes the change to the owner', async t => {
  const f = fixture(t), post = await server(t, f, false);
  const result = await post('/api/task/alpha/T1/priority', { priority: 'high' });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.read().tasks[0].priority, 'high');
  assert.equal(f.read().activity.at(-1).author, '负责人');
  assert.equal(f.read().activity.at(-1).text, '优先级 中 → 高');
  for (const body of [{ priority: 'bad' }, {}, { priority: 'high', title: 'injected' }]) {
    const before = fs.readFileSync(f.file, 'utf8');
    assert.equal((await post('/api/task/alpha/T1/priority', body)).status, 400);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  }
});

test('collaboration HTTP uses fresh role/project/state checks and records old/new priorities', async t => {
  const f = fixture(t), auth = createAuth({ home: f.home, registryPath: f.registry });
  await auth.bootstrap('owner', PASSWORD);
  const owner = await auth.login('owner', PASSWORD);
  const join = async role => {
    const invite = auth.createInvite(owner.token, { projectIds: ['alpha'], expiresInHours: 1, maxUses: 1, role });
    return auth.register({ inviteToken: invite.token, username: role, password: PASSWORD });
  };
  const member = await join('member'), viewer = await join('viewer');
  const post = await server(t, f, true);
  const route = (id = 'T1', project = 'alpha') => `/api/collaboration/projects/${project}/tasks/${id}/priority`;
  for (const [session, priority] of [[owner, 'high'], [member, 'urgent']]) {
    const old = f.read().tasks[0].priority || 'medium';
    const result = await post(route(), { priority }, session); assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.task.priority, priority);
    const activity = f.read().activity.at(-1);
    assert.equal(activity.type, 'collaboration:priority'); assert.equal(activity.oldPriority, old); assert.equal(activity.newPriority, priority);
    assert.equal(activity.author, session.user.displayName); assert.equal(activity.userId, session.user.id);
    assert.equal(activity.text, `优先级 ${LABELS[old]} → ${LABELS[priority]}`);
  }
  assert.equal((await post(route('AI'), { priority: 'low' }, member)).status, 200);
  assert.equal((await post('/api/task/alpha/T1/priority', { priority: 'optional' }, owner)).status, 200);
  assert.equal(f.read().tasks[0].priority, 'optional');
  assert.equal(f.read().activity.at(-1).type, 'collaboration:priority');
  for (const [session, target, body, status] of [
    [viewer, route(), { priority: 'high' }, 403],
    [viewer, route('T1', 'beta'), { priority: 'high' }, 403],
    [member, route('T1', 'beta'), { priority: 'high' }, 404],
    [member, route('MISSING'), { priority: 'high' }, 404],
    [member, route('DONE'), { priority: 'high' }, 409],
    [owner, route('VOID'), { priority: 'high' }, 409],
    [member, route(), { priority: 'bad' }, 400],
    [member, route(), { priority: 'high', status: '已完工' }, 400],
    [owner, '/api/task/alpha/DONE/priority', { priority: 'high' }, 409],
  ]) {
    const before = fs.readFileSync(f.file, 'utf8');
    const result = await post(target, body, session); assert.equal(result.status, status, JSON.stringify(result));
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  }
});
