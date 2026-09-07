'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cmds = require('../cli/commands.cjs');
const { inbox } = require('../cli/inboxCmd.cjs');

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

test('park 后不经 unpark 直接 claim 被拒', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.park({ _: ['P01'], reason: '等上游', ...P });
  assert.throws(() => cmds.claim({ _: ['P01'], branch: 'b', ...P }), /非法迁移/);
  clean(dir);
});

test('unpark 清除暂缓信息、记录解除依据和流水后能 claim', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.park({ _: ['P01'], reason: '等上游', note: '遗留A', ...P });
  const { task } = cmds.unpark({ _: ['P01'], reason: '上游已就绪', author: 'tester', ...P });
  assert.equal(task.status, '可复工');
  assert.equal(task.blockReason, undefined);
  assert.equal(task.parkedNote, undefined);
  assert.equal(task.unparkReason, '上游已就绪');
  assert.match(task.unparkedAt, /^\d{4}-\d{2}-\d{2}$/);
  const { readBoard } = require('../cli/store.cjs');
  const { resolveProject } = require('../core/resolveProject.cjs');
  const proj = resolveProject(P.project, { registryPath: P.registry });
  const activity = readBoard(proj.board).activity.filter((a) => a.type === 'unpark');
  assert.equal(activity.length, 1);
  assert.equal(activity[0].taskId, 'P01');
  assert.equal(activity[0].author, 'tester');
  assert.equal(activity[0].text, '复工 P01：上游已就绪');
  assert.equal(cmds.claim({ _: ['P01'], branch: 'b', ...P }).task.status, '施工中');
  clean(dir);
});

test('unpark 非暂缓卡被拒', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  assert.throws(() => cmds.unpark({ _: ['P01'], reason: '上游已就绪', ...P }), /非法迁移/);
  clean(dir);
});

test('unpark 缺卡号或解除依据被拒', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.park({ _: ['P01'], reason: '等上游', ...P });
  assert.throws(() => cmds.unpark({ _: [], reason: '上游已就绪', ...P }), /缺参数.*unpark/);
  assert.throws(() => cmds.unpark({ _: ['P01'], ...P }), /缺参数.*--reason/);
  clean(dir);
});

test('再次 park 会抹掉上一轮的解除依据（不留两套说法）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.park({ _: ['P01'], reason: '等上游', ...P });
  cmds.unpark({ _: ['P01'], reason: '上游已就绪', ...P });
  const { task } = cmds.park({ _: ['P01'], reason: '又被别的卡挡住', ...P });
  assert.equal(task.status, '暂缓');
  assert.equal(task.blockReason, '又被别的卡挡住');
  assert.equal(task.unparkReason, undefined);
  assert.equal(task.unparkedAt, undefined);
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

test('inbox 无 tid 列出待落地任务；给 tid 打印完整任务书含 claim/mark-landed/波次警告', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P10'], title: '不变量集成', ...P });
  const bg = '【场景】这是单测背景需要够长以通过校验器所以多写一些占位内容确保达标凑够六十字这里继续补充。【问题】占位。【要做】占位。【为什么】占位。';
  cmds.pending({ _: ['P10'], q: '要不要豁免?', opt: ['豁免', '不豁免'], rec: '不豁免', strict: true,
    background: bg, 'pros-豁免': '【好处】豁免的好处描述在这里。【代价】豁免的代价描述在这里。',
    'pros-不豁免': '【好处】不豁免的好处描述。【代价】不豁免的代价描述。',
    reason: '推荐不豁免的理由需要写得足够长才能通过校验器所以我多写一些占位内容。', ...P });
  cmds.decide({ _: ['P10'], did: 'd1', answer: '不豁免', ...P });
  // 无 tid → 列表含 P10
  const list = inbox({ ...P });
  assert.match(list.text, /P10/, '列表应含 P10');
  assert.match(list.text, /待落地任务/, '应是列表标题');
  // 给 tid → 完整任务书
  const book = inbox({ tid: 'P10', ...P });
  assert.match(book.text, /claim P10/, '任务书含 claim 命令');
  assert.match(book.text, /mark-landed P10 --did d1/, '任务书含逐条 mark-landed');
  assert.match(book.text, /wave.*默认留 0|新任务从 0 起/, '任务书含波次警告');
  clean(dir);
});

