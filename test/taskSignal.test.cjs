'use strict';
/**
 * AUD-UI-OVERVIEW-SIGNAL 回归测试:看板界面上那几个"要你处理"的数字，必须只数真的要你处理的卡。
 *
 * 【这卡在治什么】0907 全景审计实测(mama 项目、1920 宽):总览 KPI「需要你处理」显示 307,
 * 拆开是 待拍板 47 + 卡住 258 + 驳回 2。那 258 里绝大多数根本不需要人动手——
 *   ① 它不随顶栏项目切换(恒扫全部项目的板),站在 mama 底下却把别的项目的卡也算进来;
 *   ② 「暂缓」被算成「卡住」——暂缓是负责人自己按下的暂停键,不是挡路的石头;
 *   ③ 已完工卡上残留的 blockReason / blockedBy 照样计数,而上游其实早就完工了。
 * 同一个病根还外溢到另外两页:风险面板「阻塞」列列出已完工卡;占用防撞把完工卡的历史分支
 * 算成 36 处冲突——两页都在"全部卡"上做判断,没区分这张卡此刻还算不算数。
 *
 * 【判据怎么定的】把"这张卡此刻算不算数"抽成 core/taskSignal.cjs 的一份判据(单一真相源,
 * 前端经 vite 虚拟模块 'virtual:task-signal' 吃同一份,不许另抄),这里直接对判据跑真数据:
 * 造一块同时含 完工/暂缓/真卡住/上游已完工 的板,断言每一组的成员**逐张点名**,不只对总数。
 * 只对总数会放过"多算一张少算一张刚好抵消"的错。
 *
 * 【已知局限】前端没有组件测试运行器(web 下没有 vitest / @vue/test-utils),所以"视图确实用了
 * 这份判据、没有偷偷另写一套"这一层是对 .vue / vite.config.ts 源码的结构扫描,不是真渲染。
 * 真渲染那层由 vue-tsc + 浏览器实测兜底。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const signal = require('../core/taskSignal.cjs');
const { isGeneratedArtifact } = require('../core/generatedArtifacts.cjs');

const WEB = path.join(__dirname, '..', 'web');
const SRC = path.join(WEB, 'src');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

// ---------------------------------------------------------------------------
// 夹具:一块把各种"看着像要处理、其实不用"的卡凑齐的板
// ---------------------------------------------------------------------------
const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-09-07T12:00:00Z');
const ago = (hours) => new Date(NOW - hours * HOUR).toISOString();

function fixtureBoard() {
  return {
    schemaVersion: '1.0',
    project: { id: 'p1', name: '项目一' },
    tasks: [
      // 真卡住:活跃 + 上游没完工
      { id: 'T-BLOCKED-REAL', title: '真卡住', status: '施工中', wave: 0,
        deps: { blockedBy: ['T-UPSTREAM-OPEN'] }, gitBranch: ['feat/shared'], lastProgressAt: ago(2) },
      // 真卡住:活跃 + 写了阻塞理由
      { id: 'T-BLOCKED-REASON', title: '有阻塞理由', status: '待开工', wave: 0, blockReason: '等负责人给账号' },
      // 假卡住①:已完工卡上残留的历史阻塞痕迹
      { id: 'T-DONE-STALE', title: '完工卡的历史阻塞', status: '已完工', wave: 0,
        blockReason: '当初等过上游', deps: { blockedBy: ['T-UPSTREAM-OPEN'] }, gitBranch: ['feat/shared'] },
      // 假卡住②:上游全完工了,阻塞其实已自然解除
      { id: 'T-BLOCKER-CLEARED', title: '上游已完工', status: '未开工', wave: 0,
        deps: { blockedBy: ['T-UPSTREAM-DONE'] } },
      // 假卡住③:暂缓是负责人自己按的暂停键,不是挡路石
      { id: 'T-PARKED', title: '搁置中', status: '暂缓', wave: 0, parkedNote: '等设计定稿',
        worktree: ['F:/wt/parked'] },
      { id: 'T-UPSTREAM-OPEN', title: '还没做的上游', status: '未开工', wave: 0 },
      { id: 'T-UPSTREAM-DONE', title: '做完了的上游', status: '已完工', wave: 0 },
      // 施工中的两张:一张刚动过,一张很久没动
      { id: 'T-BUILDING-FRESH', title: '刚推过进度', status: '施工中', wave: 0, lastProgressAt: ago(1) },
      { id: 'T-BUILDING-STALE', title: '很久没动', status: '施工中', wave: 0, lastProgressAt: ago(30) },
    ],
    activity: [
      { ts: ago(26), taskId: 'T-BUILDING-STALE', type: 'note', text: '还是没动' },
      { ts: ago(0.5), taskId: 'T-BUILDING-FRESH', type: 'progress', text: '推了一步' },
    ],
  };
}

function otherBoard() {
  return {
    schemaVersion: '1.0',
    project: { id: 'p2', name: '项目二' },
    tasks: [
      { id: 'T-OTHER-BLOCKED', title: '别的项目也卡住了', status: '施工中', wave: 0, blockReason: '缺环境' },
    ],
    activity: [],
  };
}

const ids = (rows) => rows.map((r) => (r.task ? r.task.id : r.id)).sort();

// ---------------------------------------------------------------------------
// ① 单卡判据
// ---------------------------------------------------------------------------
test('单卡判据:结案 / 搁置 / 活跃 / 还占着地盘,四件事分得清', () => {
  const byId = Object.fromEntries(fixtureBoard().tasks.map((t) => [t.id, t]));

  assert.equal(signal.isSettled(byId['T-UPSTREAM-DONE']), true, '已完工 = 结案');
  assert.equal(signal.isSettled({ status: '已作废' }), true, '已作废 = 结案');
  assert.equal(signal.isSettled(byId['T-PARKED']), false, '暂缓不是结案,只是按了暂停');

  assert.equal(signal.isParked(byId['T-PARKED']), true);
  assert.equal(signal.isActive(byId['T-PARKED']), false, '暂缓不算活跃');
  assert.equal(signal.isActive(byId['T-UPSTREAM-DONE']), false, '完工不算活跃');
  assert.equal(signal.isActive(byId['T-BLOCKED-REAL']), true);

  // 占地盘 ≠ 活跃:暂缓卡的 worktree 还检出着,别人抢同一个照样撞;完工卡的分支才是历史遗迹。
  assert.equal(signal.isOccupying(byId['T-PARKED']), true, '暂缓仍压着分支/worktree');
  assert.equal(signal.isOccupying(byId['T-UPSTREAM-DONE']), false, '完工卡不再占地盘');
});

test('卡住判据:只有活跃卡 + 上游真没完工(或写了阻塞理由)才算', () => {
  const board = fixtureBoard();
  const index = signal.indexBoard(board);
  const byId = Object.fromEntries(board.tasks.map((t) => [t.id, t]));

  assert.equal(signal.isBlocked(byId['T-BLOCKED-REAL'], index), true);
  assert.equal(signal.isBlocked(byId['T-BLOCKED-REASON'], index), true);
  assert.equal(signal.isBlocked(byId['T-DONE-STALE'], index), false, '完工卡的历史阻塞不算');
  assert.equal(signal.isBlocked(byId['T-BLOCKER-CLEARED'], index), false, '上游完工了就不算卡住');
  assert.equal(signal.isBlocked(byId['T-PARKED'], index), false, '暂缓不算卡住');

  // 阻塞自然解除的卡要能单独认出来——风险面板要提一句,免得负责人以为卡"凭空消失"了。
  assert.equal(signal.isUnblocked(byId['T-BLOCKER-CLEARED'], index), true);
  assert.equal(signal.isUnblocked(byId['T-BLOCKED-REAL'], index), false);

  assert.deepEqual(signal.unfinishedBlockers(byId['T-BLOCKED-REAL'], index), ['T-UPSTREAM-OPEN']);
  assert.deepEqual(signal.unfinishedBlockers(byId['T-BLOCKER-CLEARED'], index), []);

  // 板上查无此卡的上游(跨项目写法/写错卡号):宁可当"还没完工"——判据不许凭"查不到"就放行。
  const cross = { id: 'X', title: 'x', status: '未开工', wave: 0, deps: { blockedBy: ['NOT-ON-THIS-BOARD'] } };
  assert.equal(signal.isBlocked(cross, index), true, '查不到的上游按未完工算');
});

// ---------------------------------------------------------------------------
// ② 总览汇总
// ---------------------------------------------------------------------------
test('总览汇总:卡住 / 搁置 / 施工中 / 最久没动,四组各是谁逐张点名', () => {
  const out = signal.overviewSignal([fixtureBoard()], { now: NOW });

  assert.deepEqual(ids(out.blocked), ['T-BLOCKED-REAL', 'T-BLOCKED-REASON'], '卡住只剩两张真的');
  assert.deepEqual(ids(out.parked), ['T-PARKED'], '暂缓单独成组');
  assert.equal(out.building, 3, '施工中:真卡住那张也在施工中');

  assert.ok(out.stalest, '有施工中的卡就该算得出"最久没动"');
  assert.equal(out.stalest.task.id, 'T-BUILDING-STALE');
  assert.equal(out.stalest.projectId, 'p1');
  assert.equal(out.stalest.since, ago(26), '取进度戳与活动流里更新的那个(26h 前的活动 > 30h 前的进度戳)');
  assert.equal(out.stalest.hours, 26);

  // 卡住项要带上"还没完工的上游是谁",界面直接拿去写理由,不能再显示已完工的上游。
  const real = out.blocked.find((b) => b.task.id === 'T-BLOCKED-REAL');
  assert.deepEqual(real.blockers, ['T-UPSTREAM-OPEN']);
  assert.equal(real.projectName, '项目一');
});

test('总览汇总:传几块板就只数几块板(范围切换靠这个生效)', () => {
  const one = signal.overviewSignal([fixtureBoard()], { now: NOW });
  const both = signal.overviewSignal([fixtureBoard(), otherBoard()], { now: NOW });

  assert.equal(one.blocked.length, 2, '只传当前项目 = 只数当前项目');
  assert.deepEqual(ids(both.blocked), ['T-BLOCKED-REAL', 'T-BLOCKED-REASON', 'T-OTHER-BLOCKED']);
  assert.equal(both.stalest.projectId, 'p1', '最久没动要跨板比,不是每块板各报一个');
});

test('总览汇总:空板不炸,也别硬凑出一个"最久没动"', () => {
  const empty = signal.overviewSignal([], { now: NOW });
  assert.deepEqual(empty.blocked, []);
  assert.deepEqual(empty.parked, []);
  assert.equal(empty.building, 0);
  assert.equal(empty.stalest, null);

  // 施工中但一个时间线索都没有的卡:算进"施工中 N",但不参与"最久没动"评比——
  // 没有时刻就写不出"多久",硬凑一个只会是假数字。
  const noStamp = { schemaVersion: '1.0', project: { id: 'p3', name: '三' },
    tasks: [{ id: 'T-NOSTAMP', title: '无戳', status: '施工中', wave: 0 }], activity: [] };
  const out = signal.overviewSignal([noStamp], { now: NOW });
  assert.equal(out.building, 1);
  assert.equal(out.stalest, null);
});

test('最久没动:开工日只是兜底,不许压过精确时刻', () => {
  // 【真机挖出来的坑】dates.start 是 'YYYY-MM-DD'(粗到天),lastProgressAt / 活动流是完整 ISO 时刻。
  // 把两者丢进同一个"取最新"里按字符串比大小,'2026-09-07' 会排在 '2026-09-06T20:39:45Z' 之后
  // ——今天刚开工的卡于是被判成"刚动过",真正僵着的卡反而被藏起来;显示出来还是个未来时间。
  // 0907 实测 dashboard 板:两张施工中的卡 touched 都成了 '2026-09-07',hours 被夹成 0。
  const board = {
    schemaVersion: '1.0', project: { id: 'p9', name: '九' },
    tasks: [
      { id: 'T-STAMPED', title: '有精确进度戳', status: '施工中', wave: 0,
        lastProgressAt: ago(30), dates: { start: '2026-09-07' } },
      { id: 'T-ONLY-START', title: '只有开工日', status: '施工中', wave: 0, dates: { start: '2026-09-01' } },
    ],
    activity: [],
  };
  const index = signal.indexBoard(board);
  const byId = Object.fromEntries(board.tasks.map((t) => [t.id, t]));

  assert.equal(signal.lastTouchedAt(byId['T-STAMPED'], index), ago(30), '有精确时刻就该用精确时刻');

  // 只剩开工日时才用它,而且要归一成一个真时刻,否则没法跟别的卡比大小。
  const fallback = signal.lastTouchedAt(byId['T-ONLY-START'], index);
  assert.match(fallback, /^\d{4}-\d{2}-\d{2}T/, '兜底值也要是完整时刻,不能是光秃秃的日期');
  assert.equal(fallback, new Date('2026-09-01T00:00:00').toISOString(), '开工日按【当地】那天零点算');

  // 两张卡放一起比:只有开工日的那张(9-01)比有戳的那张(30 小时前)更旧,该它上榜。
  assert.equal(signal.overviewSignal([board], { now: NOW }).stalest.task.id, 'T-ONLY-START');
});

// ---------------------------------------------------------------------------
// ③ 占用防撞
// ---------------------------------------------------------------------------
test('占用防撞:完工卡的历史分支不算抢占,打开开关才算', () => {
  const tasks = fixtureBoard().tasks;

  const rows = signal.occupancy(tasks, 'gitBranch', { isGenerated: isGeneratedArtifact });
  const shared = rows.find((r) => r.v === 'feat/shared');
  assert.ok(shared, '分支本身还要列出来给人看');
  assert.deepEqual(ids(shared.tasks), ['T-BLOCKED-REAL'], '完工那张不再算占着这条分支');
  assert.equal(shared.conflict, false, '只剩一张活跃卡 = 不是冲突');

  const withDone = signal.occupancy(tasks, 'gitBranch', { includeDone: true, isGenerated: isGeneratedArtifact });
  const sharedAll = withDone.find((r) => r.v === 'feat/shared');
  assert.deepEqual(ids(sharedAll.tasks), ['T-BLOCKED-REAL', 'T-DONE-STALE']);
  assert.equal(sharedAll.conflict, true, '「含已完工」打开后历史占用照旧显示为冲突');

  // 暂缓卡仍占着 worktree,默认口径下必须留着。
  const wt = signal.occupancy(tasks, 'worktree', { isGenerated: isGeneratedArtifact });
  assert.deepEqual(ids(wt.find((r) => r.v === 'F:/wt/parked').tasks), ['T-PARKED']);
});

test('占用防撞:自动生成物照旧不算冲突(沿用 generatedArtifacts 判据,别在这儿又松一次口)', () => {
  const tasks = [
    { id: 'A', title: 'a', status: '施工中', fileScope: ['docs/INDEX-自动生成.md', 'web/src/views/'] },
    { id: 'B', title: 'b', status: '未开工', fileScope: ['docs/INDEX-自动生成.md', 'web/src/views/'] },
  ];
  const rows = signal.occupancy(tasks, 'fileScope', { isGenerated: isGeneratedArtifact });
  assert.equal(rows.find((r) => r.v === 'docs/INDEX-自动生成.md').conflict, false);
  assert.equal(rows.find((r) => r.v === 'docs/INDEX-自动生成.md').generated, true);
  assert.equal(rows.find((r) => r.v === 'web/src/views/').conflict, true, '真手写文件照旧标红');
});

// ---------------------------------------------------------------------------
// ④ 验收矩阵:没人填过就别摆两列"—"
// ---------------------------------------------------------------------------
test('验收证据:整块板一条都没登记过时要能判出来', () => {
  assert.equal(signal.hasAcceptanceEvidence(fixtureBoard().tasks), false);
  assert.equal(signal.hasAcceptanceEvidence([{ id: 'A', status: '施工中', tests: { total: 12, passing: 12 } }]), true);
  assert.equal(signal.hasAcceptanceEvidence([{ id: 'A', status: '施工中', typecheck: false }]), true, '类型检查没过也是登记过');
  assert.equal(signal.hasAcceptanceEvidence([{ id: 'A', status: '施工中', tests: { total: 0 } }]), false, 'total=0 等于没填');
});

// ---------------------------------------------------------------------------
// ⑤ 接线:前端必须吃同一份判据,不许另抄一套
// ---------------------------------------------------------------------------
test('接线:判据经 vite 虚拟模块注入,且 TS 侧有声明', () => {
  const vite = read(WEB, 'vite.config.ts');
  assert.match(vite, /virtual:task-signal/, 'vite.config.ts 要注册 virtual:task-signal 插件');
  assert.match(vite, /taskSignal\.cjs/, '虚拟模块内容必须直接来自 core/taskSignal.cjs');
  assert.match(read(WEB, 'env.d.ts'), /declare module 'virtual:task-signal'/);

  const esm = signal.toEsmSource();
  for (const name of ['isActive', 'isSettled', 'isOccupying', 'isBlocked', 'overviewSignal', 'occupancy', 'hasAcceptanceEvidence']) {
    assert.match(esm, new RegExp(`export (const|function) ${name}\\b`), `虚拟模块要导出 ${name}`);
  }
});

test('接线:三个出事的视图都改用了这份判据', () => {
  for (const file of [['views', 'Overview.vue'], ['views', 'RiskPanel.vue'], ['views', 'Collision.vue'], ['views', 'AcceptanceMatrix.vue']]) {
    assert.match(read(SRC, ...file), /from 'virtual:task-signal'/, `${file[1]} 要 import 判据`);
  }
});

test('接线:总览的"需要你处理"尊重项目范围,且不把搁置算进去', () => {
  const src = read(SRC, 'views', 'Overview.vue');
  assert.match(src, /centerScopeAll/, '总览要跟随范围开关');
  assert.match(src, /<ScopeToggle/, '范围开关得摆在总览上,否则用户切不了');

  // actionTotal 那一行:允许待拍板 / 驳回 / 卡住,不许出现搁置。
  const line = src.split('\n').find((l) => l.includes('const actionTotal'));
  assert.ok(line, '找不到 actionTotal 的定义');
  assert.ok(!/park/i.test(line), `"需要你处理"不许把搁置算进去:${line.trim()}`);
  assert.match(src, /搁置中/, '搁置要单独成块显示');
  assert.match(src, /最久没动/, 'KPI 要有"最久没动"');
});

test('接线:验收矩阵在无人登记时合并两列,并告诉 AI 怎么登记', () => {
  const src = read(SRC, 'views', 'AcceptanceMatrix.vue');
  assert.match(src, /hasAcceptanceEvidence/, '要按"有没有人登记过"决定列数');
  assert.match(src, /--tests/, '要给出 progress --tests 的登记写法');
  assert.match(src, /--typecheck/);
});

test('接线:占用防撞给了"含已完工"开关', () => {
  const src = read(SRC, 'views', 'Collision.vue');
  assert.match(src, /includeDone/);
  assert.match(src, /含已完工/);
});
