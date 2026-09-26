'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cmds = require('../cli/commands.cjs');
const { BINDINGS_FILE } = require('../core/sessionAttribution.cjs');
const { bindingsPathOf, currentSessionId, readBindings, recordBinding } = require('../core/sessionBindings.cjs');

const SID_A = '00000000-0000-4000-8000-00000000000a';
const SID_B = '00000000-0000-4000-8000-00000000000b';

function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bindings-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  cmds.register({ id: 't', name: 'd', root, registry: reg });
  return { board: path.join(root, '.dashboard', 'board.json'), P: { project: 't', registry: reg } };
}

function withSession(id, fn) {
  const old = process.env.CLAUDE_CODE_SESSION_ID;
  try {
    if (id === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = id;
    return fn();
  } finally {
    if (old === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = old;
  }
}

test('claim 记录绑定，重复 claim/done 同卡不追加，另一会话 done 追加', (t) => {
  const { board, P } = setup(t);
  const file = bindingsPathOf(board);
  assert.equal(path.basename(file), BINDINGS_FILE);
  cmds.add({ _: ['CARD-A'], title: 'x', ...P });
  withSession(SID_A, () => {
    assert.equal(cmds.claim({ _: ['CARD-A'], branch: 'feat/a', ...P }).task.status, '施工中');
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
    cmds.claim({ _: ['CARD-A'], branch: 'feat/a', ...P });
    cmds.done({ _: ['CARD-A'], collect: true, ...P });
  });
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  withSession(SID_B, () => cmds.done({ _: ['CARD-A'], collect: true, ...P }));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => [line.v, line.sessionId, line.taskId, line.via]), [
    [1, SID_A, 'CARD-A', 'claim'], [1, SID_B, 'CARD-A', 'done'],
  ]);
  assert.match(lines[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('没有或无效会话 ID 时安静跳过且不碰文件', (t) => {
  const { board, P } = setup(t);
  cmds.add({ _: ['CARD-A'], title: 'x', ...P });
  withSession(undefined, () => cmds.claim({ _: ['CARD-A'], ...P }));
  assert.equal(fs.existsSync(bindingsPathOf(board)), false);
  withSession('not-a-uuid', () => cmds.claim({ _: ['CARD-A'], ...P }));
  assert.equal(fs.existsSync(bindingsPathOf(board)), false);
  assert.equal(currentSessionId({ CLAUDE_CODE_SESSION_ID: ` ${SID_A.toUpperCase()} ` }), SID_A.toUpperCase());
  assert.equal(recordBinding({ boardPath: board, taskId: 'CARD-A', via: 'claim', env: {} }).status, 'skipped');
});

test('claim 非法迁移抛错，不会记录绑定', (t) => {
  const { board, P } = setup(t);
  cmds.add({ _: ['CARD-A'], title: 'x', status: '已完工', ...P });
  withSession(SID_A, () => assert.throws(() => cmds.claim({ _: ['CARD-A'], ...P }), /非法迁移/));
  assert.equal(fs.existsSync(bindingsPathOf(board)), false);
});

test('绑定路径被目录占用时只警告，claim 仍成功', (t) => {
  const { board, P } = setup(t);
  cmds.add({ _: ['CARD-A'], title: 'x', ...P });
  fs.mkdirSync(bindingsPathOf(board));
  const original = process.stderr.write;
  let warning = '';
  try {
    process.stderr.write = (chunk) => { warning += chunk; return true; };
    withSession(SID_A, () => assert.equal(cmds.claim({ _: ['CARD-A'], ...P }).task.status, '施工中'));
  } finally { process.stderr.write = original; }
  assert.match(warning, /会话绑定没记上/);
  assert.equal(JSON.parse(fs.readFileSync(board, 'utf8')).tasks[0].status, '施工中');
});

test('readBindings 文件不存在返回空的无原型对象', (t) => {
  const { board } = setup(t);
  const result = readBindings(board);
  assert.deepEqual(Object.keys(result), []);
  assert.equal(Object.getPrototypeOf(result), null);
});