test('inbox 决策已落地后不再出现在待落地', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P10'], title: 'x', ...P });
  const bg = '【场景】这是单测背景需要够长以通过校验器所以多写一些占位内容确保达标凑够六十字这里继续补充。【问题】占位。【要做】占位。【为什么】占位。';
  cmds.pending({ _: ['P10'], q: 'Q?', opt: ['A', 'B'], rec: 'B', strict: true,
    background: bg, 'pros-A': '【好处】A好处描述在这里。【代价】A代价描述在这里。',
    'pros-B': '【好处】B好处描述在这里。【代价】B代价描述在这里。',
    reason: '推荐B的理由需要写得足够长才能通过校验器所以多写一些占位内容凑字数。', ...P });
  cmds.decide({ _: ['P10'], did: 'd1', answer: 'B', ...P });
  cmds.markLanded({ _: ['P10'], did: 'd1', ...P });
  const list = inbox({ ...P });
  assert.match(list.text, /没有待落地任务/, '全落地后列表应空');
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

// ---------------------------------------------------------------------------
// note 的卡号绑定（治本：静默丢弃 → 要么挂上、要么报错）
// 病根：note 原先只读 flags.task，位置参数落进 flags._[0] 从没被碰过；
// 而 claim/progress/done 都吃位置参数 —— 同一个 CLI 两种约定，写错不报错、
// 退出码 0、CLI 照常打印 ✔，note 却挂在 taskId=null 上，任何卡都看不到。
// 实测存量：某项目 1177 条 note 里 409 条（34.7%）是这样变成孤儿的。
// ---------------------------------------------------------------------------

function _notes(P) {
  const { readBoard } = require('../cli/store.cjs');
  const { resolveProject } = require('../core/resolveProject.cjs');
  const proj = resolveProject(P.project, { registryPath: P.registry });
  return readBoard(proj.board).activity.filter((a) => a.type === 'note');
}

test('note 位置参数写卡号也能挂上卡（与 claim/progress/done 约定一致）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.note({ _: ['P01'], text: '位置参数写法', ...P });
  const n = _notes(P).filter((a) => a.text === '位置参数写法');
  assert.equal(n.length, 1);
  assert.equal(n[0].taskId, 'P01', 'note 的卡号被静默丢弃了');
  clean(dir);
});

test('note --task 写法保持不变（回归）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.note({ task: 'P01', text: 'flag 写法', ...P });
  assert.equal(_notes(P).find((a) => a.text === 'flag 写法').taskId, 'P01');
  clean(dir);
});

test('note 卡号不存在要报错，且一条都不许落盘', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  const 之前 = _notes(P).length;
  assert.throws(() => cmds.note({ task: 'P99', text: '打错卡号', ...P }), /P99/);
  assert.equal(_notes(P).length, 之前, '校验失败却把 note 写进去了');
  clean(dir);
});

test('note 位置参数与 --task 同时给且不一致要报错（防歧义）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.add({ _: ['P02'], title: 'y', ...P });
  assert.throws(() => cmds.note({ _: ['P01'], task: 'P02', text: '两个卡号', ...P }), /P01|P02/);
  clean(dir);
});

test('note 两处都写同一个卡号是允许的（不算歧义）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.note({ _: ['P01'], task: 'P01', text: '一致', ...P });
  assert.equal(_notes(P).find((a) => a.text === '一致').taskId, 'P01');
  clean(dir);
});

test('note 不给卡号仍可写项目级留言（向后兼容，taskId 为 null）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.note({ text: '项目级留言', ...P });
  assert.equal(_notes(P).find((a) => a.text === '项目级留言').taskId, null);
  clean(dir);
});

