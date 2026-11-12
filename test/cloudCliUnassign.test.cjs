'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { emptyBoard, STATUS } = require('../core/boardSchema.cjs');
const { applyOp, REPLAY_COMMANDS } = require('../core/syncReplay.cjs');
const { resolveProject } = require('../core/resolveProject.cjs');
const { readOutbox } = require('../core/syncOutbox.cjs');
const { COMMANDS, GROUPS } = require('../cli/help.cjs');
const INDEX = path.resolve(__dirname, '../cli/index.cjs');
const actor = { actorUserId: 'u-owner', actorName: '项目经理' };

function fixture(t, extra = {}, cloud = false) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-unassign-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const registryPath = path.join(home, 'registry.json'), boardFile = path.join(home, 'board.json');
  const settings = path.join(home, 'settings.json');
  fs.writeFileSync(settings, '{}');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { local: { mainRepo: home, board: boardFile,
    ...(cloud ? { cloud: { enabled: true, remoteProjectId: 'remote' } } : {}) } } }));
  const board = emptyBoard({ id: 'local', name: 'Local', mainRepo: home });
  board.tasks.push({ id: 'T1', title: '撤下负责人', status: '待开工', percent: 37, wave: 0,
    dates: { design: '2026-01-01', start: '2026-01-02', done: null }, builder: '派单器',
    gitBranch: ['kept'], worktree: ['kept'], decisions: [],
    collaborators: [{ userId: 'u-mate', name: '小李', joinedAt: '2026-01-02T00:00:00Z' }],
    assigneeUserId: actor.actorUserId, assigneeName: '原名字',
    lastProgressAt: '2026-01-02T00:00:00Z', ...extra });
  fs.writeFileSync(boardFile, JSON.stringify(board));
  const read = () => JSON.parse(fs.readFileSync(boardFile, 'utf8'));
  const bytes = () => fs.readFileSync(boardFile);
  const proj = resolveProject('local', { registryPath });
  const replay = (flags = {}, who = actor) => applyOp({ kind: 'op', command: 'unassign',
    flags: { _: ['T1'], ...flags }, files: {} }, { registryPath, projectId: 'local', ...who });
  const cli = args => spawnSync(process.execPath, [INDEX, ...args, '--project', 'local', '--registry', registryPath], {
    cwd: home, windowsHide: true, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: registryPath,
      DASHBOARD_GLOBAL_SETTINGS: settings, CLAUDE_CODE_SESSION_ID: '' },
  });
  return { read, bytes, proj, replay, cli, registryPath };
}

for (const status of STATUS.filter(s => s !== '已作废')) {
  test(`①② replay unassign removes only the assignee keys in ${status}`, t => {
    const f = fixture(t, { status }, true), before = f.read();
    assert.equal(f.replay().ok, true);
    const after = f.read(), expected = { ...before.tasks[0] };
    delete expected.assigneeUserId;
    delete expected.assigneeName;
    assert.equal(Object.hasOwn(after.tasks[0], 'assigneeUserId'), false);
    assert.equal(Object.hasOwn(after.tasks[0], 'assigneeName'), false);
    assert.deepEqual(after.tasks[0], expected);
    assert.equal(after.activity.length, before.activity.length + 1);
    assert.equal(after.activity.at(-1).type, 'note');
    assert.equal(after.activity.at(-1).text, '项目经理 撤下 T1 的主负责人');
    assert.deepEqual(readOutbox(f.proj), [], 'replay must never re-enqueue');
  });
}

test('③ another assignee is refused by name or id with 409 and unchanged board bytes', t => {
  for (const assigneeName of ['小王', undefined]) {
    const f = fixture(t, { assigneeUserId: 'other', assigneeName }), before = f.bytes();
    assert.throws(() => f.replay(), { status: 409,
      message: `这张卡的主负责人是 ${assigneeName || 'other'},只有本人能撤下` });
    assert.deepEqual(f.bytes(), before);
  }
});

test('④ no assignee is successful and leaves the whole task unchanged', t => {
  const f = fixture(t, { assigneeUserId: undefined, assigneeName: undefined });
  const before = f.read().tasks[0];
  const result = f.replay();
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.changed, []);
  assert.deepEqual(f.read().tasks[0], before);
});

