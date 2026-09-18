'use strict';
// COST-UI-SESSION-DETAIL:工单(按单)成本明细的收集、计价复用、筛选与合计单测。
// 夹具一律 os.tmpdir() 临时目录 + 合成假值,不碰真实工单目录(公开仓红线)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { collectJobRows, filterJobRows, jobCostRmb, jobFilterOptions, summarizeJobRows } = require('../core/costJobDetail.cjs');
const { costRmbOf } = require('../core/deepseekCostUsage.cjs');

const PEAK = '2026-09-14T10:00:00+08:00'; // 周一上午,高峰
const BETWEEN = '2026-09-13T10:00:00+08:00'; // 周日,空闲
const OFF = '2026-09-12T10:00:00+08:00'; // 周六,空闲
const USAGE = {
  input_tokens: 1000000, output_tokens: 4000000,
  cache_read_input_tokens: 3000000, cache_creation_input_tokens: 2000000,
};
const assistant = (model = 'deepseek-flash') => ({ type: 'assistant', message: { model } });
const result = (usage = USAGE, model) => ({
  type: 'result', subtype: 'success', is_error: false, usage, total_cost_usd: 3.5,
  ...(model ? { modelUsage: { [model]: { costUSD: 1 } } } : {}),
});

function fixture(t) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'job-detail-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), tempRoot, '只能清理本测试创建的临时目录');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { jobs: path.join(dir, 'jobs') };
}

function writeJob(jobsRoot, slug, { task = {}, events = [result()], meta = { dispatchedAt: PEAK }, state = {} } = {}) {
  const dir = path.join(jobsRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task));
  if (meta !== null) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  if (state !== null) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  if (events !== null) {
    fs.writeFileSync(path.join(dir, 'exec.jsonl'),
      events.map((event) => typeof event === 'string' ? event : JSON.stringify(event)).join('\n'));
  }
}

test('collectJobRows:字段全落地——轮次数 assistant、token 取最后 result 顶层 usage、时长/高峰/美元照抄落盘', async (t) => {
  const f = fixture(t);
  writeJob(f.jobs, 'job-a', {
    task: { engine: 'deepseek', model: 'deepseek-flash', taskId: 'CARD-1', title: '示例工单' },
    meta: { dispatchedAt: PEAK },
    state: { startedAt: '2026-09-14T10:05:00+08:00', finishedAt: '2026-09-14T10:35:00+08:00' },
    events: [assistant(), assistant('deepseek-v4-pro'), result(USAGE, 'deepseek-flash'), { type: 'system' }],
  });
  const rows = await collectJobRows(f.jobs);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.slug, 'job-a');
  assert.equal(row.title, '示例工单');
  assert.equal(row.card, 'CARD-1');
  assert.equal(row.engine, 'deepseek');
  assert.equal(row.model, 'deepseek-flash', 'model = 派单时指定的档');
  assert.equal(row.usedModel, 'deepseek-flash', 'modelUsage 只有一个模型时取它');
  assert.equal(row.dispatchedAt, PEAK);
  assert.equal(row.startedAt, '2026-09-14T10:05:00+08:00');
  assert.equal(row.finishedAt, '2026-09-14T10:35:00+08:00');
  assert.equal(row.running, false);
  assert.equal(row.durationMs, 30 * 60e3, '时长 = finished − started');
  assert.equal(row.turns, 2, '轮次 = assistant 事件条数,与用量无关');
  assert.deepEqual(
    { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite },
    { input: 1000000, output: 4000000, cacheRead: 3000000, cacheWrite: 2000000 },
    'token 只取最后一条 result 的顶层 usage,assistant 行不累加',
  );
  assert.equal(row.peak, true, '派单时间落在工作日高峰段');
  assert.equal(row.chain, false, '同卡只有这一单 → 不算级联');
  assert.equal(row.reportedUsd, 3.5, 'CLI 自报美元只展示');
  assert.equal(jobCostRmb(row), costRmbOf(USAGE, 'deepseek-flash', true), '人民币直接复用 deepseekCostUsage 的价目,不另立口径');
  assert.ok(jobCostRmb(row) > 0);
});

