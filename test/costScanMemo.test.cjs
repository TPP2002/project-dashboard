'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileMemo } = require('../core/fileMemo.cjs');
const { readExecSummary } = require('../core/jobExecSummary.cjs');
const { scanDeepseekJobs, getDeepseekUsage, scanAllDeepseekJobs, summarizeDeepseekJobs } = require('../core/deepseekCostUsage.cjs');
const { scanGlmJobs, getGlmUsage } = require('../core/glmCostUsage.cjs');
const { collectJobRows } = require('../core/costJobDetail.cjs');
const { listJobs } = require('../server/codexJobs.cjs');

test('memoized scans preserve results and reuse only unchanged files', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-memo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repos = ['demo-a', 'demo-b'].map((name) => path.join(dir, name));
  for (const repo of repos) fs.mkdirSync(repo);
  const registryPath = path.join(dir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: Object.fromEntries(repos.map((repo, i) => [`demo-${i ? 'b' : 'a'}`, { mainRepo: repo }])) }));
  const at = new Date().toISOString();
  let log;
  for (const [index, repo] of repos.entries()) for (const engine of ['codex', 'deepseek', 'glm', 'workbuddy']) {
    const job = path.join(repo, '.codex', 'jobs', engine);
    fs.mkdirSync(job, { recursive: true });
    fs.writeFileSync(path.join(job, 'task.json'), JSON.stringify({ engine, model: engine === 'deepseek' ? 'deepseek-flash' : engine, repoRoot: repos[1 - index], title: engine, acceptance: [{ id: 'a', required: true }] }));
    fs.writeFileSync(path.join(job, 'meta.json'), JSON.stringify({ dispatchedAt: at }));
    fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify({ startedAt: at }));
    if (!(index === 1 && engine === 'workbuddy')) fs.writeFileSync(path.join(job, 'cost.json'), JSON.stringify({ engine }));
    if (engine === 'codex') fs.writeFileSync(path.join(job, 'verdict.json'), JSON.stringify({ acceptance: [{ id: 'a', passed: true }] }));
    if (engine === 'deepseek') {
      const file = path.join(job, 'exec.jsonl');
      fs.writeFileSync(file, [JSON.stringify({ type: 'user', text: 'x'.repeat(10000) }), JSON.stringify({ type: 'assistant', message: { model: 'deepseek-flash' } }), JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 2 } }), '{partial'].join('\n'));
      if (!log) log = file;
    } else if (index === 0) fs.writeFileSync(path.join(job, 'exec.jsonl'), JSON.stringify({ type: 'user', text: 'hello' }));
  }
  const persistPath = path.join(dir, 'memo.json'), memo = createFileMemo({ persistPath });
  const root = path.join(repos[0], '.codex', 'jobs');
  const otherRoot = path.join(repos[1], '.codex', 'jobs');
  const compare = async () => {
    const options = { registryPath, currentCodeRepo: repos[0] };
    assert.deepEqual(await scanDeepseekJobs({ ...options, memo }), await scanDeepseekJobs(options));
    const usage = { registryPath, projectId: 'demo-a' };
    assert.deepEqual(await getDeepseekUsage({ ...usage, memo }), await getDeepseekUsage(usage));
    assert.deepEqual(scanGlmJobs({ registryPath, memo }), scanGlmJobs({ registryPath }));
    assert.deepEqual(getGlmUsage({ ...usage, memo }), getGlmUsage(usage));
    assert.deepEqual(await collectJobRows(root, { memo }), await collectJobRows(root));
    assert.deepEqual(listJobs(root, { memo }), listJobs(root));
    assert.deepEqual(await collectJobRows(otherRoot, { memo }), await collectJobRows(otherRoot));
    assert.deepEqual(listJobs(otherRoot, { memo }), listJobs(otherRoot));
  };
  await compare();
  const first = memo.stats().loads;
  await compare();
  assert.equal(memo.stats().loads, first);
  const state = path.join(root, 'codex', 'state.json');
  assert.equal((await collectJobRows(root, { memo })).find((row) => row.slug === 'codex').running, true);
  fs.writeFileSync(state, JSON.stringify({ finishedAt: at }));
  const changedState = await collectJobRows(root, { memo });
  assert.equal(memo.stats().loads, first + 1);
  assert.equal(changedState.find((row) => row.slug === 'codex').running, false);
  const before = memo.stats().loadsByKey['exec-summary@1'];
  fs.appendFileSync(log, '\n' + JSON.stringify({ type: 'result', usage: { input_tokens: 3, output_tokens: 4 } }));
  const changedLog = await collectJobRows(root, { memo });
  assert.equal(memo.stats().loadsByKey['exec-summary@1'], before + 1);
  assert.equal(changedLog.find((row) => row.slug === 'deepseek').output, 4);
  await compare();
  const all = await scanAllDeepseekJobs({ registryPath, memo });
  for (const [i, repo] of repos.entries()) assert.deepEqual(summarizeDeepseekJobs(all, { projectRepo: repo }), await getDeepseekUsage({ registryPath, projectId: i ? 'demo-b' : 'demo-a', memo }));
  memo.flush();
  const fresh = createFileMemo({ persistPath });
  assert.deepEqual(await collectJobRows(root, { memo: fresh }), await collectJobRows(root));
  assert.deepEqual(await scanDeepseekJobs({ registryPath, currentCodeRepo: repos[0], memo: fresh }), await scanDeepseekJobs({ registryPath, currentCodeRepo: repos[0] }));
  assert.equal(fresh.stats().loadsByKey['exec-summary@1'] || 0, 0);
  const summary = await readExecSummary(log);
  assert.equal(summary.turns, 1);
  assert.deepEqual(summary.result.usage, { input_tokens: 3, output_tokens: 4 });
  const absentRow = (await collectJobRows(otherRoot, { memo })).find((row) => row.slug === 'workbuddy');
  assert.equal(absentRow.turns, 0);
  assert.equal(absentRow.usedModel, null);
});