test('⑤ void replay is refused before removal, even without an assignee', t => {
  for (const assigneeUserId of [actor.actorUserId, undefined]) {
    const f = fixture(t, { status: '已作废', assigneeUserId }), before = f.bytes();
    assert.throws(() => f.replay(), { status: 409, message: '已作废的卡不能撤主负责人' });
    assert.deepEqual(f.bytes(), before);
  }
});

test('⑥ local non-cloud unassign refuses without writing', t => {
  const f = fixture(t), before = f.bytes();
  const result = f.cli(['unassign', 'T1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /只在云同步时生效/);
  assert.deepEqual(f.bytes(), before);
});

test('⑦ cloud CLI preserves local assignee, queues one request and replay removes it', t => {
  for (const author of ['施工方', undefined]) {
    const f = fixture(t, {}, true), before = f.read();
    const result = f.cli(['unassign', 'T1', ...(author ? ['--author', author] : [])]);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /已提交,云同步回放后生效/);
    assert.deepEqual(f.read().tasks, before.tasks);
    assert.equal(f.read().activity.length, before.activity.length + 1);
    assert.equal(f.read().activity.at(-1).type, 'note');
    assert.equal(f.read().activity.at(-1).text, `${author || 'cli'} 为 T1 已提交撤下主负责人请求,云端按操作人落地`);
    const queue = readOutbox(f.proj);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].command, 'unassign');
    assert.equal(queue[0].flags.author, author || 'cli');
    assert.equal(applyOp(queue[0], { registryPath: f.registryPath, projectId: 'local', ...actor }).ok, true);
    assert.equal(Object.hasOwn(f.read().tasks[0], 'assigneeUserId'), false);
    assert.equal(Object.hasOwn(f.read().tasks[0], 'assigneeName'), false);
    assert.deepEqual(readOutbox(f.proj), queue);
  }
});

test('local cloud submits another assignee for authenticated cloud validation', t => {
  const f = fixture(t, { assigneeUserId: 'other', assigneeName: '小王' }, true), before = f.read().tasks;
  const result = f.cli(['unassign', 'T1']);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(f.read().tasks, before);
  assert.equal(readOutbox(f.proj).length, 1);
  const bytes = f.bytes();
  assert.throws(() => f.replay(), { status: 409 });
  assert.deepEqual(f.bytes(), bytes);
});

test('local cloud rejects missing and void tasks without board writes or queued ops', t => {
  for (const [extra, id, message] of [[{}, 'MISSING', /不存在/],
    [{ status: '已作废' }, 'T1', /已作废的卡不能撤主负责人/]]) {
    const f = fixture(t, extra, true), before = f.bytes();
    const result = f.cli(['unassign', id]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.deepEqual(f.bytes(), before);
    assert.deepEqual(readOutbox(f.proj), []);
  }
});

test('missing replay task is 404; actor name falls back to id', t => {
  const f = fixture(t), before = f.bytes();
  assert.throws(() => f.replay({ _: ['MISSING'] }), { status: 404 });
  assert.deepEqual(f.bytes(), before);
  assert.equal(f.replay({}, { actorUserId: actor.actorUserId }).ok, true);
  assert.equal(f.read().activity.at(-1).text, `${actor.actorUserId} 撤下 T1 的主负责人`);
});

test('⑧ unassign is registered for replay', () => assert.ok(REPLAY_COMMANDS.includes('unassign')));

test('⑨ help describes unassign and groups it beside assign', t => {
  const f = fixture(t), result = f.cli(['unassign', '--help']);
  assert.equal(result.status, 0, result.stderr);
  for (const word of ['unassign <卡号>', '--project', '--author', '只有本人能撤', '不改状态和进度']) {
    assert.ok(result.stdout.includes(word), word);
  }
  assert.ok(result.stdout.includes(COMMANDS.unassign.examples[0]));
  const group = GROUPS.find(([title]) => title === '卡的生命周期')[1];
  assert.equal(group[group.indexOf('assign') + 1], 'unassign');
});
