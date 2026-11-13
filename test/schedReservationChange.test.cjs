'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLedgerIndex } = require('../core/schedLedgerIndex.cjs');
const { snapshot } = require('../core/schedRead.cjs');
const f = require('./fixtures/sched/ledgerIndex.cjs');

test('预留变更与同机器指令配对，增量和重建一致', t => {
  const { share, ledger } = f.fixture(t), index = createLedgerIndex();
  let seq = 0;
  const event = (type, data) => ({ v: 1, seq: ++seq, at: f.iso(f.BASE + seq * 1000), type, data });
  const cmd = (machine, requestedCores, durationMinutes) => event('command-received', { command: { kind: 'reserve',
    data: { machine, requestedCores, ...(durationMinutes ? { durationMinutes } : {}) }, submitter: 'dashboard;client=page;addr=127.0.0.1;ua=test' } });
  const change = (machine, requestedCores, untilAt) => event('reservation-changed', { machine, requestedCores, ...(untilAt ? { untilAt } : {}) });
  const append = (...events) => { f.append(ledger, events, '2026-09-12'); assert.equal(index.refresh(share).readable, true); };
  const source = 'dashboard;client=page;addr=127.0.0.1;ua=test';
  const firstCommand = cmd('fixture-host', 5); let row = change('fixture-host', 5); append(firstCommand, row);
  assert.deepEqual(index.reservationChange('fixture-host'), { at: row.at, requestedCores: 5, untilAt: null, submitter: source });
  row = change('fixture-host', 0); append(row); assert.equal(index.reservationChange('fixture-host').submitter, null);
  assert.equal(index.reservationChange('fixture-host').requestedCores, 0);
  const until = f.iso(f.BASE + 10800000); const timed = cmd('fixture-host', 10, 180); row = change('fixture-host', 10, until); append(timed, row);
  assert.deepEqual(index.reservationChange('fixture-host'), { at: row.at, requestedCores: 10, untilAt: until, submitter: source });
  for (const [command, changed] of [[cmd('fixture-host', 5), change('fixture-host', 10)],
    [cmd('fixture-host', 5, 180), change('fixture-host', 5)], [cmd('fixture-worker', 5), change('fixture-host', 5)]]) {
    append(command, changed); assert.equal(index.reservationChange('fixture-host').submitter, null);
  }
  const expected = index.reservationChange('fixture-host');
  assert.deepEqual(snapshot(share, f.BASE + 20000).hostReservationChange, expected);
  assert.equal(index.refresh(share, true).readable, true); assert.deepEqual(index.reservationChange('fixture-host'), expected);
  f.fs.writeFileSync(f.path.join(ledger, '2026-09-12.jsonl'), '{');
  assert.equal(index.refresh(share).readable, false); assert.equal(index.reservationChange('fixture-host'), null);
  f.fs.unlinkSync(f.path.join(share, 'sched', '_control', 'format.json'));
  assert.equal(snapshot(share, f.BASE).hostReservationChange, null);
});
