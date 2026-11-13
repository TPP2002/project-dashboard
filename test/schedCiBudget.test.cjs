'use strict';
/**
 * 检查作业面板的额度闸：标题与在跑轮次的作业明细跨拍复用、按剩余额度分档放慢、撞到限额暂停。
 * 全部注入 gh、时钟与额度读数，不起真 gh、不联网。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../core/schedCiJobs.cjs');

const AT = Date.parse('2026-09-14T10:00:00Z');
const iso = offset => new Date(AT + offset).toISOString();
const base = 'repos/owner/repo';
const runningPath = `${base}/actions/runs?status=in_progress&per_page=20`;
const queuedPath = `${base}/actions/runs?status=queued&per_page=20`;
const historyPath = `${base}/actions/runs?status=completed&per_page=100`;
const jobsPath = id => `${base}/actions/runs/${id}/jobs?per_page=100&page=1`;
const pullsPath = number => `${base}/pulls/${number}`;
const RUNS = 24;
const STAMP = '2026-09-14T09:59:00Z';

const run = (number, extra = {}) => ({ id: number, name: 'CI', head_branch: `feat/${number}`, status: 'in_progress',
  event: 'pull_request', updated_at: STAMP, pull_requests: [{ number }], ...extra });
const job = (id, extra = {}) => ({ id, name: 'fast', runner_name: 'runner-1', status: 'in_progress',
  started_at: iso(-720_000), completed_at: null, conclusion: null, ...extra });

/** 24 个在跑轮次各带一个 PR，pull_requests 里都没有标题，标题只能靠 pulls/<n>。 */
function fixture({ rate = async () => ({ remaining: 4000, limit: 5000, resetAt: null }) } = {}) {
  let now = AT;
  const calls = new Map();
  const stamps = new Map();
  const monitor = c.createCiJobsMonitor({ now: () => now, repositoryOverrides: 'owner/repo', readRateLimit: rate,
    readRunnerMachines: async () => new Map([['runner-1', 'machine-a']]),
    gh: async endpoint => {
      calls.set(endpoint, (calls.get(endpoint) ?? 0) + 1);
      if (endpoint === runningPath) {
        return { workflow_runs: Array.from({ length: RUNS }, (_, index) => run(index + 1, { updated_at: stamps.get(index + 1) ?? STAMP })) };
      }
      if (endpoint === queuedPath) return { workflow_runs: [] };
      if (endpoint === historyPath) return { workflow_runs: [] };
      const jobHit = /\/runs\/(\d+)\/jobs\?per_page=100&page=1$/.exec(endpoint);
      if (jobHit) return { total_count: 1, jobs: [job(Number(jobHit[1]) * 10)] };
      const pullHit = /^repos\/owner\/repo\/pulls\/(\d+)$/.exec(endpoint);
      if (pullHit) return { title: `第 ${pullHit[1]} 号改动` };
      throw new Error(`未登记的请求：${endpoint}`);
    } });
  const count = pattern => [...calls].filter(([endpoint]) => pattern(endpoint)).reduce((sum, [, value]) => sum + value, 0);
  return { monitor, calls, count, time: value => { now = value; }, stamp: (number, value) => stamps.set(number, value),
    total: () => [...calls.values()].reduce((sum, value) => sum + value, 0) };
}

const rateOf = (remaining, limit = 5000, resetAt = null) => async () => ({ remaining, limit, resetAt });

test('B1 标题跨拍缓存：24 个 PR 连刷 10 拍，每个 PR 的标题只取一次', async () => {
  const h = fixture({ rate: rateOf(4000) });
  for (let tick = 0; tick < 10; tick++) {
    await h.monitor.refresh();
    h.time(AT + (tick + 1) * 30_000);
  }
  for (let number = 1; number <= RUNS; number++) {
    assert.equal(h.calls.get(pullsPath(number)) ?? 0, 1, `PR ${number} 只应取一次标题`);
  }
  assert.equal(h.count(endpoint => endpoint.startsWith(`${base}/pulls/`)), RUNS);
});

test('B2 轮次没变不重取子任务：第 2~10 拍每拍只发两次列表', async () => {
  const h = fixture({ rate: rateOf(4000) });
  await h.monitor.refresh();
  assert.ok(h.total() > 2);
  for (let tick = 2; tick <= 10; tick++) {
    h.time(AT + (tick - 1) * 30_000);
    const before = h.total();
    await h.monitor.refresh();
    assert.equal(h.total() - before, 2, `第 ${tick} 拍只应列两次轮次`);
    assert.equal(h.calls.get(runningPath), tick);
    assert.equal(h.calls.get(queuedPath), tick);
  }
});