test('invalid metadata keeps each reader error policy and absent engine defaults to codex', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-bad-meta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'demo-a');
  const job = path.join(repo, '.codex', 'jobs', 'bad-meta');
  fs.mkdirSync(job, { recursive: true });
  const registryPath = path.join(root, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { 'demo-a': { mainRepo: repo } } }));
  fs.writeFileSync(path.join(job, 'task.json'), JSON.stringify({ title: 'legacy' }));
  fs.writeFileSync(path.join(job, 'meta.json'), '{invalid');
  const jobsRoot = path.dirname(job), memo = createFileMemo();
  assert.deepEqual(await collectJobRows(jobsRoot, { memo }), await collectJobRows(jobsRoot));
  assert.equal((await collectJobRows(jobsRoot, { memo }))[0].engine, 'codex');
  assert.throws(() => listJobs(jobsRoot), SyntaxError);
  assert.throws(() => listJobs(jobsRoot, { memo }), SyntaxError);
  assert.deepEqual(await scanDeepseekJobs({ registryPath, currentCodeRepo: repo, memo }), []);
});

test('exec summary agrees with parsing every line, including escaped event types', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'exec.jsonl');
  const lines = [JSON.stringify({ type: 'user', data: 'x'.repeat(20000) }),
    '{"type":"assi\\u0073tant","message":{"model":"first"}}',
    '{"type":"res\\u0075lt","usage":{"input_tokens":1},"modelUsage":{"first":{}}}',
    JSON.stringify({ type: 'assistant', message: { model: 'second' } }),
    JSON.stringify({ type: 'result', usage: { output_tokens: 2 }, total_cost_usd: 3 }),
    '{"type":"res\\u0075lt","usage":{"output_tokens":5},"total_cost_usd":7}', '{partial'];
  fs.writeFileSync(file, lines.join('\n'));
  const expected = { turns: 0, lastAssistantModel: null, result: null };
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch (_) { continue; }
    if (event?.type === 'assistant') {
      expected.turns++;
      if (typeof event.message?.model === 'string') expected.lastAssistantModel = event.message.model;
    }
    if (event?.type === 'result') expected.result = { usage: event.usage,
      modelUsageNames: event.modelUsage && typeof event.modelUsage === 'object' && !Array.isArray(event.modelUsage) ? Object.keys(event.modelUsage) : [],
      model: event.model ?? null, totalCostUsd: event.total_cost_usd ?? null, assistantModel: expected.lastAssistantModel };
  }
  assert.deepEqual(await readExecSummary(file), expected);
});
