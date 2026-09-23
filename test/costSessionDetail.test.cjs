'use strict';
// COST-UI-SESSION-DETAIL:会话明细(按会话一行)的聚合、对账与筛选纯函数单测。
// 夹具一律 os.tmpdir() 临时目录 + 合成假值,不碰真实流水目录(公开仓红线)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getUsage, HEAVY_CONTEXT_TOKENS } = require('../core/costUsage.cjs');
const {
  filterSessions, sessionFilterOptions, summarizeSessionRows,
} = require('../core/costSessionDetail.cjs');

const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** 带会话字段的流水行(id 缺省 = 不带 message.id)。 */
function line({ ts, sid, cwd, id, gitBranch, model = 'claude-fable-5', input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  return JSON.stringify({
    type: 'assistant', isSidechain: false, timestamp: ts, sessionId: sid, cwd, gitBranch,
    message: id === undefined ? { model, usage: {
      input_tokens: input, output_tokens: output,
      cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
    } } : { id, model, usage: {
      input_tokens: input, output_tokens: output,
      cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
    } },
  });
}

const isoDaysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString();

/** 这一条是本单最要紧的断言:明细行四类 token 相加必须等于顶层合计。 */
function reconcile(r) {
  const sum = (pick) => r.sessionRows.reduce((acc, row) => acc + pick(row), 0);
  assert.equal(sum((x) => x.input), r.totals.input, 'input:明细行相加 === 顶层合计');
  assert.equal(sum((x) => x.output), r.totals.output, 'output:明细行相加 === 顶层合计');
  assert.equal(sum((x) => x.cacheRead), r.totals.cacheRead, 'cacheRead:明细行相加 === 顶层合计');
  assert.equal(sum((x) => x.cacheWrite), r.totals.cacheWrite, 'cacheWrite:明细行相加 === 顶层合计');
}

test('getUsage:对账断言——明细行四类 token 相加等于顶层合计,实扫与缓存命中两跑都成立', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'R--p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'R--p', 'a.jsonl'), [
    line({ ts: isoDaysAgo(0), sid: 'sess-aaaa-0001', id: 'msg_a1', input: 10, output: 100, cacheRead: 1000, cacheWrite: 50 }),
    line({ ts: isoDaysAgo(0), sid: 'sess-aaaa-0001', id: 'msg_a2', input: 5, output: 7, cacheRead: 0, cacheWrite: 0 }),
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'R--p', 'b.jsonl'),
    line({ ts: isoDaysAgo(1), sid: 'sess-bbbb-0002', input: 3, output: 4, cacheRead: 5, cacheWrite: 6 }));
  fs.writeFileSync(path.join(root, 'R--p', 'c.jsonl'),
    line({ ts: isoDaysAgo(40), sid: 'sess-cccc-0003', input: 900, output: 900 }));
  const opts = { prefix: 'R--p', days: 30, projectsRoot: root, cachePath: path.join(dir, 'cache.json') };

  const fresh = await getUsage(opts);
  assert.equal(fresh.scanned, 3);
  assert.equal(fresh.sessionRows.length, 2, '窗口外的 40 天前会话不上明细');
  reconcile(fresh);

  const cached = await getUsage(opts);
  assert.equal(cached.scanned, 0, '第二跑全走缓存');
  assert.equal(cached.cachedFiles, 3);
  reconcile(cached);

  assert.equal(fresh.totals.input, 18, '窗口外 900 不进合计');
  assert.equal(fresh.sessionRows.reduce((s, x) => s + x.turns, 0), 3, '窗口外轮次不进行明细');
  clean(dir);
});

