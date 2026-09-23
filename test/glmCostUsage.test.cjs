'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getGlmUsage } = require('../core/glmCostUsage.cjs');

test('GLM 按目标项目归账，首轮与续聊四桶相加，积分缺失/归因不清不伪装成零成本', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-cost-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = path.join(root, 'host'), target = path.join(root, 'target');
  fs.mkdirSync(host); fs.mkdirSync(target);
  const registryPath = path.join(root, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: {
    host: { mainRepo: host }, target: { mainRepo: target }, duplicate: { mainRepo: host },
  } }));
  function job(slug, repo, cost) {
    const dir = path.join(host, '.codex', 'jobs', slug); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ engine: 'glm', repoRoot: repo }));
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ dispatchedAt: '2026-09-23T02:00:00Z' }));
    fs.writeFileSync(path.join(dir, 'cost.json'), JSON.stringify({ engine: 'glm', ...cost }));
  }
  job('one', target, { model: 'glm-5.3', usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 4 },
    resumeUsage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 1 }, resumeRounds: 1,
    glmQuota: { weeklyDelta: 50 }, attribution: { attributable: null } });
  job('two', target, { model: 'glm-5.3-flash', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 },
    glmQuota: { weeklyDelta: null }, attribution: { attributable: false } });
  job('other', host, { model: 'glm-5.3', usage: { input: 900, output: 900, cacheRead: 900, cacheWrite: 0 } });
  const result = getGlmUsage({ projectId: 'target', registryPath, days: 7,
    nowMs: Date.parse('2026-09-23T12:00:00Z') });
  assert.equal(result.totals.jobs, 2);
  assert.equal(result.totals.input, 13);
  assert.equal(result.totals.output, 25);
  assert.equal(result.totals.cacheRead, 38);
  assert.equal(result.totals.cacheWrite, 5);
  assert.equal(result.totals.tokens, 81);
  assert.equal(result.totals.credits, 50);
  assert.equal(result.totals.creditJobs, 1);
  assert.equal(result.totals.uncertainCredits, 50);
  assert.equal(result.byDay.length, 1);
  assert.equal(result.byDay[0].tokens, 81);
});
