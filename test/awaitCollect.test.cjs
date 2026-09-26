'use strict';
// 「待收单」状态闭环(DASH-STATUS-AWAIT-COLLECT-0924):
//   schema 枚举 → await-collect 迁移与交活登记 → claim 收回再交 → claimCheck 放行 →
//   协议卡 → 收单指令触发句 → 前端接线 → 开工三查与并行清单口径。
// 夹具照 protocol.test.cjs 的隔离 registry/board 模式;项目 id 一律 myproj(不写真实路径/项目名)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { STATUS, STATUS_EMOJI, VOID_STATUSES, emptyBoard, validate } = require('../core/boardSchema.cjs');
const { SETTLED_STATUSES } = require('../core/taskSignal.cjs');
const {
  COLLECT_OUTCOMES, OUTCOME_TEXT, COLLECT_TRIGGER_TEMPLATE, NO_JOBS_TEXT, COLLECT_BRIEF_MAX,
  collectInstructionOf, hasCollectBrief,
} = require('../core/collectTrigger.cjs');
const { scanAll } = require('../cli/claimCheck.cjs');
const { buildParallelPlan } = require('../server/parallelPlan.cjs');
const { protocol } = require('../cli/protocol.cjs');
const { COMMANDS } = require('../cli/help.cjs');
const { precheck } = require('../cli/precheck.cjs');
const cmds = require('../cli/commands.cjs');

const readBoard = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const taskOf = (file, id) => readBoard(file).tasks.find((t) => t.id === id);

function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'await-collect-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  cmds.register({ id: 'myproj', name: 'myproj', root: repo, registry: reg });
  return { dir, repo, reg, P: { project: 'myproj', registry: reg }, board: path.join(repo, '.dashboard', 'board.json') };
}

/** 建卡 → 认领 → (可选报进度),站在「施工中」这一格,await-collect 的合法起点。 */
function startWorking(f, id = 'AC1', branch = 'feat/ac1') {
  cmds.add({ ...f.P, _: [id], title: id });
  cmds.claim({ ...f.P, _: [id], branch, scope: 'cli/x.cjs' });
  return id;
}

// ---------------------------------------------------------------- T1 schema 层

test('T1 · 待收单在 STATUS 枚举里紧跟可复工,emoji 显式登记,不算作废也不算已了结', () => {
  assert.ok(STATUS.includes('待收单'), 'STATUS 枚举缺「待收单」');
  assert.equal(STATUS[STATUS.indexOf('待收单') - 1], '可复工');
  assert.equal(STATUS[STATUS.indexOf('待收单') + 1], '收官');
  assert.equal(STATUS_EMOJI['待收单'], '📥', 'STATUS_EMOJI 缺「待收单」显式条目');
  assert.ok(!VOID_STATUSES.includes('待收单'), '待收单不是作废态,要计入完成度分母');
  assert.ok(!SETTLED_STATUSES.includes('待收单'), '待收单不算已了结,仍占着分支');
});

// ---------------------------------------------------------------- T2 基本迁移

test('T2 · await-collect 从施工中转待收单:记 since/jobs,lastProgressAt 盖戳,进度分支不动,活动流留痕', (t) => {
  const f = setup(t);
  startWorking(f);
  cmds.progress({ ...f.P, _: ['AC1'], percent: 80 });
  const before = taskOf(f.board, 'AC1');
  const res = cmds.awaitCollect({
    ...f.P, _: ['AC1'], job: 'job-a', outcome: 'finished',
    'finished-at': '2026-09-24T10:00:00Z', engine: 'codex',
  });
  assert.equal(res.ok, true);
  assert.match(res.text, /await-collect AC1 → 待收单/);
  assert.match(res.text, /【会话种类:收单员 · Sonnet】收单卡 AC1\(看板项目 myproj\)/);
  for (const key of ['status', 'awaitCollect']) assert.ok(res.changed.includes(key), `changed 缺 ${key}`);
  for (const key of ['percent', 'gitBranch', 'fileScope']) assert.ok(!res.changed.includes(key), `changed 不该有 ${key}`);
  const task = taskOf(f.board, 'AC1');
  assert.equal(task.status, '待收单');
  assert.ok(!Number.isNaN(Date.parse(task.awaitCollect.since)), 'since 应是可解析的时刻');
  assert.deepEqual(task.awaitCollect.jobs, [
    { slug: 'job-a', outcome: 'finished', finishedAt: '2026-09-24T10:00:00Z', engine: 'codex' },
  ]);
  assert.equal(task.percent, before.percent, '进度不动');
  assert.deepEqual(task.gitBranch, ['feat/ac1'], '分支不动');
  assert.ok(task.lastProgressAt >= before.lastProgressAt, 'lastProgressAt 总写');
  const last = readBoard(f.board).activity.at(-1);
  assert.equal(last.type, 'await-collect');
  assert.equal(last.taskId, 'AC1');
  assert.match(last.text, /工单 job-a 正常交活/);
});

