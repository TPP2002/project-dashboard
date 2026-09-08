'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { protocol } = require('../cli/protocol.cjs');
const { COMMANDS } = require('../cli/help.cjs');
const { displayCliCommand } = require('../core/runtimeRoot.cjs');
const { STATUS } = require('../core/boardSchema.cjs');
const cmds = require('../cli/commands.cjs');

const CLI = path.resolve(__dirname, '../cli/index.cjs');
const NAMES = ['brief', 'claim', 'progress', 'pending', 'decide', 'done', 'note', 'unclaim',
  'park', 'unpark', 'block', 'cancel', 'reopen', 'edit', 'mark-landed', 'list', 'show', 'inbox'];
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const card = (flags = {}) => JSON.parse(protocol({ ...flags, format: 'json' }).text);

// 沿用 hooksInstall 的隔离 registry/board 夹具；行为测试不装 hook，也不需要新建 git 仓。
function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  cmds.register({ id: 't', name: 'protocol fixture', root: repo, registry: reg });
  return { dir, repo, reg, P: { project: 't', registry: reg }, board: path.join(repo, '.dashboard/board.json') };
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

test('md 协议不超过 60 行，每条命令原样引用帮助的一行 usage', () => {
  const result = protocol({ project: 't' });
  assert.equal(result.ok, true);
  const lines = result.text.split('\n');
  assert.ok(lines.length <= 60, `实际 ${lines.length} 行`);
  assert.match(lines[0], /看板协议卡 · 项目 t · 由 CLI 生成、与 --help 同源/);
  for (const name of NAMES) {
    assert.ok(!COMMANDS[name].usage.includes('\n'), `${name} 用法应为一行`);
    assert.ok(lines.includes(`- \`${COMMANDS[name].usage}\``), `${name} 未原样引用 usage`);
  }
  assert.match(result.text, /本协议 > 用户启动指令/);
  assert.match(result.text, /没做完比做完更要写/);
  assert.doesNotMatch(result.text, /\p{Extended_Pictographic}/u);
});

test('--format json 输出约定形状；显式项目无需预先注册', (t) => {
  const f = setup(t);
  const result = JSON.parse(run(['protocol', '--project', 'unregistered', '--format', 'json', '--registry', f.reg], f.repo));
  assert.deepEqual(Object.keys(result).sort(), ['project', 'generatedAt', 'commands', 'transitions', 'rules', 'examples'].sort());
  assert.equal(result.project, 'unregistered');
  assert.equal(new Date(result.generatedAt).toISOString(), result.generatedAt);
  assert.deepEqual(result.commands, NAMES.map((name) => ({ name, usage: COMMANDS[name].usage, summary: COMMANDS[name].summary })));
  assert.deepEqual(result.transitions.map((entry) => entry.command).sort(), [...NAMES].sort());
  for (const entry of result.transitions) {
    assert.deepEqual(Object.keys(entry).sort(), ['command', 'status', 'writes']);
    const targets = entry.status && typeof entry.status === 'object' ? Object.values(entry.status) : [entry.status];
    assert.ok(targets.every((status) => status === null || STATUS.includes(status)));
    assert.ok(entry.writes.length && entry.writes.every((text) => typeof text === 'string'));
  }
  assert.ok(result.rules.length && result.rules.every((text) => typeof text === 'string'));
  assert.deepEqual(Object.keys(result.examples).sort(), ['add', 'claim', 'pending', 'done'].sort());
});

