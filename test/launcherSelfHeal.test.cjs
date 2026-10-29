'use strict';
/**
 * launcherSelfHeal.test.cjs —— 看护进程自愈重启（DASH-SERVER-SELF-HEAL-1029）。
 *
 * 钉死的行为：
 *   · server 自发崩溃（非 SIGINT/SIGTERM、非看护主动停树、非票据终态/消失、非共享盘持续不可读）
 *     → 持同一张常驻票按 1s→2s→4s→…封顶 60s 退避重启（同一 argv/env/cwd，serverPid 变、票号不变）。
 *   · 人类意图信号（SIGINT/SIGTERM）：不自愈重启，看护按停机收场。
 *   · 10 分钟内第 6 次连续崩溃 → 放弃自愈，把最近一次崩溃（at/code/signal/count）落盘到归属登记后收场。
 *   · 退避计时器必须 unref，收场时清掉，不吊住看护退出。
 *
 * 全部用假 spawn / 假 stopTree / 假客户端，不起真服务、不连真共享盘、不动生产登记。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const lr = require('../core/launcherRuntime.cjs');

const SHAM = 'a'.repeat(40);
const tmp = (p) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

function makeEnv() {
  const dir = tmp('selfheal-');
  const share = path.join(dir, 'share');
  fs.mkdirSync(share, { recursive: true });
  const recordFile = path.join(dir, 'launcher-instance.json');
  return { dir, share, recordFile };
}

/** 假 server 子进程：真实事件发射；crash() 模拟自发退出、signalExit() 模拟人类信号退出。 */
function makeFakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid;
  c._exited = false;
  c.crash = (code = 1) => { if (c._exited) return; c._exited = true; c.emit('exit', code, null); };
  c.signalExit = (sig) => { if (c._exited) return; c._exited = true; c.emit('exit', null, sig); };
  return c;
}

/**
 * 看护 deps 注入基座：假客户端（票面 granted）+ 假 spawn（每次返回新假子进程，按 exitPlan 编排第几次崩溃）
 * + 假 stopTree（总是确认停成）+ 真 confirmOwn/updateOwn（走 record.write.lock 临界区，与既有用例同口径）。
 * exitPlan：每次 spawn 后该子进程是否自爆（数字=退出码，null=稳住）。kill 默认不抛 = 包装进程活着。
 */
function makeWatchDeps(env, { ticketId, wrapperPid, exitPlan, over = {} }) {
  let nextPid = 5000;
  let idx = 0;
  let wrapperDead = false;
  const spawned = [];
  const spawnTimes = [];
  const d = {
    platform: process.platform,
    cwd: env.dir,
    env: { SCHED_PERMIT: `${ticketId}:a1:TOK`, SCHED_GRANTED_CORES: '1' },
    intervalMs: 20,
    shareFailBudgetMs: 1000,
    hostname: os.hostname(),
    ppid: wrapperPid,
    spawn: () => {
      const pid = nextPid++;
      const c = makeFakeChild(pid);
      spawned.push(c);
      spawnTimes.push(Date.now());
      const plan = exitPlan[idx++];
      if (plan !== null && plan !== undefined) setTimeout(() => c.crash(plan), 5); // 短暂存活后自爆，确保 wireChild 已接线
      return c;
    },
    stopTree: async () => ({ ok: true }),
    confirmOwn: lr.confirmOwnRecordLocked,
    updateOwn: lr.updateOwnRecordLocked,
    verifyGrant: async () => ({ ok: true }),
    client: {
      status: () => ({ state: 'granted' }),
      residentLeaseFile: (share, id) => path.join(share, 'sched', 'leases', `${id}.json`),
      cancel: async () => ({ exitCode: 0 }),
    },
    log: () => {},
    err: () => {},
    kill: (pid) => { if (wrapperDead) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; } },
    exit: () => {},
    ...over,
  };
  d._setWrapperDead = (v) => { wrapperDead = v; };
  d._spawned = spawned;
  d._spawnTimes = spawnTimes;
  return d;
}

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { if (fn()) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 20)); }
}

