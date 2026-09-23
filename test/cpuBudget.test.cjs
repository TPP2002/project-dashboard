'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, heartbeat, write } = require('./fixtures/sched/support.cjs');

test('退休账本接口明确下线，不再报零占用或写入已无消费者的预留', async t => {
  const srv = await startServer(t);
  const sentinel = path.join(srv.legacy, 'reserve-owner.json');
  fs.writeFileSync(sentinel, 'retired-ledger-sentinel');
  for (const [endpoint, body] of [['/api/cpu'], ['/api/cpu', { cores: 10 }], ['/api/sched/legacy-reserve', { requestedCores: 5 }]]) {
    const result = await srv.json(endpoint, body);
    assert.equal(result.status, 410);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /已下线.*调度/);
    assert.equal(result.body.cpu, undefined);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'retired-ledger-sentinel');
  }
  assert.deepEqual(fs.readdirSync(srv.paths.commands).filter(name => name.endsWith('.json')), []);
});

test('机器占用、预留与 CI 余量全由心跳提供，账本为空也不能推断机器空闲', async t => {
  const srv = await startServer(t), hb = heartbeat(new Date().toISOString());
  Object.assign(hb.machines[0], { ci: 'active', ciRunners: ['runner-a'], ciReserveCores: 8 });
  write(srv.paths.heartbeat, hb);
  const result = await srv.json('/api/sched/snapshot');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.machines, hb.machines);
  assert.equal(Object.hasOwn(result.body, 'legacyReserve'), false);
  assert.deepEqual(fs.readdirSync(srv.legacy), []);
});
