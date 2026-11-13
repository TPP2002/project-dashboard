'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { formatSubmitter, parseSubmitter } = require('../core/schedSubmitter.cjs');
const { startServer } = require('./fixtures/sched/support.cjs');

test('来源格式清理和解析', () => {
  const text = formatSubmitter({ clientHeader: 'sched-console', remoteAddress: '::ffff:127.0.0.1', userAgent: ' a;\n\tb ' });
  assert.equal(text, 'dashboard;client=page;addr=127.0.0.1;ua=a b');
  assert.deepEqual(parseSubmitter(text), { client: 'page', addr: '127.0.0.1', ua: 'a b' });
  assert.equal(formatSubmitter({ clientHeader: 'other', userAgent: 'x'.repeat(130) }), `dashboard;client=api;addr=unknown;ua=${'x'.repeat(120)}`);
  assert.equal(formatSubmitter({}), 'dashboard;client=api;addr=unknown;ua=none');
  assert.deepEqual(parseSubmitter('dashboard'), { legacy: true });
  assert.deepEqual(parseSubmitter('other'), { raw: 'other' });
  assert.equal(parseSubmitter(null), null); assert.equal(parseSubmitter(''), null);
});

test('请求来源、预留期限和确认约束', async t => {
  const srv = await startServer(t);
  const post = (body, headers) => srv.json('/api/sched/command', body, headers);
  const command = result => JSON.parse(fs.readFileSync(path.join(srv.paths.commands, `${result.body.commandId}.json`), 'utf8'));
  let result = await post({ kind: 'owner-hold', data: {} }, { 'X-Dashboard-Client': 'sched-console', 'User-Agent': 'test-agent' });
  assert.equal(result.status, 200); assert.deepEqual(parseSubmitter(command(result).submitter), { client: 'page', addr: '127.0.0.1', ua: 'test-agent' });
  result = await post({ kind: 'owner-hold', data: {} });
  assert.equal(parseSubmitter(command(result).submitter).client, 'api');
  for (const [data, confirm, expected] of [[{ requestedCores: 5 }, undefined, 180], [{ requestedCores: 5 }, true, null],
    [{ requestedCores: 5, durationMinutes: 60 }, undefined, 60], [{ requestedCores: 0 }, undefined, null]]) {
    result = await post({ kind: 'reserve', data, ...(confirm ? { confirmNoExpiry: true } : {}) });
    assert.equal(result.status, 200); assert.equal(result.body.durationMinutes, expected);
    const saved = command(result); assert.equal(saved.data.durationMinutes ?? null, expected); assert.equal(Object.hasOwn(saved, 'confirmNoExpiry'), false);
  }
  const before = fs.readdirSync(srv.paths.commands).sort();
  for (const body of [{ kind: 'reserve', data: { requestedCores: 5 }, confirmNoExpiry: false },
    { kind: 'reserve', data: { requestedCores: 5 }, confirmNoExpiry: 'true' },
    { kind: 'reserve', data: { requestedCores: 5, durationMinutes: 60 }, confirmNoExpiry: true },
    { kind: 'reserve', data: { requestedCores: 0 }, confirmNoExpiry: true },
    { kind: 'owner-hold', data: {}, confirmNoExpiry: true }]) {
    result = await post(body); assert.equal(result.status, 400); assert.match(result.body.error, /confirmNoExpiry 只用于不带期限的非零预留/);
  }
  assert.deepEqual(fs.readdirSync(srv.paths.commands).sort(), before);
});
