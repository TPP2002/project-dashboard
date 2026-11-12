'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCostSources } = require('../server/costSources.cjs');
const { findDemoDir, DEMO_MARKER_FILE } = require('../core/demoMode.cjs');
const costUsage = require('../core/costUsage.cjs');
const deepseek = require('../core/deepseekCostUsage.cjs');
const glm = require('../core/glmCostUsage.cjs');
const workbuddy = require('../core/workbuddyCostUsage.cjs');

test('normal sources forward all arguments unchanged', () => {
  const names = ['getUsage', 'collectJobRows', 'getDeepseekUsage', 'scanAllDeepseekJobs', 'summarizeDeepseekJobs', 'getGlmUsage', 'scanGlmJobs', 'summarizeGlmJobs', 'getWorkbuddyUsage', 'scanWorkbuddyLedgers', 'summarizeWorkbuddyRequests', 'getDeepseekBalance'];
  for (const name of names) {
    let received;
    const real = { [name]: (...args) => { received = args; return 'result'; } };
    const sources = createCostSources({ real });
    const args = [{ a: [1] }, { b: 2 }];
    assert.equal(sources[name](...args), 'result');
    assert.deepEqual(received, args);
  }
  const sources = createCostSources({ real: {} });
  assert.equal(sources.sessionsRoot('root'), 'root');
  assert.equal(sources.jobsRoot('root'), 'root');
});

test('demo isolates sources and uses real empty summarizers', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-sources-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prefix = 'demo-a';
  fs.mkdirSync(path.join(dir, 'claude-projects', prefix), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fake-real', prefix), { recursive: true });
  const row = { type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'demo', isSidechain: false, message: { id: 'one', model: 'claude-sonnet-4-5', usage: { output_tokens: 1234 } } };
  fs.writeFileSync(path.join(dir, 'claude-projects', prefix, 'one.jsonl'), JSON.stringify(row) + '\n');
  fs.writeFileSync(path.join(dir, 'fake-real', prefix, 'one.jsonl'), JSON.stringify({ ...row, message: { ...row.message, usage: { output_tokens: 9876 } } }) + '\n');
  let balanceCalls = 0, fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { fetchCalls++; throw new Error('unexpected'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const real = { ...deepseek, ...glm, ...workbuddy, getUsage: costUsage.getUsage, getDeepseekBalance: () => { balanceCalls++; } };
  const sources = createCostSources({ demoDir: dir, real });
  const usage = await sources.getUsage({ prefix, projectsRoot: path.join(dir, 'fake-real'), cachePath: path.join(dir, 'fake-cache') });
  assert.equal(usage.totals.output, 1234);
  assert.equal((await sources.getDeepseekBalance()).available, false);
  assert.equal((await sources.getDeepseekBalance()).balance, null);
  assert.equal(balanceCalls, 0);
  assert.equal(fetchCalls, 0);
  const opts = { days: 30 };
  const ledger = { requests: [], lastCheck: null, updatedAt: null };
  assert.deepEqual(await sources.getDeepseekUsage(opts), deepseek.summarizeDeepseekJobs([], { ...opts, projectRepo: dir }));
  assert.deepEqual(sources.getGlmUsage(opts), glm.summarizeGlmJobs([], opts));
  assert.deepEqual(sources.getWorkbuddyUsage(opts), workbuddy.summarizeWorkbuddyRequests(ledger, opts));
  assert.deepEqual(await sources.scanAllDeepseekJobs(opts), []);
  assert.deepEqual(sources.scanGlmJobs(opts), []);
  assert.deepEqual(sources.scanWorkbuddyLedgers(opts), ledger);
  assert.equal(sources.sessionsRoot('real'), path.join(dir, 'codex-sessions'));
  assert.equal(sources.jobsRoot('real'), path.join(dir, 'demo-jobs'));
});

test('marker discovery checks registry before home and ignores contents', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-marker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registryDir = path.join(dir, 'registry'), home = path.join(dir, 'home');
  fs.mkdirSync(registryDir); fs.mkdirSync(home);
  const opts = { registryPath: path.join(registryDir, 'registry.json'), home };
  assert.equal(findDemoDir(opts), null);
  fs.writeFileSync(path.join(home, DEMO_MARKER_FILE), '{}');
  assert.equal(findDemoDir(opts), home);
  fs.writeFileSync(path.join(registryDir, DEMO_MARKER_FILE), 'bad json');
  assert.equal(findDemoDir(opts), registryDir);
});
