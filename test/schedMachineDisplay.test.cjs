'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../core/schedMachineDisplay.mjs');
const reading = changes => ({ online: true, availableCores: 11.9, quotaCores: 17, grantedCores: 2,
  externalLoadCores: 1.1, ci: 'idle', reservation: null, ...changes });

test('配额 17、未接入占用 14.8、可用 0 必须显示占满，差额不能被当成可派核', async () => {
  const { machineCapacity } = await modulePromise;
  const machine = Object.freeze(reading({ availableCores: 0, grantedCores: 0, externalLoadCores: 14.8, ci: 'active' }));
  const result = machineCapacity(machine, false);
  assert.equal(result.label, '已被占满'); assert.equal(result.kind, 'full');
  assert.equal(result.tone, 'warn'); assert.equal(result.barPercent, 100);
  assert.match(result.detail, /配额已用尽/); assert.match(result.detail, /波动余量/);
  assert.match(result.detail, /可用核为 0，不能再派/);
  assert.match(result.barLabel, /不代表实测利用率/);
  assert.equal(machine.availableCores, 0);
});

test('CI 空闲但可用核为零仍显示占满，说明已派任务及未接入占用', async () => {
  const { machineCapacity } = await modulePromise;
  const result = machineCapacity(reading({ availableCores: 0, grantedCores: 8, externalLoadCores: 6 }), false);
  assert.equal(result.label, '已被占满'); assert.equal(result.tone, 'warn'); assert.equal(result.barPercent, 100);
  assert.match(result.detail, /已派任务/); assert.match(result.detail, /未接入调度的占用/);
  assert.match(result.detail, /CI 空闲不代表机器可派/);
  const reservation = machineCapacity(reading({ availableCores: 0, grantedCores: 0, externalLoadCores: 0,
    reservation: { requestedCores: 15 } }), false);
  assert.match(reservation.detail, /负责人预留/); assert.equal(reservation.kind, 'full');
});

test('空闲结论直接使用可用核，不从其他数字倒算，条形按不可再派份额显示正常色', async () => {
  const { machineCapacity } = await modulePromise;
  const result = machineCapacity(reading(), false);
  assert.equal(result.label, '空闲 11.9 核可派'); assert.equal(result.kind, 'available'); assert.equal(result.tone, 'ok');
  assert.ok(Math.abs(result.barPercent - 30) < 1e-10);
  assert.match(result.detail, /能否再派看可用核/);
  const changedDetails = machineCapacity(reading({ grantedCores: 0, externalLoadCores: 0 }), false);
  assert.equal(changedDetails.label, result.label); assert.equal(changedDetails.barPercent, result.barPercent);
  const tiny = machineCapacity(reading({ availableCores: 0.001 }), false);
  assert.equal(tiny.kind, 'available'); assert.equal(tiny.label, '空闲 0.001 核可派');
});

test('离线和过期优先于满闲数字，使用灰色条，不能把旧可用核当作空闲', async () => {
  const { machineCapacity } = await modulePromise;
  for (const availableCores of [0, 11.9]) {
    const offline = machineCapacity(reading({ online: false, availableCores }), true);
    assert.equal(offline.label, '离线'); assert.equal(offline.tone, 'muted'); assert.equal(offline.barPercent, null);
    const stale = machineCapacity(reading({ availableCores }), true);
    assert.equal(stale.label, '数据过期'); assert.equal(stale.tone, 'muted'); assert.equal(stale.barPercent, null);
    assert.match(stale.detail, /旧快照/);
  }
});

test('缺字段、无效数字和零配额安全降级，同输入结果可重放且不修改快照', async () => {
  const { machineCapacity } = await modulePromise;
  for (const machine of [null, undefined, {}, reading({ availableCores: undefined }), reading({ availableCores: null }),
    reading({ availableCores: NaN }), reading({ availableCores: Infinity }), reading({ availableCores: -1 })]) {
    let result;
    assert.doesNotThrow(() => { result = machineCapacity(machine, false); });
    assert.equal(result.kind, 'unknown'); assert.equal(result.barPercent, null);
  }
  const zero = machineCapacity(reading({ quotaCores: 0, availableCores: 0 }), false);
  assert.equal(zero.kind, 'full'); assert.equal(zero.barPercent, 100);
  assert.equal(machineCapacity(reading({ quotaCores: 0 }), false).barPercent, null);
  assert.match(machineCapacity(reading({ quotaCores: undefined, availableCores: 0 }), false).barLabel, /配额未知/);
  assert.equal(machineCapacity(reading({ availableCores: 20 }), false).barPercent, 0);
  const machine = Object.freeze(reading());
  const before = JSON.stringify(machine);
  assert.deepEqual(machineCapacity(machine, false), machineCapacity(machine, false));
  assert.equal(JSON.stringify(machine), before);
});
