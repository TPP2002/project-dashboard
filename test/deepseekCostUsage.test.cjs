'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  isPeakBeijing, priceForDeepseek, costRmbOf, scanDeepseekJobs, getDeepseekUsage,
} = require('../core/deepseekCostUsage.cjs');

const PEAK = '2026-09-14T10:00:00+08:00';
const USAGE = {
  input_tokens: 1000000, output_tokens: 4000000, cache_read_input_tokens: 3000000,
  cache_creation_input_tokens: 2000000,
  cache_creation: { ephemeral_5m_input_tokens: 500000, ephemeral_1h_input_tokens: 1500000 },
};
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const result = (usage = USAGE, model = 'deepseek-flash') => ({
  type: 'result', subtype: 'success', is_error: false, usage,
  total_cost_usd: 987654321, modelUsage: { [model]: { costUSD: 876543210 } },
});

function fixture(t) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'deepseek-usage-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), tempRoot, '只能清理本测试创建的临时目录');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const repos = {};
  for (const name of ['host', 'target', 'hostBoard', 'targetBoard', 'empty']) {
    repos[name] = path.join(dir, name);
    fs.mkdirSync(repos[name]);
  }
  const registryPath = path.join(dir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: '1.0', projects: {
    host: { mainRepo: repos.hostBoard, codeRepo: repos.host },
    target: { mainRepo: repos.targetBoard, codeRepo: repos.target },
    hostAlias: { mainRepo: repos.hostBoard, codeRepo: repos.host },
    empty: { mainRepo: repos.empty },
  } }));
  return { ...repos, registryPath };
}

function writeJob(repo, slug, { task = {}, events = [result()], meta = { dispatchedAt: PEAK } } = {}) {
  const dir = path.join(repo, '.codex', 'jobs', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ engine: 'deepseek', model: 'deepseek-flash', ...task }));
  if (meta !== null) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  if (events !== null) fs.writeFileSync(path.join(dir, 'exec.jsonl'), events
    .map((event) => typeof event === 'string' ? event : JSON.stringify(event)).join('\n'));
}

test('isPeakBeijing:工作日边界采用左闭右开，周末全天空闲', () => {
  for (const [time, expected] of [
    ['08:59', false], ['09:00', true], ['11:59', true], ['12:00', false],
    ['13:59', false], ['14:00', true], ['17:59', true], ['18:00', false],
  ]) assert.equal(isPeakBeijing(`2026-09-14T${time}:00+08:00`), expected, time);
  assert.equal(isPeakBeijing('2026-09-18T17:59:59+08:00'), true, '周五仍有高峰');
  for (const day of ['12', '13']) {
    assert.equal(isPeakBeijing(`2026-09-${day}T10:00:00+08:00`), false);
    assert.equal(isPeakBeijing(`2026-09-${day}T15:00:00+08:00`), false);
  }
  assert.equal(isPeakBeijing('2026-09-14T01:00:00Z'), true, 'UTC 01:00 是北京时间 09:00');
  assert.equal(isPeakBeijing('2026-09-11T18:00:00-07:00'), false, '北京时间已是周六');
  for (const invalid of [null, undefined, '', 'invalid']) assert.equal(isPeakBeijing(invalid), false);
});

test('costRmbOf:两档模型的高峰与空闲人民币价，四个 token 桶不重计', () => {
  for (const [model, peak, prices, expected] of [
    ['deepseek-flash', true, { cacheHit: 0.04, cacheMiss: 2, output: 8 }, 38.12],
    ['deepseek-flash', false, { cacheHit: 0.02, cacheMiss: 1, output: 4 }, 19.06],
    ['deepseek-v4-pro', true, { cacheHit: 0.30, cacheMiss: 9, output: 27 }, 135.9],
    ['deepseek-v4-pro', false, { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }, 67.95],
  ]) {
    assert.deepEqual(priceForDeepseek(model, peak), prices);
    // 输入 1M + 写缓存 2M 按未命中价，读缓存 3M 按命中价，输出 4M 按输出价。
    closeTo(costRmbOf(USAGE, model, peak), expected);
  }
});