test('collectJobRows:老工单缺字段与坏日志都容忍——engine 缺省 codex、无 usage 记 0、非法时间不猜', async (t) => {
  const f = fixture(t);
  writeJob(f.jobs, 'legacy', {
    task: { title: '老工单' }, // 没写 engine/model
    meta: { dispatchedAt: 'invalid' },
    state: { startedAt: '2026-09-14T10:00:00Z' }, // 没有 finishedAt → 还在跑
    events: [assistant('deepseek-v4-pro'), '坏行{{{', { type: 'result' }],
  });
  writeJob(f.jobs, 'no-exec', { task: {}, events: null, state: null });
  writeJob(f.jobs, 'no-meta', { task: {}, meta: null });
  const rows = await collectJobRows(f.jobs);
  const by = new Map(rows.map((row) => [row.slug, row]));
  assert.equal(rows.length, 3);

  const legacy = by.get('legacy');
  assert.equal(legacy.engine, 'codex', '没写 engine 的老工单都是标准 Codex 派单');
  assert.equal(legacy.model, null);
  assert.equal(legacy.dispatchedAt, null, '非法时间不猜');
  assert.equal(legacy.peak, null, '判不出派单时间就不判高峰');
  assert.equal(legacy.turns, 1, '坏行跳过,只数到一条 assistant');
  assert.equal(legacy.usedModel, 'deepseek-v4-pro', '缺 modelUsage 时退回 assistant 的模型');
  assert.deepEqual(
    { input: legacy.input, output: legacy.output, cacheRead: legacy.cacheRead, cacheWrite: legacy.cacheWrite },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    'result 没有 usage 记 0,不伪造账目',
  );
  assert.equal(legacy.reportedUsd, null);
  assert.equal(legacy.running, true);
  assert.equal(legacy.durationMs, null);
  assert.equal(jobCostRmb(legacy), 0, '零用量是明确的有效账目');

  const noExec = by.get('no-exec');
  assert.equal(noExec.turns, 0);
  assert.equal(noExec.usedModel, null);
  assert.equal(jobCostRmb(noExec), null, '判不出实际模型就不折钱');
  assert.equal(by.get('no-meta').dispatchedAt, null);
});

test('collectJobRows:级联链看同卡单数、slug 合法性把关、按派单时间降序、目录缺失返回空', async (t) => {
  const f = fixture(t);
  writeJob(f.jobs, 'chain-old', { task: { taskId: 'CARD-9' }, meta: { dispatchedAt: OFF } });
  writeJob(f.jobs, 'chain-new', { task: { taskId: 'CARD-9' }, meta: { dispatchedAt: PEAK } });
  writeJob(f.jobs, 'lone', { task: { taskId: 'CARD-8' }, meta: { dispatchedAt: BETWEEN } });
  writeJob(f.jobs, 'nocard', { task: {}, meta: { dispatchedAt: '2026-09-11T10:00:00+08:00' } });
  fs.mkdirSync(path.join(f.jobs, 'Bad_Slug'), { recursive: true }); // 大写+下划线,非法 slug
  fs.writeFileSync(path.join(f.jobs, 'Bad_Slug', 'task.json'), '{}');
  fs.mkdirSync(path.join(f.jobs, '.hidden'), { recursive: true });

  assert.deepEqual(await collectJobRows(path.join(f.jobs, 'nope')), [], 'jobsRoot 不存在 → 没有工单');
  const rows = await collectJobRows(f.jobs);
  assert.deepEqual(rows.map((row) => row.slug),
    ['chain-new', 'lone', 'chain-old', 'nocard'], '按派单时间降序;非法 slug 目录不进表');
  const by = new Map(rows.map((row) => [row.slug, row]));
  assert.equal(by.get('chain-new').chain, true, '同卡两张单 → 都算级联链');
  assert.equal(by.get('chain-old').chain, true);
  assert.equal(by.get('lone').chain, false, '同卡只有这一单');
  assert.equal(by.get('nocard').chain, null, '没有卡的工单判不出级联');
});

test('filterJobRows:派单日筛选是本机时区口径——UTC 16:30 派的单按它在本机的当天筛得到', () => {
  const row = { slug: 'tz-job', title: null, card: 'C-1', engine: 'codex', model: null, usedModel: null,
    dispatchedAt: '2026-09-14T16:30:00Z', running: false, turns: 1,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reportedUsd: null, peak: null, chain: null, costRmb: null };
  const d = new Date('2026-09-14T16:30:00Z'); // 东八区墙上时钟已是 09-15 凌晨,按天图口径就该算 09-15
  const p = (n) => String(n).padStart(2, '0');
  const localDay = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  assert.deepEqual(filterJobRows([row], { fromDate: localDay, toDate: localDay }).map((x) => x.slug), ['tz-job'],
    '按本机日历的当天要筛得到(旧口径按 UTC 切前 10 位,东八区会漏掉它)');
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const nextDay = `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}`;
  assert.deepEqual(filterJobRows([row], { fromDate: nextDay, toDate: nextDay }), [], '从次日起筛不得再带到前一天');
});

