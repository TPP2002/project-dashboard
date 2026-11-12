'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const vm = require('node:vm');
const { fs, path, DAY, BASE, iso, line, fixture } = require('./fixtures/sched/ledgerIndex.cjs');
const { createLedgerIndex } = require('../core/schedLedgerIndex.cjs');
const reference = require('../core/schedLedger.cjs');

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
function memory() { gc(); gc(); const { heapUsed, external } = process.memoryUsage(); return heapUsed + external; }
function median(values) { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)]; }
function timed(fn) { const start = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - start); }
function request(i) { return { idempotencyKey: `fixture-${i}`, project: `demo-${i % 8}`, submitter: 'fixture-dispatcher',
  category: ['unit-test', 'other', 'codex-build'][i % 3], title: `测试任务 ${i}`,
  work: { type: `work-${i % 12}`, targetPaths: ['test/sample.test.cjs'] }, requestedCores: 4,
  allowedMachines: ['machine-a', 'machine-b'], codeRef: { kind: 'commit', value: 'b'.repeat(40) } }; }
const ticketId = i => `tk-${i.toString(16).padStart(20, '0')}`;

test('ledger index footprint, speed and equivalence on a large ledger', t => {
  const { share, ledger } = fixture(t);
  let seq = 0;
  function event(i, at, type, data = {}) { return { v: 1, seq: ++seq, at: iso(at), type, ticketId: ticketId(i), attemptId: 'a1', data }; }
  for (let day = 0; day < 20; day++) {
    const rows = [];
    for (let n = 0; n < 400; n++) {
      const i = day * 400 + n, at = BASE + day * DAY + n * 4000;
      rows.push(event(i, at, 'submitted', { request: request(i) }));
      if (i % 5 === 0) {
        rows.push(event(i, at + 100, 'dispatch-intent', { intent: { machine: 'machine-a', submissionId: `job-${i}` } }));
        rows.push(event(i, at + 200, 'dispatched', { submissionId: `job-${i}` }));
      }
      if (i % 10 !== 9) rows.push(event(i, at + 300, 'granted', { permit: { ciAware: i % 10 < 3 } }));
      rows.push(event(i, at + 400, 'started'), event(i, at + 500, 'suspension-observed'),
        event(i, at + 600, 'suspension-observed'), event(i, at + 1400 + (i % 977) * 10, 'finished'));
    }
    fs.writeFileSync(path.join(ledger, `${iso(BASE + day * DAY).slice(0, 10)}.jsonl`), rows.map(line).join(''));
  }
  assert.equal(seq, 50400);
  const baseline = memory(), index = createLedgerIndex();
  index.refresh(share);
  const initial = (memory() - baseline) / 8000;
  assert.ok(initial <= 1500, `initial bytes per ticket: ${initial}`);
  const nowMs = BASE + 20 * DAY;
  for (const ciAware of [false, true]) index.durationSamples([], { cursorSeq: Infinity, nowMs, ciAware });
  index.connectedProjects([], nowMs);
  const queried = (memory() - baseline) / 8000;
  assert.ok(queried <= 1200, `queried bytes per ticket: ${queried}`);
  let history = reference.readLedger(share);
  assert.equal(history.readable, true);
  const R = median(Array.from({ length: 5 }, () => timed(() => reference.durationSamples([], history.events, nowMs, { ciAware: false }))));
  const duration = median(Array.from({ length: 15 }, (_, k) => timed(() => index.durationSamples([], { cursorSeq: Infinity, nowMs: nowMs + k + 1, ciAware: false }))));
  const projects = median(Array.from({ length: 15 }, (_, k) => timed(() => index.connectedProjects([], nowMs + k + 1))));
  assert.ok(duration <= R / 25, `duration ratio: ${R / duration}`);
  assert.ok(projects <= R / 25, `projects ratio: ${R / projects}`);
  const before = index.stats().bytesRead, times = [];
  let appended = 0;
  for (let j = 0; j < 7; j++) {
    const i = 8000 + j, at = BASE + 19 * DAY + 23 * 3600000 + j * 2000;
    const bytes = [event(i, at, 'submitted', { request: request(i) }), event(i, at + 100, 'granted', { permit: { ciAware: false } }),
      event(i, at + 200, 'started'), event(i, at + 700, 'finished')].map(line).join('');
    fs.appendFileSync(path.join(ledger, '2026-10-01.jsonl'), bytes); appended += Buffer.byteLength(bytes);
    times.push(timed(() => { index.refresh(share); for (const ciAware of [false, true]) index.durationSamples([], { cursorSeq: Infinity, nowMs: nowMs + 16 + j, ciAware }); index.connectedProjects([], nowMs + 16 + j); }));
  }
  const appendTime = median(times);
  assert.ok(appendTime <= R / 6, `append ratio: ${R / appendTime}`);
  history = reference.readLedger(share);
  const finalNow = nowMs + 22;
  for (const ciAware of [false, true]) assert.deepEqual(index.durationSamples([], { cursorSeq: Infinity, nowMs: finalNow, ciAware }), reference.durationSamples([], history.events, finalNow, { ciAware }));
  assert.deepEqual(index.connectedProjects([], finalNow), reference.connectedProjects([], history, finalNow));
  assert.equal(index.stats().retainedEvents, 0);
  assert.equal(index.stats().fullRebuilds, 1);
  assert.ok(index.stats().bytesRead - before <= appended + 7 * 8192);
  t.diagnostic(`bytes/ticket initial=${initial} queried=${queried}; speed ratios duration=${R / duration} projects=${R / projects} append=${R / appendTime}`);
});
