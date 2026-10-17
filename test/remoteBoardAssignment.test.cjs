'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, must, addArgs } = require('./remoteBoardFixtures.test.cjs');

function assignedBoard(f) {
  const board = f.read(), task = board.tasks[0];
  Object.assign(task, {
    status: '施工中', percent: 47, assigneeUserId: 'member-a', assigneeName: '成员甲',
    builder: '派单器', gitBranch: ['feat/member', 'feat/keep'],
    commitShas: ['abcdef123456'], prNumbers: [12], fileScope: ['cli/**'], worktree: ['saved-worktree'],
  });
  f.write(f.board, board);
  return JSON.parse(JSON.stringify(task));
}

test('member ownership blocks AI claim; remote unclaim atomically releases and audits once', t => {
  const f = fixture(t); must(f.cli(addArgs('A')));
  const original = assignedBoard(f), before = fs.readFileSync(f.board, 'utf8');
  const conflict = f.cli(['claim', 'A', '--project', 'p', '--branch', 'feat/ai', '--builder', '派单器']);
  assert.equal(conflict.status, 1); assert.match(conflict.stderr, /member-a/); assert.match(conflict.stderr, /不能自动夺卡/);
  assert.equal(fs.readFileSync(f.board, 'utf8'), before);

  must(f.cli(['unclaim', 'A', '--project', 'p', '--branch', 'feat/member', '--author', '负责人', '--reason', '成员交回任务']));
  const board = f.read(), task = board.tasks[0], audit = board.activity.at(-1);
  assert.equal(Object.hasOwn(task, 'assigneeUserId'), false); assert.equal(Object.hasOwn(task, 'assigneeName'), false);
  assert.equal(task.status, '待开工'); assert.equal(task.percent, 47);
  assert.deepEqual(task.gitBranch, ['feat/keep']);
  for (const key of ['builder', 'commitShas', 'prNumbers', 'fileScope', 'worktree', 'deps', 'decisions', 'dates']) assert.deepEqual(task[key], original[key], key);
  assert.equal(audit.type, 'unclaim');
  assert.deepEqual(audit.releasedAssignee, { userId: 'member-a', name: '成员甲' });
  assert.deepEqual(audit.releasedBy, { kind: 'owner-transport', subjectId: 'owner-device', author: '负责人' });

  const pending = fs.readdirSync(path.join(f.local, 'remote-outbox')).map(name => JSON.parse(fs.readFileSync(path.join(f.local, 'remote-outbox', name), 'utf8')));
  const request = pending.find(entry => entry.request.command === 'unclaim').request;
  const after = fs.readFileSync(f.board, 'utf8');
  must(f.cli(['remote-retry', request.requestId]));
  assert.equal(fs.readFileSync(f.board, 'utf8'), after);
  assert.equal(f.read().activity.filter(entry => entry.type === 'unclaim').length, 1);

  // A later member claim must survive replay of the previous release receipt.
  const reassigned = f.read();
  Object.assign(reassigned.tasks[0], { status: '施工中', assigneeUserId: 'member-b', assigneeName: '成员乙' });
  f.write(f.board, reassigned);
  const withNewMember = fs.readFileSync(f.board, 'utf8');
  must(f.cli(['remote-retry', request.requestId]));
  assert.equal(fs.readFileSync(f.board, 'utf8'), withNewMember);
  assert.equal(f.read().tasks[0].assigneeUserId, 'member-b');
  assert.equal(f.read().activity.filter(entry => entry.type === 'unclaim').length, 1);
  assert.equal(f.cli(['claim', 'A', '--project', 'p', '--branch', 'feat/ai', '--builder', '派单器']).status, 1);
  must(f.cli(['unclaim', 'A', '--project', 'p', '--branch', 'feat/member', '--author', '负责人', '--reason', '第二位成员明确交回']));
  assert.deepEqual(f.read().activity.at(-1).releasedAssignee, { userId: 'member-b', name: '成员乙' });
  must(f.cli(['claim', 'A', '--project', 'p', '--branch', 'feat/ai', '--builder', '派单器']));
  assert.deepEqual(f.read().tasks[0].gitBranch, ['feat/keep', 'feat/ai']);
});

test('local claim conflict and rejected unclaim leave ownership intact; successful release keeps metadata', t => {
  const f = fixture(t); must(f.cli(addArgs('A'))); assignedBoard(f);
  const env = { ...f.env, DASHBOARD_HOME: f.cloud }; delete env.DASHBOARD_REMOTE_CONFIG;
  const cli = args => f.cli([...args, '--project', 'p'], { env });
  let before = fs.readFileSync(f.board, 'utf8');
  assert.equal(cli(['claim', 'A', '--branch', 'feat/ai', '--builder', '派单器']).status, 1);
  assert.equal(fs.readFileSync(f.board, 'utf8'), before);

  // Schema failure occurs after the mutator; neither ownership deletion nor audit may reach disk.
  let board = f.read(); board.tasks[0].deps.blockedBy = ['MISSING']; f.write(f.board, board);
  before = fs.readFileSync(f.board, 'utf8');
  const invalid = cli(['unclaim', 'A', '--branch', 'feat/member', '--author', '本机负责人', '--reason', '释放']);
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /MISSING/);
  assert.equal(fs.readFileSync(f.board, 'utf8'), before);

  board = f.read(); board.tasks[0].deps.blockedBy = []; board.tasks[0].status = '已完工'; f.write(f.board, board);
  before = fs.readFileSync(f.board, 'utf8');
  assert.equal(cli(['unclaim', 'A', '--branch', 'feat/member', '--reason', '拒绝终态释放']).status, 1);
  assert.equal(fs.readFileSync(f.board, 'utf8'), before);

  board = f.read(); board.tasks[0].status = '施工中'; board.tasks[0].unparkReason = '已解除暂缓'; f.write(f.board, board);
  must(cli(['unclaim', 'A', '--branch', 'feat/member', '--author', '本机负责人', '--reason', '释放']));
  board = f.read();
  assert.equal(board.tasks[0].status, '可复工'); assert.equal(board.tasks[0].assigneeUserId, undefined); assert.equal(board.tasks[0].assigneeName, undefined);
  assert.equal(board.tasks[0].builder, '派单器'); assert.equal(board.tasks[0].percent, 47);
  assert.deepEqual(board.tasks[0].gitBranch, ['feat/keep']);
  assert.deepEqual(board.activity.at(-1).releasedBy, { kind: 'local-cli', subjectId: null, author: '本机负责人' });
  assert.deepEqual(board.activity.at(-1).releasedAssignee, { userId: 'member-a', name: '成员甲' });
});