test('B2 某一轮的 updated_at 变了，下一拍只补那一轮的作业', async () => {
  const h = fixture({ rate: rateOf(4000) });
  await h.monitor.refresh();
  h.time(AT + 30_000);
  h.stamp(3, '2026-09-14T10:00:20Z');
  const before = h.total();
  await h.monitor.refresh();
  assert.equal(h.total() - before, 3);
  assert.equal(h.calls.get(jobsPath(3)), 2);
  assert.equal(h.calls.get(jobsPath(4)), 1);
});

test('B2 轮次明细最多复用五分钟，过了就整轮重取但标题仍走缓存', async () => {
  const h = fixture({ rate: rateOf(4000) });
  await h.monitor.refresh();
  h.time(AT + c.LIVE_JOBS_MAX_AGE_MS);
  const beforeJobs = h.count(endpoint => endpoint.includes('/jobs?'));
  const beforePulls = h.count(endpoint => endpoint.startsWith(`${base}/pulls/`));
  await h.monitor.refresh();
  assert.equal(h.count(endpoint => endpoint.includes('/jobs?')) - beforeJobs, RUNS);
  assert.equal(h.count(endpoint => endpoint.startsWith(`${base}/pulls/`)), beforePulls);
});

test('B3 分档表：额度比例、读不到额度与恢复时刻各自成档', () => {
  const nowMs = AT, resetAt = iso(600_000);
  const plan = overrides => c.ciPollPlan({ remaining: 4000, limit: 5000, resetAt, nowMs, pausedUntil: null, ...overrides });
  assert.deepEqual(plan({}), { level: 'normal', intervalMs: c.POLL_MS, nextAt: null });
  assert.deepEqual(plan({ remaining: 2000 }), { level: 'normal', intervalMs: c.POLL_MS, nextAt: null });
  assert.deepEqual(plan({ remaining: 1999 }), { level: 'slow', intervalMs: 120_000, nextAt: null });
  assert.deepEqual(plan({ remaining: 1000 }), { level: 'slow', intervalMs: 120_000, nextAt: null });
  assert.deepEqual(plan({ remaining: 999 }), { level: 'slow', intervalMs: 300_000, nextAt: null });
  assert.deepEqual(plan({ remaining: 500 }), { level: 'slow', intervalMs: 300_000, nextAt: null });
  assert.deepEqual(plan({ remaining: 499 }), { level: 'paused', intervalMs: 605_000, nextAt: AT + 605_000 });
  assert.deepEqual(plan({ remaining: null }), { level: 'normal', intervalMs: c.POLL_MS, nextAt: null });
  assert.deepEqual(plan({ remaining: undefined }), { level: 'normal', intervalMs: c.POLL_MS, nextAt: null });
  assert.deepEqual(plan({ limit: 0 }), { level: 'normal', intervalMs: c.POLL_MS, nextAt: null });
  assert.deepEqual(plan({ limit: null }), { level: 'normal', intervalMs: c.POLL_MS, nextAt: null });
  assert.deepEqual(plan({ pausedUntil: AT + 60_000 }), { level: 'paused', intervalMs: 60_000, nextAt: AT + 60_000 });
  assert.deepEqual(plan({ pausedUntil: AT + 60_000, remaining: 4000 }),
    { level: 'paused', intervalMs: 60_000, nextAt: AT + 60_000 });
  assert.deepEqual(plan({ pausedUntil: AT }), { level: 'normal', intervalMs: c.POLL_MS, nextAt: null });
  assert.deepEqual(plan({ remaining: 0, resetAt: 'not a time' }), { level: 'paused', intervalMs: 900_000, nextAt: AT + 900_000 });
});

test('B4 慢档门控：隔六十秒不重采，隔一百二十一秒重采', async () => {
  const h = fixture({ rate: rateOf(1500) });
  await h.monitor.refresh();
  assert.equal(h.calls.get(runningPath), 1);
  h.time(AT + 60_000);
  const skip = h.monitor.refresh();
  assert.equal(typeof skip.catch, 'function');
  await skip;
  assert.equal(h.calls.get(runningPath), 1);
  assert.equal(h.monitor.snapshot().throttle.intervalMs, 120_000);
  h.time(AT + 121_000);
  await h.monitor.refresh();
  assert.equal(h.calls.get(runningPath), 2);
});

