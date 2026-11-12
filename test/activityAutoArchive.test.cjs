'use strict';
/**
 * activityAutoArchive 单测：用假时钟 + 假 spawnArchive，不依赖真实服务与 CLI。
 * 覆盖六类：beforeMonth 跨年/退位、首跑延迟、每 interval 一次、串行、去重告警、不叠加、stop 后不再触发。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createActivityAutoArchive } = require('../core/activityAutoArchive.cjs');

/** 可控时钟：advance(ms) 按时间顺序触发到期回调；setTimer 返回带 unref 的对象。 */
function fakeClock() {
  let now = 0;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => now,
    setTimer: (cb, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + (ms || 0), cb });
      return { unref() {}, id };
    },
    clearTimer: (t) => { if (t && t.id) timers.delete(t.id); },
    advance: (ms) => {
      const target = now + ms;
      let guard = 0;
      while (true) {
        let nextId = null;
        let nextAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = id; }
        }
        if (nextId === null) break;
        const t = timers.get(nextId);
        timers.delete(nextId);
        now = t.at;
        t.cb();
        if (++guard > 100000) throw new Error('fakeClock advance 死循环');
      }
      now = target;
    },
  };
}

function defer() {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}

/** 把挂起的微任务（async 链）跑完。 */
async function flush(n = 30) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

test('beforeMonth：11 月→10 月、1 月→上一年 12 月、3 月→2 月', () => {
  const a = createActivityAutoArchive({ listProjects: () => [], spawnArchive: async () => ({ moved: 0 }) });
  assert.equal(a.beforeMonth(new Date(2026, 10, 15)), '2026-10');
  assert.equal(a.beforeMonth(new Date(2026, 0, 5)), '2025-12');
  assert.equal(a.beforeMonth(new Date(2026, 2, 1, 0, 0, 0)), '2026-02');
});

test('start 后 initialDelayMs 才首跑', async () => {
  const clock = fakeClock();
  let calls = 0;
  const a = createActivityAutoArchive({
    listProjects: () => ['p'], spawnArchive: async () => { calls++; return { moved: 0 }; },
    now: () => clock.now(), setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    initialDelayMs: 1000, intervalMs: 5000,
  });
  a.start();
  assert.equal(calls, 0);
  clock.advance(999); await flush();
  assert.equal(calls, 0);
  clock.advance(1); await flush();
  assert.equal(calls, 1);
});

test('之后每 intervalMs 一次', async () => {
  const clock = fakeClock();
  let calls = 0;
  const a = createActivityAutoArchive({
    listProjects: () => ['p'], spawnArchive: async () => { calls++; return { moved: 0 }; },
    now: () => clock.now(), setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    initialDelayMs: 1000, intervalMs: 5000,
  });
  a.start();
  clock.advance(1000); await flush();
  assert.equal(calls, 1);
  clock.advance(4999); await flush();
  assert.equal(calls, 1);
  clock.advance(1); await flush();
  assert.equal(calls, 2);
  clock.advance(5000); await flush();
  assert.equal(calls, 3);
});

test('三个项目按顺序串行（第二个在第一个 resolve 之后才被调用）', async () => {
  const clock = fakeClock();
  const defs = { p1: defer(), p2: defer(), p3: defer() };
  const started = [];
  const order = [];
  const a = createActivityAutoArchive({
    listProjects: () => ['p1', 'p2', 'p3'],
    spawnArchive: async (id) => { started.push(id); await defs[id].p; order.push(id); return { moved: 0 }; },
    now: () => clock.now(), setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    initialDelayMs: 1000, intervalMs: 5000,
  });
  a.start();
  clock.advance(1000); await flush();
  assert.deepEqual(started, ['p1']); // 第二个还没开始
  defs.p1.resolve(); await flush();
  assert.deepEqual(started, ['p1', 'p2']); // p2 开始了，p3 还没有
  assert.deepEqual(order, ['p1']);
  defs.p2.resolve(); await flush();
  assert.deepEqual(started, ['p1', 'p2', 'p3']);
  assert.deepEqual(order, ['p1', 'p2']);
  defs.p3.resolve(); await flush();
  assert.deepEqual(order, ['p1', 'p2', 'p3']);
});

test('moved=0 不 log；moved>0 写一行含项目 id 与数量', async () => {
  const clock = fakeClock();
  const logs = [];
  const a = createActivityAutoArchive({
    listProjects: () => ['a', 'b'],
    spawnArchive: async (id) => ({ moved: id === 'a' ? 0 : 5 }),
    now: () => clock.now(), setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    initialDelayMs: 1000, intervalMs: 5000, log: (m) => logs.push(m),
  });
  a.start();
  clock.advance(1000); await flush();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /项目 b 归档 5 条/);
  assert.ok(!logs.some((l) => l.includes('项目 a')));
});

test('同一错误连续只 warn 一次，换文案再 warn', async () => {
  const clock = fakeClock();
  const warns = [];
  let msg = 'boom';
  const a = createActivityAutoArchive({
    listProjects: () => ['p'],
    spawnArchive: async () => { throw new Error(msg); },
    now: () => clock.now(), setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    initialDelayMs: 1000, intervalMs: 5000, warn: (m) => warns.push(m),
  });
  await a.runOnce();
  await a.runOnce();
  assert.equal(warns.length, 1); // 第二次同样 boom 不重复
  msg = 'bang';
  await a.runOnce();
  assert.equal(warns.length, 2); // 换文案再 warn
  assert.match(warns[0], /boom/);
  assert.match(warns[1], /bang/);
});

test('上一轮未完成时到点不叠加', async () => {
  const clock = fakeClock();
  let calls = 0;
  const first = defer();
  const a = createActivityAutoArchive({
    listProjects: () => ['p'],
    spawnArchive: async () => { calls++; await first.p; return { moved: 0 }; },
    now: () => clock.now(), setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    initialDelayMs: 1000, intervalMs: 5000,
  });
  a.start();
  clock.advance(1000); await flush();
  assert.equal(calls, 1); // 首跑
  clock.advance(5000); await flush();
  assert.equal(calls, 1); // 还在跑，不叠加
  first.resolve(); await flush();
  assert.equal(calls, 1); // 首跑刚结束，下一轮还没到点
  clock.advance(5000); await flush();
  assert.equal(calls, 2); // 下一轮正常跑
});

test('stop 后不再触发', async () => {
  const clock = fakeClock();
  let calls = 0;
  const a = createActivityAutoArchive({
    listProjects: () => ['p'], spawnArchive: async () => { calls++; return { moved: 0 }; },
    now: () => clock.now(), setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    initialDelayMs: 1000, intervalMs: 5000,
  });
  a.start();
  clock.advance(1000); await flush();
  assert.equal(calls, 1);
  a.stop();
  clock.advance(5000); await flush();
  clock.advance(5000); await flush();
  assert.equal(calls, 1); // stop 后不再跑
});