// ------------------------------------------------- T3 追加工单 / 同名覆盖

test('T3 · 已是待收单再交活:新工单追加,同名工单就地覆盖且 since 不重置', (t) => {
  const f = setup(t);
  startWorking(f);
  cmds.awaitCollect({ ...f.P, _: ['AC1'], job: 'job-a', outcome: 'finished', 'finished-at': '2026-09-24T08:00:00Z' });
  const first = taskOf(f.board, 'AC1');
  cmds.awaitCollect({ ...f.P, _: ['AC1'], job: 'job-b', outcome: 'timeout', 'finished-at': '2026-09-24T09:00:00Z', engine: 'glm' });
  let task = taskOf(f.board, 'AC1');
  assert.equal(task.awaitCollect.since, first.awaitCollect.since, '没离开过待收单,since 不重置');
  assert.deepEqual(task.awaitCollect.jobs, [
    { slug: 'job-a', outcome: 'finished', finishedAt: '2026-09-24T08:00:00Z' },
    { slug: 'job-b', outcome: 'timeout', finishedAt: '2026-09-24T09:00:00Z', engine: 'glm' },
  ]);
  // 同一张卡同一张工单续聊又交了一次:覆盖 outcome/finishedAt,engine 不传则保留旧值
  cmds.awaitCollect({ ...f.P, _: ['AC1'], job: 'job-b', outcome: 'failed', 'finished-at': '2026-09-24T09:30:00Z' });
  task = taskOf(f.board, 'AC1');
  assert.deepEqual(task.awaitCollect.jobs[1], { slug: 'job-b', outcome: 'failed', finishedAt: '2026-09-24T09:30:00Z', engine: 'glm' });
  assert.equal(task.awaitCollect.jobs.length, 2, '同名覆盖不追加');
});

// ---------------------------------------------------------------- T4 非法来源

test('T4 · 未开工/暂缓/收官 都不能 await-collect,拒绝且一个字段都不改', (t) => {
  const f = setup(t);
  cmds.add({ ...f.P, _: ['AC0'], title: 'AC0' }); // AC0 停在未开工(建卡后没认领)
  startWorking(f, 'AC1', 'feat/ac1');
  cmds.park({ ...f.P, _: ['AC1'], reason: '等条件' }); // AC1 暂缓
  startWorking(f, 'AC2', 'feat/ac2');
  cmds.done({ ...f.P, _: ['AC2'], collect: true }); // AC2 收官(--collect 不过开销闸)
  const snapshot = fs.readFileSync(f.board, 'utf8');
  for (const id of ['AC0', 'AC1', 'AC2']) {
    assert.throws(
      () => cmds.awaitCollect({ ...f.P, _: [id], job: 'job-x' }),
      /非法迁移/,
      `${id} 应被拒`,
    );
  }
  assert.equal(fs.readFileSync(f.board, 'utf8'), snapshot, '被拒命令不能留下写入');
});

// ---------------------------------------------------------------- T5 claim 收回

