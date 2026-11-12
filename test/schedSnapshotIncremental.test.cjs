'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const read = require('../core/schedRead.cjs');
const { readLedger, connectedProjects } = require('../core/schedLedger.cjs');
const { estimateTickets } = require('../core/schedEstimates.cjs');
const { ticketRelations } = require('../core/schedRelations.cjs');
const f = require('./fixtures/sched/ledgerIndex.cjs');

test('snapshot and details share incremental ledger reads and equal full-read projections', t => {
  const { share, paths, ledger } = f.fixture(t), tickets = f.records(), nowMs = f.BASE + 7 * f.DAY;
  const hb = f.heartbeat(f.iso(nowMs)); hb.cursorSeq = 3100;
  hb.machines = hb.machines.map((machine, i) => ({ ...machine, name: i ? 'machine-b' : 'machine-a', reservation: null }));
  f.write(paths.heartbeat, hb);
  tickets[0].state = 'running'; tickets[0].endedAt = null;
  tickets[0].attempts[0].startedAt = f.iso(nowMs - 1000);
  tickets.forEach(ticket => f.write(f.path.join(paths.tickets, `${ticket.ticketId}.json`), ticket));
  f.write(f.path.join(paths.commandReceipts, 'receipt-a.json'), { commandId: 'receipt-a', status: 'executed', at: f.iso(nowMs) });
  const { events } = f.stream(71, 3100);
  for (let day = 0; day < 5; day++) f.append(ledger, events.slice(day * 620, (day + 1) * 620), f.iso(f.BASE + day * f.DAY).slice(0, 10));
  function compare() {
    const actual = read.snapshot(share, nowMs), history = readLedger(share);
    assert.equal(actual.ok, true);
    assert.equal(actual.estimates[tickets[0].ticketId].kind, 'completion');
    assert.deepEqual(actual.estimates, estimateTickets({ readable: true, nowMs, tickets, queue: hb.queue, machines: hb.machines,
      locks: hb.locks, heartbeatAt: hb.at, cursorSeq: hb.cursorSeq }, history));
    assert.deepEqual(actual.connectedProjects, connectedProjects(tickets, history, nowMs));
    assert.equal(actual.historyError, history.reason);
  }
  assert.equal(read.ledgerIndexStats(share), null);
  compare();
  const first = read.ledgerIndexStats(share);
  compare(); assert.equal(read.ledgerIndexStats(share).bytesRead, first.bytesRead);
  const extra = [{ v: 1, seq: 3101, at: f.iso(nowMs - 5000), type: 'started', ticketId: tickets[1].ticketId, attemptId: 'a-new', data: {} },
    { v: 1, seq: 3102, at: f.iso(nowMs - 2000), type: 'finished', ticketId: tickets[1].ticketId, attemptId: 'a-new', data: {} },
    { v: 1, seq: 3103, at: f.iso(nowMs - 1000), type: 'dispatch-intent', ticketId: tickets[0].ticketId, attemptId: 'a1',
    data: { intent: { machine: 'machine-a', submissionId: 'job-new' } } }];
  const k = f.append(ledger, extra, '2026-09-16'); hb.cursorSeq += extra.length; f.write(paths.heartbeat, hb);
  compare();
  const after = read.ledgerIndexStats(share).bytesRead;
  assert.ok(after - first.bytesRead <= k + 8192);
  assert.deepEqual(read.relatedTickets(share, tickets[0]), ticketRelations(tickets[0], tickets, readLedger(share)));
  assert.equal(read.ledgerIndexStats(share).bytesRead, after);
});