test('costRmbOf:新写缓存的 TTL 细分与老格式回落口径一致', () => {
  const legacy = { ...USAGE };
  delete legacy.cache_creation;
  closeTo(costRmbOf(legacy, 'deepseek-flash', true), 38.12);
  closeTo(costRmbOf({ ...legacy, cache_creation: {
    ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0,
  } }, 'deepseek-flash', true), 38.12);
  const splitOnly = { ...USAGE };
  delete splitOnly.cache_creation_input_tokens;
  closeTo(costRmbOf(splitOnly, 'deepseek-flash', true), 38.12);
});

test('costRmbOf:未知模型与无效用量不伪造零元，明确的零用量有效', () => {
  for (const model of ['unknown', 'constructor', '__proto__']) {
    assert.equal(priceForDeepseek(model, true), null);
    assert.equal(costRmbOf(USAGE, model, true), null);
  }
  for (const usage of [null, {}, [], { ...USAGE, output_tokens: -1 }, { ...USAGE, input_tokens: '100' }]) {
    assert.equal(costRmbOf(usage, 'deepseek-flash', true), null);
  }
  assert.equal(costRmbOf({ input_tokens: 0, output_tokens: 0 }, 'deepseek-flash', false), 0);
});

test('scanDeepseekJobs:跨仓归属、代码仓与看板目录分离、重复登记不重计', async (t) => {
  const f = fixture(t);
  writeJob(f.host, 'local');
  writeJob(f.host, 'cross', { task: { repoRoot: f.target.split(path.sep).join('/') + '/.' } });
  writeJob(f.target, 'local'); // 同名工单在另一发起仓是独立记录。
  writeJob(f.target, 'back', { task: { repoRoot: f.host } });
  writeJob(f.hostBoard, 'wrong-home');
  for (const engine of ['codex', 'claude', 'glm', null]) writeJob(f.host, `other-${engine}`, { task: { engine } });
  const hostJobs = await scanDeepseekJobs({ registryPath: f.registryPath, currentCodeRepo: f.host });
  assert.deepEqual(hostJobs.map((job) => job.slug).sort(), ['back', 'local']);
  const targetJobs = await scanDeepseekJobs({ registryPath: f.registryPath, currentCodeRepo: f.target });
  assert.deepEqual(targetJobs.map((job) => job.slug).sort(), ['cross', 'local']);
  assert.equal(targetJobs.find((job) => job.slug === 'cross').hostRepo, f.host);
  assert.equal(targetJobs.find((job) => job.slug === 'local').hostRepo, f.target);
});

test('scanDeepseekJobs:仅取最后一个 result，用原始 token 忽略两处美元数字', async (t) => {
  const f = fixture(t);
  const usage = { input_tokens: 59009, output_tokens: 23029,
    cache_read_input_tokens: 1474240, cache_creation_input_tokens: 0 };
  writeJob(f.host, 'final-result', { events: [
    result(),
    { type: 'assistant', message: { model: 'deepseek-flash', usage: USAGE } },
    '坏行{{{',
    result(usage),
    { type: 'system', subtype: 'stop' },
  ] });
  const jobs = await scanDeepseekJobs({ registryPath: f.registryPath, currentCodeRepo: f.host });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], { slug: 'final-result', hostRepo: f.host, dispatchedAt: PEAK,
    model: 'deepseek-flash', usage, peak: true, costRmb: 0.3612196 });
});

