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
const INDEX = path.resolve(__dirname, '../cli/index.cjs');
const actor = { actorUserId: 'u-owner', actorName: '项目经理' };

function fixture(t, extra = {}, cloud = false) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-assign-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const registryPath = path.join(home, 'registry.json'), boardFile = path.join(home, 'board.json');
  const settings = path.join(home, 'settings.json');
  fs.writeFileSync(settings, '{}');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { local: { mainRepo: home, board: boardFile,
    ...(cloud ? { cloud: { enabled: true, remoteProjectId: 'remote' } } : {}) } } }));
  const board = emptyBoard({ id: 'local', name: 'Local', mainRepo: home });
  board.tasks.push({ id: 'T1', title: '补记负责人', status: '待开工', percent: 37, wave: 0,
    dates: { design: '2026-01-01', start: '2026-01-02', done: null }, builder: '自干:例外①',
    gitBranch: ['kept'], collaborators: [], lastProgressAt: '2026-01-02T00:00:00Z', ...extra });
  fs.writeFileSync(boardFile, JSON.stringify(board));
  const read = () => JSON.parse(fs.readFileSync(boardFile, 'utf8'));
  const bytes = () => fs.readFileSync(boardFile);
  const proj = resolveProject('local', { registryPath });
  const replay = (command, flags = {}, who = actor) => applyOp({ kind: 'op', command,
    flags: { _: ['T1'], ...(command === 'claim' ? { builder: '派单器' } : { me: true }), ...flags }, files: {} },
  { registryPath, projectId: 'local', ...who });
  const cli = args => spawnSync(process.execPath, [INDEX, ...args, '--project', 'local', '--registry', registryPath], {
    cwd: home, windowsHide: true, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: registryPath,
      DASHBOARD_GLOBAL_SETTINGS: settings, CLAUDE_CODE_SESSION_ID: '' },
  });
  return { read, bytes, proj, replay, cli, registryPath, boardFile };
}

test('① replay claim assigns the authenticated actor and name, including name fallback', t => {
  for (const who of [actor, { actorUserId: actor.actorUserId }]) {
    const f = fixture(t);
    assert.equal(f.replay('claim', {}, who).ok, true);
    assert.equal(f.read().tasks[0].assigneeUserId, actor.actorUserId);
    assert.equal(f.read().tasks[0].assigneeName, who.actorName || who.actorUserId);
  }
});

test('② replay claim preserves both assignee fields for the same actor', t => {
  const f = fixture(t, { assigneeUserId: actor.actorUserId, assigneeName: '原名字' });
  assert.equal(f.replay('claim').ok, true);
  assert.equal(f.read().tasks[0].assigneeUserId, actor.actorUserId);
  assert.equal(f.read().tasks[0].assigneeName, '原名字');
});

test('③ replay claim refuses another member with the exact legacy 409 and no board write', t => {
  const f = fixture(t, { assigneeUserId: 'other', assigneeName: '小王' });
  const before = f.bytes();
  assert.throws(() => f.replay('claim'), { status: 409,
    message: '这张卡已被成员 小王 认领(主负责人),云端退回本次认领;要一起干请在网页上改用「加入协作」,或请对方先放弃认领' });
  assert.deepEqual(f.bytes(), before);
});

test('④ local CLI claim and actorless replay never create assignee fields', t => {
  for (const local of [true, false]) {
    const f = fixture(t);
    if (local) {
      const result = f.cli(['claim', 'T1', '--builder', '派单器']);
      assert.equal(result.status, 0, result.stderr || result.error?.message);
    } else assert.equal(f.replay('claim', {}, {}).ok, true);
    for (const key of ['assigneeUserId', 'assigneeName']) assert.equal(Object.hasOwn(f.read().tasks[0], key), false);
  }
});

test('⑤ assign replay on completed card changes only assignee fields and appends one named activity', t => {
  const f = fixture(t, { status: '已完工', percent: 100,
    dates: { design: '2026-01-01', start: '2026-01-02', done: '2026-01-03' } }, true);
  const before = f.read();
  assert.equal(f.replay('assign').ok, true);
  const after = f.read();
  assert.deepEqual(after.tasks[0], { ...before.tasks[0], assigneeUserId: actor.actorUserId, assigneeName: actor.actorName });
  assert.equal(after.activity.length, before.activity.length + 1);
  assert.equal(after.activity.at(-1).type, 'note');
  for (const word of ['项目经理', 'T1', '补记主负责人']) assert.ok(after.activity.at(-1).text.includes(word));
  assert.deepEqual(readOutbox(f.proj), [], 'replay must never re-enqueue');
});

