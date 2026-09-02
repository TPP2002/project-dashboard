'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  attachLiveness, classifyJobLiveness, indexSessionsById, pidAlive,
} = require('../server/codexJobHealth.cjs');
const { buildCodexReport } = require('../server/codexMetrics.cjs');

const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const minutesAgo = (n) => new Date(NOW - n * 60 * 1000).toISOString();
const alive = () => true;
const dead = () => false;

function runningJob(overrides = {}) {
  return {
    running: true,
    pid: 4321,
    startedAt: minutesAgo(5),
    timeoutSec: 900,
    ...overrides,
  };
}

test('收尾记录已落盘 = 已完成，不再探进程', () => {
  const health = classifyJobLiveness({ running: false, pid: 4321 }, { nowMs: NOW, isAlive: dead });
  assert.strictEqual(health.liveness, 'finished');
  assert.strictEqual(health.stalledReason, null);
});

test('进程号已经不在 = 失联（最硬的一条铁证，优先报它）', () => {
  const health = classifyJobLiveness(runningJob(), { nowMs: NOW, isAlive: dead });
  assert.strictEqual(health.liveness, 'stalled');
  assert.match(health.stalledReason, /进程已经不在/);
});

test('早该收工却没落盘收尾 = 失联（监工超时会自己写收尾，没写说明监工也死了）', () => {
  const health = classifyJobLiveness(
    runningJob({ startedAt: minutesAgo(60), timeoutSec: 900 }), // 允许 15 分钟，已经跑了 60 分钟
    { nowMs: NOW, isAlive: alive },
  );
  assert.strictEqual(health.liveness, 'stalled');
  assert.match(health.stalledReason, /超过.*时长|没有留下收尾/);
});

test('很久没有新动静 = 失联（软判据），且进程号还在也救不回来', () => {
  const health = classifyJobLiveness(
    runningJob({ startedAt: minutesAgo(30), timeoutSec: 7200 }),
    { nowMs: NOW, isAlive: alive, lastActivityAt: minutesAgo(45) },
  );
  assert.strictEqual(health.liveness, 'stalled');
  assert.match(health.stalledReason, /45 分钟没有任何新动静/);
});

test('近期有新事件 = 还在跑（有进展就是活着的证据，不必再纠结进程号）', () => {
  const health = classifyJobLiveness(
    runningJob({ startedAt: minutesAgo(30), timeoutSec: 7200 }),
    { nowMs: NOW, isAlive: alive, lastActivityAt: minutesAgo(1) },
  );
  assert.strictEqual(health.liveness, 'running');
  assert.strictEqual(health.stalledReason, null);
  assert.strictEqual(health.silentForMs, 60 * 1000);
});

test('进程号会被系统复用，所以「号还在」本身不构成还活着的结论', () => {
  // 号还在、没超时、也没有会话记录 —— 证据不足以判失联，如实当作还在跑
  const unknown = classifyJobLiveness(
    runningJob({ startedAt: minutesAgo(1), timeoutSec: 7200 }),
    { nowMs: NOW, isAlive: alive },
  );
  assert.strictEqual(unknown.liveness, 'running');

  // 但只要另外两条判据任意一条成立，「号还在」都推翻不了失联结论
  const overdue = classifyJobLiveness(
    runningJob({ startedAt: minutesAgo(600), timeoutSec: 900 }),
    { nowMs: NOW, isAlive: alive },
  );
  assert.strictEqual(overdue.liveness, 'stalled');
});

test('pidAlive：ESRCH 判不在，EPERM 判还在（有进程但没权限发信号）', () => {
  assert.strictEqual(pidAlive(0), false);
  assert.strictEqual(pidAlive(-3), false);
  assert.strictEqual(pidAlive(null), false);
  const esrch = () => { const error = new Error('no such process'); error.code = 'ESRCH'; throw error; };
  const eperm = () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; };
  assert.strictEqual(pidAlive(123, esrch), false);
  assert.strictEqual(pidAlive(123, eperm), true);
});

test('会话按 sessionId 认领，工单据此拿到自己的最后事件时间', () => {
  const index = indexSessionsById([{ sessionId: 'S-1', lastActivityAt: minutesAgo(2) }]);
  assert.strictEqual(index.size, 1);

  const [job] = attachLiveness(
    [{ slug: 'j1', running: true, pid: 9, startedAt: minutesAgo(10), timeoutSec: 7200, threadId: 'S-1' }],
    { nowMs: NOW, isAlive: alive, sessions: [{ sessionId: 'S-1', lastActivityAt: minutesAgo(2) }] },
  );
  assert.strictEqual(job.liveness, 'running');
  assert.strictEqual(job.lastActivityAt, minutesAgo(2));
  assert.strictEqual(job.slug, 'j1', '原有字段必须原样保留');
});

test('战报：失联单不按时间窗筛掉，且不再被算进「还在跑」', () => {
  const jobs = [
    // 三天前派出、状态仍说 running、进程早没了 —— 正是最该被看见的那种
    { slug: 'corpse', title: '三天前那单', dispatchedAt: new Date(NOW - 3 * 86400000).toISOString(),
      running: true, collected: false, passed: null, pid: 111, startedAt: new Date(NOW - 3 * 86400000).toISOString(), timeoutSec: 900 },
    // 窗口内、真在跑
    { slug: 'live', title: '正在跑的那单', dispatchedAt: minutesAgo(10),
      running: true, collected: false, passed: null, pid: 222, startedAt: minutesAgo(10), timeoutSec: 7200 },
  ];
  const report = buildCodexReport({
    jobs, sessions: [], nowMs: NOW, windowMs: 24 * 60 * 60 * 1000,
    isAlive: (pid) => pid === 222,
  });

  assert.strictEqual(report.running, 1, '只数真在跑的那一单');
  assert.strictEqual(report.stalled, 1);
  assert.deepStrictEqual(report.stalledJobs.map((job) => job.slug), ['corpse']);
  assert.match(report.stalledJobs[0].reason, /进程已经不在/);
  assert.strictEqual(report.dispatched, 1, '派出数仍按 24 小时窗口口径,不受影响');
});