test('省略项目且认不出时使用占位符，不报错也不改 registry/board', (t) => {
  const f = setup(t);
  const before = [f.reg, f.board].map((file) => fs.readFileSync(file, 'utf8'));
  const empty = path.join(f.dir, 'empty.json');
  const broken = path.join(f.dir, 'broken.json');
  fs.writeFileSync(empty, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  fs.writeFileSync(broken, '{');
  for (const registry of [empty, broken, path.join(f.dir, 'missing.json')]) {
    const result = JSON.parse(run(['protocol', '--format', 'json', '--registry', registry], path.dirname(CLI)));
    assert.equal(result.project, '<项目id>');
  }
  const md = run(['protocol', '--registry', f.reg], f.repo);
  assert.match(md, /项目 <项目id>/);
  assert.deepEqual([f.reg, f.board].map((file) => fs.readFileSync(file, 'utf8')), before);
});

test('省略项目时唯一命中自动选择，共仓歧义不被入口拒绝且显式值优先', (t) => {
  const f = setup(t);
  const cwd = path.dirname(CLI);
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', windowsHide: true }).trim();
  const root = path.dirname(path.resolve(cwd, common));
  for (const id of ['one', 'two']) {
    cmds.register({ id, root, board: path.join(f.dir, `${id}-board.json`), registry: f.reg });
    const result = JSON.parse(run(['protocol', '--format', 'json', '--registry', f.reg], cwd));
    assert.equal(result.project, id === 'one' ? 'one' : '<项目id>');
  }
  const result = JSON.parse(run(['protocol', '--project', 'chosen', '--format', 'json', '--registry', f.reg], cwd));
  assert.equal(result.project, 'chosen');
});

test('四条示例使用统一 CLI 前缀，参数及 pending JSON 均能被真实 CLI 接收', (t) => {
  const f = setup(t);
  const examples = card(f.P).examples;
  const prefix = displayCliCommand() + ' ';
  const [pendingCommand, pendingJson] = examples.pending.split('\n');
  fs.writeFileSync(path.join(f.repo, 'pending.json'), pendingJson);
  for (const example of [examples.add, examples.claim, pendingCommand, examples.done]) {
    assert.ok(example.startsWith(prefix));
    const args = example.slice(prefix.length).match(/"[^"]*"|\S+/g).map((arg) => arg.startsWith('"') ? JSON.parse(arg) : arg);
    run([...args, '--registry', f.reg], f.repo);
  }
  const task = read(f.board).tasks[0];
  assert.equal(task.status, '已完工');
  assert.ok(task.modelHint && task.plainTitle && task.fileScope.length);
  assert.equal(task.decisions.length, 1);
  assert.equal(task.decisions[0].answer, null, 'done 不代替负责人回答问题');
  assert.deepEqual(task.prNumbers, [42]);
  assert.deepEqual(task.commitShas, ['a1b2c3d']);
});

test('静默行为表逐项对照真实命令的落盘状态与字段（含条件分支）', (t) => {
  const f = setup(t);
  const protocolCard = card(f.P);
  const transitions = new Map(protocolCard.transitions.map((entry) => [entry.command, entry]));
  const get = () => read(f.board).tasks.find((task) => task.id === 'T1');
  const payloadFile = path.join(f.dir, 'pending.json');
  fs.writeFileSync(payloadFile, protocolCard.examples.pending.split('\n')[1]);
  for (const id of ['T1', 'UPSTREAM']) cmds.add({ ...f.P, _: [id], title: id });
  const checked = new Set();
  function apply(command, flags = {}, condition) {
    const before = get();
    const entry = transitions.get(command);
    let expected = entry.status;
    if (expected && typeof expected === 'object') {
      assert.ok(Object.hasOwn(expected, condition), `${command} 缺条件 ${condition}`);
      expected = expected[condition];
    }
    const fn = command === 'mark-landed' ? 'markLanded' : command;
    cmds[fn]({ ...f.P, _: ['T1'], ...flags });
    const after = get();
    assert.equal(after.status, expected === null ? before.status : expected, `${command} ${condition || ''}`);
    checked.add(command);
    return after;
  }
  function rejectTerminal() {
    const before = fs.readFileSync(f.board, 'utf8');
    assert.throws(() => cmds.claim({ ...f.P, _: ['T1'], branch: 'feat/test' }), /非法迁移/);
    assert.throws(() => cmds.progress({ ...f.P, _: ['T1'], percent: 100 }), /不能再报进度/);
    assert.equal(fs.readFileSync(f.board, 'utf8'), before, '被拒命令不能留下写入');
  }
  const pendingFlags = { 'json-file': payloadFile };
  apply('pending', pendingFlags, '未开工/待开工');
  apply('pending', pendingFlags, '其它状态');
  apply('decide', { did: 'd1', answer: '分批切换' }, '其它情况');
  apply('decide', { did: 'd2', answer: '分批切换', 'no-promote': true }, '其它情况');
  apply('decide', { did: 'd2', answer: '分批切换' }, '待拍板且全部答完且未传 --no-promote');
  let task = apply('claim', { branch: 'feat/test', scope: 'cli/protocol.cjs' });
  assert.deepEqual(task.gitBranch, ['feat/test']);
  assert.deepEqual(task.fileScope, ['cli/protocol.cjs']);
  assert.ok(task.dates.start && task.lastProgressAt);
  task = apply('progress', { percent: 100, next: '核对行为', tests: '8/8/1', typecheck: 'true' });
  assert.equal(task.percent, 100);
  assert.equal(task.dates.done, null);
  assert.deepEqual(task.tests, { total: 8, passing: 8, mustFailFirst: 1 });
  assert.equal(task.typecheck, true);
  task = apply('pending', pendingFlags, '其它状态');
  assert.match(task.nextMilestone, /^等拍板：/);
  const milestone = task.nextMilestone;
  task = apply('decide', { did: 'd3', answer: '分批切换' }, '其它情况');
  assert.equal(task.nextMilestone, milestone, 'decide 不清除等拍板提示');
  assert.ok(task.decisions.every((d) => d.answer && d.decidedAt));
  task = apply('mark-landed', { did: 'd1', commit: 'abcdef1' });
  const landed = { ...task.decisions[0] };
  const beforeNote = get();
  apply('note', { text: '核对当前事实' });
  assert.deepEqual(get(), beforeNote, 'note 不改卡上任何字段');
  assert.equal(read(f.board).activity.at(-1).kind, 'message');
  assert.equal(read(f.board).activity.at(-1).taskId, 'T1');
  task = apply('block', { by: 'UPSTREAM', reason: '上游未完成' });
  assert.deepEqual(task.deps.blockedBy, ['UPSTREAM']);
  assert.equal(task.blockReason, '上游未完成');
  task = apply('park', { reason: '等条件', note: '已完成主体' });
  assert.equal(task.blockReason, '等条件');
  assert.equal(task.parkedNote, '已完成主体');
  assert.ok(!Object.hasOwn(task, 'parkReason'));
  apply('block', { by: 'UPSTREAM' });
  task = apply('unpark', { reason: '条件就绪' });
  assert.ok(!Object.hasOwn(task, 'blockReason') && !Object.hasOwn(task, 'parkedNote'));
  assert.ok(task.unparkReason && task.unparkedAt);
  apply('claim', { branch: 'feat/test' });
  task = apply('unclaim', { branch: 'feat/test', reason: '转手' }, '施工中且有 unparkReason');
  assert.deepEqual(task.gitBranch, []);
  assert.equal(task.percent, 100);
  apply('claim', { branch: 'feat/test' });
  task = apply('park', { reason: '再次挂起' });
  assert.ok(!Object.hasOwn(task, 'unparkReason') && !Object.hasOwn(task, 'unparkedAt'));
  apply('unpark', { reason: '再次就绪' });
  apply('claim', { branch: 'feat/test' });
  apply('progress', { percent: 60 });
  task = apply('done', { collect: true, pr: 42, commit: 'a1b2c3d' }, '--collect');
  assert.equal(task.percent, 60);
  assert.equal(task.dates.done, null);
  assert.ok(!task.decisions[1].landed);
  task = apply('done', { pr: 42, commit: 'a1b2c3d' }, '默认');
  assert.equal(task.percent, 100);
  assert.ok(task.dates.done);
  assert.deepEqual(task.decisions[0], landed, '已落地决策不得被 done 覆盖');
  assert.ok(task.decisions.slice(1).every((d) => d.landed && d.landedAt && d.landedCommit === 'a1b2c3d'));
  rejectTerminal();
  task = apply('reopen', { reason: '验收返工' });
  assert.equal(task.percent, 0);
  assert.equal(task.dates.done, null);
  assert.deepEqual(task.prNumbers, [42]);
  assert.deepEqual(task.commitShas, ['a1b2c3d']);
  assert.equal(task.decisions.length, 3);
  assert.ok(!Object.hasOwn(task, 'unparkReason') && !Object.hasOwn(task, 'unclaimReason'));
  apply('claim', { branch: 'feat/test' });
  task = apply('unclaim', { branch: 'other', reason: '交回' }, '施工中且无 unparkReason');
  assert.deepEqual(task.gitBranch, ['feat/test'], '没有摘到分支也不报错');
  apply('block', { by: 'UPSTREAM', reason: '阻塞记录' });
  task = apply('cancel', { reason: '需求取消' });
  for (const key of ['blockReason', 'parkedNote', 'unparkReason', 'unparkedAt', 'unclaimReason', 'unclaimedAt', 'nextMilestone']) {
    assert.ok(!Object.hasOwn(task, key), `cancel 应删除 ${key}`);
  }
  assert.equal(task.cancelReason, '需求取消');
  assert.ok(task.cancelledAt);
  rejectTerminal();
  task = apply('reopen', { reason: '恢复需求' });
  assert.ok(!Object.hasOwn(task, 'cancelReason') && !Object.hasOwn(task, 'cancelledAt'));
  task = apply('edit', { title: '新技术说明', 'plain-title': '更新后的任务标题', desc: '补充', model: 'opus·中', wave: 1 });
  assert.equal(task.title, '新技术说明');
  assert.equal(task.description, '补充');
  assert.equal(task.wave, 1);
  assert.deepEqual([...checked].sort(), NAMES.filter((name) => !['brief', 'list', 'show', 'inbox'].includes(name)).sort());
});