test('note --task 后面漏写值要报错，不许当成没给卡号', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  assert.throws(() => cmds.note({ task: true, text: '漏写值', ...P }), /task/);
  clean(dir);
});

// ---------------------------------------------------------------------------
// DECIDE-LEAVES-STATUS-STALE —— 答完最后一条决策，卡就该自己从「待拍板」走到「已拍板」。
// 为什么翻默认：负责人拍板走的是网页那条路，而 server 的 /api/decide 从来不带 --promote，
// 于是拍完板卡还挂着「待拍板」，要有人记得手工 `set` 一次才对得上事实。靠人记 = 必失守，
// 看板于是长期落后于事实（skill §0「看板状态永不落后于事实」正是要防这个）。
// 想让卡继续留在「待拍板」的，用 --no-promote。
// ---------------------------------------------------------------------------

/** 给某卡挂一条合规的待拍板（三件套齐全，过 §6.2 校验）。 */
function addPending(P, id, q) {
  return cmds.pending({ _: [id], q, opt: ['A', 'B'], rec: 'B',
    background: '【场景】这是单元测试用的背景描述文字需要够长才能通过校验器所以我在这里多写一些占位内容以确保。【问题】用于占位以通过 skill 六点二的字数最小值检查。【要做的事】占位。【为什么重要】占位。',
    'pros-A': '【好处】A 的好处。【代价】A 的代价描述在这里。',
    'pros-B': '【好处】B 的好处。【代价】B 的代价描述在这里。',
    reason: '推荐 B 的理由描述需要写得足够长才能通过校验器所以我在这里多写一些内容占位。',
    ...P });
}

test('decide：答完最后一条 → 默认自动 待拍板→已拍板（不必记得加 --promote）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  assert.equal(addPending(P, 'P01', 'A?').task.status, '待拍板');
  assert.equal(cmds.decide({ _: ['P01'], did: 'd1', answer: 'B', ...P }).task.status, '已拍板');
  clean(dir);
});

test('decide：还有没答完的决策 → 状态不动（只答一条不算拍完板）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  addPending(P, 'P01', '第一问?');
  addPending(P, 'P01', '第二问?');
  const after1 = cmds.decide({ _: ['P01'], did: 'd1', answer: 'B', ...P }).task;
  assert.equal(after1.status, '待拍板', '还剩 d2 没答，不许前进');
  assert.equal(cmds.decide({ _: ['P01'], did: 'd2', answer: 'A', ...P }).task.status, '已拍板', '最后一条答完才前进');
  clean(dir);
});

test('decide --no-promote：显式要求留在待拍板时不动状态', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  addPending(P, 'P01', 'A?');
  const t = cmds.decide({ _: ['P01'], did: 'd1', answer: 'B', 'no-promote': true, ...P }).task;
  assert.equal(t.status, '待拍板');
  assert.equal(t.decisions[0].answer, 'B', '答案照样落库，只是不动状态');
  clean(dir);
});

test('decide：卡不在「待拍板」时一律不动状态（施工中的卡拍板不该被拽回去）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  addPending(P, 'P01', 'A?');
  cmds.claim({ _: ['P01'], branch: 'br1', ...P });
  assert.equal(cmds.decide({ _: ['P01'], did: 'd1', answer: 'B', ...P }).task.status, '施工中');
  clean(dir);
});

// ===========================================================================
// 卡的一生缺的四个动作（审计 §4-A5/A6/A7/C1）
//   unclaim 放弃认领 / cancel 作废 / reopen 重开 / edit 改卡面
// 病根：CLI 只有「往前走」的命令。对话一中断，卡就永远挂着「施工中」；
// 方案被否了没地方记，只能留着假装还要做；写错标题只能裸 set 绕过所有校验。
// ===========================================================================

