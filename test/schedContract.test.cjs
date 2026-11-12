'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const c = require('../core/schedContract.cjs');
const golden = require('./fixtures/sched/contract-golden.json');
const { temporary, initialize, write, AT } = require('./fixtures/sched/support.cjs');

test('调度契约金样：规范 JSON、sha256 与确定性单号逐字一致', () => {
  for (const sample of golden.canonical) {
    assert.equal(c.canonicalJson(sample.value), sample.json);
    assert.equal(c.contentHash(sample.value), sample.sha256);
  }
  for (const sample of golden.ticketIds) assert.equal(c.deriveTicketId(sample.project, sample.key), sample.ticketId);
  for (const sample of golden.commands) {
    assert.deepEqual(c.validateCommand(sample.command), sample.command);
    assert.equal(c.canonicalJson(sample.command), sample.json);
    assert.equal(c.contentHash(sample.command), sample.sha256);
  }
});
test('调度契约金样：非法指令错误逐字一致，安全路径段正反例', () => {
  for (const sample of golden.invalidCommands) {
    assert.equal(sample.rejected, true);
    assert.throws(() => c.validateCommand(sample.command), { message: sample.error });
  }
  for (const sample of golden.segments.valid) assert.equal(c.segment(sample.value), sample.value);
  for (const sample of golden.segments.invalid) assert.throws(() => c.segment(sample.value));
});
test('规范编码拒收 undefined、空洞、非有限数、非 JSON 值与原型键', () => {
  for (const value of [undefined, [undefined], { a: undefined }, new Array(2), NaN, Infinity, -Infinity, 1n, () => {}, Symbol('x'), new Date(AT), JSON.parse('{"__proto__":1}')]) {
    assert.throws(() => c.canonicalJson(value)); assert.throws(() => c.contentHash(value));
  }
  assert.equal(c.canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 })), '{"a":2,"b":1}');
  assert.equal(c.canonicalJson(-0), '0');
});
test('七种指令严格字段：四档与手动/60/180 分钟期限，0 核不带期限', () => {
  const base = { commandId: 'reserve-fixture', kind: 'reserve', submitter: 'dashboard', createdAt: AT, expiresAt: '2026-09-12T00:10:00.000Z' };
  for (const cores of [0, 5, 10, 15]) for (const duration of [undefined, 60, 180]) {
    const command = { ...base, data: { machine: 'fixture-host', requestedCores: cores, ...(duration === undefined ? {} : { durationMinutes: duration }) } };
    if (cores === 0 && duration !== undefined) assert.throws(() => c.validateCommand(command), /零核预留不能带期限/);
    else assert.deepEqual(c.validateCommand(command), command);
  }
  for (const duration of [0, 1, 59, 61, 179, 181, -60, '60', null, undefined]) {
    assert.throws(() => c.validateCommand({ ...base, data: { machine: 'fixture-host', requestedCores: 5, durationMinutes: duration } }));
  }
  for (const cores of [-1, 1, 20, '5', null]) assert.throws(() => c.validateCommand({ ...base, data: { machine: 'fixture-host', requestedCores: cores } }));
  // pause-one/resume-one 与 jump-queue/cancel 同款:只带 ticketId 即合法,原样返回(改动前这两种被拒)。
  for (const kind of ['pause-one', 'resume-one']) {
    const command = { ...golden.commands[0].command, kind };
    assert.deepEqual(c.validateCommand(command), command);
  }
  for (const command of [
    { ...golden.commands[0].command, extra: true }, { ...golden.commands[0].command, data: { ticketId: golden.ticketIds[0].ticketId, machine: 'forbidden' } },
    { ...golden.commands[0].command, kind: 'pause-one', data: {} },
    { ...golden.commands[0].command, kind: 'resume-one', data: { ticketId: golden.ticketIds[0].ticketId, machine: 'forbidden' } },
    { ...golden.commands[0].command, expiresAt: '2026-09-11T23:59:59.999Z' },
  ]) assert.throws(() => c.validateCommand(command));
});
test('指令文件逐字等于金样；create-only 同内容也拒绝，不覆盖、不留暂存', t => {
  const share = temporary(t), paths = initialize(share);
  for (const [index, sample] of golden.commands.entries()) {
    const source = { nonce: () => `fixture-${index}` };
    const target = c.writeCommand(share, sample.command, source);
    assert.deepEqual(fs.readFileSync(target), Buffer.from(sample.json, 'utf8'));
    assert.throws(() => c.writeCommand(share, sample.command, source), { code: 'EEXIST' });
    assert.throws(() => c.writeCommand(share, { ...sample.command, submitter: 'other' }, source), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(target, 'utf8'), sample.json);
    assert.deepEqual(fs.readdirSync(paths.staging), []);
  }
});
test('格式比代码新、缺失、读不到或损坏即拒写，不能初始化或写半截目标', t => {
  const share = temporary(t), paths = initialize(share), command = golden.commands[0].command;
  for (const value of [{ formatVersion: 2, capabilities: [], createdAt: AT }, { formatVersion: 0, capabilities: [], createdAt: AT }, null]) {
    write(paths.format, value);
    assert.throws(() => c.writeCommand(share, command));
    assert.deepEqual(fs.readdirSync(paths.commands), ['_receipts']);
    assert.deepEqual(fs.readdirSync(paths.staging), []);
  }
  fs.writeFileSync(paths.format, '{'); assert.throws(() => c.writeCommand(share, command));
  fs.unlinkSync(paths.format); assert.throws(() => c.writeCommand(share, command), { code: 'ENOENT' });
  fs.mkdirSync(paths.format); assert.throws(() => c.writeCommand(share, command));
  assert.deepEqual(fs.readdirSync(paths.staging), []);
});
test('暂存碰撞不删别人的文件；目标目录缺失不降级成非原子写入', t => {
  const share = temporary(t), paths = initialize(share), command = golden.commands[0].command;
  const staging = path.join(paths.staging, '.dashboard-collision.tmp'); fs.writeFileSync(staging, 'occupied');
  assert.throws(() => c.writeCommand(share, command, { nonce: () => 'collision' }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(staging, 'utf8'), 'occupied');
  fs.renameSync(paths.commands, paths.commands + '-away');
  assert.throws(() => c.writeCommand(share, command, { nonce: () => 'missing-directory' }));
  assert.deepEqual(fs.readdirSync(paths.staging), ['.dashboard-collision.tmp']);
});

test('派单员心跳可带 CI 车道字段(ciRunners/ciReserveCores),缺省仍合法;别的未知字段记录但不拒读', () => {
  const { heartbeat } = require('./fixtures/sched/support.cjs');
  const plain = heartbeat();
  assert.doesNotThrow(() => c.validateHeartbeat(plain));
  const laned = heartbeat();
  laned.machines[0] = { ...laned.machines[0], ciRunners: ['rogue-local-win-2'], ciReserveCores: 12 };
  laned.machines[1] = { ...laned.machines[1], ciRunners: null, ciReserveCores: 0 };
  assert.doesNotThrow(() => c.validateHeartbeat(laned));
  const bad = heartbeat();
  bad.machines[0] = { ...bad.machines[0], ciReserveCores: -1 };
  assert.throws(() => c.validateHeartbeat(bad));
  const unknown = heartbeat();
  unknown.machines[0] = { ...unknown.machines[0], somethingElse: 1 };
  assert.doesNotThrow(() => c.validateHeartbeat(unknown));
  assert.deepEqual(c.heartbeatUnknownFields(unknown), ['machines[].somethingElse']);
});

test('派单员心跳可带实测退回字段 actualUsageCreditCores(退回 >0 才写),缺省仍合法;负数与非数字照拒(1010 看板读不到共享盘的病根)', () => {
  const { heartbeat } = require('./fixtures/sched/support.cjs');
  const credited = heartbeat();
  credited.machines[0] = { ...credited.machines[0], actualUsageCreditCores: 4 };
  credited.machines[1] = { ...credited.machines[1], actualUsageCreditCores: 0.5 };
  assert.doesNotThrow(() => c.validateHeartbeat(credited));
  for (const bad of [-1, '4', null, Number.NaN]) {
    const broken = heartbeat();
    broken.machines[0] = { ...broken.machines[0], actualUsageCreditCores: bad };
    assert.throws(() => c.validateHeartbeat(broken), `actualUsageCreditCores=${String(bad)} 应被拒`);
  }
});

test('派单员心跳可带执行端作业槽实测 agentSlots(缺键或 null 表示未知);合法槽位与超占通过,非法值与未知字段严格拒收(0924)', () => {
  const { heartbeat } = require('./fixtures/sched/support.cjs');
  // 旧心跳缺键仍合法;显式 null(新写者对没有 jobSlots 的旧执行心跳)也合法,都表示未知。
  assert.doesNotThrow(() => c.validateHeartbeat(heartbeat()));
  const nulled = heartbeat();
  nulled.machines[0] = { ...nulled.machines[0], agentSlots: null };
  assert.doesNotThrow(() => c.validateHeartbeat(nulled));
  // 合法:0 占用、满槽、超占(occupied 允许超过 capacity,保留超占实况)。
  for (const slots of [{ capacity: 4, occupied: 0 }, { capacity: 4, occupied: 4 }, { capacity: 4, occupied: 6 }]) {
    const ok = heartbeat();
    ok.machines[0] = { ...ok.machines[0], agentSlots: slots };
    ok.machines[1] = { ...ok.machines[1], agentSlots: { capacity: 1, occupied: 1 } };
    assert.doesNotThrow(() => c.validateHeartbeat(ok), `agentSlots=${JSON.stringify(slots)} 应合法`);
  }
  // 非法:capacity=0/负数/小数/非数,occupied=负数/小数/非数。
  for (const bad of [{ capacity: 0, occupied: 0 }, { capacity: -1, occupied: 0 }, { capacity: 1.5, occupied: 0 },
    { capacity: '4', occupied: 0 }, { capacity: Number.NaN, occupied: 0 },
    { capacity: 4, occupied: -1 }, { capacity: 4, occupied: 0.5 }, { capacity: 4, occupied: '2' }]) {
    const broken = heartbeat();
    broken.machines[0] = { ...broken.machines[0], agentSlots: bad };
    assert.throws(() => c.validateHeartbeat(broken), `agentSlots=${JSON.stringify(bad)} 应被拒`);
  }
  // 缺嵌套字段与多字段都拒收,对象严格只认 capacity/occupied。
  const missing = heartbeat();
  missing.machines[0] = { ...missing.machines[0], agentSlots: { capacity: 4 } };
  assert.throws(() => c.validateHeartbeat(missing));
  const occupiedOnly = heartbeat();
  occupiedOnly.machines[0] = { ...occupiedOnly.machines[0], agentSlots: { occupied: 1 } };
  assert.throws(() => c.validateHeartbeat(occupiedOnly));
  const extra = heartbeat();
  extra.machines[0] = { ...extra.machines[0], agentSlots: { capacity: 4, occupied: 1, free: 3 } };
  assert.throws(() => c.validateHeartbeat(extra), { message: '[sched] 未知字段:free' });
});

test('派单员心跳机器条目可带执行端工具读数 tools(1027 看板第三次整页读不到调度共享盘的病根)', () => {
  const { heartbeat } = require('./fixtures/sched/support.cjs');
  for (const tools of [{ bash: true }, { bash: false }, {}]) {
    const ok = heartbeat();
    ok.machines[0] = { ...ok.machines[0], tools };
    assert.doesNotThrow(() => c.validateHeartbeat(ok), `tools=${JSON.stringify(tools)} 应合法`);
  }
  const bad = heartbeat();
  bad.machines[0] = { ...bad.machines[0], tools: { bash: 'yes' } };
  assert.throws(() => c.validateHeartbeat(bad));
});

test('机器条目 tools 认任意合规工具名(bash、py:<项目id>),值必须是布尔;名字不合规或值非布尔整份拒读(SCHED-SPARE-PY-DEPS-VERIFY-1028)', () => {
  const { heartbeat } = require('./fixtures/sched/support.cjs');
  for (const tools of [
    { bash: true, 'py:mama': true }, { 'py:mama': false }, { bash: false, 'py:better-numbers': true },
    { ['py:' + 'a'.repeat(32)]: true },
  ]) {
    const ok = heartbeat();
    ok.machines[0] = { ...ok.machines[0], tools };
    assert.doesNotThrow(() => c.validateHeartbeat(ok), `tools=${JSON.stringify(tools)} 应合法`);
  }
  for (const tools of [
    { 'py:mama': 'yes' }, { 'Py:mama': true }, { 'py:': true }, { 'py:mama:x': true },
    { 'a b': true }, { ['py:' + 'a'.repeat(33)]: true },
  ]) {
    const bad = heartbeat();
    bad.machines[0] = { ...bad.machines[0], tools };
    assert.throws(() => c.validateHeartbeat(bad), `tools=${JSON.stringify(tools)} 应整份拒读`);
  }
});