test('B5 额度见底暂停，到恢复时刻才继续采集', async () => {
  let recovered = false;
  const rate = async () => recovered ? { remaining: 5000, limit: 5000, resetAt: null }
    : { remaining: 300, limit: 5000, resetAt: iso(20 * 60_000) };
  const h = fixture({ rate });
  // 服务端会对返回值挂 catch：暂停拍也必须回 Promise。
  const first = h.monitor.refresh();
  assert.equal(typeof first.catch, 'function');
  await first;
  assert.equal(h.total(), 0);
  h.time(AT + 60_000);
  await h.monitor.refresh();
  assert.equal(h.total(), 0);
  recovered = true;
  h.time(AT + 20 * 60_000);
  await h.monitor.refresh();
  assert.equal(h.total(), 0);
  h.time(AT + 20 * 60_000 + 5_000);
  await h.monitor.refresh();
  assert.equal(h.calls.get(runningPath), 1);
  assert.equal(h.monitor.snapshot().throttle, undefined);
});

test('B6 撞到限额立刻暂停，直到读数里的恢复时刻加五秒', async () => {
  let now = AT, limited = false;
  const calls = new Map();
  const hit = endpoint => calls.set(endpoint, (calls.get(endpoint) ?? 0) + 1);
  const monitor = c.createCiJobsMonitor({ now: () => now, repositoryOverrides: 'owner/repo',
    readRateLimit: async () => ({ remaining: 4000, limit: 5000, resetAt: iso(300_000) }),
    gh: async endpoint => {
      hit(endpoint);
      if (endpoint === runningPath) {
        if (limited) {
          throw Object.assign(new Error('HTTP 403: API rate limit exceeded'), { stderr: 'gh: API rate limit exceeded (HTTP 403)' });
        }
        return { workflow_runs: [run(1)] };
      }
      if (endpoint === queuedPath) return { workflow_runs: [] };
      if (endpoint === historyPath) return { workflow_runs: [] };
      if (endpoint === jobsPath(1)) return { total_count: 1, jobs: [job(10)] };
      if (endpoint === pullsPath(1)) return { title: '一号改动' };
      throw new Error(`未登记的请求：${endpoint}`);
    } });
  await monitor.refresh();
  assert.equal(calls.get(runningPath), 1);
  limited = true;
  now = AT + 30_000;
  await monitor.refresh();
  assert.equal(calls.get(runningPath), 2);
  for (const offset of [60_000, 120_000, 304_000]) {
    now = AT + offset;
    const before = [...calls.values()].reduce((sum, value) => sum + value, 0);
    await monitor.refresh();
    assert.equal([...calls.values()].reduce((sum, value) => sum + value, 0), before, `第 ${offset} 毫秒不得发请求`);
    assert.equal(monitor.snapshot().throttle.level, 'paused');
  }
  now = AT + 305_000;
  await monitor.refresh();
  assert.equal(calls.get(runningPath), 3);
});

test('B7 快照：normal 不加键，slow 与 paused 带齐放慢说明', async () => {
  const normal = fixture({ rate: rateOf(4000) });
  assert.deepEqual(Object.keys(normal.monitor.snapshot()).sort(), ['machines', 'queued', 'staleSince', 'updatedAt']);
  await normal.monitor.refresh();
  const normalData = normal.monitor.snapshot();
  assert.deepEqual(Object.keys(normalData).sort(), ['machines', 'queued', 'staleSince', 'updatedAt']);
  assert.equal(normalData.throttle, undefined);

  const slow = fixture({ rate: rateOf(1500, 5000, iso(20 * 60_000)) });
  await slow.monitor.refresh();
  assert.deepEqual(slow.monitor.snapshot().throttle, { level: 'slow', intervalMs: 120_000, nextAt: null,
    remaining: 1500, limit: 5000, resetAt: iso(20 * 60_000) });

  const paused = fixture({ rate: rateOf(300, 5000, iso(20 * 60_000)) });
  await paused.monitor.refresh();
  assert.deepEqual(paused.monitor.snapshot().throttle, { level: 'paused', intervalMs: 20 * 60_000 + 5_000,
    nextAt: iso(20 * 60_000 + 5_000), remaining: 300, limit: 5000, resetAt: iso(20 * 60_000) });
});

test('B8 读不到额度照常三十秒一拍，也不带放慢说明', async () => {
  const readers = [async () => null, async () => { throw new Error('fixture quota unreadable'); }];
  for (const rate of readers) {
    const h = fixture({ rate });
    await h.monitor.refresh();
    assert.equal(h.calls.get(runningPath), 1);
    h.time(AT + 30_000);
    await h.monitor.refresh();
    assert.equal(h.calls.get(runningPath), 2);
    assert.equal(h.monitor.snapshot().throttle, undefined);
  }
});