function _board(P) {
  const { readBoard } = require('../cli/store.cjs');
  const { resolveProject } = require('../core/resolveProject.cjs');
  return readBoard(resolveProject(P.project, { registryPath: P.registry }).board);
}
function _acts(P, type) { return _board(P).activity.filter((a) => a.type === type); }

// ---------------------------- unclaim ----------------------------

test('unclaim：施工中 → 待开工，摘掉本次分支并留痕', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'feat-a', ...P });
  const { task } = cmds.unclaim({ _: ['P01'], branch: 'feat-a', reason: '对话中断，交回', author: 'tester', ...P });
  assert.equal(task.status, '待开工');
  assert.deepEqual(task.gitBranch, [], '本次分支应从占用里摘掉');
  assert.equal(task.unclaimReason, '对话中断，交回');
  assert.match(task.unclaimedAt, /^\d{4}-\d{2}-\d{2}$/);
  const a = _acts(P, 'unclaim');
  assert.equal(a.length, 1);
  assert.equal(a[0].taskId, 'P01');
  assert.equal(a[0].author, 'tester');
  assert.match(a[0].text, /对话中断，交回/);
  clean(dir);
});

test('unclaim：只摘自己那条分支，别人的分支留着', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'feat-a', ...P });
  cmds.claim({ _: ['P01'], branch: 'feat-b', ...P });
  const { task } = cmds.unclaim({ _: ['P01'], branch: 'feat-b', reason: '这条分支不做了', ...P });
  assert.deepEqual(task.gitBranch, ['feat-a']);
  clean(dir);
});

test('unclaim：暂缓解除后认领的卡，退回「可复工」而不是「待开工」', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.park({ _: ['P01'], reason: '等上游', ...P });
  cmds.unpark({ _: ['P01'], reason: '上游好了', ...P });
  cmds.claim({ _: ['P01'], branch: 'feat-a', ...P });
  assert.equal(cmds.unclaim({ _: ['P01'], reason: '没接着做', ...P }).task.status, '可复工');
  clean(dir);
});

test('unclaim：保留已报的进度（做到一半没人接，是有价值的信息）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'feat-a', ...P });
  cmds.progress({ _: ['P01'], percent: '60', ...P });
  assert.equal(cmds.unclaim({ _: ['P01'], reason: '交回', ...P }).task.percent, 60);
  clean(dir);
});

test('unclaim：非施工中的卡被拒', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  assert.throws(() => cmds.unclaim({ _: ['P01'], reason: 'r', ...P }), /非法迁移/);
  clean(dir);
});

test('unclaim：缺卡号或理由被拒', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'feat-a', ...P });
  assert.throws(() => cmds.unclaim({ _: [], reason: 'r', ...P }), /缺参数.*unclaim/);
  assert.throws(() => cmds.unclaim({ _: ['P01'], ...P }), /缺参数.*--reason/);
  clean(dir);
});

test('unclaim 后可以再次 claim（这才是它存在的意义）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'feat-a', ...P });
  cmds.unclaim({ _: ['P01'], branch: 'feat-a', reason: '交回', ...P });
  assert.equal(cmds.claim({ _: ['P01'], branch: 'feat-b', ...P }).task.status, '施工中');
  clean(dir);
});

// ---------------------------- cancel ----------------------------

test('cancel：任意状态 → 已作废，记理由并留痕', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'feat-a', ...P });
  const { task } = cmds.cancel({ _: ['P01'], reason: '方案被否，不做了', author: 'tester', ...P });
  assert.equal(task.status, '已作废');
  assert.equal(task.cancelReason, '方案被否，不做了');
  assert.match(task.cancelledAt, /^\d{4}-\d{2}-\d{2}$/);
  const a = _acts(P, 'cancel');
  assert.equal(a.length, 1);
  assert.equal(a[0].taskId, 'P01');
  assert.match(a[0].text, /方案被否/);
  clean(dir);
});

test('cancel：不写完工日期（作废不是完工）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  const { task } = cmds.cancel({ _: ['P01'], reason: '不做了', ...P });
  assert.equal(task.dates.done, null);
  clean(dir);
});