test('自愈：server 自发崩溃两次后稳住 → 退避重启 3 次、serverPid 变而票号不变、时延 1s/2s', { timeout: 30000 }, async () => {
  const e = makeEnv();
  const T = 'tk-' + 'a'.repeat(20);
  const W = 4242;
  lr.writeRecord(e.recordFile, { schema: 1, hostname: os.hostname(), mode: 'strict', key: 'k', ticketId: T, wrapperPid: W, serverPid: null });
  const d = makeWatchDeps(e, { ticketId: T, wrapperPid: W, exitPlan: [1, 1, null] });
  const p = lr.runWatchServer({ ticketId: T, share: e.share, wrapperPid: W, record: e.recordFile, server: 'server.cjs', key: 'k' }, d);
  assert.ok(await waitFor(() => d._spawned.length >= 3), '应当退避重启到第三次（前两次崩溃、第三次稳住）');
  await new Promise((r) => setTimeout(r, 300)); // 第三次稳住：不应再有新的 spawn
  assert.equal(d._spawned.length, 3, '第三次之后不应再重启');
  const pids = d._spawned.map((c) => c.pid);
  assert.notEqual(pids[0], pids[1], '重启复用同一 argv/env/cwd，但 server 子进程是新的（pid 变）');
  assert.notEqual(pids[1], pids[2], '第二次重启同样是新子进程');
  const rec = lr.readRecord(e.recordFile);
  assert.equal(rec.ticketId, T, '常驻票号全程不变（不撤不换）');
  assert.equal(rec.serverPid, pids[2], '登记里的 serverPid 指向当前活着的子进程');
  // 退避时延序列：第一次重启≈1s，第二次≈2s（容差 ±50%）
  const d1 = d._spawnTimes[1] - d._spawnTimes[0];
  const d2 = d._spawnTimes[2] - d._spawnTimes[1];
  assert.ok(d1 >= 500 && d1 <= 1500, `第一次退避应≈1s，实际 ${d1}ms`);
  assert.ok(d2 >= 1000 && d2 <= 3000, `第二次退避应≈2s，实际 ${d2}ms`);
  d._setWrapperDead(true); // 收场：让包装进程死，看护停服退出
  await p;
  assert.ok(lr.readRecord(e.recordFile).serverExitedAt, '收场补记 server 退出时刻');
  clean(e.dir);
});

test('人类信号：server 收到 SIGINT → 不重启，看护按停机收场', { timeout: 15000 }, async () => {
  const e = makeEnv();
  const T = 'tk-' + 'b'.repeat(20);
  const W = 4243;
  lr.writeRecord(e.recordFile, { schema: 1, hostname: os.hostname(), mode: 'strict', key: 'k', ticketId: T, wrapperPid: W, serverPid: null });
  const d = makeWatchDeps(e, { ticketId: T, wrapperPid: W, exitPlan: [null] }); // 第一次 spawn 后由测试显式发 SIGINT
  const p = lr.runWatchServer({ ticketId: T, share: e.share, wrapperPid: W, record: e.recordFile, server: 'server.cjs', key: 'k' }, d);
  assert.ok(await waitFor(() => d._spawned.length >= 1), '看护应拉起一次 server');
  d._spawned[0].signalExit('SIGINT');
  await p;
  assert.equal(d._spawned.length, 1, 'SIGINT（人类意图信号）不应触发自愈重启');
  assert.ok(lr.readRecord(e.recordFile).serverExitedAt, 'SIGINT 停机照常补记退出时刻');
  clean(e.dir);
});

test('放弃自愈：10 分钟内连续 6 次崩溃 → 收场并落盘 lastCrash（at/code/signal/count）', { timeout: 15000 }, async () => {
  const e = makeEnv();
  const T = 'tk-' + 'c'.repeat(20);
  const W = 4244;
  lr.writeRecord(e.recordFile, { schema: 1, hostname: os.hostname(), mode: 'strict', key: 'k', ticketId: T, wrapperPid: W, serverPid: null });
  // 退避基数缩到 1ms 跑完；每次 spawn 都自爆 code=1，第 6 次崩溃放弃（不拉第 7 次）。
  const d = makeWatchDeps(e, { ticketId: T, wrapperPid: W, exitPlan: [1, 1, 1, 1, 1, 1], over: { backoffBaseMs: 1, backoffMaxMs: 60000 } });
  const p = lr.runWatchServer({ ticketId: T, share: e.share, wrapperPid: W, record: e.recordFile, server: 'server.cjs', key: 'k' }, d);
  await p;
  assert.equal(d._spawned.length, 6, '前 5 次崩溃各自退避重启一次、第 6 次崩溃放弃，共拉起 6 次');
  const rec = lr.readRecord(e.recordFile);
  assert.ok(rec.lastCrash, '第 6 次崩溃应把最近一次崩溃落盘到归属登记');
  assert.equal(rec.lastCrash.count, 6, 'lastCrash.count = 连续崩溃次数');
  assert.equal(rec.lastCrash.code, 1, 'lastCrash.code = 最近一次退出码');
  assert.equal(rec.lastCrash.signal, null, 'lastCrash.signal = 最近一次信号（无则 null）');
  assert.ok(typeof rec.lastCrash.at === 'string' && !Number.isNaN(Date.parse(rec.lastCrash.at)), 'lastCrash.at 是 ISO 时间');
  clean(e.dir);
});
