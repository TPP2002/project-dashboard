'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLedgerIndex, ledgerIndexFor } = require('../core/schedLedgerIndex.cjs');
const { readLedger, durationSamples, connectedProjects } = require('../core/schedLedger.cjs');
const { ticketRelations } = require('../core/schedRelations.cjs');
const f = require('./fixtures/sched/ledgerIndex.cjs');

function equivalent(index, share, tickets, cursorSeq, nowMs, label) {
  const history = readLedger(share);
  assert.equal(index.refresh(share).readable, history.readable, label);
  for (const ciAware of [false, true]) assert.deepEqual(index.durationSamples(tickets, { cursorSeq, nowMs, ciAware }),
    durationSamples(tickets, history.events.filter(e => e.seq <= cursorSeq), nowMs, { ciAware }), label);
  assert.deepEqual(index.connectedProjects(tickets, nowMs), connectedProjects(tickets, history, nowMs), label);
  for (const ticket of f.records()) assert.deepEqual(ticketRelations(ticket, tickets, index.history()), ticketRelations(ticket, tickets, history), label);
}

test('40 seeded streams match full reads with changing snapshots, cursors and clocks', t => {
  for (let seed = 1; seed <= 40; seed++) {
    const { share, ledger } = f.fixture(t), index = createLedgerIndex(), { tickets, events, random } = f.stream(seed);
    for (let offset = 0; offset < events.length;) {
      const end = Math.min(events.length, offset + 1 + Math.floor(random() * 25));
      // Three day files at minimum, independently of the event timestamps.
      for (let j = offset; j < end; j++) f.append(ledger, [events[j]], f.iso(f.BASE + Math.floor(j / 60) * f.DAY).slice(0, 10));
      offset = end;
      const snapshot = tickets.filter((_, i) => i !== 5 && random() > .25).map(ticket => ({ ...ticket,
        request: { ...ticket.request, category: random() < .5 ? 'other' : 'unit-test' },
        attempts: ticket.attempts.map(a => ({ ...a, permit: random() < .5 ? null : { ciAware: random() < .5 } })) }));
      equivalent(index, share, snapshot, Math.floor(random() * (end + 1)), f.BASE + Math.floor(random() * 8 * f.DAY), `seed=${seed}, end=${end}`);
    }
    equivalent(index, share, tickets, events.length, f.BASE + 40 * f.DAY, `seed=${seed}, folded`);
    assert.equal(index.stats().retainedEvents, 0, `seed=${seed}`);
    const rebuilds = index.stats().fullRebuilds;
    equivalent(index, share, tickets, 10, f.BASE + f.DAY, `seed=${seed}, rewind`);
    assert.ok(index.stats().fullRebuilds > rebuilds, `seed=${seed}, rewind must rebuild`);
  }
});

test('injected filesystem counts zero unchanged bytes and bounded append bytes', t => {
  const { share, ledger } = f.fixture(t), { events, tickets } = f.stream(42, 100);
  let measured = 0;
  const io = Object.create(f.fs);
  io.readSync = (...args) => { const n = f.fs.readSync(...args); measured += n; return n; };
  io.readFileSync = (...args) => { const bytes = f.fs.readFileSync(...args); measured += Buffer.byteLength(bytes); return bytes; };
  const index = createLedgerIndex({ fs: io });
  f.append(ledger, events.slice(0, 80), '2026-09-12');
  equivalent(index, share, tickets, 80, f.BASE + 7 * f.DAY);
  const before = index.stats().bytesRead;
  assert.equal(before, measured);
  index.refresh(share);
  equivalent(index, share, tickets, 80, f.BASE + 7 * f.DAY - 1000);
  assert.equal(index.stats().bytesRead, before);
  const k = f.append(ledger, events.slice(80), '2026-09-12');
  equivalent(index, share, tickets, 100, f.BASE + 7 * f.DAY);
  assert.ok(index.stats().bytesRead - before <= k + 8192);
  assert.equal(index.stats().bytesRead, measured);
  assert.equal(ledgerIndexFor(share), ledgerIndexFor(share));
  ledgerIndexFor(share + '-other');
  assert.notEqual(ledgerIndexFor(share), ledgerIndexFor(share + '-other'));
});