test('cancel：抹掉暂缓/放弃认领留下的旧说法（show 出来不许两套并存）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.park({ _: ['P01'], reason: '等上游', note: '遗留A', ...P });
  const { task } = cmds.cancel({ _: ['P01'], reason: '干脆不做了', ...P });
  assert.equal(task.blockReason, undefined);
  assert.equal(task.parkedNote, undefined);
  clean(dir);
});

test('cancel：缺理由被拒', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  assert.throws(() => cmds.cancel({ _: ['P01'], ...P }), /缺参数.*--reason/);
  clean(dir);
});

test('作废卡不计入完成度分母（一张完工一张作废 = 100%）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'a', status: '已完工', ...P });
  cmds.add({ _: ['P02'], title: 'b', ...P });
  cmds.cancel({ _: ['P02'], reason: '不做了', ...P });
  const s = cmds.deriveStats(_board(P));
  assert.equal(s.total, 1, '分母应把作废卡排除');
  assert.equal(s.done, 1);
  assert.equal(s.progress, 100);
  assert.ok(cmds.list({ ...P }).text.includes('进度 100%'));
  clean(dir);
});

test('作废卡仍出现在状态分布里（排除的是分母，不是这张卡本身）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'a', ...P });
  cmds.cancel({ _: ['P01'], reason: '不做了', ...P });
  assert.equal(cmds.deriveStats(_board(P)).byStatus['已作废'], 1);
  assert.ok(cmds.list({ ...P }).text.includes('P01'));
  clean(dir);
});

test('claim 已作废卡被拒，并提示先 reopen', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.cancel({ _: ['P01'], reason: '不做了', ...P });
  assert.throws(() => cmds.claim({ _: ['P01'], branch: 'b', ...P }), /reopen/);
  clean(dir);
});

// ---------------------------- reopen ----------------------------

test('reopen：已完工 → 待开工，进度归零、完工日期清空', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'feat-a', ...P });
  cmds.done({ _: ['P01'], commit: 'a1b2c3d', ...P });
  const { task } = cmds.reopen({ _: ['P01'], reason: '验收没过，返工', author: 'tester', ...P });
  assert.equal(task.status, '待开工');
  assert.equal(task.percent, 0);
  assert.equal(task.dates.done, null);
  assert.equal(task.reopenReason, '验收没过，返工');
  assert.match(task.reopenedAt, /^\d{4}-\d{2}-\d{2}$/);
  clean(dir);
});

test('reopen：活动流留着历史（完工那条不许抹）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.done({ _: ['P01'], ...P });
  cmds.reopen({ _: ['P01'], reason: '返工', ...P });
  assert.equal(_acts(P, 'done').length, 1, '完工历史被抹了');
  assert.equal(_acts(P, 'reopen').length, 1);
  clean(dir);
});

test('reopen：已作废 → 待开工，抹掉作废理由', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.cancel({ _: ['P01'], reason: '当时觉得不做了', ...P });
  const { task } = cmds.reopen({ _: ['P01'], reason: '又要做了', ...P });
  assert.equal(task.status, '待开工');
  assert.equal(task.cancelReason, undefined);
  assert.equal(task.cancelledAt, undefined);
  clean(dir);
});

test('reopen：PR / commit / 拍板记录都留着（重开不是重建）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  addPending(P, 'P01', 'A?');
  cmds.decide({ _: ['P01'], did: 'd1', answer: 'B', ...P });
  cmds.done({ _: ['P01'], pr: '24', commit: 'a1b2c3d', ...P });
  const { task } = cmds.reopen({ _: ['P01'], reason: '返工', ...P });
  assert.deepEqual(task.prNumbers, [24]);
  assert.deepEqual(task.commitShas, ['a1b2c3d']);
  assert.equal(task.decisions[0].answer, 'B');
  clean(dir);
});