test('assign supports every non-void status; same actor preserves fields and missing name falls back', t => {
  for (const status of STATUS.filter(s => s !== '已作废')) {
    const f = fixture(t, { status });
    const before = f.read().tasks[0];
    f.replay('assign', {}, { actorUserId: actor.actorUserId });
    assert.deepEqual(f.read().tasks[0], { ...before, assigneeUserId: actor.actorUserId, assigneeName: actor.actorUserId });
    const same = f.read().tasks[0];
    assert.deepEqual(f.replay('assign').result.changed, []);
    assert.deepEqual(f.read().tasks[0], same);
  }
});

test('⑥ assign refuses another member by name or id, leaving board bytes unchanged', t => {
  for (const assigneeName of ['小王', undefined]) {
    const f = fixture(t, { assigneeUserId: 'other', assigneeName });
    const before = f.bytes();
    assert.throws(() => f.replay('assign'), e => e.status === 409 && e.message.includes(assigneeName || 'other'));
    assert.deepEqual(f.bytes(), before);
  }
});

test('⑦ assign refuses void cards without writing', t => {
  const f = fixture(t, { status: '已作废' });
  const before = f.bytes();
  assert.throws(() => f.replay('assign'), { status: 409, message: '已作废的卡不能补记主负责人' });
  assert.deepEqual(f.bytes(), before);
});

test('⑧ local non-cloud assign refuses without writing', t => {
  const f = fixture(t), before = f.bytes();
  const result = f.cli(['assign', 'T1', '--me']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /只在云同步时生效/);
  assert.deepEqual(f.bytes(), before);
});

test('⑨ cloud CLI assign appends only request activity, queues one op, then actor replay assigns', t => {
  const f = fixture(t, { status: '已完工', percent: 100 }, true), before = f.read();
  const result = f.cli(['assign', 'T1', '--me', '--author', '施工方']);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /已提交,云同步回放后生效/);
  assert.deepEqual(f.read().tasks, before.tasks);
  assert.equal(f.read().activity.length, before.activity.length + 1);
  assert.match(f.read().activity.at(-1).text, /已提交.*补记.*云端按操作人落地/);
  const queue = readOutbox(f.proj);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].command, 'assign');
  assert.equal(queue[0].flags.me, true);
  assert.equal(queue[0].flags.author, '施工方');
  assert.equal(applyOp(queue[0], { registryPath: f.registryPath, projectId: 'local', ...actor }).ok, true);
  assert.deepEqual(f.read().tasks[0], { ...before.tasks[0], assigneeUserId: actor.actorUserId, assigneeName: actor.actorName });
  assert.deepEqual(readOutbox(f.proj), queue);
});

test('local cloud validation rejects missing, void and occupied cards without writing or enqueueing', t => {
  for (const [extra, id, message] of [[{}, 'MISSING', /不存在/],
    [{ status: '已作废' }, 'T1', /已作废的卡不能补记主负责人/],
    [{ assigneeUserId: 'other', assigneeName: '小王' }, 'T1', /小王/]]) {
    const f = fixture(t, extra, true), before = f.bytes();
    const result = f.cli(['assign', id, '--me']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.deepEqual(f.bytes(), before);
    assert.deepEqual(readOutbox(f.proj), []);
  }
});

test('missing --me is refused with usage locally and during replay; missing replay task is 404', t => {
  const f = fixture(t, {}, true), before = f.bytes();
  const result = f.cli(['assign', 'T1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /用法: assign.*--me/);
  assert.throws(() => f.replay('assign', { me: undefined }), /用法: assign.*--me/);
  assert.throws(() => f.replay('assign', { _: ['MISSING'] }), { status: 404 });
  assert.deepEqual(f.bytes(), before);
  assert.deepEqual(readOutbox(f.proj), []);
});

test('⑩ assign is registered for replay', () => assert.ok(REPLAY_COMMANDS.includes('assign')));