test('getUsage:会话行窗口化——起止时间取窗口内首末记录,跨窗口会话只计窗口内轮次', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'W--p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'W--p', 'a.jsonl'), [
    line({ ts: isoDaysAgo(40), sid: 'sess-win-0001', id: 'msg_old', input: 700, output: 1 }),
    line({ ts: isoDaysAgo(2), sid: 'sess-win-0001', id: 'msg_w1', input: 10, output: 2 }),
    line({ ts: isoDaysAgo(1), sid: 'sess-win-0001', id: 'msg_w2', input: 20, output: 3 }),
  ].join('\n'));
  const r = await getUsage({ prefix: 'W--p', days: 30, projectsRoot: root, cachePath: path.join(dir, 'c.json') });
  assert.equal(r.sessionRows.length, 1);
  const row = r.sessionRows[0];
  assert.equal(row.turns, 2, '只计窗口内两轮');
  assert.equal(row.input, 30);
  assert.ok(row.startedAt && row.endedAt && row.startedAt <= row.endedAt, '起止时间取窗口内首末');
  reconcile(r);
  clean(dir);
});

test('getUsage:上下文口径与两项新指标——峰值/平均、轮次×平均上下文、超40万轮次占比', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'X--p'), { recursive: true });
  assert.equal(HEAVY_CONTEXT_TOKENS, 400000, '超大上下文门槛就是 40 万 token');
  fs.writeFileSync(path.join(root, 'X--p', 'a.jsonl'), [
    line({ ts: isoDaysAgo(0), sid: 'sess-ctx-0001', id: 'msg_x1', input: 100 }),
    line({ ts: isoDaysAgo(0), sid: 'sess-ctx-0001', id: 'msg_x2', input: 500000, cacheRead: 100, cacheWrite: 20 }),
  ].join('\n'));
  const r = await getUsage({ prefix: 'X--p', days: 30, projectsRoot: root, cachePath: path.join(dir, 'c.json') });
  const row = r.sessionRows[0];
  assert.equal(row.peakContext, 500120, '峰值 = 最大单轮(input+缓存读+缓存写)');
  assert.equal(row.avgContext, (100 + 500120) / 2, '平均 = Σ单轮上下文 ÷ 轮次');
  assert.equal(r.context.turns, 2);
  assert.equal(r.context.load, 500220, '轮次 × 平均上下文 = 总驮载');
  assert.equal(r.context.heavyTurns, 1, '只有 500120 那轮超 40 万');
  assert.ok(Math.abs(r.context.heavyRatio - 0.5) < 1e-12, '占比 = 1/2');
  reconcile(r);
  clean(dir);
});

test('getUsage:所有轮次都没超 40 万——重上下文占比为 0,恰好 40 万那一轮不算「超过」', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'L--p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'L--p', 'a.jsonl'), [
    line({ ts: isoDaysAgo(0), sid: 'sess-light-0001', id: 'msg_l1', input: 100 }),
    line({ ts: isoDaysAgo(0), sid: 'sess-light-0001', id: 'msg_l2', input: 399999, cacheWrite: 1 }), // 单轮上下文恰好 = 400000
  ].join('\n'));
  const r = await getUsage({ prefix: 'L--p', days: 30, projectsRoot: root, cachePath: path.join(dir, 'c.json') });
  assert.equal(r.sessionRows[0].turns, 2);
  assert.equal(r.sessionRows[0].heavyTurns, 0, '门槛是「大于 40 万」,恰好 40 万不算超');
  assert.equal(r.context.heavyTurns, 0);
  assert.equal(r.context.heavyRatio, 0, '所有轮次都没超 → 占比 0');
  reconcile(r);
  clean(dir);
});

test('getUsage:明细日期筛选与按天图同一本机时区口径——UTC 16:30 的记录按它在本机的当天能筛出来', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'T--p'), { recursive: true });
  const base = new Date(Date.now() - 3 * 86400e3);
  base.setUTCHours(16, 30, 0, 0); // 三天前的 UTC 16:30:东八区的墙上时钟已是次日凌晨
  fs.writeFileSync(path.join(root, 'T--p', 'a.jsonl'),
    line({ ts: base.toISOString(), sid: 'sess-tz-0001', id: 'msg_t1', input: 7, output: 8 }));
  const r = await getUsage({ prefix: 'T--p', days: 30, projectsRoot: root, cachePath: path.join(dir, 'c.json') });
  const localDay = r.byDay[0].date; // 按天图的分日(本机时区)= 既有基准口径
  assert.equal(r.sessionRows.length, 1);
  assert.deepEqual(
    filterSessions(r.sessionRows, { fromDate: localDay, toDate: localDay }).map((x) => x.sessionId),
    ['sess-tz-0001'], '按天图把这条记录分到本机的哪一天,日期筛就得用哪一天能筛到它');
  const [y, m, d] = localDay.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  const p = (n) => String(n).padStart(2, '0');
  const nextDay = `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}`;
  assert.deepEqual(filterSessions(r.sessionRows, { fromDate: nextDay }), [], '从次日起筛不得再带到前一天');
  clean(dir);
});