test('reopen：非终态卡被拒（施工中的卡没什么可重开）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'b', ...P });
  assert.throws(() => cmds.reopen({ _: ['P01'], reason: 'r', ...P }), /非法迁移/);
  clean(dir);
});

test('reopen：缺理由被拒', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.done({ _: ['P01'], ...P });
  assert.throws(() => cmds.reopen({ _: ['P01'], ...P }), /缺参数.*--reason/);
  clean(dir);
});

test('reopen 后能重新 claim', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.done({ _: ['P01'], ...P });
  cmds.reopen({ _: ['P01'], reason: '返工', ...P });
  assert.equal(cmds.claim({ _: ['P01'], branch: 'b2', ...P }).task.status, '施工中');
  clean(dir);
});

// ---------------------------- edit ----------------------------

test('edit：改标题 / 人话标题 / 说明 / 档位 / 波次', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: '旧技术说明', ...P });
  const { task } = cmds.edit({ _: ['P01'], title: '新技术说明', 'plain-title': '一句人话讲清这张卡在干嘛',
    desc: '一句话说明', model: 'opus·中', wave: '2', ...P });
  assert.equal(task.title, '新技术说明');
  assert.equal(task.plainTitle, '一句人话讲清这张卡在干嘛');
  assert.equal(task.description, '一句话说明');
  assert.equal(task.modelHint, 'opus·中');
  assert.equal(task.wave, 2);
  assert.equal(_acts(P, 'note').filter((a) => /^edit P01/.test(a.text || '')).length, 1, '改卡面要留痕');
  clean(dir);
});

test('edit：只改给了的字段，没给的不动', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'T', 'plain-title': '原来的人话标题写在这里', model: 'sonnet·低', wave: '3', ...P });
  const { task } = cmds.edit({ _: ['P01'], title: 'T2', ...P });
  assert.equal(task.title, 'T2');
  assert.equal(task.plainTitle, '原来的人话标题写在这里');
  assert.equal(task.modelHint, 'sonnet·低');
  assert.equal(task.wave, 3);
  clean(dir);
});

test('edit：一个字段都不给要报错（免得空写一条流水）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'T', ...P });
  const 之前 = _board(P).activity.length;
  assert.throws(() => cmds.edit({ _: ['P01'], ...P }), /至少给一个/);
  assert.equal(_board(P).activity.length, 之前, '被拒还写了流水');
  clean(dir);
});

test('edit：带校验（空标题 / 超长档位 / 负波次 / 空人话标题一律拒）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'T', ...P });
  assert.throws(() => cmds.edit({ _: ['P01'], title: '  ', ...P }), /--title/);
  assert.throws(() => cmds.edit({ _: ['P01'], model: 'x'.repeat(41), ...P }), /--model/);
  assert.throws(() => cmds.edit({ _: ['P01'], wave: '-1', ...P }), /--wave/);
  assert.throws(() => cmds.edit({ _: ['P01'], wave: 'abc', ...P }), /--wave/);
  assert.throws(() => cmds.edit({ _: ['P01'], 'plain-title': '   ', ...P }), /--plain-title/);
  clean(dir);
});

test('edit：--desc 允许清空（说明写错了要能删掉）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'T', desc: '写错的说明', ...P });
  assert.equal(cmds.edit({ _: ['P01'], desc: '', ...P }).task.description, '');
  clean(dir);
});

test('edit：flag 后面漏写值要报错，不许当成空字符串写进去', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'T', ...P });
  assert.throws(() => cmds.edit({ _: ['P01'], title: true, ...P }), /--title/);
  clean(dir);
});

// ---------------------------- mark-landed --all ----------------------------

test('mark-landed --all：本卡所有已拍板未落地的决策一次标完', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P10'], title: 'x', ...P });
  addPending(P, 'P10', '第一问?');
  addPending(P, 'P10', '第二问?');
  cmds.decide({ _: ['P10'], did: 'd1', answer: 'B', ...P });
  cmds.decide({ _: ['P10'], did: 'd2', answer: 'A', ...P });
  const r = cmds.markLanded({ _: ['P10'], all: true, commit: 'a1b2c3d', ...P });
  assert.deepEqual(r.landed, ['d1', 'd2']);
  for (const d of r.task.decisions) {
    assert.equal(d.landed, true);
    assert.equal(d.landedCommit, 'a1b2c3d');
  }
  clean(dir);
});