test('T5 · 收单员 claim 把待收单收回施工中(分支保留);再交活重置 since 与 jobs', (t) => {
  const f = setup(t);
  startWorking(f);
  cmds.awaitCollect({ ...f.P, _: ['AC1'], job: 'job-a', outcome: 'finished', 'finished-at': '2026-09-24T08:00:00Z' });
  const since1 = taskOf(f.board, 'AC1').awaitCollect.since;
  const claimed = cmds.claim({ ...f.P, _: ['AC1'], branch: 'feat/ac1' }).task;
  assert.equal(claimed.status, '施工中', '收单员开工第一步 claim');
  assert.deepEqual(claimed.gitBranch, ['feat/ac1'], '分支保留不摘');
  assert.ok(claimed.awaitCollect, '上一轮交活登记还在');
  cmds.awaitCollect({ ...f.P, _: ['AC1'], job: 'job-b', outcome: 'failed', 'finished-at': '2026-09-24T12:00:00Z' });
  const after = taskOf(f.board, 'AC1');
  assert.equal(after.status, '待收单');
  assert.ok(after.awaitCollect.since >= since1, '重新交活要重置 since');
  assert.deepEqual(after.awaitCollect.jobs, [
    { slug: 'job-b', outcome: 'failed', finishedAt: '2026-09-24T12:00:00Z' },
  ], '上一轮工单清单不带入新一轮');
});

// ---------------------------------------------------------------- T6 参数校验

test('T6 · 参数校验:outcome 枚举、--job 必填、--finished-at 要合法时刻,坏调用不落盘', (t) => {
  const f = setup(t);
  startWorking(f);
  const snapshot = fs.readFileSync(f.board, 'utf8');
  assert.throws(() => cmds.awaitCollect({ ...f.P, _: ['AC1'], job: 'j', outcome: 'aborted' }), /outcome 非法/);
  assert.throws(() => cmds.awaitCollect({ ...f.P, _: ['AC1'] }), /--job/);
  assert.throws(() => cmds.awaitCollect({ ...f.P, _: ['AC1'], job: 'j', 'finished-at': '明天下午' }), /finished-at/);
  assert.throws(() => cmds.awaitCollect({ ...f.P, _: ['GHOST'], job: 'j' }), /GHOST/);
  assert.equal(fs.readFileSync(f.board, 'utf8'), snapshot, '被拒调用一个字段都不改');
  // 缺省:--outcome 不给默认 finished,--finished-at 不给用当前时刻
  const task = cmds.awaitCollect({ ...f.P, _: ['AC1'], job: 'job-a' }).task;
  assert.equal(task.awaitCollect.jobs[0].outcome, 'finished');
  assert.ok(!Number.isNaN(Date.parse(task.awaitCollect.jobs[0].finishedAt)));
});

// ---------------------------------------------------------------- T7 claimCheck 放行

test('T7 · claimCheck 扫描:待收单的分支照施工中命中放行', (t) => {
  const f = setup(t);
  startWorking(f, 'AC1', 'feat/collect-x');
  cmds.awaitCollect({ ...f.P, _: ['AC1'], job: 'job-a' });
  const res = scanAll(f.reg, 'feat/collect-x');
  assert.deepEqual(res.hits, [
    { project: 'myproj', name: 'myproj', taskId: 'AC1', percent: 0, title: 'AC1' },
  ], '待收单分支要在 pre-commit 闸里放行');
  assert.deepEqual(res.skipped, []);
});

// ---------------------------------------------------------------- T8 schema 校验

test('T8 · validate:awaitCollect 合法放行;坏结构/坏 outcome/空 slug/缺 finishedAt 拒收', () => {
  const mk = (awaitCollect) => {
    const b = emptyBoard({ id: 'myproj', name: 'myproj' });
    b.tasks.push({ id: 'AC1', title: 'x', status: '待收单', wave: 0, awaitCollect });
    return b;
  };
  const good = {
    since: '2026-09-24T08:00:00Z',
    jobs: [{ slug: 'job-a', outcome: 'finished', finishedAt: '2026-09-24T08:00:00Z', engine: 'codex' }],
  };
  const okRes = validate(mk(good));
  assert.equal(okRes.ok, true, okRes.errors.join('\n'));
  const badCases = [
    ['不是对象', '应为对象'],
    [{ since: 5, jobs: [] }, 'since'],
    [{ since: '2026-09-24T08:00:00Z', jobs: 'nope' }, 'jobs'],
    [{ since: '2026-09-24T08:00:00Z', jobs: [{ slug: 'j', outcome: 'aborted', finishedAt: 'x' }] }, 'outcome'],
    [{ since: '2026-09-24T08:00:00Z', jobs: [{ slug: '', outcome: 'finished', finishedAt: 'x' }] }, 'slug'],
    [{ since: '2026-09-24T08:00:00Z', jobs: [{ slug: 'j', outcome: 'finished' }] }, 'finishedAt'],
    [{ since: '2026-09-24T08:00:00Z', jobs: [{ slug: 'j', outcome: 'finished', finishedAt: 'x', engine: 3 }] }, 'engine'],
  ];
  for (const [awaitCollect, frag] of badCases) {
    const r = validate(mk(awaitCollect));
    assert.equal(r.ok, false, `应拒收:${JSON.stringify(awaitCollect)}`);
    assert.ok(
      r.errors.some((e) => e.includes('awaitCollect') && e.includes(frag)),
      `${JSON.stringify(awaitCollect)} 应报含「${frag}」的错,实为:${r.errors.join(';')}`,
    );
  }
  // 不给 awaitCollect 的普通卡照旧合法(向后兼容)
  const plain = emptyBoard({ id: 'myproj', name: 'myproj' });
  plain.tasks.push({ id: 'AC2', title: 'y', status: '施工中', wave: 0 });
  assert.equal(validate(plain).ok, true);
});

