'use strict';
// WorkBuddy 命令行积分账:账本异常容忍、跨仓去重、时间窗口与两位小数口径的单测。
// 夹具一律 os.tmpdir() 临时目录 + 合成假值,不碰真实账本(公开仓红线)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  getWorkbuddyUsage,
  scanWorkbuddyLedgers,
  summarizeWorkbuddyRequests,
} = require('../core/workbuddyCostUsage.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'workbuddy-cost-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeLedger(root, name, data) {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.codex', 'workbuddy-ledger.json'),
    typeof data === 'string' ? data : JSON.stringify(data));
  return repo;
}

function writeRegistry(root, entries) {
  const registryPath = path.join(root, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: entries }));
  return registryPath;
}

function request(overrides) {
  return {
    at: '2026-11-02T09:00:00+08:00', model: 'deepseek-v4.1-flash', credits: 1,
    source: 'transcript', slug: 'job-a', taskId: null, repo: null, label: null, ...overrides,
  };
}

// 时刻一律按本机时间构造:产品按本机时区切天,夹具写死 +08:00 在别的时区跑会整体偏移。
function localTime(month, day, hour, minute, second = 0) {
  return new Date(2026, month - 1, day, hour, minute, second);
}

test('账本缺失、JSON 损坏、schemaVersion 不对都当没有账:返回空且不抛', (t) => {
  const root = fixture(t);
  const missing = path.join(root, 'repo-missing');
  const broken = writeLedger(root, 'repo-broken', '{ 这不是 JSON');
  const wrongSchema = writeLedger(root, 'repo-schema', { schemaVersion: 2, requests: { a: request({}) } });
  fs.mkdirSync(missing, { recursive: true });
  const registryPath = writeRegistry(root, {
    missing: { mainRepo: missing }, broken: { mainRepo: broken }, schema: { mainRepo: wrongSchema },
  });
  const scan = scanWorkbuddyLedgers({ registryPath });
  assert.deepEqual(scan.requests, []);
  assert.equal(scan.lastCheck, null);
  assert.equal(scan.updatedAt, null);
  const summary = summarizeWorkbuddyRequests(scan, { nowMs: Date.parse('2026-11-05T00:00:00+08:00') });
  assert.equal(summary.totals.requests, 0);
  assert.equal(summary.totals.credits, 0);
  const perProject = getWorkbuddyUsage({
    projectId: 'broken', registryPath, nowMs: Date.parse('2026-11-05T00:00:00+08:00'),
  });
  assert.equal(perProject.totals.requests, 0);
});