test('getUsage:主干不猜卡，user claim、分支、绑定与歧义各走各的判据', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-'));
  try {
    const root = path.join(dir, 'projects');
    const project = path.join(root, '-F--fake-repo');
    fs.mkdirSync(project, { recursive: true });
    const ts = isoDaysAgo(0);
    const sidMain = '00000000-0000-4000-8000-00000000000a';
    const sidCommand = '00000000-0000-4000-8000-00000000000b';
    const sidBranch = '00000000-0000-4000-8000-00000000000c';
    const sidBound = '00000000-0000-4000-8000-00000000000d';
    const sidAmbiguous = '00000000-0000-4000-8000-00000000000e';
    const user = (sid, content) => JSON.stringify({ type: 'user', sessionId: sid, timestamp: ts, message: { content } });
    fs.writeFileSync(path.join(project, 'a.jsonl'), [
      line({ ts, sid: sidMain, gitBranch: 'main', cwd: path.join(dir, 'fake-repo'), output: 1 }),
      user(sidCommand, 'claim CARD-A --project demo'),
      line({ ts, sid: sidCommand, gitBranch: 'main', output: 2 }),
      line({ ts, sid: sidBranch, gitBranch: 'feat/a', output: 3 }),
      line({ ts, sid: sidBound, gitBranch: 'main', output: 4 }),
      line({ ts, sid: sidAmbiguous, gitBranch: 'feat/x', output: 5 }),
    ].join('\n'));
    const cards = [
      { id: 'CARD-A', gitBranch: ['main', 'feat/a'] },
      { id: 'CARD-B', gitBranch: ['main', 'feat/b', 'feat/x'] },
      { id: 'CARD-C', gitBranch: ['feat/x'] },
    ];
    const opts = { prefix: '-F--fake-repo', days: 7, projectsRoot: root,
      cachePath: path.join(dir, 'cache.json'), cards,
      bindings: { [sidBound]: ['CARD-A', 'CARD-B'] } };
    const fresh = await getUsage(opts);
    const bySid = new Map(fresh.sessionRows.map((row) => [row.sessionId, row]));
    assert.equal(bySid.get(sidMain).attribution.status, 'unattributed');
    assert.equal(bySid.get(sidMain).card, null);
    assert.equal(bySid.get(sidCommand).card, 'CARD-A');
    assert.equal(bySid.get(sidCommand).attribution.level, 'command');
    assert.equal(bySid.get(sidBranch).attribution.level, 'branch');
    assert.equal(bySid.get(sidBound).attribution.status, 'multi');
    assert.deepEqual(bySid.get(sidBound).attribution.cardIds, ['CARD-A', 'CARD-B']);
    assert.equal(bySid.get(sidAmbiguous).attribution.status, 'ambiguous');
    assert.deepEqual(filterSessions(fresh.sessionRows, { card: 'CARD-B' }).map((r) => r.sessionId), [sidBound]);
    assert.deepEqual(summarizeSessionRows(fresh.sessionRows).attribution,
      { attributed: 2, multi: 1, ambiguous: 1, unattributed: 1 });
    assert.deepEqual(sessionFilterOptions(fresh.sessionRows).cards, ['CARD-A', 'CARD-B']);
    reconcile(fresh);
    const cached = await getUsage(opts);
    assert.equal(cached.scanned, 0);
    reconcile(cached);
    const cache = JSON.parse(fs.readFileSync(opts.cachePath, 'utf8'));
    cache.schemaVersion = 3;
    fs.writeFileSync(opts.cachePath, JSON.stringify(cache));
    const rescanned = await getUsage(opts);
    assert.equal(rescanned.scanned, 1, 'v3 旧缓存整份丢弃');
    assert.deepEqual(rescanned.sessionRows, fresh.sessionRows, '旧缓存重扫与无缓存同结果');
    reconcile(rescanned);
  } finally { clean(dir); }
});