// ---------- 纯函数:filterJobRows / summarizeJobRows / jobFilterOptions ----------

const ROWS = [
  { slug: 'job-1', title: null, card: 'C-1', engine: 'codex', model: 'gpt-5-codex', usedModel: null,
    dispatchedAt: '2026-09-01T08:00:00+08:00', running: false, turns: 2,
    input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reportedUsd: null, peak: false, chain: false },
  { slug: 'job-2', title: '跨境单', card: null, engine: 'deepseek', model: 'deepseek-flash', usedModel: 'deepseek-v4-pro',
    dispatchedAt: '2026-09-05T10:00:00+08:00', running: false, turns: 1,
    input: 10, output: 20, cacheRead: 3, cacheWrite: 4, reportedUsd: 1.5, peak: true, chain: true },
  { slug: 'job-3', title: null, card: 'C-2', engine: 'codex', model: null, usedModel: 'gpt-5-codex',
    dispatchedAt: '2026-09-10T08:00:00+08:00', running: true, turns: 3,
    input: 5, output: 6, cacheRead: 7, cacheWrite: 8, reportedUsd: null, peak: false, chain: false },
];

test('filterJobRows:日期按派单日含端点,engine/card 精确,model 命中指定或实际任一侧,不设的一侧不限', () => {
  assert.deepEqual(filterJobRows(ROWS, {}).map((row) => row.slug), ['job-1', 'job-2', 'job-3']);
  assert.deepEqual(filterJobRows(ROWS, { fromDate: '2026-09-05' }).map((row) => row.slug), ['job-2', 'job-3']);
  assert.deepEqual(filterJobRows(ROWS, { toDate: '2026-09-05' }).map((row) => row.slug), ['job-1', 'job-2'], '端点日含入');
  assert.deepEqual(filterJobRows(ROWS, { fromDate: '2026-09-05', toDate: '2026-09-05' }).map((row) => row.slug), ['job-2']);
  assert.deepEqual(filterJobRows(ROWS, { engine: 'codex' }).map((row) => row.slug), ['job-1', 'job-3']);
  assert.deepEqual(filterJobRows(ROWS, { card: 'C-1' }).map((row) => row.slug), ['job-1']);
  assert.deepEqual(filterJobRows(ROWS, { model: 'deepseek-flash' }).map((row) => row.slug), ['job-2'], '命中工单指定档');
  assert.deepEqual(filterJobRows(ROWS, { model: 'deepseek-v4-pro' }).map((row) => row.slug), ['job-2'], '命中实际判读档');
  assert.deepEqual(filterJobRows(ROWS, { model: 'gpt-5-codex' }).map((row) => row.slug), ['job-1', 'job-3']);
  assert.deepEqual(filterJobRows(null, {}), []);
});

test('summarizeJobRows:筛后合计——单数/轮次/四类 token;人民币只累加判得出价目的单', () => {
  const sum = summarizeJobRows(ROWS);
  assert.equal(sum.jobs, 3);
  assert.equal(sum.turns, 6);
  assert.equal(sum.input, 16);
  assert.equal(sum.output, 28);
  assert.equal(sum.cacheRead, 10);
  assert.equal(sum.cacheWrite, 12);
  assert.equal(sum.costRmbJobs, 1, '只有 job-2 判得出 DeepSeek 价目');
  assert.ok(Math.abs(sum.costRmb - jobCostRmb(ROWS[1])) < 1e-12);
  assert.equal(summarizeJobRows([]).jobs, 0);
  assert.equal(summarizeJobRows([]).costRmb, 0);
});

test('jobFilterOptions:引擎/模型(实际∪指定)/卡各取全集字典序,空值不进候选', () => {
  assert.deepEqual(jobFilterOptions(ROWS), {
    engines: ['codex', 'deepseek'],
    models: ['deepseek-flash', 'deepseek-v4-pro', 'gpt-5-codex'],
    cards: ['C-1', 'C-2'],
  });
  assert.deepEqual(jobFilterOptions([]), { engines: [], models: [], cards: [] });
});
