'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { getEventListeners } = require('node:events');
const { Worker } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { createSchedReadExecutor } = require('../core/schedReadExecutor.cjs');
const read = require('../core/schedRead.cjs');
const c = require('../core/schedContract.cjs');
const { temporary, initialize, ticket, write, AT } = require('./fixtures/sched/support.cjs');
const { readServer } = require('./fixtures/sched/read-server.cjs');
const WORKER = path.join(__dirname, 'fixtures/sched/read-worker.cjs');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, 'fixture condition did not complete within the unchanged 5s limit');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function fixture(t, { count = 3, block = false, fault, ...limits } = {}) {
  let executor;
  const cleanups = [];
  const directory = temporary(t, async () => {
    for (const cleanup of cleanups) await cleanup();
    await executor?.close();
  });
  const share = path.join(directory, 'share'), paths = initialize(share), workers = [];
  const records = Array.from({ length: count }, (_, index) => ticket(index + 1));
  for (const value of records) write(path.join(paths.tickets, value.ticketId + '.json'), value);
  fs.mkdirSync(path.join(paths.root, 'ledger'));
  const gate = new Int32Array(new SharedArrayBuffer(8));
  executor = createSchedReadExecutor({ ...limits, workerFactory: () => {
    const thread = new Worker(WORKER, { workerData: {
      ...(block ? { gate: gate.buffer, blockFile: path.join(paths.tickets, records[0].ticketId + '.json') } : {}),
      ...(workers.length === 0 && fault ? { fault } : {}),
    } });
    workers.push(thread); return thread;
  } });
  const request = (action = 'tickets', query = {}, root = share) => ({ action, query, share: root, nowMs: Date.parse(AT) + 3600000 });
  const release = () => { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); };
  return { directory, share, paths, records, workers, executor, request, gate, release,
    onCleanup: cleanup => cleanups.push(cleanup) };
}

test('real reusable worker: complete snapshot/page/export/detail results match the unchanged readers', async t => {
  const f = fixture(t), { executor: e, request } = f;
  const cases = [
    [request('snapshot'), () => read.snapshot(f.share, request().nowMs)],
    [request('tickets', { limit: '2', project: 'sample' }), () => read.ticketPage(f.share, { limit: '2', project: 'sample' })],
    [request('tickets.csv', { project: 'sample' }), () => read.exportTickets(f.share, { project: 'sample' })],
    [request('ticket/' + f.records[0].ticketId), () => {
      const value = read.ticketDetail(f.share, f.records[0].ticketId);
      return { ok: true, ticket: value, related: read.relatedTickets(f.share, value) };
    }],
    [request('ticket/' + f.records[0].ticketId, { related: '0' }), () => ({ ok: true, ticket: f.records[0] })],
  ];
  for (const [input, expected] of cases) {
    assert.equal(digest(await e.run(input)), digest(expected()), input.action);
    assert.equal(e.stats().pending, 0); assert.equal(e.stats().waiters, 0);
  }
  assert.equal(f.workers.length, 1, 'reuse the same worker across every read kind');
});

test('only unfinished identical queries coalesce; different queries/actions/shares stay isolated and serial', async t => {
  const f = fixture(t, { block: true }), e = f.executor;
  const first = e.run(f.request('tickets', { project: 'sample', limit: '1' }));
  await until(() => Atomics.load(f.gate, 0) === 1);
  const same = e.run(f.request('tickets', { limit: '1', project: 'sample' }));
  const different = e.run(f.request('tickets', { limit: '2', project: 'sample' }));
  const csv = e.run(f.request('tickets.csv'));
  const otherShare = path.join(f.directory, 'other'), otherPaths = initialize(otherShare);
  const other = ticket(50, { project: 'other' }); write(path.join(otherPaths.tickets, other.ticketId + '.json'), other);
  const isolated = e.run(f.request('tickets', {}, otherShare));
  assert.equal(e.stats().pending, 4); assert.equal(e.stats().queued, 3); assert.equal(e.stats().waiters, 5);
  assert.equal(f.workers.length, 1);
  f.release();
  const [a, b, next, exported, isolatedPage] = await Promise.all([first, same, different, csv, isolated]);
  assert.deepEqual(a, b); assert.equal(next.items.length, 2); assert.match(exported, /sample/);
  assert.equal(isolatedPage.total, 1); assert.equal(isolatedPage.items[0].project, 'other');
  assert.equal(f.workers.length, 2, 'share switch releases all private caches before starting its replacement');
  assert.equal(f.workers[0].threadId, -1, 'old worker has actually exited');
  const record = ticket(51, { project: 'new' }); write(path.join(otherPaths.tickets, record.ticketId + '.json'), record);
  assert.equal((await e.run(f.request('tickets', {}, otherShare))).total, 2, 'completed HTTP results are never reused');
  assert.equal(f.workers.length, 2); assert.equal(e.stats().waiters, 0);
});

