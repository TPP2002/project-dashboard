'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cmds = require('../cli/commands.cjs');

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  cmds.register({ id: 't', name: 'd', root, registry: reg });
  return { dir, P: { project: 't', registry: reg } };
}
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('状态机全流转 未开工→待拍板→已拍板→施工中→已完工', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  assert.equal(cmds.pending({ _: ['P01'], q: 'A?', opt: ['A', 'B'], rec: 'B',
    background: '【场景】这是单元测试用的背景描述文字需要够长才能通过校验器所以我在这里多写一些占位内容以确保。【问题】用于占位以通过 skill 六点二的字数最小值检查。【要做的事】占位。【为什么重要】占位。',
    'pros-A': '【好处】A 的好处。【代价】A 的代价描述在这里。',
    'pros-B': '【好处】B 的好处。【代价】B 的代价描述在这里。',
    reason: '推荐 B 的理由描述需要写得足够长才能通过校验器所以我在这里多写一些内容占位。',
    ...P }).task.status, '待拍板');
  assert.equal(cmds.decide({ _: ['P01'], did: 'd1', answer: 'B', promote: true, ...P }).task.status, '已拍板');
  assert.equal(cmds.claim({ _: ['P01'], branch: 'br1', ...P }).task.status, '施工中');
  const done = cmds.done({ _: ['P01'], pr: '24', commit: 'a1b2c3d', ...P });
  assert.equal(done.task.status, '已完工');
  assert.equal(done.task.percent, 100);
  clean(dir);
});

test('pending 强制校验：缺三件套被拒（skill §6.2 硬规则）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  assert.throws(() => cmds.pending({ _: ['P01'], q: 'A?', opt: ['A', 'B'], rec: 'B', ...P }),
    /不合格|background|optionPros|recommendReason/);
  clean(dir);
});

test('claim 非法迁移被拒（已完工不能再 claim）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', status: '已完工', ...P });
  assert.throws(() => cmds.claim({ _: ['P01'], branch: 'b', ...P }), /非法迁移|claim/);
  clean(dir);
});

test('done 多次 commit 用 union 不丢（抗并发丢更新）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.done({ _: ['P01'], commit: 'aaaaaa1', ...P });
  const b = cmds.done({ _: ['P01'], commit: 'bbbbbb2', ...P });
  assert.deepEqual(b.task.commitShas.sort(), ['aaaaaa1', 'bbbbbb2']);
  clean(dir);
});

test('add 非法 status 被拒', () => {
  const { dir, P } = setup();
  assert.throws(() => cmds.add({ _: ['P01'], title: 'x', status: '瞎写', ...P }), /status/);
  clean(dir);
});

test('decide 答案不在选项被拒', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.pending({ _: ['P01'], q: 'A?', opt: ['A', 'B'], rec: 'B', strict: true,
    background: '【场景】这是单元测试用的背景描述文字需要够长才能通过校验器所以我在这里多写一些占位内容以确保。【问题】用于占位以通过 skill 六点二的字数最小值检查。【要做的事】占位。【为什么重要】占位。',
    'pros-A': '【好处】A 的好处描述。【代价】A 的代价描述在这里。',
    'pros-B': '【好处】B 的好处描述。【代价】B 的代价描述在这里。',
    reason: '推荐 B 的理由描述需要写得足够长才能通过校验器所以我在这里多写一些内容占位。',
    ...P });
  assert.throws(() => cmds.decide({ _: ['P01'], did: 'd1', answer: 'C', ...P }), /选项|options/);
  clean(dir);
});

test('block 引用不存在 task 被拒（引用完整性）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  assert.throws(() => cmds.block({ _: ['P01'], by: 'P99', reason: 'r', ...P }), /P99|不存在/);
  clean(dir);
});

test('list 读时派生统计正确', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'a', status: '已完工', ...P });
  cmds.add({ _: ['P02'], title: 'b', ...P });
  assert.ok(cmds.list({ ...P }).text.includes('进度 50%'));
  clean(dir);
});

test('park 转暂缓并记理由', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  const b = cmds.park({ _: ['P01'], reason: '等上游', ...P });
  assert.equal(b.task.status, '暂缓');
  assert.equal(b.task.blockReason, '等上游');
  clean(dir);
});

test('sync-progress 按分支找施工中任务、只进不退、封顶 95', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'feat-x', ...P });
  // 显式传 --branch 免得读到真实 git 分支
  let b = cmds.syncProgress({ _: [], branch: 'feat-x', percent: '40', ...P });
  assert.equal(b.task.percent, 40, '首次同步应设 40');
  assert.ok((b.task).lastProgressAt, '应盖进度时间戳');
  // 只进不退:报更低时跳过(不覆盖、无 task 字段)
  const r = cmds.syncProgress({ _: [], branch: 'feat-x', percent: '20', ...P });
  assert.ok(r.skipped, '报更低应被跳过(只进不退)');
  // 封顶 95:待办全完成=100 也只到 95(真完工靠 cli done)
  b = cmds.syncProgress({ _: [], branch: 'feat-x', percent: '100', ...P });
  assert.equal(b.task.percent, 95, '自动进度封顶 95');
  clean(dir);
});

test('sync-progress 无匹配分支/无施工中任务时静默跳过、不写坏数据', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'feat-x', ...P });
  const r = cmds.syncProgress({ _: [], branch: 'other-branch', percent: '50', ...P });
  assert.ok(r.skipped, '分支不匹配应跳过');
  clean(dir);
});