test('mark-landed --all：跳过还没拍板的决策', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P10'], title: 'x', ...P });
  addPending(P, 'P10', '第一问?');
  addPending(P, 'P10', '第二问?');
  cmds.decide({ _: ['P10'], did: 'd1', answer: 'B', ...P });
  const r = cmds.markLanded({ _: ['P10'], all: true, ...P });
  assert.deepEqual(r.landed, ['d1']);
  assert.equal(r.task.decisions[1].landed, undefined, '没拍板的不许标落地');
  clean(dir);
});

test('mark-landed --all：一条可标的都没有时报错（免得写空流水）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P10'], title: 'x', ...P });
  assert.throws(() => cmds.markLanded({ _: ['P10'], all: true, ...P }), /没有.*落地|无/);
  clean(dir);
});

test('mark-landed 逐条写法保持不变（回归）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P10'], title: 'x', ...P });
  addPending(P, 'P10', 'A?');
  cmds.decide({ _: ['P10'], did: 'd1', answer: 'B', ...P });
  assert.equal(cmds.markLanded({ _: ['P10'], did: 'd1', ...P }).task.decisions[0].landed, true);
  clean(dir);
});

// ------------------- done 自动落地 / collect 不冒充完工（审计 A6/A7）-------------------

test('done：本卡已拍板未落地的决策自动标落地，并在输出里列出来', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P10'], title: 'x', ...P });
  addPending(P, 'P10', '第一问?');
  addPending(P, 'P10', '第二问?');
  cmds.decide({ _: ['P10'], did: 'd1', answer: 'B', ...P });
  cmds.decide({ _: ['P10'], did: 'd2', answer: 'A', ...P });
  const r = cmds.done({ _: ['P10'], commit: 'a1b2c3d', ...P });
  assert.deepEqual(r.landed, ['d1', 'd2']);
  assert.match(r.text, /d1.*d2|d1, d2/, '输出要列出顺带标了哪几条');
  for (const d of r.task.decisions) {
    assert.equal(d.landed, true);
    assert.equal(d.landedCommit, 'a1b2c3d', '落地提交号取本次 --commit');
  }
  clean(dir);
});

test('done：没拍板的决策不会被顺带标落地', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P10'], title: 'x', ...P });
  addPending(P, 'P10', '还没答的问题?');
  const r = cmds.done({ _: ['P10'], ...P });
  assert.deepEqual(r.landed, []);
  assert.equal(r.task.decisions[0].landed, undefined);
  clean(dir);
});

test('done：已经标过落地的决策不被本次提交号覆盖', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P10'], title: 'x', ...P });
  addPending(P, 'P10', 'A?');
  cmds.decide({ _: ['P10'], did: 'd1', answer: 'B', ...P });
  cmds.markLanded({ _: ['P10'], did: 'd1', commit: 'aaaaaa1', ...P });
  const r = cmds.done({ _: ['P10'], commit: 'bbbbbb2', ...P });
  assert.deepEqual(r.landed, []);
  assert.equal(r.task.decisions[0].landedCommit, 'aaaaaa1');
  clean(dir);
});

test('done：没有可顺带落地的决策时，输出保持原样', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  const r = cmds.done({ _: ['P01'], ...P });
  assert.equal(r.text, undefined, '没东西可报就别改输出格式');
  clean(dir);
});

test('done --collect：进「收官」但不冒充完工（不写完工日期、不写 100%）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'b', ...P });
  cmds.progress({ _: ['P01'], percent: '80', ...P });
  const { task } = cmds.done({ _: ['P01'], collect: true, ...P });
  assert.equal(task.status, '收官');
  assert.equal(task.dates.done, null, '收官不是完工，不许写完工日期');
  assert.equal(task.percent, 80, '收官不许把进度篡改成 100');
  clean(dir);
});

