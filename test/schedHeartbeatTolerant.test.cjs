'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../core/schedContract.cjs');
const read = require('../core/schedRead.cjs');
const { heartbeat, temporary, initialize, write, AT } = require('./fixtures/sched/support.cjs');

test('机器未知字段保留原对象，名单使用机器通用路径', () => {
  const value = heartbeat();
  value.machines[0].futureField = 1;
  assert.doesNotThrow(() => c.validateHeartbeat(value));
  assert.strictEqual(c.validateHeartbeat(value), value);
  assert.equal(value.machines[0].futureField, 1);
  assert.deepEqual(c.heartbeatUnknownFields(value), ['machines[].futureField']);
});

test('顶层未知字段不拒读，跨机器名单去重并排序，不深入未知对象', () => {
  const value = heartbeat();
  value.newTop = { arbitrary: true };
  value.anotherTop = null;
  value.machines[0].futureField = 1;
  value.machines[1].futureField = 2;
  value.machines[1].anotherField = { nested: 3 };
  assert.doesNotThrow(() => c.validateHeartbeat(value));
  assert.deepEqual(c.heartbeatUnknownFields(value), [
    'anotherTop', 'machines[].anotherField', 'machines[].futureField', 'newTop',
  ]);
});

test('所有已知展示字段都不算未知，旧心跳返回空名单', () => {
  const value = heartbeat();
  assert.deepEqual(c.heartbeatUnknownFields(value), []);
  Object.assign(value.machines[0], {
    ciRunners: ['fixture-runner'], ciReserveCores: 2, actualUsageCreditCores: 1.5,
    agentSlots: { capacity: 2, occupied: 1 }, tools: { bash: true },
  });
  assert.deepEqual(c.heartbeatUnknownFields(value), []);
});

test('未知字段不能掩盖已知字段错误或缺必填', () => {
  for (const corrupt of [
    value => { value.machines[0].availableCores = -1; },
    value => { value.machines[0].availableCores = '1'; },
    value => { delete value.machines[0].online; },
    value => { value.tick = '7'; },
    value => { delete value.machines; },
  ]) {
    const value = heartbeat();
    value.newTop = true;
    value.machines[0].futureField = 1;
    corrupt(value);
    assert.throws(() => c.validateHeartbeat(value));
  }
});

test('reservation、agentSlots、tools、queue 和 locks 仍严格拒收', () => {
  for (const corrupt of [
    value => { value.machines[0].reservation.extra = 1; },
    value => { value.machines[0].agentSlots = { capacity: 4, occupied: 1, free: 3 }; },
    value => { value.machines[0].tools = { bash: 'yes' }; },
    value => { value.machines[0].tools = { bash: true, extra: 1 }; },
    value => { value.queue = [{ ticketId: 'tk-' + '1'.repeat(20), position: 1, band: 1,
      requestedCores: 1, allowedMachines: ['fixture-host'], queuedAt: AT,
      state: 'queued', reason: null, extra: 1 }]; },
    value => { value.locks = [{ machine: 'fixture-host', byTicketId: 'tk-' + '1'.repeat(20), extra: 1 }]; },
  ]) {
    const value = heartbeat();
    value.machines[0].futureField = 1;
    corrupt(value);
    assert.throws(() => c.validateHeartbeat(value));
  }
});

test('成功快照只在有未知字段时携带名单，每种名单在进程内只提醒一次', t => {
  const share = temporary(t), paths = initialize(share), nowMs = Date.parse(AT);
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const plain = read.snapshot(share, nowMs);
  assert.equal(plain.ok, true, plain.reason);
  assert.equal(Object.hasOwn(plain, 'unknownHeartbeatFields'), false);
  assert.deepEqual(warnings, []);

  const value = heartbeat();
  value.newTop = true;
  value.machines[0].futureField = 1;
  value.machines[1].futureField = 2;
  const names = ['machines[].futureField', 'newTop'];
  write(paths.heartbeat, value);
  for (let index = 0; index < 2; index++) {
    const result = read.snapshot(share, nowMs);
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.unknownHeartbeatFields, names);
    assert.deepEqual(result.dispatcher.heartbeat, value);
    assert.deepEqual(result.machines, value.machines);
  }
  assert.deepEqual(warnings, [[`[sched] 派单员心跳有看板不认识的字段:${names.join(',')},页面照常显示,看板该跟进`]]);

  value.machines[0].futureField = 99;
  write(paths.heartbeat, value);
  assert.equal(read.snapshot(share, nowMs).ok, true);
  assert.equal(warnings.length, 1);

  value.anotherTop = 1;
  write(paths.heartbeat, value);
  const changed = read.snapshot(share, nowMs);
  assert.equal(changed.ok, true, changed.reason);
  assert.deepEqual(changed.unknownHeartbeatFields, ['anotherTop', ...names]);
  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings[1], [`[sched] 派单员心跳有看板不认识的字段:anotherTop,${names.join(',')},页面照常显示,看板该跟进`]);

  delete value.anotherTop;
  write(paths.heartbeat, value);
  assert.equal(read.snapshot(share, nowMs).ok, true);
  assert.equal(warnings.length, 2);
  write(paths.heartbeat, heartbeat());
  const clean = read.snapshot(share, nowMs);
  assert.equal(clean.ok, true, clean.reason);
  assert.equal(Object.hasOwn(clean, 'unknownHeartbeatFields'), false);
  assert.equal(warnings.length, 2);
});

test('带未知字段的坏心跳仍让快照整份拒读', t => {
  const share = temporary(t), paths = initialize(share);
  const value = heartbeat();
  value.newTop = true;
  value.machines[0].availableCores = -1;
  write(paths.heartbeat, value);
  const result = read.snapshot(share, Date.parse(AT));
  assert.equal(result.ok, false);
  assert.equal(result.readable, false);
  assert.equal(result.machines, null);
  assert.match(result.reason, /心跳核数或偏好不合法/);
});