test('汇总口径:跨仓同请求号只算一次、null 积分只计次数、没走工单与估算分包、按模型按日拆分', (t) => {
  const root = fixture(t);
  const repoA = writeLedger(root, 'repo-a', {
    schemaVersion: 1,
    unit: 'WorkBuddy 积分',
    updatedAt: '2026-11-02T00:00:00.000Z',
    requests: {
      r1: request({ at: localTime(11, 1, 10, 0).toISOString(), credits: 0.1, repo: path.join(root, 'repo-a') }),
      r2: request({ at: localTime(11, 2, 10, 0).toISOString(), credits: 0.2, repo: path.join(root, 'repo-a') }),
      r3: request({ at: localTime(11, 2, 11, 0).toISOString(), model: 'glm-5', credits: 0.2,
        source: 'estimate', slug: null, repo: path.join(root, 'repo-a') }),
      r4: request({ at: localTime(11, 3, 12, 0).toISOString(), credits: null, slug: 'job-b',
        reason: '定不出价', repo: path.join(root, 'repo-a') }),
    },
    lastCheck: { through: '2026-11-02 13:55:00', statementCredits: 100.1, ledgerCredits: 100.05 },
  });
  const repoB = writeLedger(root, 'repo-b', {
    schemaVersion: 1,
    unit: 'WorkBuddy 积分',
    updatedAt: '2026-11-03T00:00:00.000Z',
    requests: {
      // 同一请求号在另一个仓重复记了一遍,只认先出现的那份。
      r1: request({ credits: 999, repo: path.join(root, 'repo-b') }),
      r5: request({ at: localTime(11, 4, 9, 0).toISOString(), model: 'glm-5', credits: 1.5,
        source: 'official', slug: 'job-c', repo: path.join(root, 'repo-b') }),
    },
    lastCheck: { through: '2026-11-03 10:00:00', statementCredits: 200, ledgerCredits: 199.99 },
  });
  const registryPath = writeRegistry(root, { a: { mainRepo: repoA }, b: { mainRepo: repoB } });
  const scan = scanWorkbuddyLedgers({ registryPath });

  assert.equal(scan.requests.length, 5, 'r1 跨仓重复只保留一行');
  assert.equal(scan.requests.filter((row) => row.id === 'r1').length, 1);
  assert.equal(scan.requests.find((row) => row.id === 'r1').credits, 0.1);
  assert.equal(scan.lastCheck.through, '2026-11-03 10:00:00', 'lastCheck 取 updatedAt 最新那份');
  assert.equal(scan.updatedAt, '2026-11-03T00:00:00.000Z');

  const all = summarizeWorkbuddyRequests(scan, { nowMs: localTime(11, 4, 12, 0).getTime(), days: 90 });
  assert.equal(all.totals.requests, 5);
  assert.equal(all.totals.credits, 2, '0.1 + 0.2 + 0.2 + null + 1.5,重复的 999 不算');
  assert.equal(all.totals.jobCredits, 1.8);
  assert.equal(all.totals.nonJobCredits, 0.2, 'slug 为 null 的行单独归为没走工单');
  assert.equal(all.totals.estimateCredits, 0.2, '估算来源的积分单独合计,同样计入总积分');
  assert.equal(all.totals.unpricedRequests, 1, '定不出价的请求计入次数,不计入积分');
  assert.equal(all.totals.jobs, 3, '不同 slug 计张数');
  assert.deepEqual(all.byModel['deepseek-v4.1-flash'], { requests: 3, credits: 0.3 });
  assert.deepEqual(all.byModel['glm-5'], { requests: 2, credits: 1.7 });
  assert.deepEqual(all.byDay.map((row) => row.date),
    ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'], '按日期升序');
  assert.deepEqual(all.byDay.map((row) => row.requests), [1, 2, 1, 1]);
  assert.deepEqual(all.byDay.map((row) => row.credits), [0.1, 0.4, 0, 1.5]);
  assert.equal(all.lastCheck.through, '2026-11-03 10:00:00');
  assert.equal(all.updatedAt, '2026-11-03T00:00:00.000Z');

  const project = getWorkbuddyUsage({
    projectId: 'a', registryPath, days: 90, nowMs: localTime(11, 4, 12, 0).getTime(),
  });
  assert.equal(project.totals.requests, 3, '只算仓库 a 且排除了没走工单的请求');
  assert.equal(project.totals.credits, 0.3);
  assert.equal(project.totals.nonJobCredits, 0, '没走工单的不归任何项目');
  assert.equal(project.totals.estimateCredits, 0);
  assert.equal(project.totals.jobs, 2);
  assert.deepEqual(project.byModel, { 'deepseek-v4.1-flash': { requests: 3, credits: 0.3 } });
});

test('时间窗口与本机时区按天同口径:起止端点含入,晚于 now 的不算', () => {
  const nowMs = localTime(11, 4, 12, 0).getTime();
  const data = { requests: [
    { at: localTime(11, 1, 23, 59, 59).toISOString(), model: 'm', credits: 1, source: 'transcript', slug: 'job-a', repo: null },
    { at: localTime(11, 2, 0, 0, 0).toISOString(), model: 'm', credits: 2, source: 'transcript', slug: 'job-a', repo: null },
    { at: localTime(11, 4, 12, 0, 0).toISOString(), model: 'm', credits: 4, source: 'transcript', slug: 'job-a', repo: null },
    { at: localTime(11, 4, 12, 0, 1).toISOString(), model: 'm', credits: 8, source: 'transcript', slug: 'job-a', repo: null },
  ] };
  const result = summarizeWorkbuddyRequests(data, { days: 3, nowMs });
  assert.equal(result.totals.requests, 2, '窗口起点与 now 端点都算,窗口外前后都不算');
  assert.equal(result.totals.credits, 6);
  assert.deepEqual(result.byDay.map((row) => row.date), ['2026-11-02', '2026-11-04']);
});

test('浮点尾巴四舍五入到两位小数:0.1 + 0.2 记 0.3 而不是 0.30000000000000004', () => {
  const data = { requests: [
    { at: '2026-11-02T09:00:00+08:00', model: 'm', credits: 0.1, source: 'transcript', slug: 'job-a', repo: null },
    { at: '2026-11-02T10:00:00+08:00', model: 'm', credits: 0.2, source: 'transcript', slug: 'job-a', repo: null },
    { at: '2026-11-02T11:00:00+08:00', model: 'm', credits: 1.005, source: 'transcript', slug: 'job-a', repo: null },
  ] };
  const result = summarizeWorkbuddyRequests(data, { days: 30, nowMs: Date.parse('2026-11-03T00:00:00+08:00') });
  assert.equal(result.totals.credits, 1.31);
  assert.equal(result.byModel.m.credits, 1.31);
  assert.equal(result.byDay[0].credits, 1.31);
});

test('单行不合格就跳过:时间解析不出、积分为负数或非数字、请求记录不是对象', (t) => {
  const root = fixture(t);
  const repo = writeLedger(root, 'repo-a', { schemaVersion: 1, requests: {
    badAt: { at: '不是时间', model: 'm', credits: 1, source: 'transcript', slug: 'job-a' },
    negative: { at: '2026-11-02T09:00:00+08:00', model: 'm', credits: -1, source: 'transcript', slug: 'job-a' },
    textCredits: { at: '2026-11-02T09:00:00+08:00', model: 'm', credits: '3.2', source: 'transcript', slug: 'job-a' },
    notObject: '坏行',
    zeroNoSlug: { at: '2026-11-02T09:00:00+08:00', model: 'm', credits: 0, source: 'transcript', slug: null },
  } });
  const registryPath = writeRegistry(root, { a: { mainRepo: repo } });
  const result = summarizeWorkbuddyRequests(scanWorkbuddyLedgers({ registryPath }),
    { days: 30, nowMs: Date.parse('2026-11-03T00:00:00+08:00') });
  assert.equal(result.totals.requests, 1, '只有最后一条合法');
  assert.equal(result.totals.credits, 0);
  assert.equal(result.totals.nonJobCredits, 0);
  assert.equal(result.totals.jobs, 0);
});
