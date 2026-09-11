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
test('五种指令严格字段：四档与手动/60/180 分钟期限，0 核不带期限', () => {
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
  for (const command of [
    { ...golden.commands[0].command, extra: true }, { ...golden.commands[0].command, data: { ticketId: golden.ticketIds[0].ticketId, machine: 'forbidden' } },
    { ...golden.commands[0].command, kind: 'pause-one' }, { ...golden.commands[0].command, kind: 'resume-one' },
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
