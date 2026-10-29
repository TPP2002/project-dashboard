'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const c = require('../core/schedContract.cjs');
const read = require('../core/schedRead.cjs');
const { readLedger } = require('../core/schedLedger.cjs');
const { temporary, initialize, ticket, write, AT } = require('./fixtures/sched/support.cjs');
const NOW = Date.parse(AT);
function line(seq, data = {}) {
  const event = { v: 1, seq, at: AT, type: 'fixture', data };
  return JSON.stringify({ ...event, sha256: c.contentHash(event) }) + '\n';
}
function fixture(t, count = 0) {
  const share = temporary(t), paths = initialize(share), ledger = path.join(paths.root, 'ledger');
  fs.mkdirSync(ledger);
  const old = new Date(Date.now() - 10000);
  for (const file of [paths.format, paths.dispatcher, paths.heartbeat]) fs.utimesSync(file, old, old);
  for (let i = 1; i <= count; i++) {
    const record = ticket(i, { project: 'fixture-project' });
    const file = path.join(paths.tickets, record.ticketId + '.json');
    write(file, record);
    fs.utimesSync(file, old, old);
  }
  fs.utimesSync(paths.tickets, old, old);
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
test('fresh directory lists rescan same-stamp additions and stable lists restore the shortcut', t => {
  const f = fixture(t, 0), calls = observe(t), originalNow = Date.now, wallNow = originalNow();
  Date.now = () => wallNow;
  t.after(() => { Date.now = originalNow; });
  const first = ticket(1, { project: 'fixture-project', state: 'running' });
  write(path.join(f.paths.tickets, first.ticketId + '.json'), first);
  const recent = new Date(wallNow);
  fs.utimesSync(f.paths.tickets, recent, recent);
  const originalStat = fs.statSync, stamp = originalStat(f.paths.tickets);
  const ctimeNs = originalStat(f.paths.tickets, { bigint: true }).ctimeNs;
  // Keep both observed timestamps in the same clock tick, independent of host timing.
  fs.statSync = function (file, ...args) {
    const stat = originalStat.call(this, file, ...args);
    return file === f.paths.tickets && args[0]?.bigint ? { ...stat, ctimeNs } : stat;
  };
  t.after(() => { fs.statSync = originalStat; });
  assert.equal(read.snapshot(f.share, NOW).running.length, 1);
  const second = ticket(2, { project: 'fixture-project', state: 'running' });
  write(path.join(f.paths.tickets, second.ticketId + '.json'), second);
  fs.utimesSync(f.paths.tickets, stamp.atime, stamp.mtime); calls.clear();
  assert.equal(read.snapshot(f.share, NOW + 2001).running.length, 2);
  assert.equal(calls.dirs.includes(f.paths.tickets), true);
  const old = new Date(wallNow - 10000);
  fs.utimesSync(f.paths.tickets, old, old);
  assert.equal(read.snapshot(f.share, NOW + 4002).running.length, 2); calls.clear();
  assert.equal(read.snapshot(f.share, NOW + 6003).running.length, 2);
  assert.equal(calls.dirs.includes(f.paths.tickets), false);
});
test('racy tickets reread same-size rewrites, reuse matching hashes, and restore the old-file shortcut', t => {
  const f = fixture(t), record = ticket(1), file = path.join(f.paths.tickets, record.ticketId + '.json');
  const { createTicketReadCache } = require('../core/schedTicketReadCache.cjs');
  const cache = createTicketReadCache(), calls = observe(t);
  let validations = 0;
  const load = () => cache.read(path.basename(file), record.ticketId, value => { validations++; return value; });
  write(file, record);
  const recent = new Date(Date.now()); fs.utimesSync(file, recent, recent);
  cache.select(f.paths.tickets);
  const first = load(), stamp = fs.statSync(file);
  assert.equal(load(), first); assert.equal(validations, 1, 'matching hashes must not parse/validate again');
  const raw = JSON.stringify(record);
  record.request.title = record.request.title.replace('1', '2');
  assert.equal(Buffer.byteLength(JSON.stringify(record)), Buffer.byteLength(raw));
  write(file, record); fs.utimesSync(file, stamp.atime, stamp.mtime);
  assert.equal(load().request.title, record.request.title);
  assert.equal(validations, 2);
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(file, old, old); load(); calls.clear();
  assert.equal(load().request.title, record.request.title);
  assert.equal(calls.full.length, 0);
  assert.equal(validations, 2);
});
test('racy cached JSON observes a same-size heartbeat rewrite and restores the old-file shortcut', t => {
  const f = fixture(t), heartbeat = c.readJson(f.paths.heartbeat), calls = observe(t);
  const recent = new Date(Date.now());
  fs.utimesSync(f.paths.heartbeat, recent, recent);
  const first = read.snapshot(f.share, NOW), stamp = fs.statSync(f.paths.heartbeat);
  assert.equal(first.ok, true);
  const raw = JSON.stringify(heartbeat);
  heartbeat.tick++;
  assert.equal(Buffer.byteLength(JSON.stringify(heartbeat)), Buffer.byteLength(raw));
  write(f.paths.heartbeat, heartbeat); fs.utimesSync(f.paths.heartbeat, stamp.atime, stamp.mtime);
  const second = read.snapshot(f.share, NOW + 2001);
  assert.equal(second.ok, true);
  assert.equal(second.dispatcher.heartbeat.tick, heartbeat.tick);
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(f.paths.heartbeat, old, old);
  assert.equal(read.snapshot(f.share, NOW + 4002).ok, true); calls.clear();
  assert.equal(read.snapshot(f.share, NOW + 6003).dispatcher.heartbeat.tick, heartbeat.tick);
  assert.equal(calls.full.filter(file => file === f.paths.heartbeat).length, 0);
});
test('removed receipts release exactly their JSON cache entries without evicting another share', t => {
  const f = fixture(t), g = fixture(t);
  const other = path.join(g.paths.commandReceipts, 'other-receipt.json');
  write(other, { commandId: 'other-receipt', status: 'executed', at: AT });
  assert.equal(read.snapshot(g.share, NOW).ok, true);
  for (let i = 1; i <= 5; i++) {
    write(path.join(f.paths.commandReceipts, `receipt-${i}.json`), { commandId: `receipt-${i}`, status: 'executed', at: AT });
  }
  assert.equal(read.snapshot(f.share, NOW).recentReceipts.length, 5);
  const before = read.cacheStats();
  assert.deepEqual(Object.keys(before).sort(), ['jsonEntries', 'snapshots', 'ticketDirectories']);
  for (let i = 1; i <= 3; i++) fs.unlinkSync(path.join(f.paths.commandReceipts, `receipt-${i}.json`));
  assert.equal(read.snapshot(f.share, NOW + 2001).recentReceipts.length, 2);
  assert.equal(read.cacheStats().jsonEntries, before.jsonEntries - 3);
  assert.equal(read.snapshot(g.share, NOW + 2001).recentReceipts[0].commandId, 'other-receipt');
});
test('ledger events are shared and deeply frozen while returned array shells remain independent', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.ledger, '2026-09-01.jsonl'), line(1, { nested: [{ value: 'original' }] }));
  const first = readLedger(f.share), second = readLedger(f.share);
  assert.equal(first.readable, true); assert.equal(second.readable, true);
  assert.notEqual(first.events, second.events);
  const event = first.events[0];
  assert.equal(event, second.events[0]);
  assert.equal(Object.isFrozen(event), true); assert.equal(Object.isFrozen(event.data), true);
  assert.equal(Object.isFrozen(event.data.nested), true); assert.equal(Object.isFrozen(event.data.nested[0]), true);
  assert.throws(() => { event.type = 'changed'; }, TypeError);
  assert.throws(() => { event.data.changed = true; }, TypeError);
  assert.throws(() => { event.data.nested[0].value = 'changed'; }, TypeError);
  first.events.push(event); first.events.length = 0;
  const third = readLedger(f.share);
  assert.equal(third.events.length, 5); assert.equal(third.events[0], event);
});
test('racy directory stamps reveal a recreated ticket; old directory stamps skip readdir', t => {
  const f = fixture(t, 2), calls = observe(t), recent = new Date(Date.now());
  const originalStat = fs.statSync;
  fs.utimesSync(f.paths.tickets, recent, recent);
  const ctimeNs = originalStat(f.paths.tickets, { bigint: true }).ctimeNs;
  // Model a coarse clock tick: restoring mtime must also leave the observed ctime unchanged.
  fs.statSync = function (file, ...args) {
    const stat = originalStat.call(this, file, ...args);
    return file === f.paths.tickets && args[0]?.bigint ? { ...stat, ctimeNs } : stat;
  };
  t.after(() => { fs.statSync = originalStat; });
  assert.equal(read.ticketPage(f.share).total, 2);
  const recreated = ticket(1, { project: 'fixture-project' });
  const file = path.join(f.paths.tickets, recreated.ticketId + '.json');
  fs.unlinkSync(file); fs.utimesSync(f.paths.tickets, recent, recent);
  assert.equal(read.ticketPage(f.share).total, 1);
  recreated.request.title = 'recreated ticket'; write(file, recreated);
  fs.utimesSync(f.paths.tickets, recent, recent); calls.clear();
  const page = read.ticketPage(f.share);
  assert.equal(page.total, 2);
  assert.equal(page.items.find(item => item.ticketId === recreated.ticketId).title, 'recreated ticket');
  assert.equal(calls.dirs.filter(dir => dir === f.paths.tickets).length, 1);
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(f.paths.tickets, old, old); calls.clear();
  assert.equal(read.ticketPage(f.share).total, 2);
  assert.equal(calls.dirs.filter(dir => dir === f.paths.tickets).length, 1);
  calls.clear();
  assert.equal(read.ticketPage(f.share).total, 2);
  assert.equal(calls.dirs.filter(dir => dir === f.paths.tickets).length, 0);
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
