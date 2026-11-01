'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBoardPoller } = require('../core/boardPoller.cjs');

function fixture(stat) {
  let time = 0;
  const timers = [], first = [], changed = [], logs = [];
  let refreshes = 0;
  const poller = createBoardPoller({
    index: { refresh: async () => { refreshes++; }, ids: () => ['a', 'b', 'invalid'], get: id => id === 'invalid' ? null : { board: '/' + id } },
    stat, intervalMs: 1500, now: () => time,
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() { this.unrefed = true; } }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
    onFirstSeen: (...args) => first.push(args), onChanged: (...args) => changed.push(args), log: line => logs.push(line),
  });
  return { poller, timers, first, changed, logs, advance: ms => { time += ms; }, refreshes: () => refreshes };
}

test('first tick hanging skips the second tick without another stat (skipped=1)', async () => {
  const pending = [];
  const f = fixture(file => new Promise(resolve => pending.push({ file, resolve })));
  const firstTick = f.poller.tick();
  await Promise.resolve();
  assert.equal(pending.length, 2, 'all board stats start concurrently');
  await f.poller.tick();
  assert.equal(f.poller.stats().skipped, 1);
  assert.equal(f.refreshes(), 1);
  assert.equal(pending.length, 2);
  for (const item of pending) item.resolve({ mtimeMs: 1 });
  await firstTick;
  assert.deepEqual(f.first, [['a', 1], ['b', 1]]);
  assert.deepEqual(f.changed, []);
});

test('slow ticks double the interval, cap at 30000, then recover to 1500', async () => {
  let slow = true;
  const f = fixture(async () => { if (slow) f.advance(31000); return { mtimeMs: 1 }; });
  f.poller.start();
  for (const expected of [3000, 6000, 12000, 24000, 30000, 30000]) {
    const timer = f.timers.at(-1);
    assert.equal(timer.unrefed, true);
    await timer.fn();
    assert.equal(f.poller.stats().intervalMs, expected);
    assert.equal(f.timers.at(-1).ms, expected);
  }
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /板轮询退避到 3000 毫秒/);
  slow = false;
  await f.timers.at(-1).fn();
  assert.equal(f.poller.stats().intervalMs, 1500);
  assert.equal(f.timers.at(-1).ms, 1500);
  assert.equal(f.logs.length, 2);
  f.poller.stop();
  assert.equal(f.timers.at(-1).cleared, true);
});

test('first sight establishes baseline; changes and missing files retain event semantics', async () => {
  let mtime = 1;
  const f = fixture(async () => { if (mtime === null) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return { mtimeMs: mtime }; });
  await f.poller.tick();
  await f.poller.tick();
  assert.equal(f.first.length, 2);
  assert.equal(f.changed.length, 0);
  mtime = 2;
  await f.poller.tick();
  mtime = null;
  await f.poller.tick();
  await f.poller.tick();
  assert.deepEqual(f.changed, [['a', 2], ['b', 2], ['a', null], ['b', null]]);
});

test('stop during an in-flight tick does not schedule another timer', async () => {
  const pending = [];
  const f = fixture(() => new Promise(resolve => pending.push(resolve)));
  f.poller.start();
  const tick = f.timers[0].fn();
  await Promise.resolve();
  f.poller.stop();
  pending.forEach(resolve => resolve({ mtimeMs: 1 }));
  await tick;
  assert.equal(f.timers.length, 1);
});