test('new reads observe metadata changes, repairs, additions, deletions and appended ledger corruption', async t => {
  const f = fixture(t), e = f.executor, file = path.join(f.paths.tickets, f.records[0].ticketId + '.json');
  await e.run(f.request());
  const original = fs.readFileSync(file), stamp = fs.statSync(file);
  const broken = Buffer.from(original); broken[0] = '!'.charCodeAt(0);
  fs.writeFileSync(file, broken); fs.utimesSync(file, stamp.atime, new Date(stamp.mtimeMs + 1000));
  await assert.rejects(e.run(f.request()));
  write(file, f.records[0]);
  const added = ticket(100); write(path.join(f.paths.tickets, added.ticketId + '.json'), added);
  assert.equal((await e.run(f.request())).total, 4);
  fs.unlinkSync(file); assert.equal((await e.run(f.request())).total, 3);
  const ledger = path.join(f.paths.root, 'ledger', '2026-09-12.jsonl');
  const event = { v: 1, seq: 1, at: AT, type: 'fixture', data: {} };
  fs.writeFileSync(ledger, JSON.stringify({ ...event, sha256: c.contentHash(event) }) + '\n');
  assert.equal((await e.run(f.request('snapshot'))).historyError, null);
  const bytes = fs.readFileSync(ledger, 'utf8'), stat = fs.statSync(ledger);
  fs.writeFileSync(ledger, bytes + JSON.stringify({ ...event, seq: 2, sha256: '0'.repeat(64) }) + '\n'); fs.utimesSync(ledger, stat.atime, stat.mtime);
  assert.match((await e.run({ ...f.request('snapshot'), nowMs: f.request().nowMs + 2000 })).historyError, /校验和/);
  fs.unlinkSync(ledger); assert.equal((await e.run({ ...f.request('snapshot'), nowMs: f.request().nowMs + 4000 })).historyError, null);
});

test('overlapping snapshots share the first read time, while the next completed read gets a new timestamp', async t => {
  const f = fixture(t, { block: true }), e = f.executor, input = f.request('snapshot');
  const first = e.run(input);
  await until(() => Atomics.load(f.gate, 0) === 1);
  const overlapping = e.run({ ...input, nowMs: input.nowMs + 1000 });
  assert.equal(e.stats().pending, 1); assert.equal(e.stats().waiters, 2);
  f.release();
  const [a, b] = await Promise.all([first, overlapping]);
  assert.deepEqual(a, b); assert.equal(a.estimatesAt, new Date(input.nowMs).toISOString());
  const next = await e.run({ ...input, nowMs: input.nowMs + 2000 });
  assert.equal(next.estimatesAt, new Date(input.nowMs + 2000).toISOString());
  assert.equal(f.workers.length, 1);
});

test('unique-job and total-waiter caps reject excess work without losing existing work; abort frees queued slots', async t => {
  const f = fixture(t, { block: true, maxPending: 2, maxWaiters: 3 }), e = f.executor;
  const activeController = new AbortController(), queuedController = new AbortController();
  const first = e.run(f.request(), { signal: activeController.signal });
  await until(() => Atomics.load(f.gate, 0) === 1);
  const queued = e.run(f.request('tickets', { limit: '1' }), { signal: queuedController.signal });
  await assert.rejects(e.run(f.request('tickets.csv')), /队列已满/);
  const duplicate = e.run(f.request());
  await assert.rejects(e.run(f.request()), /等待人数已满/);
  const aborted = assert.rejects(queued, { name: 'AbortError' }); queuedController.abort(); await aborted;
  assert.equal(getEventListeners(queuedController.signal, 'abort').length, 0);
  assert.equal(e.stats().pending, 1); assert.equal(e.stats().waiters, 2);
  const replacement = e.run(f.request('tickets.csv'));
  f.release(); await Promise.all([first, duplicate, replacement]);
  assert.equal(e.stats().pending, 0); assert.equal(e.stats().queued, 0); assert.equal(e.stats().waiters, 0);
  assert.equal(getEventListeners(activeController.signal, 'abort').length, 0);
  assert.equal(f.workers.length, 1);
});