test('done --collect：PR / commit 照常记（收官阶段的产物要留）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  const { task } = cmds.done({ _: ['P01'], collect: true, pr: '24', commit: 'a1b2c3d', ...P });
  assert.deepEqual(task.prNumbers, [24]);
  assert.deepEqual(task.commitShas, ['a1b2c3d']);
  clean(dir);
});

test('done 真完工照旧写完工日期与 100%（回归）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  const { task } = cmds.done({ _: ['P01'], ...P });
  assert.equal(task.status, '已完工');
  assert.equal(task.percent, 100);
  assert.match(task.dates.done, /^\d{4}-\d{2}-\d{2}$/);
  clean(dir);
});

// ------------------- progress 对终态卡拒收（审计 A7）-------------------

test('progress：已完工的卡拒收，并提示先 reopen', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.done({ _: ['P01'], ...P });
  assert.throws(() => cmds.progress({ _: ['P01'], percent: '50', ...P }), /reopen/);
  assert.equal(_board(P).tasks[0].percent, 100, '被拒还是把进度写进去了');
  clean(dir);
});

test('progress：已作废的卡拒收，并提示先 reopen', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.cancel({ _: ['P01'], reason: '不做了', ...P });
  assert.throws(() => cmds.progress({ _: ['P01'], percent: '50', ...P }), /reopen/);
  clean(dir);
});

test('progress：收官中的卡照常可以报进度（收官不是终态）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.done({ _: ['P01'], collect: true, ...P });
  assert.equal(cmds.progress({ _: ['P01'], percent: '90', ...P }).task.percent, 90);
  clean(dir);
});

// ------------------- 施工中挂起要看得见（审计 A7）-------------------

test('pending：施工中的卡登记待拍板，下一步里程碑写成「等拍板：…」', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'b', ...P });
  cmds.progress({ _: ['P01'], percent: '40', next: '接着写接口', ...P });
  const { task } = addPending(P, 'P01', '接口要不要兼容旧字段?');
  assert.equal(task.status, '施工中', '施工中不因登记待拍板而倒退');
  assert.match(task.nextMilestone, /^等拍板：/);
  assert.match(task.nextMilestone, /接口要不要兼容旧字段/);
  clean(dir);
});

test('pending：未开工的卡照旧转「待拍板」，不动下一步（回归）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  const { task } = addPending(P, 'P01', 'A?');
  assert.equal(task.status, '待拍板');
  assert.equal(task.nextMilestone, undefined);
  clean(dir);
});

test('pending：问题太长时下一步里程碑截断（卡片上塞不下整段）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.claim({ _: ['P01'], branch: 'b', ...P });
  const { task } = addPending(P, 'P01', '问'.repeat(80) + '?');
  assert.ok(task.nextMilestone.length <= 45, `太长了：${task.nextMilestone.length}`);
  assert.match(task.nextMilestone, /…$/);
  clean(dir);
});

test('reopen 后再放弃认领，退回「待开工」而不是「可复工」（重开=全新一轮）', () => {
  const { dir, P } = setup();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  cmds.park({ _: ['P01'], reason: '等上游', ...P });
  cmds.unpark({ _: ['P01'], reason: '上游好了', ...P });
  cmds.claim({ _: ['P01'], branch: 'b1', ...P });
  cmds.done({ _: ['P01'], ...P });
  const reopened = cmds.reopen({ _: ['P01'], reason: '返工', ...P }).task;
  assert.equal(reopened.unparkReason, undefined, '重开没抹掉上一轮的解冻依据');
  cmds.claim({ _: ['P01'], branch: 'b2', ...P });
  assert.equal(cmds.unclaim({ _: ['P01'], reason: '又没做', ...P }).task.status, '待开工');
  clean(dir);
});