test('file damage, directory changes and repairs agree with full validation', t => {
  const mutations = {
    truncate: (file, bytes) => f.fs.writeFileSync(file, bytes.subarray(0, bytes.length - 12)),
    delete: file => f.fs.unlinkSync(file),
    sameSize: (file, bytes) => { const stat = f.fs.statSync(file); f.fs.writeFileSync(file, bytes.toString().replace('demo-b', 'demo-z')); f.fs.utimesSync(file, stat.atime, stat.mtime); },
    middle: (file, bytes, ledger) => f.fs.writeFileSync(f.path.join(ledger, '2026-09-11.jsonl'), bytes),
    unknown: (file, bytes, ledger) => f.fs.writeFileSync(f.path.join(ledger, 'unknown.txt'), ''),
    badLine: file => f.fs.writeFileSync(file, '{\n'),
    checksum: (file, bytes) => f.fs.writeFileSync(file, bytes.toString().replace(/"sha256":"./, '"sha256":"z')),
    sequence: (file, bytes) => f.fs.appendFileSync(file, bytes),
    utf8: file => f.fs.writeFileSync(file, Buffer.from([0xff, 0x0a])),
    unfinished: file => f.fs.appendFileSync(file, '{')
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const { share, ledger } = f.fixture(t), index = createLedgerIndex(), { events, tickets } = f.stream(9);
    f.append(ledger, events.slice(0, 4), '2026-09-12');
    f.append(ledger, events.slice(4, 8), '2026-09-14');
    equivalent(index, share, tickets, 8, f.BASE + 8 * f.DAY, name);
    const file = f.path.join(ledger, '2026-09-12.jsonl'), bytes = f.fs.readFileSync(file), rebuilds = index.stats().fullRebuilds;
    mutate(file, bytes, ledger);
    const actual = index.refresh(share), expected = readLedger(share);
    assert.equal(actual.readable, expected.readable, name);
    if (!actual.readable) {
      assert.match(actual.reason, /^读不到调度台账：/, name);
      if (['checksum', 'sameSize', 'sequence', 'middle'].includes(name)) assert.match(actual.reason, /校验和/, name);
    }
    if (name !== 'sequence' && name !== 'unfinished') assert.ok(index.stats().fullRebuilds > rebuilds, name);
    for (const entry of f.fs.readdirSync(ledger)) f.fs.unlinkSync(f.path.join(ledger, entry));
    f.append(ledger, events, '2026-09-12');
    equivalent(index, share, tickets, events.length, f.BASE + 8 * f.DAY, `${name} repaired`);
  }
});

test('monotone thirty-day history prunes marks; old-window rewind rebuilds', t => {
  const { share, ledger } = f.fixture(t), index = createLedgerIndex(), tickets = f.records();
  for (let day = 0; day < 30; day++) {
    const event = { v: 1, seq: day + 1, at: f.iso(f.BASE + day * f.DAY), type: 'started', ticketId: tickets[0].ticketId, attemptId: `a${day}`, data: {} };
    f.append(ledger, [event], event.at.slice(0, 10));
    equivalent(index, share, tickets, day + 1, f.BASE + day * f.DAY, `day=${day}`);
    assert.ok(index.stats().recentMarks <= 9, `day=${day}`);
    assert.equal(index.stats().retainedEvents, 0);
  }
  const count = index.stats().fullRebuilds;
  equivalent(index, share, tickets, 30, f.BASE + 2 * f.DAY, 'old window');
  assert.ok(index.stats().fullRebuilds > count);
});

test('valid append in an older day stays equivalent, including sequence gaps', t => {
  const { share, ledger } = f.fixture(t), index = createLedgerIndex(), tickets = f.records(), id = tickets[0].ticketId;
  tickets[0].attempts[0].permit.ciAware = true;
  const event = (seq, type, ms, data = {}) => ({ v: 1, seq, type, at: f.iso(f.BASE + ms), ticketId: id, attemptId: 'a1', data });
  f.append(ledger, [event(10, 'started', 1000)], '2026-09-12');
  f.append(ledger, [event(100, 'finished', 5000), event(110, 'submitted', 6000, { request: { ...tickets[0].request, category: 'other' } }),
    event(120, 'dispatched', 7000, { submissionId: 'job-new' })], '2026-09-13');
  equivalent(index, share, tickets, 120, f.BASE + f.DAY);
  const before = index.stats();
  const k = f.append(ledger, [event(20, 'granted', 2000, { permit: { ciAware: false } }),
    event(30, 'submitted', 3000, { request: tickets[0].request }),
    event(40, 'dispatch-intent', 4000, { intent: { machine: 'machine-a', submissionId: 'job-old' } })], '2026-09-12');
  equivalent(index, share, tickets, 120, f.BASE + f.DAY);
  assert.ok(index.stats().fullRebuilds >= before.fullRebuilds);
  assert.equal(index.stats().retainedEvents, 0);
});

test('mismatching old tail rebuilds even when a file grows; complete rows without final newline are accepted', t => {
  const { share, ledger } = f.fixture(t), index = createLedgerIndex(), { tickets, events } = f.stream(17);
  const file = f.path.join(ledger, '2026-09-12.jsonl');
  f.fs.writeFileSync(file, f.line(events[0]).trimEnd());
  equivalent(index, share, tickets, 1, f.BASE + 7 * f.DAY);
  const before = index.stats();
  f.fs.appendFileSync(file, '\n' + f.line(events[1]));
  equivalent(index, share, tickets, 2, f.BASE + 7 * f.DAY);
  assert.ok(index.stats().bytesRead - before.bytesRead <= Buffer.byteLength(f.line(events[1])) + 1 + 8192);
  const count = index.stats().fullRebuilds;
  const bytes = f.fs.readFileSync(file, 'utf8').replace('demo-b', 'demo-z');
  f.fs.writeFileSync(file, bytes + f.line(events[2]));
  assert.equal(index.refresh(share).readable, readLedger(share).readable);
  assert.match(index.history().reason, /校验和/);
  assert.ok(index.stats().fullRebuilds > count);
});

test('empty intervening files do not hide cross-file sequence damage after earlier appends', t => {
  const { share, ledger } = f.fixture(t), index = createLedgerIndex(), { events } = f.stream(21);
  f.append(ledger, [events[0]], '2026-09-12');
  f.append(ledger, [], '2026-09-13');
  f.append(ledger, [{ ...events[1], seq: 100 }], '2026-09-14');
  assert.equal(index.refresh(share).readable, true);
  f.append(ledger, [{ ...events[1], seq: 20 }], '2026-09-12');
  assert.equal(index.refresh(share).readable, true);
  f.append(ledger, [{ ...events[1], seq: 10 }], '2026-09-13');
  assert.equal(readLedger(share).readable, false);
  assert.equal(index.refresh(share).readable, false);
  assert.match(index.history().reason, /校验和/);
});

test('non-finite cutoffs agree without poisoning a later finite query', t => {
  const { share, ledger } = f.fixture(t), index = createLedgerIndex(), { tickets, events } = f.stream(25);
  f.append(ledger, events, '2026-09-12');
  equivalent(index, share, tickets, events.length, f.BASE + 8 * f.DAY);
  for (const nowMs of [NaN, -Infinity, Infinity]) equivalent(index, share, tickets, events.length, nowMs);
  equivalent(index, share, tickets, NaN, f.BASE + 8 * f.DAY);
  equivalent(index, share, tickets, events.length, f.BASE + 8 * f.DAY);
});

test('recent twenty samples break timestamp ties by sequence and follow final requests and snapshot permits', t => {
  const { share, ledger } = f.fixture(t), index = createLedgerIndex(), tickets = f.records(), events = [];
  const add = (type, ms, data = {}) => events.push({ v: 1, seq: events.length + 1, at: f.iso(f.BASE + ms),
    type, ticketId: tickets[0].ticketId, attemptId: 'a1', data });
  for (let i = 0; i < 40; i++) { add('started', i * 100); add('finished', 100000); }
  add('submitted', 10 * f.DAY, { request: { ...tickets[0].request, category: 'other', work: { type: 'build' } } });
  f.append(ledger, events, '2026-09-12');
  for (const ciAware of [false, true]) {
    tickets[0].attempts[0].permit.ciAware = ciAware;
    equivalent(index, share, tickets, 81, f.BASE + f.DAY);
    assert.deepEqual(index.durationSamples(tickets, { cursorSeq: 81, nowMs: f.BASE + f.DAY, ciAware }).get('["other","build"]'),
      { sampleCount: 20, medianMs: 97050 });
  }
  const count = index.stats().fullRebuilds;
  equivalent(index, share, tickets, 40, f.BASE + f.DAY, 'cursor-only rewind');
  assert.ok(index.stats().fullRebuilds > count);
});