// ---------------------------------------------------------------- T9 协议卡

test('T9 · 协议卡登记 await-collect:命令表/迁移表/claim 迁移口径同步', () => {
  const card = JSON.parse(protocol({ project: 'myproj', format: 'json' }).text);
  const names = card.commands.map((c) => c.name);
  assert.ok(names.includes('await-collect'), '命令表缺 await-collect');
  assert.equal(names.indexOf('await-collect'), names.indexOf('progress') + 1, '应排在 progress 之后');
  assert.equal(card.commands.find((c) => c.name === 'await-collect').usage, COMMANDS['await-collect'].usage, 'usage 与 --help 同源');
  const tr = card.transitions.find((e) => e.command === 'await-collect');
  assert.equal(tr.status, '待收单');
  assert.ok(tr.writes.some((w) => w.includes('仅允许施工中/待收单')), '迁移表要写明合法来源');
  assert.ok(names.includes('collect-brief'), '命令表缺 collect-brief');
  assert.equal(names.indexOf('collect-brief'), names.indexOf('await-collect') + 1, 'collect-brief 应排在 await-collect 之后');
  const briefTr = card.transitions.find((e) => e.command === 'collect-brief');
  assert.ok(briefTr, '迁移表缺 collect-brief');
  assert.equal(briefTr.status, null, 'collect-brief 不改状态');
  const claimTr = card.transitions.find((e) => e.command === 'claim');
  assert.ok(
    claimTr.writes.some((w) => w.includes('待收单')),
    'claim 的迁移口径要包含 待收单 → 施工中',
  );
  const md = protocol({ project: 'myproj' }).text;
  assert.ok(md.includes(`- \`${COMMANDS['await-collect'].usage}\``), 'md 卡要原样引用 usage 行');
  assert.match(md, /await-collect/);
});

// ---------------------------------------------------------------- T10 收单指令触发句

test('T10 · collectInstructionOf:有 collectBrief 原样返回;没有时按模板兜底(两条工单/空工单);hasCollectBrief 判有无', () => {
  assert.ok(COLLECT_TRIGGER_TEMPLATE.includes('{taskId}') && COLLECT_TRIGGER_TEMPLATE.includes('{projectId}') && COLLECT_TRIGGER_TEMPLATE.includes('{jobs}'));
  // 卡上存了完整指令:全等于原文,不拼任何前后缀
  assert.equal(
    collectInstructionOf({ projectId: 'myproj', task: { id: 'MY-CARD', collectBrief: { text: '第一步…第二步…', updatedAt: '2026-09-24T08:00:00Z' } } }),
    '第一步…第二步…',
  );
  // 没存指令:兜底串一字不差(两条工单 finished + timeout)
  assert.equal(
    collectInstructionOf({ projectId: 'myproj', task: { id: 'MY-CARD', awaitCollect: { jobs: [{ slug: 'job-a', outcome: 'finished' }, { slug: 'job-b', outcome: 'timeout' }] } } }),
    '【会话种类:收单员 · Sonnet】收单卡 MY-CARD(看板项目 myproj)。'
    + '第一步 claim 本卡(待收单 → 施工中);'
    + '这张卡上没有存收单指令,先 show MY-CARD --project myproj --full 读卡面与留言,拿不准就停下交回编排对话。'
    + '施工方已交活的工单:job-a(正常交活)、job-b(超时被停)。',
  );
  // 没存指令且一条工单都没记:{jobs} 处给 NO_JOBS_TEXT
  assert.equal(
    collectInstructionOf({ projectId: 'myproj', task: { id: 'MY-CARD' } }),
    '【会话种类:收单员 · Sonnet】收单卡 MY-CARD(看板项目 myproj)。'
    + '第一步 claim 本卡(待收单 → 施工中);'
    + '这张卡上没有存收单指令,先 show MY-CARD --project myproj --full 读卡面与留言,拿不准就停下交回编排对话。'
    + `施工方已交活的工单:${NO_JOBS_TEXT}。`,
  );
  assert.equal(hasCollectBrief({ collectBrief: { text: '有指令', updatedAt: 't' } }), true);
  assert.equal(hasCollectBrief({ collectBrief: { text: '', updatedAt: 't' } }), false);
  assert.equal(hasCollectBrief({}), false);
  assert.equal(OUTCOME_TEXT.finished, '正常交活');
  assert.deepEqual(COLLECT_OUTCOMES, ['finished', 'timeout', 'failed']);
  assert.equal(COLLECT_BRIEF_MAX, 20000);
});