test('getUsage:同一会话跨文件的分支信号取并集', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-merge-'));
  try {
    const root = path.join(dir, 'projects');
    const project = path.join(root, '-F--fake-repo');
    fs.mkdirSync(project, { recursive: true });
    const sid = '00000000-0000-4000-8000-00000000000a';
    const ts = isoDaysAgo(0);
    fs.writeFileSync(path.join(project, 'a.jsonl'), line({ ts, sid, gitBranch: 'feat/a', output: 1 }));
    fs.writeFileSync(path.join(project, 'b.jsonl'), line({ ts, sid, gitBranch: 'feat/b', output: 2 }));
    const r = await getUsage({ prefix: '-F--fake-repo', days: 7, projectsRoot: root,
      cachePath: path.join(dir, 'cache.json'), cards: [
        { id: 'CARD-A', gitBranch: ['feat/a'] }, { id: 'CARD-B', gitBranch: ['feat/b'] },
      ] });
    assert.equal(r.sessionRows.length, 1);
    assert.equal(r.sessionRows[0].attribution.status, 'multi');
    assert.deepEqual(r.sessionRows[0].attribution.cardIds, ['CARD-A', 'CARD-B']);
    reconcile(r);
  } finally { clean(dir); }
});

// ---------- 纯函数:filterSessions / summarize / options ----------

const ROWS = [
  { sessionId: 'sess-a', models: ['claude-fable-5'], card: 'T-1',
    startedAt: '2026-09-01T08:00:00Z', endedAt: '2026-09-02T09:00:00Z',
    turns: 2, peakContext: 300, avgContext: 100, heavyTurns: 0,
    input: 10, output: 20, cacheRead: 30, cacheWrite: 40, compactions: 1, usd: 0.5 },
  { sessionId: 'sess-b', models: ['claude-opus-5'], card: null,
    startedAt: '2026-09-05T08:00:00Z', endedAt: '2026-09-05T09:00:00Z',
    turns: 1, peakContext: 10, avgContext: 10, heavyTurns: 0,
    input: 1, output: 2, cacheRead: 3, cacheWrite: 4, compactions: 0, usd: 0.1 },
  { sessionId: 'sess-c', models: ['claude-fable-5', 'claude-opus-5'], card: 'T-2',
    startedAt: '2026-09-10T08:00:00Z', endedAt: '2026-09-11T09:00:00Z',
    turns: 3, peakContext: 500000, avgContext: 50, heavyTurns: 1,
    input: 5, output: 6, cacheRead: 7, cacheWrite: 8, compactions: 2, usd: 0.3 },
  { sessionId: 'sess-d', models: ['claude-fable-5-20260901'], card: null, // 同一 fable,只差日期后缀
    startedAt: '2026-09-20T08:00:00Z', endedAt: '2026-09-21T09:00:00Z',
    turns: 1, peakContext: 5, avgContext: 5, heavyTurns: 0,
    input: 2, output: 3, cacheRead: 0, cacheWrite: 0, compactions: 0, usd: 0.2 },
];