test('abort before start retains nothing; aborting all active waiters retains only one running descriptor', async t => {
  const f = fixture(t, { block: true }), e = f.executor, before = new AbortController(); before.abort();
  await assert.rejects(e.run(f.request(), { signal: before.signal }), { name: 'AbortError' });
  assert.equal(f.workers.length, 0); assert.equal(e.stats().pending, 0);
  const controller = new AbortController();
  const first = e.run(f.request(), { signal: controller.signal });
  await until(() => Atomics.load(f.gate, 0) === 1);
  const aborted = assert.rejects(first, { name: 'AbortError' }); controller.abort(); await aborted;
  assert.equal(e.stats().active, 1); assert.equal(e.stats().waiters, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const joined = e.run(f.request());
  assert.equal(e.stats().pending, 1); assert.equal(f.workers.length, 1);
  f.release(); assert.equal((await joined).total, 3);
  assert.equal(e.stats().pending, 0);
});

for (const fault of ['error', 'exit', 'message']) test(`worker ${fault} rejects all waiters and queued jobs, then allows a fresh worker`, async t => {
  const f = fixture(t, { fault }), e = f.executor;
  const first = e.run(f.request()), same = e.run(f.request()), queued = e.run(f.request('tickets.csv'));
  const settled = await Promise.allSettled([first, same, queued]);
  assert.deepEqual(settled.map(result => result.status), ['rejected', 'rejected', 'rejected']);
  assert.equal(e.stats().pending, 0); assert.equal(e.stats().waiters, 0); assert.equal(e.stats().queued, 0);
  assert.equal((await e.run(f.request())).total, 3);
  assert.equal(f.workers.length, 2); assert.equal(f.workers[0].threadId, -1);
});

test('reader errors preserve status/message and do not kill the reusable worker', async t => {
  const f = fixture(t), e = f.executor;
  for (const input of [f.request('tickets', { limit: '0' }), f.request('ticket/not-a-ticket'), f.request('ticket/tk-ffffffffffffffffffff')]) {
    let expected;
    try {
      if (input.action === 'tickets') read.ticketPage(f.share, input.query);
      else read.ticketDetail(f.share, input.action.slice(7));
    } catch (error) { expected = error; }
    assert.ok(expected);
    await assert.rejects(e.run(input), { status: expected.status, message: expected.message });
  }
  assert.equal((await e.run(f.request())).total, 3); assert.equal(f.workers.length, 1);
});

test('a stuck read expires, releases all subscribers and permits one replacement worker', async t => {
  const f = fixture(t, { fault: 'hang', timeoutMs: 1000 }), e = f.executor;
  const pending = Promise.allSettled([e.run(f.request()), e.run(f.request()), e.run(f.request('tickets.csv'))]);
  let deadline;
  try {
    const results = await Promise.race([pending, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('stuck read did not expire within 5s')), 5000);
    })]);
    for (const result of results) {
      assert.equal(result.status, 'rejected'); assert.match(result.reason.message, /超时/);
    }
    assert.equal(e.stats().pending, 0); assert.equal(e.stats().waiters, 0);
    assert.equal((await e.run(f.request())).total, 3);
    assert.equal(f.workers.length, 2); assert.equal(f.workers[0].threadId, -1);
    assert.equal(e.stats().pending, 0);
  } finally { clearTimeout(deadline); await e.close(); }
});

test('message deserialization errors settle active and queued reads and allow recovery', async t => {
  const f = fixture(t, { block: true }), e = f.executor;
  const pending = Promise.allSettled([e.run(f.request()), e.run(f.request('tickets.csv'))]);
  await until(() => Atomics.load(f.gate, 0) === 1);
  f.workers[0].emit('messageerror', new Error('fixture deserialization failure'));
  const results = await pending;
  for (const result of results) {
    assert.equal(result.status, 'rejected'); assert.match(result.reason.message, /fixture deserialization failure/);
  }
  f.release();
  assert.equal((await e.run(f.request())).total, 3);
  assert.equal(f.workers[0].threadId, -1);
  assert.equal(f.workers[0].listenerCount('messageerror'), 0);
  assert.equal(e.stats().waiters, 0);
});

test('startup failure rejects the read without leaking signals or jobs', async () => {
  const e = createSchedReadExecutor({ workerFactory() { throw new Error('fixture startup failure'); } });
  const signal = new AbortController().signal;
  await assert.rejects(e.run({ share: 'fixture', action: 'tickets' }, { signal }), /fixture startup failure/);
  assert.equal(e.stats().pending, 0); assert.equal(e.stats().waiters, 0); assert.equal(e.stats().workers, 0);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  await e.close();
});