// ---------------------------------------------------------------- T11 前端接线

test('T11 · 前端接线:工具函数引同一份模板且不含留言判断,图标生成物含 collect,抽屉有复制与展开', () => {
  const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  const util = read('web/src/utils/collectTrigger.ts');
  assert.match(util, /COLLECT_TRIGGER_TEMPLATE/, '网页指令要引核心模板(virtual:board-schema)');
  assert.match(util, /collectInstructionOf/);
  assert.ok(!util.includes('hasCollectorNote'), '留言判断的旧逻辑要删干净');
  const vite = read('web/vite.config.ts');
  assert.match(vite, /collectTrigger\.cjs/, 'vite 虚拟模块要内联 collectTrigger.cjs');
  assert.match(read('web/src/icons/statusGlyphs.ts'), /collect: \{/, '状态图标生成物缺 collect 条目');
  const drawer = read('web/src/components/TaskDrawer.vue');
  assert.match(drawer, /复制收单指令/, '抽屉要有「复制收单指令」按钮');
  assert.match(drawer, /展开全文/, '长指令要有「展开全文」切换');
  assert.match(drawer, /collectInstructionOf/);
  const schema = read('web/src/api/schema.ts');
  assert.match(schema, /待收单/, 'schema.ts 的状态音色/图标映射要登记待收单');
});

// ------------------------------------------------- T12 开工三查 + 并行清单

test('T12 · 开工三查单列待收单一段;并行清单把待收单算占坑,未开工照常可派', (t) => {
  const f = setup(t);
  startWorking(f, 'AC1', 'feat/ac1');
  cmds.awaitCollect({ ...f.P, _: ['AC1'], job: 'job-a' });
  process.env.DASHBOARD_SKIP_SERVICE_PROBE = '1';
  const out = precheck({ project: 'myproj', registry: f.reg, repo: f.repo, 'no-fetch': true });
  assert.match(out.text, /待收单 1 张/, '三查要单列待收单');
  assert.match(out.text, /AC1/, '待收单段要列出卡号');
  const plan = buildParallelPlan([
    { id: 'AC1', status: '待收单', gitBranch: ['feat/ac1'], title: 'T' },
    { id: 'AC2', status: '施工中', gitBranch: ['feat/ac2'], title: 'T' },
    { id: 'AC3', status: '未开工', fileScope: ['src/a.cjs'], title: 'T' },
  ]);
  assert.deepEqual(plan.running.map((r) => r.id).sort(), ['AC1', 'AC2'], '待收单与施工中一样算占坑');
  assert.ok(plan.ready.some((r) => r.id === 'AC3'), '未开工照常进候选');
});

// ------------------------------------------------- T13 collect-brief 存收单指令

test('T13 · collect-brief:--text 整段覆盖不改状态;--file 去首尾空白;坏调用与终态拒绝;schema 校验 collectBrief', (t) => {
  const f = setup(t);
  startWorking(f);
  const before = taskOf(f.board, 'AC1');
  const res = cmds.collectBrief({ ...f.P, _: ['AC1'], text: '收单指令全文第一版' });
  assert.equal(res.ok, true);
  assert.match(res.text, /已存 9 字/);
  let task = taskOf(f.board, 'AC1');
  assert.equal(task.collectBrief.text, '收单指令全文第一版', 'text 全等(--text 去首尾空白)');
  assert.ok(task.collectBrief.updatedAt && typeof task.collectBrief.updatedAt === 'string', 'updatedAt 是字符串');
  assert.equal(task.status, before.status, '状态不动');
  assert.equal(task.lastProgressAt, before.lastProgressAt, 'lastProgressAt 不动');
  assert.equal(task.percent, before.percent, '进度不动');
  // 再写一次:整段覆盖;--author 给了才加 author 键
  cmds.collectBrief({ ...f.P, _: ['AC1'], text: '第二版全文', author: 'planner' });
  task = taskOf(f.board, 'AC1');
  assert.equal(task.collectBrief.text, '第二版全文');
  assert.equal(task.collectBrief.author, 'planner');
  // --file:临时文件按 utf8 读,首尾空白去掉
  const file = path.join(f.dir, 'brief.txt');
  fs.writeFileSync(file, '\n  文件版指令  \r\n', 'utf8');
  cmds.collectBrief({ ...f.P, _: ['AC1'], file });
  task = taskOf(f.board, 'AC1');
  assert.equal(task.collectBrief.text, '文件版指令');
  assert.ok(!('author' in task.collectBrief), '不传 --author 就不加 author 键');
  // 坏调用:空文本 / 超长 / --text 与 --file 同给 / 都不给 / 卡号不存在,各自报错且板上与调用前深相等
  let snapshot = fs.readFileSync(f.board, 'utf8');
  assert.throws(() => cmds.collectBrief({ ...f.P, _: ['AC1'], text: '   ' }), /不能为空/);
  assert.throws(() => cmds.collectBrief({ ...f.P, _: ['AC1'], text: 'x'.repeat(COLLECT_BRIEF_MAX + 1) }), /上限/);
  assert.throws(() => cmds.collectBrief({ ...f.P, _: ['AC1'], text: 'a', file: 'brief.txt' }), /二选一/);
  assert.throws(() => cmds.collectBrief({ ...f.P, _: ['AC1'] }), /二选一/);
  assert.throws(() => cmds.collectBrief({ ...f.P, _: ['GHOST'], text: 'a' }), /GHOST/);
  assert.equal(fs.readFileSync(f.board, 'utf8'), snapshot, '被拒调用一个字段都不改');
  // 卡为已完工后拒绝且不落盘
  cmds.done({ ...f.P, _: ['AC1'], pr: 42, commit: 'a1b2c3d' });
  snapshot = fs.readFileSync(f.board, 'utf8');
  assert.throws(() => cmds.collectBrief({ ...f.P, _: ['AC1'], text: 'x' }), /拒绝/);
  assert.equal(fs.readFileSync(f.board, 'utf8'), snapshot, '终态卡拒绝且不落盘');
  // schema 校验:text 空串 / 超长 / collectBrief 不是对象 各报错;完整结构放行
  const mk = (collectBrief) => {
    const b = emptyBoard({ id: 'myproj', name: 'myproj' });
    b.tasks.push({ id: 'CB1', title: 'x', status: '待收单', wave: 0, collectBrief });
    return b;
  };
  const okRes = validate(mk({ text: '完整指令', updatedAt: '2026-09-24T08:00:00Z', author: 'planner' }));
  assert.equal(okRes.ok, true, okRes.errors.join('\n'));
  const badCases = [
    [{ text: '', updatedAt: 't' }, 'text'],
    [{ text: 'x'.repeat(COLLECT_BRIEF_MAX + 1), updatedAt: 't' }, '上限'],
    ['不是对象', '应为对象'],
  ];
  for (const [collectBrief, frag] of badCases) {
    const r = validate(mk(collectBrief));
    assert.equal(r.ok, false, `应拒收:${JSON.stringify(collectBrief).slice(0, 40)}`);
    assert.ok(
      r.errors.some((e) => e.includes('collectBrief') && e.includes(frag)),
      `应报含「${frag}」的错,实为:${r.errors.join(';')}`,
    );
  }
});