test('filterSessions:日期按有交集算,模型按归一名匹配(全名短名都行),卡精确,不设的一侧不限', () => {
  assert.deepEqual(filterSessions(ROWS, {}).map((r) => r.sessionId), ['sess-a', 'sess-b', 'sess-c', 'sess-d']);
  // a 结束于 09-02(≥from)∩ 起于 09-01(≤to);b 整在区间;c 起于 09-10 > to;d 起于 09-20 > to
  assert.deepEqual(filterSessions(ROWS, { fromDate: '2026-09-02', toDate: '2026-09-05' }).map((r) => r.sessionId),
    ['sess-a', 'sess-b'], '跨天会话与区间有交集就该留下');
  assert.deepEqual(filterSessions(ROWS, { fromDate: '2026-09-06' }).map((r) => r.sessionId), ['sess-c', 'sess-d']);
  assert.deepEqual(filterSessions(ROWS, { toDate: '2026-09-04' }).map((r) => r.sessionId), ['sess-a']);
  assert.deepEqual(filterSessions(ROWS, { model: 'claude-fable-5' }).map((r) => r.sessionId),
    ['sess-a', 'sess-c', 'sess-d'], '全名筛得到;d 的带后缀模型归一后同属 fable');
  assert.deepEqual(filterSessions(ROWS, { model: 'fable-5' }).map((r) => r.sessionId),
    ['sess-a', 'sess-c', 'sess-d'], '短名(候选项显示的样子)也筛得到');
  assert.deepEqual(filterSessions(ROWS, { card: 'T-1' }).map((r) => r.sessionId), ['sess-a']);
  assert.deepEqual(filterSessions(ROWS, { card: 'T-9' }), []);
  assert.deepEqual(filterSessions(null, {}), []);
});

test('summarizeSessionRows:筛后合计——四类 token、轮次、压缩、等价美元,平均上下文按总量重算', () => {
  const sum = summarizeSessionRows(ROWS);
  assert.equal(sum.sessions, 4);
  assert.equal(sum.turns, 7);
  assert.equal(sum.input, 18);
  assert.equal(sum.output, 31);
  assert.equal(sum.cacheRead, 40);
  assert.equal(sum.cacheWrite, 52);
  assert.equal(sum.compactions, 3);
  assert.ok(Math.abs(sum.usd - 1.1) < 1e-12, `usd=${sum.usd}`); // 浮点相加不恰好等于小数
  assert.equal(sum.contextSum, 2 * 100 + 1 * 10 + 3 * 50 + 1 * 5);
  assert.equal(sum.avgContext, 365 / 7, 'Σ上下文 ÷ Σ轮次,不平均各行的平均数');
  assert.deepEqual(sum.attribution, { attributed: 2, multi: 0, ambiguous: 0, unattributed: 2 });
  assert.equal(summarizeSessionRows([]).turns, 0);
  assert.equal(summarizeSessionRows([]).avgContext, 0);
});

test('sessionFilterOptions:模型归一去重排序(null 卡不进候选)——同一模型只差日期后缀只出一个选项', () => {
  assert.deepEqual(sessionFilterOptions(ROWS), {
    models: ['fable-5', 'opus-5'], // claude-fable-5 与 claude-fable-5-20260901 归一后同为一个候选
    cards: ['T-1', 'T-2'],
  });
  assert.deepEqual(sessionFilterOptions([]), { models: [], cards: [] });
});

test('带归因字段时多卡能筛中，歧义候选不能筛中，四类计数和选项只取归属', () => {
  const rows = [
    { card: 'CARD-A', attribution: { status: 'attributed', cardIds: ['CARD-A'] } },
    { card: null, attribution: { status: 'multi', cardIds: ['CARD-A', 'CARD-B'] } },
    { card: null, attribution: { status: 'ambiguous', cardIds: [], candidates: ['CARD-C'] } },
    { card: null, attribution: { status: 'unattributed', cardIds: [] } },
  ];
  assert.equal(filterSessions(rows, { card: 'CARD-B' }).length, 1);
  assert.equal(filterSessions(rows, { card: 'CARD-C' }).length, 0);
  assert.deepEqual(summarizeSessionRows(rows).attribution,
    { attributed: 1, multi: 1, ambiguous: 1, unattributed: 1 });
  assert.deepEqual(sessionFilterOptions(rows).cards, ['CARD-A', 'CARD-B']);
});
