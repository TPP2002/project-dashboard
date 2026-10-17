'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const Module = require('node:module');
const c = require('../core/schedContract.cjs');
// Deliberately load the real existing module BEFORE touching any new cache interface.
const read = require('../core/schedRead.cjs');
const { temporary, initialize, ticket, write, AT } = require('./fixtures/sched/support.cjs');

function fixture(t, count = 3) {
  const share = temporary(t), paths = initialize(share);
  fs.mkdirSync(path.join(paths.root, 'ledger'));
  const records = Array.from({ length: count }, (_, i) => ticket(i + 1,
    { state: i === 0 ? 'paused' : 'running', registerOnly: i === 1 }));
  if (records[2]) records[2].request.parentTicketId = records[0].ticketId;
  const save = value => write(path.join(paths.tickets, `${value.ticketId}.json`), value);
  records.forEach(save);
  return { share, paths, records, save, file: path.join(paths.tickets, `${records[0].ticketId}.json`) };
}
function observe(t, f) {
  const originalRead = fs.readFileSync, originalParse = JSON.parse, originalRecord = c.requireRecord;
  const raw = new Set(f.records.map(value => originalRead(path.join(f.paths.tickets, `${value.ticketId}.json`), 'utf8')));
  const calls = { reads: 0, parses: 0, validations: 0 };
  fs.readFileSync = function (file, ...args) {
    if (typeof file === 'string' && path.dirname(file) === f.paths.tickets) calls.reads++;
    return originalRead.call(this, file, ...args);
  };
  JSON.parse = function (text, ...args) {
    if (raw.has(text)) calls.parses++;
    return originalParse.call(this, text, ...args);
  };
  c.requireRecord = function (value, label) {
    if (label === '单子快照') calls.validations++;
    return originalRecord(value, label);
  };
  t.after(() => { fs.readFileSync = originalRead; JSON.parse = originalParse; c.requireRecord = originalRecord; });
  return calls;
}
function uncachedReader() {
  const filename = require.resolve('../core/schedRead.cjs');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths;
  const baseRequire = Module.createRequire(filename);
  // Use an uncached adapter rather than a separate implementation of projection/validation.
  let directory;
  const adapter = { select(value) { directory = value; }, prune() {},
    read(file, id, validate) { return validate(c.readJson(path.join(directory, file)), id); } };
  loaded.require = name => name === './schedTicketReadCache.cjs' ? { ticketReadCache: adapter } : baseRequire(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}
const outcome = action => { try { return { value: action() }; } catch (error) {
  return { error: { message: error.message, status: error.status, code: error.code } };
} };
function outputs(reader, f) {
  const detail = reader.ticketDetail(f.share, f.records[0].ticketId);
  return { snapshot: reader.snapshot(f.share, Date.parse(AT)), page: reader.ticketPage(f.share, { limit: '2' }),
    csv: reader.exportTickets(f.share), detail, related: reader.relatedTickets(f.share, detail) };
}

test('baseline red: real existing consumers reread all bytes but unchanged tickets parse/validate only once', t => {
  const f = fixture(t), calls = observe(t, f);
  const first = read.ticketPage(f.share);
  assert.deepEqual(calls, { reads: 3, parses: 3, validations: 3 });
  assert.deepEqual(read.ticketPage(f.share), first);
  assert.equal(calls.reads, 6, 'a hit must still read every file in full');
  assert.equal(calls.parses, 3, 'unchanged tickets must not be JSON parsed again by real ticketPage');
  assert.equal(calls.validations, 3, 'unchanged tickets must not be validated again');
  read.snapshot(f.share, Date.parse(AT)); read.exportTickets(f.share); read.relatedTickets(f.share, f.records[0]);
  assert.deepEqual(calls, { reads: 15, parses: 3, validations: 3 });
  read.ticketDetail(f.share, f.records[0].ticketId);
  read.ticketDetail(f.share, f.records[0].ticketId);
  assert.deepEqual(calls, { reads: 17, parses: 5, validations: 5 }, 'detail remains a fresh full read');
});

test('all public projections equal uncached results, recompute now and isolate nested consumer edits', t => {
  const f = fixture(t), reference = uncachedReader();
  const expected = outputs(reference, f);
  assert.deepEqual(outputs(read, f), expected);
  const page = read.ticketPage(f.share), snap = read.snapshot(f.share, Date.parse(AT));
  page.items.forEach(item => { item.pauseReasons.push('owner-hold'); item.title = 'changed'; });
  page.items.reverse(); page.filters.projects.push('injected'); page.filters.engines[0].label = 'changed';
  snap.running.forEach(item => item.pauseReasons.push('ci'));
  snap.registerOnlyGroups[0].tickets[0].pauseReasons.push('manual');
  snap.dispatcher.heartbeat.machines[0].reservation.requestedCores = 999;
  snap.estimates[f.records[0].ticketId].reason = 'changed'; snap.connectedProjects.names.push('changed');
  const detail = read.ticketDetail(f.share, f.records[0].ticketId);
  detail.request.work.targetPaths.push('changed'); detail.attempts[0].timing.runningMs = 999;
  detail.timeline[0].data.request.title = 'changed'; detail.pauseReasons.push('ci');
  const related = read.relatedTickets(f.share, f.records[0]); related.children[0].title = 'changed';
  assert.deepEqual(outputs(read, f), expected);
  const later = Date.parse(AT) + 12345;
  assert.deepEqual(read.snapshot(f.share, later), reference.snapshot(f.share, later));
  assert.notEqual(read.snapshot(f.share, later).dispatcher.heartbeatAgeMs, expected.snapshot.dispatcher.heartbeatAgeMs);
});

test('same-length rewrite with restored mtime, replacement, append and truncation never reuse stale values', t => {
  const f = fixture(t, 1), reference = uncachedReader();
  read.ticketPage(f.share);
  const stat = fs.statSync(f.file), raw = fs.readFileSync(f.file, 'utf8');
  const changed = raw.replace('测试任务', '改写任务'); assert.equal(Buffer.byteLength(changed), Buffer.byteLength(raw));
  fs.writeFileSync(f.file, changed); fs.utimesSync(f.file, stat.atime, stat.mtime);
  assert.equal(read.ticketPage(f.share).items[0].title, '改写任务 1');
  assert.deepEqual(outputs(read, f), outputs(reference, f));
  f.records[0].request.title = 'replacement';
  write(f.file + '.replacement', f.records[0]); fs.renameSync(f.file + '.replacement', f.file);
  assert.equal(read.ticketPage(f.share).items[0].title, 'replacement');
  fs.appendFileSync(f.file, ' '); assert.deepEqual(outputs(read, f), outputs(reference, f));
  fs.writeFileSync(f.file, raw.slice(0, -1));
  assert.deepEqual(outcome(() => read.ticketPage(f.share)), outcome(() => reference.ticketPage(f.share)));
  f.save(f.records[0]); assert.equal(read.ticketPage(f.share).items[0].title, 'replacement');
});

test('UTF8, JSON, fields, filenames, non-files and directory errors preserve complete public API errors', t => {
  const f = fixture(t, 1), reference = uncachedReader();
  const apiFile = require.resolve('../server/schedApi.cjs');
  function api(reader, action, query = {}) {
    const loaded = new Module(apiFile, module); loaded.filename = apiFile; loaded.paths = module.paths;
    const baseRequire = Module.createRequire(apiFile);
    loaded.require = name => name === '../core/schedRead.cjs' ? reader : baseRequire(name);
    loaded._compile(fs.readFileSync(apiFile, 'utf8'), apiFile);
    let response;
    const router = loaded.exports.createSchedApi({ resolveShare: () => f.share, sources: { now: () => Date.parse(AT) },
      sendJson: (_, status, body) => { response = { status, body }; } });
    router.route(action, { method: 'GET' }, {
      writeHead(status, headers) { response = { status, headers }; },
      end(body) { response.body = body; },
    }, query); return response;
  }
  const equalErrors = () => {
    for (const action of ['snapshot', 'tickets', 'tickets.csv', `ticket/${f.records[0].ticketId}`]) {
      assert.deepEqual(api(read, action), api(reference, action), action);
    }
    assert.deepEqual(read.relatedTickets(f.share, f.records[0]), reference.relatedTickets(f.share, f.records[0]));
  };
  for (const bad of [Buffer.from([0xff, 0xfe]), '{', 'null', JSON.stringify({ ...f.records[0], state: 'bad' }),
    JSON.stringify({ ...f.records[0], pauseReasons: ['bad'] }), JSON.stringify({ ...f.records[0], ticketId: ticket(2).ticketId })]) {
    f.save(f.records[0]); assert.equal(api(read, 'tickets').status, 200);
    fs.writeFileSync(f.file, bad); equalErrors(); equalErrors();
    assert.equal(api(read, 'tickets').status, 503);
  }
  f.save(f.records[0]); read.ticketPage(f.share);
  fs.mkdirSync(path.join(f.paths.tickets, 'not-a-file.json')); equalErrors();
  fs.rmdirSync(path.join(f.paths.tickets, 'not-a-file.json'));
  write(path.join(f.paths.tickets, 'invalid-id.json'), f.records[0]); equalErrors();
  fs.unlinkSync(path.join(f.paths.tickets, 'invalid-id.json'));
  fs.renameSync(f.paths.tickets, f.paths.tickets + '.saved'); equalErrors();
  fs.writeFileSync(f.paths.tickets, 'not a directory'); equalErrors();
  fs.unlinkSync(f.paths.tickets); fs.renameSync(f.paths.tickets + '.saved', f.paths.tickets);
  fs.unlinkSync(f.file); equalErrors(); assert.equal(api(read, `ticket/${f.records[0].ticketId}`).status, 404);
  for (const query of [{ limit: '0' }, { cursor: 'bad' }, { result: 'bad' }, { from: 'yesterday' }]) {
    assert.deepEqual(api(read, 'tickets', query), api(reference, 'tickets', query));
    assert.equal(api(read, 'tickets', query).status, 400);
  }
});

test('injected file/directory read failures are never hidden by a warm cache and recovery revalidates', t => {
  const f = fixture(t, 1), calls = observe(t, f), reference = uncachedReader();
  read.ticketPage(f.share);
  const originalRead = fs.readFileSync, originalList = fs.readdirSync;
  const failure = Object.assign(new Error('fixture read denied'), { code: 'EACCES' });
  fs.readFileSync = function (file, ...args) { if (file === f.file) throw failure; return originalRead.call(this, file, ...args); };
  try {
    assert.deepEqual(outcome(() => read.ticketPage(f.share)), outcome(() => reference.ticketPage(f.share)));
    assert.equal(read.snapshot(f.share, Date.parse(AT)).reason, 'fixture read denied');
  } finally { fs.readFileSync = originalRead; }
  const before = calls.parses; read.ticketPage(f.share); assert.equal(calls.parses, before + 1);
  fs.readdirSync = function (dir, ...args) { if (dir === f.paths.tickets) throw failure; return originalList.call(this, dir, ...args); };
  try { assert.deepEqual(outcome(() => read.ticketPage(f.share)), outcome(() => reference.ticketPage(f.share))); }
  finally { fs.readdirSync = originalList; }
  assert.equal(read.ticketPage(f.share).total, 1);
});

test('delete/add/share switch prune resident state, including failed switch to another share', t => {
  const f = fixture(t, 2), g = fixture(t, 1);
  const { ticketReadCache: cache } = require('../core/schedTicketReadCache.cjs');
  read.ticketPage(f.share); assert.equal(cache.stats().entries, 2);
  fs.unlinkSync(f.file); assert.equal(read.ticketPage(f.share).total, 1); assert.equal(cache.stats().entries, 1);
  f.save(f.records[0]); read.ticketPage(f.share); assert.equal(cache.stats().entries, 2);
  g.records[0].request.title = 'other share'; g.save(g.records[0]);
  assert.equal(read.ticketPage(g.share).items[0].title, 'other share'); assert.equal(cache.stats().entries, 1);
  assert.equal(read.ticketPage(f.share).total, 2); assert.equal(cache.stats().entries, 2);
  assert.throws(() => read.ticketPage(path.join(g.share, 'missing')));
  assert.equal(cache.stats().entries, 0); assert.equal(cache.stats().weightBytes, 0);
});

test('stable resident set survives 24 over-capacity scans, with full byte reads and exact outputs', t => {
  const f = fixture(t, 5), calls = observe(t, f);
  const { createTicketReadCache } = require('../core/schedTicketReadCache.cjs');
  const cache = createTicketReadCache({ maxEntries: 2, maxBytes: 100000 });
  const filename = require.resolve('../core/schedRead.cjs'), loaded = new Module(filename, module);
  const baseRequire = Module.createRequire(filename); loaded.filename = filename; loaded.paths = module.paths;
  loaded.require = name => name === './schedTicketReadCache.cjs' ? { ticketReadCache: cache } : baseRequire(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  const expected = read.ticketPage(f.share), before = { ...calls };
  for (let round = 0; round < 24; round++) assert.deepEqual(loaded.exports.ticketPage(f.share), expected);
  assert.equal(calls.reads - before.reads, 24 * 5);
  assert.equal(calls.parses - before.parses, 5 + 23 * 3);
  assert.equal(calls.validations - before.validations, 5 + 23 * 3);
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().weightBytes, f.records.slice(0, 2).reduce((n, value) => n + Buffer.byteLength(JSON.stringify(value)), 0));
});

test('raw byte budget, oversize bypass, replacement weight and invalid data cleanup do not retain buffers/text', t => {
  const f = fixture(t, 2), { createTicketReadCache, MAX_ENTRIES, MAX_BYTES, MAX_ITEM_BYTES, IDLE_MS } = require('../core/schedTicketReadCache.cjs');
  assert.deepEqual([MAX_ENTRIES, MAX_BYTES, MAX_ITEM_BYTES, IDLE_MS], [20000, 64 * 1024 * 1024, 1024 * 1024, 600000]);
  const files = fs.readdirSync(f.paths.tickets), weight = fs.statSync(f.file).size;
  let validates = 0;
  const validate = value => { validates++; return value; };
  const cache = createTicketReadCache({ maxBytes: weight, maxEntries: 20000 });
  cache.select(f.paths.tickets); cache.prune(files);
  for (let round = 0; round < 24; round++) files.forEach(file => cache.read(file, '', validate));
  assert.equal(cache.stats().entries, 1); assert.equal(validates, 25); assert.equal(cache.stats().weightBytes, weight);
  f.records[0].request.title = 'x'; f.save(f.records[0]);
  cache.read(files[0], '', validate); assert.equal(cache.stats().weightBytes, fs.statSync(f.file).size);
  f.records[0].extra = 'x'.repeat(MAX_ITEM_BYTES); f.save(f.records[0]);
  for (let i = 0; i < 2; i++) assert.equal(cache.read(files[0], '', validate).extra.length, MAX_ITEM_BYTES);
  assert.equal(cache.stats().entries, 0); assert.equal(cache.stats().weightBytes, 0);
  const wide = createTicketReadCache(); wide.select(f.paths.tickets);
  wide.read(files[0], '', validate); assert.equal(wide.stats().entries, 0, 'per-item limit also applies with free total capacity');
  const empty = createTicketReadCache({ maxEntries: 0 }); empty.select(f.paths.tickets);
  assert.equal(empty.read(files[1], '', validate).ticketId, f.records[1].ticketId); assert.equal(empty.stats().entries, 0);
  f.records[0].extra = ''; f.save(f.records[0]); cache.read(files[0], '', validate);
  assert.equal(cache.stats().entries, 1);
  fs.appendFileSync(f.file, ' ');
  for (let i = 0; i < 2; i++) {
    assert.throws(() => cache.read(files[0], '', () => { throw new Error('fixture validation failed'); }), /fixture validation failed/);
    assert.equal(cache.stats().entries, 0); assert.equal(cache.stats().weightBytes, 0);
  }
});

test('ten minutes without calls clears state via sweep or next call; sweep itself does not keep cache alive', t => {
  const f = fixture(t, 1), { createTicketReadCache } = require('../core/schedTicketReadCache.cjs');
  let now = 1000, parses = 0;
  const cache = createTicketReadCache({ now: () => now }), file = path.basename(f.file);
  const load = () => { cache.select(f.paths.tickets); cache.prune([file]); return cache.read(file, '', value => { parses++; return value; }); };
  load(); now += 599999; cache.sweep(); assert.equal(cache.stats().entries, 1);
  load(); assert.equal(parses, 1);
  now += 600000; cache.sweep(); assert.equal(cache.stats().entries, 0); assert.equal(cache.stats().weightBytes, 0);
  load(); assert.equal(parses, 2);
  now += 600000; load(); assert.equal(parses, 3, 'a direct next call also enforces idle expiry');
  cache.clear(); assert.equal(cache.stats().lastUsedAt, null); assert.equal(cache.stats().weightBytes, 0);
});
