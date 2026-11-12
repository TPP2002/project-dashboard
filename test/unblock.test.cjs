'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { REPLAY_COMMANDS } = require('../core/syncReplay.cjs');
const CLI = path.resolve(__dirname, '../cli/index.cjs');

function fixture(t, blocked = true) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  cmds.register({ id: 't', root: dir, registry });
  const P = { project: 't', registry, _: ['T1'] };
  cmds.add({ ...P, title: '待解除的卡' });
  for (const id of ['A', 'B']) cmds.add({ ...P, _: [id], title: '上游卡' });
  cmds.progress({ ...P, percent: 37 });
  cmds.set({ ...P, field: 'deps.dependsOn', value: '["A","B"]' });
  if (blocked) cmds.block({ ...P, by: ['A', 'B'], reason: '等待上游' });
  const board = path.join(dir, '.dashboard/board.json');
  const read = () => JSON.parse(fs.readFileSync(board, 'utf8'));
  const cli = args => spawnSync(process.execPath, [CLI, ...args, '--project', 't', '--registry', registry],
    { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const run = args => cli(['unblock', 'T1', ...args]);
  const success = args => { const r = run(args); assert.equal(r.status, 0, r.stderr); return r; };
  const reject = (args, message) => {
    const before = fs.readFileSync(board);
    const r = run(args);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, message);
    assert.deepEqual(fs.readFileSync(board), before, '拒绝时板文件逐字节不变');
  };
  return { P, read, cli, success, reject };
}

test('不带 by 清空阻塞、删除说明，仅改变指定字段并追加一条解除活动', t => {
  const f = fixture(t), before = f.read();
  f.success(['--reason', '上游已完成']);
  const after = f.read(), expected = structuredClone(before.tasks[0]);
  expected.deps.blockedBy = []; delete expected.blockReason;
  assert.deepEqual(after.tasks[0], expected);
  assert.equal(after.activity.length, before.activity.length + 1);
  const activity = after.activity.at(-1);
  assert.equal(activity.type, 'unblock');
  assert.equal(activity.taskId, 'T1');
  assert.match(activity.text, /解除阻塞 T1.*上游已完成.*去掉 A,B/);
});

test('指定 by 仅去掉一个且保留剩余阻塞说明', t => {
  const f = fixture(t), expected = f.read().tasks[0];
  expected.deps.blockedBy = ['B'];
  f.success(['--by', 'A', '--reason', 'A 已完成']);
  assert.deepEqual(f.read().tasks[0], expected);
  assert.match(f.read().activity.at(-1).text, /去掉 A\)/);
});

test('by 混有不在阻塞列表的卡时整次拒绝且不写盘', t => {
  fixture(t).reject(['--by', 'A', '--by', 'MISSING', '--reason', '完成'], /MISSING.*不在/);
});

test('缺 reason 拒绝且不写盘', t => {
  fixture(t).reject([], /缺参数.*--reason/);
});

test('无阻塞卡拒绝且不写盘', t => {
  fixture(t, false).reject(['--reason', '完成'], /这张卡没有阻塞/);
});

test('只有阻塞说明时删除说明并记清掉阻塞说明', t => {
  const f = fixture(t, false);
  cmds.block({ ...f.P, reason: '外部条件' });
  const expected = f.read().tasks[0]; delete expected.blockReason;
  f.success(['--reason', '条件满足']);
  assert.deepEqual(f.read().tasks[0], expected);
  assert.equal(f.read().activity.at(-1).type, 'unblock');
  assert.match(f.read().activity.at(-1).text, /条件满足.*清掉阻塞说明/);
});

test('暂缓卡拒绝并提示 unpark，板文件不变', t => {
  const f = fixture(t);
  cmds.park({ ...f.P, reason: '等待决定' });
  f.reject(['--reason', '完成'], /暂缓的卡用 unpark --reason 解除/);
});

test('json 仅输出五个约定键，多个 by 可以清空阻塞', t => {
  const f = fixture(t);
  const result = JSON.parse(f.success(['--by', 'B', '--by', 'A', '--reason', '完成', '--json']).stdout);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'id', 'status', 'percent', 'changed'].sort());
  assert.equal(result.ok, true); assert.equal(result.id, 'T1'); assert.equal(result.percent, 37);
  assert.deepEqual(result.changed.sort(), ['blockReason', 'deps.blockedBy'].sort());
  assert.deepEqual(f.read().tasks[0].deps.blockedBy, []);
  assert.equal(Object.hasOwn(f.read().tasks[0], 'blockReason'), false);
});

test('回放白名单包含 unblock，set 阻塞字段提示专门解除命令', t => {
  assert.ok(REPLAY_COMMANDS.includes('unblock'));
  const f = fixture(t);
  for (const [field, value] of [['blockReason', '说明'], ['deps.blockedBy', '[]']]) {
    const r = f.cli(['set', 'T1', '--field', field, '--value', value]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /有专门命令/);
    assert.match(r.stderr, /unblock/);
  }
});
