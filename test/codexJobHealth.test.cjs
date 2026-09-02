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

// ── 证据强度:哪些失联单允许一键复派(CODEX-STALLED-JOB-REDISPATCH,2026-09-02 拍板"只对两条铁证放开")──
//
// 复派会真的再派出一单 Codex,烧的是七天窗口里的额度。所以放开复派的前提不是"看起来像死了",
// 而是"确定死了"。三条判据里只有前两条够格:
//   ① 进程号已经不在  —— 铁证(号被回收复用只会让它显示成"在",绝不会显示成"不在")
//   ② 超时还没收尾    —— 铁证(监工超时会自己写收尾,没写说明监工本人没活到那一刻)
//   ③ 很久没新动静    —— 软判据,**不够格**:一个真在跑长活的单也会很久没动静,
//                        照它放开复派 = 有概率对活着的单重复派出一单,直接烧额度。

test('铁证①进程号没了:标记为确定已死,允许复派', () => {
  const health = classifyJobLiveness(runningJob(), { nowMs: NOW, isAlive: dead });
  assert.strictEqual(health.stalledEvidence, 'process-gone');
  assert.strictEqual(health.confirmedDead, true);
});

test('铁证②超时没收尾:标记为确定已死,允许复派', () => {
  const health = classifyJobLiveness(
    runningJob({ startedAt: minutesAgo(60), timeoutSec: 900 }),
    { nowMs: NOW, isAlive: alive },
  );
  assert.strictEqual(health.stalledEvidence, 'overdue');
  assert.strictEqual(health.confirmedDead, true);
});

test('软判据③久无动静:仍判失联(该显示),但不算确定已死(不许复派)', () => {
  const health = classifyJobLiveness(runningJob(), {
    nowMs: NOW, isAlive: alive, lastActivityAt: minutesAgo(90),
  });
  assert.strictEqual(health.liveness, 'stalled', '久无动静照旧要标红给人看');
  assert.strictEqual(health.stalledEvidence, 'silent');
  assert.strictEqual(health.confirmedDead, false, '软判据不得放开复派闸——会误判活着的慢单');
});

test('还在正常跑的单:既不失联也不算已死', () => {
  const health = classifyJobLiveness(runningJob(), {
    nowMs: NOW, isAlive: alive, lastActivityAt: minutesAgo(1),
  });
  assert.strictEqual(health.liveness, 'running');
  assert.strictEqual(health.stalledEvidence, null);
  assert.strictEqual(health.confirmedDead, false);
});

test('已收尾的单:不是"确定已死"那种死(它是正常完成的,走收单不走复派)', () => {
  const health = classifyJobLiveness({ running: false, pid: 4321 }, { nowMs: NOW, isAlive: dead });
  assert.strictEqual(health.confirmedDead, false);
  assert.strictEqual(health.stalledEvidence, null);
});

test('attachLiveness 把证据强度一并带给接口调用方', () => {
  const [job] = attachLiveness([{ slug: 'a', running: true, pid: 7, startedAt: minutesAgo(5), timeoutSec: 900 }],
    { nowMs: NOW, isAlive: dead });
  assert.strictEqual(job.confirmedDead, true);
  assert.strictEqual(job.stalledEvidence, 'process-gone');
});
