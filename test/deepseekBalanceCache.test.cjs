'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCachedDeepseekBalance } = require('../core/deepseekBalance.cjs');

test('fresh, stale refresh, failed refresh and expired failure', async () => {
  let time = 0, calls = 0, value = { available: true, balance: 10 };
  const get = createCachedDeepseekBalance({ now: () => time, freshMs: 10, staleMs: 100, failureMs: 5,
    fetchBalance: async () => { calls++; return value; } });
  assert.deepEqual(await get(), value);
  time = 10;
  assert.deepEqual(await get(), value);
  assert.equal(calls, 1);
  time = 11;
  value = { available: false, reason: 'failed' };
  assert.equal((await get()).balance, 10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  time = 101;
  assert.equal((await get()).available, false);
  assert.equal(calls, 3);
  time = 105;
  await get();
  assert.equal(calls, 3);
  time = 107;
  value = { available: true, balance: 20 };
  assert.equal((await get()).balance, 20);
  assert.equal(calls, 4);
});

test('concurrent calls share an in-flight request', async () => {
  let calls = 0, finish;
  const get = createCachedDeepseekBalance({ fetchBalance: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } });
  const first = get(), second = get();
  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ available: true, balance: 1 });
  assert.deepEqual(await first, await second);
});