test('scanDeepseekJobs:缺结果、缺用量、缺时间的工单跳过，不作为零用量工单', async (t) => {
  const f = fixture(t);
  writeJob(f.host, 'assistant-only', { events: [{ type: 'assistant', message: { model: 'deepseek-flash', usage: USAGE } }] });
  writeJob(f.host, 'missing-usage', { events: [{ type: 'result' }] });
  writeJob(f.host, 'null-usage', { events: [result(null)] });
  writeJob(f.host, 'empty-usage', { events: [result({})] });
  writeJob(f.host, 'incomplete-last', { events: [result(), { type: 'result' }] });
  writeJob(f.host, 'missing-exec', { events: null });
  writeJob(f.host, 'missing-meta', { meta: null });
  writeJob(f.host, 'bad-time', { meta: { dispatchedAt: 'invalid' } });
  writeJob(f.host, 'bad-target', { task: { repoRoot: '' } });
  writeJob(f.host, 'unknown-model', { events: [result(USAGE, 'unknown')] });
  writeJob(f.host, 'mixed-models', { events: [{ ...result(), modelUsage: {
    'deepseek-flash': {}, 'deepseek-v4-pro': {},
  } }] });
  const options = { registryPath: f.registryPath, currentCodeRepo: f.host };
  assert.deepEqual(await scanDeepseekJobs(options), []);
  writeJob(f.host, 'zero', { events: [result({ input_tokens: 0, output_tokens: 0 })] });
  const jobs = await scanDeepseekJobs(options);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].costRmb, 0);
});

test('scanDeepseekJobs:保留失败工单已消耗用量，缺 modelUsage 时读取 assistant 模型', async (t) => {
  const f = fixture(t);
  writeJob(f.host, 'failed', { events: [
    { type: 'assistant', message: { model: 'deepseek-v4-pro', usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'result', subtype: 'error_during_execution', is_error: true, usage: USAGE },
  ] });
  const jobs = await scanDeepseekJobs({ registryPath: f.registryPath, currentCodeRepo: f.host });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].model, 'deepseek-v4-pro');
  closeTo(jobs[0].costRmb, 135.9);
});

test('getDeepseekUsage:固定本地日期窗口、逐日与按模型合计、金额汇总前不舍入', async (t) => {
  const f = fixture(t);
  const usage = { input_tokens: 0, output_tokens: 100 };
  const timestamp = (day) => new Date(2026, 8, day, 12).toISOString();
  const modelFor = (day) => day === 13 ? 'deepseek-v4-pro' : 'deepseek-flash';
  for (const day of [11, 12, 13, 14, 15]) {
    writeJob(day === 13 ? f.target : f.host, `day-${day}`, {
      task: { repoRoot: f.target }, meta: { dispatchedAt: timestamp(day) },
      events: [result(usage, modelFor(day))],
    });
  }
  const options = { registryPath: f.registryPath, projectId: 'target', days: 3,
    nowMs: new Date(2026, 8, 14, 18).getTime() };
  const r = await getDeepseekUsage(options);
  const costs = [12, 13, 14].map((day) => costRmbOf(usage, modelFor(day), isPeakBeijing(timestamp(day))));
  const outputOnly = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, cacheHitRate: 0 };
  assert.deepEqual(r.byDay, [12, 13, 14].map((day, i) => ({
    date: `2026-09-${day}`, tokens: 100, costRmb: costs[i], ...outputOnly,
  })));
  assert.equal(r.totals.jobs, 3);
  assert.equal(r.totals.tokens, 300);
  closeTo(r.totals.costRmb, costs.reduce((sum, value) => sum + value, 0));
  assert.ok(r.totals.costRmb > 0 && r.totals.costRmb < 0.01, '分以下金额须累加，不能逐单舍入成零');
  for (const [field, value] of Object.entries({ ...outputOnly, output: 300 })) {
    assert.equal(r.totals[field], value, field);
  }
  assert.deepEqual(r.byModel, {
    'deepseek-flash': { tokens: 200, costRmb: costs[0] + costs[2], ...outputOnly, output: 200 },
    'deepseek-v4-pro': { tokens: 100, costRmb: costs[1], ...outputOnly },
  });
  assert.deepEqual(await getDeepseekUsage(options), r, '相同输入与窗口应可重放');
  const today = await getDeepseekUsage({ ...options, days: 1 });
  assert.deepEqual(today.byDay, [r.byDay[2]]);
  assert.deepEqual(await getDeepseekUsage({ ...options, projectId: 'empty' }), {
    byDay: [], totals: { tokens: 0, costRmb: 0, jobs: 0, ...outputOnly, output: 0 }, byModel: {},
  });
});