test('postMessage failure retires the real worker and releases its waiter', async t => {
  let thread;
  const e = createSchedReadExecutor({ workerFactory() {
    thread = new Worker(WORKER);
    thread.postMessage = () => { throw new Error('fixture send failure'); };
    return thread;
  } });
  t.after(() => e.close());
  const signal = new AbortController().signal;
  await assert.rejects(e.run({ share: 'fixture', action: 'tickets' }, { signal }), /fixture send failure/);
  await e.close();
  assert.equal(thread.threadId, -1); assert.equal(e.stats().workers, 0);
  assert.equal(e.stats().pending, 0); assert.equal(e.stats().waiters, 0);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('idle and share sweep reclaim worker/cache ownership; close is idempotent and cancels active and queued work', async t => {
  const idle = fixture(t, { idleMs: 50 }), e = idle.executor;
  await e.run(idle.request());
  await until(() => e.stats().workers === 0);
  assert.equal(e.stats().idleTimer, false); assert.equal(idle.workers[0].threadId, -1);
  await e.run(idle.request()); assert.equal(idle.workers.length, 2);
  e.sweep(path.join(idle.directory, 'new-share'));
  await until(() => e.stats().workers === 0);
  assert.equal(idle.workers[1].threadId, -1);
  const busy = fixture(t, { block: true }), controller = new AbortController();
  const first = busy.executor.run(busy.request(), { signal: controller.signal });
  await until(() => Atomics.load(busy.gate, 0) === 1);
  const queued = busy.executor.run(busy.request('tickets.csv'));
  const rejected = Promise.all([assert.rejects(first, /已关闭/), assert.rejects(queued, /已关闭/)]);
  const close = busy.executor.close(); assert.equal(busy.executor.close(), close);
  await rejected; await close;
  assert.equal(busy.workers[0].threadId, -1); assert.equal(busy.executor.stats().workers, 0);
  assert.equal(busy.executor.stats().pending, 0); assert.equal(busy.executor.stats().waiters, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(busy.executor.run(busy.request()), /已关闭/);
});

test('real HTTP health/static/light requests complete while the production heavy reader is unfinished', async t => {
  const f = fixture(t, { count: 512, block: true });
  const srv = await readServer(f);
  let finished = false;
  const heavy = fetch(srv.base + '/api/sched/snapshot', { signal: AbortSignal.timeout(5000) })
    .then(async res => { const body = await res.json(); finished = true; return { status: res.status, body }; });
  // A rejection must stay observable even when a preceding health assertion fails.
  heavy.catch(() => {});
  await until(() => Atomics.load(f.gate, 0) === 1);
  const responses = await Promise.all(['/api/health', '/fixture.js', '/api/projects'].map(endpoint =>
    fetch(srv.base + endpoint, { signal: AbortSignal.timeout(5000) })));
  assert.equal(responses[0].status, 200); assert.equal((await responses[0].json()).ok, true);
  assert.equal(responses[1].status, 200); assert.equal(await responses[1].text(), 'window.fixture = true;');
  assert.equal(responses[2].status, 200); assert.deepEqual((await responses[2].json()).projects, []);
  assert.equal(finished, false); assert.equal(f.executor.stats().active, 1);
  assert.equal(Atomics.load(f.gate, 1), 0, 'health completed before the real file read was released');
  f.release();
  const result = await heavy;
  assert.equal(result.status, 200);
  assert.equal(digest(result.body), digest(read.snapshot(f.share, Date.parse(result.body.estimatesAt))));
});

test('real HTTP disconnect releases its waiter without cancelling another subscriber to the same read', async t => {
  const f = fixture(t, { block: true }), srv = await readServer(f);
  const disconnected = http.get(srv.base + '/api/sched/tickets');
  disconnected.on('error', () => {});
  await until(() => Atomics.load(f.gate, 0) === 1);
  const survivor = fetch(srv.base + '/api/sched/tickets', { signal: AbortSignal.timeout(5000) });
  await until(() => f.executor.stats().waiters === 2);
  disconnected.destroy();
  await until(() => f.executor.stats().waiters === 1);
  assert.equal(f.executor.stats().pending, 1); assert.equal(f.workers.length, 1);
  f.release(); assert.equal((await (await survivor).json()).total, 3);
  await until(() => f.executor.stats().waiters === 0);
});

test('real server close settles a blocked HTTP read before waiting for connections to drain', async t => {
  const f = fixture(t, { block: true }), srv = await readServer(f);
  const response = fetch(srv.base + '/api/sched/tickets', { signal: AbortSignal.timeout(5000) });
  response.catch(() => {});
  await until(() => Atomics.load(f.gate, 0) === 1);
  const stopped = new Promise(resolve => srv.server.close(resolve));
  try {
    const result = await response;
    assert.equal(result.status, 503);
    assert.match((await result.json()).reason, /已关闭/);
    assert.equal(Atomics.load(f.gate, 1), 0, 'shutdown must not wait for the blocked reader');
    await stopped;
    await f.executor.close();
    assert.equal(f.workers[0].threadId, -1);
    assert.equal(f.executor.stats().pending, 0); assert.equal(f.executor.stats().waiters, 0);
  } finally { await f.executor.close(); srv.server.closeAllConnections(); await stopped; }
});
