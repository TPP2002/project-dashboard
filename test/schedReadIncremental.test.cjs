'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const c = require('../core/schedContract.cjs');
const read = require('../core/schedRead.cjs');
const { readLedger } = require('../core/schedLedger.cjs');
const { temporary, initialize, ticket, write, AT } = require('./fixtures/sched/support.cjs');
const NOW = Date.parse(AT);
function line(seq) {
  const event = { v: 1, seq, at: AT, type: 'fixture', data: {} };
  return JSON.stringify({ ...event, sha256: c.contentHash(event) }) + '\n';
}
function fixture(t, count = 0) {
  const share = temporary(t), paths = initialize(share), ledger = path.join(paths.root, 'ledger');
  fs.mkdirSync(ledger);
  for (let i = 1; i <= count; i++) {
    const record = ticket(i, { project: 'fixture-project' });
    write(path.join(paths.tickets, record.ticketId + '.json'), record);
  }
  for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(ledger, `2026-09-0${i}.jsonl`), line(i));
  return { share, paths, ledger };
}
function observe(t) {
  const originals = { readFileSync: fs.readFileSync, readSync: fs.readSync, readdirSync: fs.readdirSync };
  const calls = { full: [], tails: [], dirs: [] };
  let fullReadDepth = 0;
  fs.readFileSync = function (file, ...args) {
    calls.full.push(file); fullReadDepth++;
    try { return originals.readFileSync.call(this, file, ...args); }
    finally { fullReadDepth--; }
  };
  fs.readSync = function (fd, buffer, offset, length, position) {
    const result = originals.readSync.call(this, fd, buffer, offset, length, position);
    // readFileSync may call the patched readSync internally: count that operation once.
    if (fullReadDepth === 0) calls.tails.push({ length: result, position });
    return result;
  };
  fs.readdirSync = function (dir, ...args) { calls.dirs.push(dir); return originals.readdirSync.call(this, dir, ...args); };
  t.after(() => Object.assign(fs, originals));
  calls.clear = () => { calls.full.length = 0; calls.tails.length = 0; calls.dirs.length = 0; };
  return calls;
}
test('3000 tickets: unchanged snapshot reads no contents, one changed file reads once, two-second hits do zero IO', t => {
  const f = fixture(t, 3000), calls = observe(t);
  assert.equal(read.snapshot(f.share, NOW).ok, true);
  calls.clear();
  assert.equal(read.snapshot(f.share, NOW + 2000).ok, true);
  assert.equal(calls.full.length + calls.tails.length, 0);
  assert.equal(calls.dirs.includes(f.paths.tickets), false);
  const changed = ticket(1, { project: 'fixture-project', state: 'running' });
  write(path.join(f.paths.tickets, changed.ticketId + '.json'), changed);
  calls.clear();
  assert.equal(read.snapshot(f.share, NOW + 4000).running.length, 1);
  assert.equal(calls.full.length + calls.tails.length, 1);
  calls.clear();
  const a = read.snapshot(f.share, NOW + 4100), b = read.snapshot(f.share, NOW + 5999);
  assert.deepEqual(a, b); assert.equal(calls.full.length + calls.tails.length + calls.dirs.length, 0);
  a.running[0].title = 'consumer edit';
  assert.notEqual(read.snapshot(f.share, NOW + 4200).running[0].title, a.running[0].title);
});
test('ledger append reads precisely the new bytes; truncation and file-set changes rebuild', t => {
  const f = fixture(t), calls = observe(t), file = path.join(f.ledger, '2026-09-05.jsonl');
  assert.equal(readLedger(f.share).events.length, 5);
  const size = fs.statSync(file).size, appended = line(6);
  fs.appendFileSync(file, appended); calls.clear();
  assert.equal(readLedger(f.share).events.length, 6);
  assert.deepEqual(calls.full, []);
  assert.deepEqual(calls.tails, [{ length: Buffer.byteLength(appended), position: size }]);
  fs.writeFileSync(file, line(7)); calls.clear();
  assert.equal(readLedger(f.share).events.at(-1).seq, 7); assert.equal(calls.full.length, 5);
  fs.unlinkSync(file); calls.clear();
  assert.equal(readLedger(f.share).events.length, 4); assert.equal(calls.full.length, 4);
});
test('ticket size changes invalidate a cached file even with its modification time restored', t => {
  const f = fixture(t), record = ticket(1), file = path.join(f.paths.tickets, record.ticketId + '.json');
  write(file, record);
  assert.equal(read.ticketPage(f.share).items[0].title, record.request.title);
  const stamp = fs.statSync(file);
  record.request.title += ' changed-size'; write(file, record);
  fs.utimesSync(file, stamp.atime, stamp.mtime);
  assert.equal(read.ticketPage(f.share).items[0].title, record.request.title);
});
test('archive directories are skipped; detail searches newest date first and validates the archived ticket', t => {
  const f = fixture(t), record = ticket(99), archive = path.join(f.paths.tickets, '_archive');
  for (const date of ['2026-10-01', '2026-10-02']) {
    fs.mkdirSync(path.join(archive, date), { recursive: true });
    write(path.join(archive, date, record.ticketId + '.json'), { ...record, request: { ...record.request, title: date } });
  }
  fs.mkdirSync(path.join(f.paths.tickets, 'ignored.json'));
  assert.equal(read.snapshot(f.share, NOW).ok, true);
  assert.equal(read.ticketDetail(f.share, record.ticketId).request.title, '2026-10-02');
  fs.writeFileSync(path.join(archive, '2026-10-02', record.ticketId + '.json'), '{');
  assert.throws(() => read.ticketDetail(f.share, record.ticketId));
});
test('cache is isolated by share; partial lines, invalid UTF8, bad checksums and event order remain errors', t => {
  const f = fixture(t), g = fixture(t);
  assert.equal(read.snapshot(f.share, NOW).ok, true);
  fs.writeFileSync(g.paths.heartbeat, '{');
  assert.equal(read.snapshot(g.share, NOW).ok, false);
  const file = path.join(f.ledger, '2026-09-05.jsonl');
  assert.equal(readLedger(f.share).readable, true);
  fs.appendFileSync(file, '{'); assert.equal(readLedger(f.share).readable, false);
  fs.appendFileSync(file, 'broken\n'); assert.equal(readLedger(f.share).readable, false);
  for (const bad of [Buffer.from([255]), line(6).replace('fixture', 'invalid'), line(1)]) {
    fs.writeFileSync(file, bad); assert.equal(readLedger(f.share).readable, false);
  }
  fs.writeFileSync(file, line(6).trimEnd()); assert.equal(readLedger(f.share).readable, true);
  fs.appendFileSync(file, '\n' + line(7)); assert.equal(readLedger(f.share).events.at(-1).seq, 7);
});