test('getDeepseekUsage:四个用量桶与命中率在逐日、模型和总计中均保留', async (t) => {
  const f = fixture(t);
  writeJob(f.host, 'all-buckets');
  const r = await getDeepseekUsage({ registryPath: f.registryPath, projectId: 'host', days: 1, nowMs: Date.parse(PEAK) });
  assert.equal(r.totals.tokens, 10000000);
  assert.equal(r.totals.jobs, 1);
  closeTo(r.totals.costRmb, 38.12);
  const tally = { tokens: 10000000, costRmb: 38.12, input: 1000000, output: 4000000,
    cacheRead: 3000000, cacheWrite: 2000000, cacheHitRate: 0.5 };
  assert.deepEqual(r.totals, { ...tally, jobs: 1 });
  assert.deepEqual(r.byModel, { 'deepseek-flash': tally });
  assert.deepEqual(r.byDay, [{ date: r.byDay[0].date, ...tally }]);
});

test('getDeepseekUsage:命中率按桶数加权，缓存写入细分不重计，输出不入分母', async (t) => {
  const f = fixture(t);
  const timestamp = (day) => new Date(2026, 8, day, 12).toISOString();
  const rows = [
    [13, 'deepseek-flash', { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 30 }],
    [14, 'deepseek-flash', { input_tokens: 30, output_tokens: 200, cache_read_input_tokens: 10,
      cache_creation_input_tokens: 999,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 40 } }],
    [14, 'deepseek-v4-pro', { input_tokens: 0, output_tokens: 600, cache_read_input_tokens: 100 }],
  ];
  for (const [index, [day, model, usage]] of rows.entries()) {
    writeJob(f.host, `weighted-${index}`, { meta: { dispatchedAt: timestamp(day) }, events: [result(usage, model)] });
  }
  const r = await getDeepseekUsage({ registryPath: f.registryPath, projectId: 'host', days: 2,
    nowMs: new Date(2026, 8, 14, 18).getTime() });
  assert.equal(r.totals.jobs, 3);
  assert.deepEqual(r.byDay.map((row) => row.date), ['2026-09-13', '2026-09-14']);
  for (const [row, expected] of [
    [r.totals, { tokens: 1140, input: 40, output: 900, cacheRead: 140, cacheWrite: 60, cacheHitRate: 140 / 240 }],
    [r.byModel['deepseek-flash'], { tokens: 440, input: 40, output: 300, cacheRead: 40, cacheWrite: 60, cacheHitRate: 40 / 140 }],
    [r.byModel['deepseek-v4-pro'], { tokens: 700, input: 0, output: 600, cacheRead: 100, cacheWrite: 0, cacheHitRate: 1 }],
    [r.byDay[0], { tokens: 140, input: 10, output: 100, cacheRead: 30, cacheWrite: 0, cacheHitRate: 0.75 }],
    [r.byDay[1], { tokens: 1000, input: 30, output: 800, cacheRead: 110, cacheWrite: 60, cacheHitRate: 0.55 }],
  ]) {
    for (const [field, value] of Object.entries(expected)) assert.equal(row[field], value, field);
  }
});

test('getDeepseekUsage:全零用量及没有缓存命中的输入，命中率为零', async (t) => {
  const f = fixture(t);
  const options = { registryPath: f.registryPath, projectId: 'host', days: 1, nowMs: Date.parse(PEAK) };
  writeJob(f.host, 'zero', { events: [result({ input_tokens: 0, output_tokens: 0 })] });
  const zero = await getDeepseekUsage(options);
  assert.equal(zero.totals.jobs, 1);
  for (const row of [zero.totals, ...zero.byDay, ...Object.values(zero.byModel)]) {
    for (const field of ['tokens', 'costRmb', 'input', 'output', 'cacheRead', 'cacheWrite', 'cacheHitRate']) {
      assert.equal(row[field], 0, field);
    }
  }
  writeJob(f.host, 'miss', { events: [result({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30 })] });
  const miss = await getDeepseekUsage(options);
  assert.equal(miss.totals.input, 10);
  assert.equal(miss.totals.cacheWrite, 30);
  for (const row of [miss.totals, ...miss.byDay, ...Object.values(miss.byModel)]) {
    assert.equal(row.cacheHitRate, 0);
  }
});
