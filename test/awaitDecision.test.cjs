'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { protocol } = require('../cli/protocol.cjs');
const { COMMANDS } = require('../cli/help.cjs');

const readBoard = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const taskOf = (file, id) => readBoard(file).tasks.find(t => t.id === id);
const payload = {
  q: '这项工作应当采用哪个方案来完成？', opt: ['甲', '乙'], rec: '甲',
  background: '这项工作需要在两个方案之间作出选择，负责人需要了解具体情况和后续影响。'.repeat(3),
  'pros-甲': '好处是沿用现有规则，代价是需要仔细核对原有记录。'.repeat(2),
  'pros-乙': '好处是可以重新安排，代价是需要额外协调有关人员。'.repeat(2),
  reason: '推荐沿用现有规则，因为可以减少变更范围并保留已有记录，方便后续核对。'.repeat(2),
};
function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'await-decision-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  cmds.register({ id: 'myproj', name: 'myproj', root: repo, registry: reg });
  return { dir, repo, reg, P: { project: 'myproj', registry: reg }, board: path.join(repo, '.dashboard', 'board.json') };
}
function startWorking(f, id = 'AD1', branch = 'feat/ad1') {
  cmds.add({ ...f.P, _: [id], title: id });
  cmds.claim({ ...f.P, _: [id], branch, builder: '派单器', scope: 'cli/x.cjs' });
  return id;
}
const pending = (f, id = 'AD1', extra = {}) => cmds.pending({ ...f.P, _: [id], ...payload, ...extra });
const answer = (f, id, did) => cmds.decide({ ...f.P, _: [id], did, answer: '甲' });

test('T1 施工中有未答决策时转待拍板并保留进度和分支', t => {
  const f = setup(t); startWorking(f); pending(f);
  const before = taskOf(f.board, 'AD1');
  const result = cmds.awaitDecision({ ...f.P, _: ['AD1'], reason: '等待决定', author: '测试' });
  const after = taskOf(f.board, 'AD1');
  assert.equal(result.text, '✔ await-decision AD1 → 待拍板(未答 d1)');
  assert.equal(after.status, '待拍板'); assert.match(after.nextMilestone, /^等拍板：/);
  for (const key of ['percent', 'gitBranch', 'decisions', 'dates']) assert.deepEqual(after[key], before[key]);
  const activity = readBoard(f.board).activity.at(-1);
  assert.equal(activity.type, 'await-decision'); assert.equal(activity.author, '测试');
  assert.equal(activity.text, '转待拍板 AD1：未答 d1；等待决定');
});

test('T2 待收单只列未答问题并保留交活记录', t => {
  const f = setup(t); startWorking(f); pending(f); pending(f); answer(f, 'AD1', 'd1');
  cmds.awaitCollect({ ...f.P, _: ['AD1'], job: 'job-a' });
  const before = taskOf(f.board, 'AD1');
  cmds.awaitDecision({ ...f.P, _: ['AD1'], reason: true });
  const after = taskOf(f.board, 'AD1');
  assert.equal(after.status, '待拍板'); assert.deepEqual(after.awaitCollect, before.awaitCollect);
  assert.equal(readBoard(f.board).activity.at(-1).text, '转待拍板 AD1：未答 d2');
});

test('T3 已待拍板且有未答决策时成功且逐字节不写', t => {
  const f = setup(t); cmds.add({ ...f.P, _: ['AD1'], title: 'AD1' }); pending(f);
  const before = fs.readFileSync(f.board);
  const result = cmds.awaitDecision({ ...f.P, _: ['AD1'] });
  assert.equal(result.text, '✔ await-decision AD1 已是待拍板(未答 d1)');
  assert.deepEqual(fs.readFileSync(f.board), before);
});

test('T4 非法状态优先拒绝且逐字节不写', t => {
  const f = setup(t);
  for (const [id, status] of [['AD1', '未开工'], ['AD2', '已完工'], ['AD3', '暂缓']]) {
    cmds.add({ ...f.P, _: [id], title: id, status });
    const before = fs.readFileSync(f.board);
    assert.throws(() => cmds.awaitDecision({ ...f.P, _: [id] }), /非法迁移/);
    assert.deepEqual(fs.readFileSync(f.board), before);
  }
});

test('T5 全答完或无决策字段时拒绝且逐字节不写', t => {
  const f = setup(t); startWorking(f); pending(f); answer(f, 'AD1', 'd1');
  startWorking(f, 'AD2', 'feat/ad2');
  const board = readBoard(f.board); delete board.tasks.find(x => x.id === 'AD2').decisions;
  fs.writeFileSync(f.board, JSON.stringify(board));
  for (const id of ['AD1', 'AD2']) {
    const before = fs.readFileSync(f.board);
    assert.throws(() => cmds.awaitDecision({ ...f.P, _: [id] }), /没有未答的决策/);
    assert.deepEqual(fs.readFileSync(f.board), before);
  }
});

test('T6 答完最后一条后现有逻辑转已拍板', t => {
  const f = setup(t); startWorking(f); pending(f);
  cmds.awaitDecision({ ...f.P, _: ['AD1'] }); answer(f, 'AD1', 'd1');
  assert.equal(taskOf(f.board, 'AD1').status, '已拍板');
});

test('T7 命令行成功退出零，非法迁移退出一', t => {
  const f = setup(t); startWorking(f); pending(f);
  cmds.add({ ...f.P, _: ['AD2'], title: 'AD2' });
  const run = id => spawnSync(process.execPath, [path.resolve(__dirname, '../cli/index.cjs'), 'await-decision', id,
    '--project', 'myproj', '--registry', f.reg], { encoding: 'utf8', windowsHide: true });
  const ok = run('AD1'); assert.equal(ok.status, 0, ok.stderr);
  const bad = run('AD2'); assert.equal(bad.status, 1, bad.stderr); assert.match(bad.stderr, /非法迁移/);
});

test('T8 帮助和协议登记命令及迁移', () => {
  assert.ok(COMMANDS['await-decision']);
  const md = protocol({ project: 'myproj' }).text;
  assert.ok(md.includes(`- \`${COMMANDS['await-decision'].usage}\``));
  assert.match(md, /\| await-decision \| → 待拍板 \|/);
});
