'use strict';
// Development-only TS loader. Production uses the existing package build's original domain modules.
require('tsx/cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const p = require('../packages/scheduler/src/protocol/contract.cjs');
const f = require('../packages/scheduler/fixtures/protocol/messages.cjs');
const { ProjectionCache, hash } = require('../packages/scheduler/src/gateway/cache.cjs');

function fixture(t, { bytes = f.configBytes, kind = 'dispatcher-config', ttlMs = 10000, mutateChunk } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = { ...structuredClone(f.payloads['projection.manifest'].entries[0]), kind,
    object: { objectId: randomUUID(), hash: hash(bytes), size: bytes.length } };
  if (['log-segment', 'snapshot-bundle'].includes(kind)) Object.assign(entry, { ticketId: f.execution.ticketId, attemptId: f.execution.attemptId,
    ...(kind === 'log-segment' ? { segmentId: 'fixture-log' } : {}),
    audience: { kind: 'project', project: f.payloads.submission.project }, contentType: kind === 'log-segment' ? 'text/plain' : 'application/octet-stream' });
  let chunks = 0, catalogs = 0;
  const manifest = { ...structuredClone(f.payloads['projection.manifest']), entries: [entry],
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const cache = new ProjectionCache({ config: { root, ttlMs, maxObjectBytes: 2 * 1024 * 1024, maxCacheBytes: 4 * 1024 * 1024 },
    authorityId: f.scope.authorityId, authorityEpoch: f.scope.authorityEpoch,
    accessForPeer: () => f.trust().principal,
    async request(kind, payload) {
      if (kind === 'projection.catalog') { catalogs++; return { kind: 'projection.manifest', payload: { ...manifest, requestId: payload.requestId } }; }
      assert.equal(kind, 'projection.read'); chunks++;
      const piece = bytes.subarray(payload.offset, payload.offset + payload.length);
      const chunk = { ...payload, dataBase64: piece.toString('base64'), chunkHash: hash(piece) };
      return { kind: 'projection.chunk', payload: mutateChunk ? mutateChunk(chunk) : chunk };
    } });
  cache.connect('fixture-session');
  const peer = { sid: 'fixture-peer' }, request = { kind: 'read', callId: 'fixture-read', snapshotId: null, pageToken: null,
    selectors: [{ kind, ...(['log-segment', 'snapshot-bundle'].includes(kind) ? { ticketId: entry.ticketId, attemptId: entry.attemptId,
      ...(kind === 'log-segment' ? { segmentId: entry.segmentId } : {}) } : {}) }] };
  return { cache, root, entry, peer, request, manifest, bytes, counts: () => ({ chunks, catalogs }),
    read: () => cache.read(request, peer, { timeoutMs: 1000 }),
    local(offset = 0, length = Math.min(bytes.length, 131072)) { return { kind: 'read-object', callId: 'fixture-object',
      snapshotId: entry.snapshotId, ledgerCursor: entry.ledgerCursor, entry, offset, length }; } };
}

test('manifest reply publishes original complete domain-validated body and a working read-object path', async t => {
  const fx = fixture(t), manifest = await fx.read();
  assert.equal(manifest.entries.length, 1);
  const chunk = fx.cache.chunk(fx.local(), fx.peer);
  assert.deepEqual(Buffer.from(chunk.dataBase64, 'base64'), f.configBytes);
  assert.equal(fx.counts().chunks, 1);
  await fx.read(); assert.equal(fx.counts().chunks, 1, 'unchanged object is not transferred again');
  assert.equal(fx.counts().catalogs, 2);
});

function version(fx, n) {
  fx.manifest.snapshotId = fx.entry.snapshotId = `snapshot-${n}`;
  fx.manifest.ledgerCursor = fx.entry.ledgerCursor = { seq: n + 1, hash: hash(Buffer.from(String(n))) };
  fx.request.callId = `catalog-${n}`;
}
function rejected(reason, status = 'business_rejected') {
  const { outcome, ...base } = structuredClone(f.payloads.result);
  return { kind: 'result', payload: { ...base, status, reason } };
}

test('snapshot-bundle retains arbitrary binary bytes and checks complete hash and execution identity', async t => {
  const bytes = Buffer.from([0xff, 0xfe, 0, 0x80, 0x50, 0x4b]), fx = fixture(t, { bytes, kind: 'snapshot-bundle' });
  await fx.read();
  assert.deepEqual(Buffer.from(fx.cache.chunk(fx.local(), fx.peer).dataBase64, 'base64'), bytes);
  const wrong = structuredClone(fx.local()); wrong.entry.attemptId = 'a99';
  assert.throws(() => fx.cache.chunk(wrong, fx.peer), { code: 'CACHE_MANIFEST_UNKNOWN' });
  fs.writeFileSync(fx.cache.file(fx.entry), Buffer.alloc(bytes.length));
  assert.throws(() => fx.cache.chunk(fx.local(), fx.peer), /OBJECT_HASH_OR_SIZE/);
});

test('more than 64 fresh polling versions remain readable; evicted receipts request one complete reread', async t => {
  const fx = fixture(t, { ttlMs: 60000 }); let old;
  for (let i = 0; i < 130; i++) {
    version(fx, i); await fx.read();
    assert.deepEqual(Buffer.from(fx.cache.chunk(fx.local(), fx.peer).dataBase64, 'base64'), fx.bytes);
    if (i === 0) old = structuredClone(fx.local());
  }
  assert.equal(fx.counts().chunks, 1, 'polling unchanged content does not repeatedly download it');
  assert.ok(fx.cache.manifests.size <= 64); assert.ok(fx.cache.retired.size <= 4096);
  assert.ok(fx.cache.metadataBytes <= 8 * 1024 * 1024);
  for (const record of [...fx.cache.manifests.values(), ...fx.cache.retired.values()]) {
    for (const object of record.objects.values()) assert.equal(Object.hasOwn(object, 'value'), false, 'receipts retain entries, not decoded binary/JSON payloads');
  }
  assert.throws(() => fx.cache.chunk(old, fx.peer), { code: 'READ_VERSION_UNAVAILABLE' });
  const forged = structuredClone(old); forged.entry.object.hash = '0'.repeat(64);
  assert.throws(() => fx.cache.chunk(forged, fx.peer), { code: 'CACHE_MANIFEST_UNKNOWN' });
  assert.throws(() => fx.cache.chunk(old, { sid: 'other-peer' }), { code: 'CACHE_MANIFEST_UNKNOWN' });
  const cursor = structuredClone(old); cursor.ledgerCursor = cursor.entry.ledgerCursor = { seq: 99, hash: 'a'.repeat(64) };
  assert.throws(() => fx.cache.chunk(cursor, fx.peer), { code: 'CACHE_MANIFEST_UNKNOWN' });
  fx.cache.accessForPeer = () => undefined;
  assert.throws(() => fx.cache.chunk(old, fx.peer), { code: 'READ_DENIED' });
  fx.cache.accessForPeer = () => f.trust().principal;
  fx.cache.authorityEpoch++;
  assert.throws(() => fx.cache.chunk(old, fx.peer), { code: 'MANIFEST_VERSION' });
  fx.cache.authorityEpoch--;
  // Consumer drops the old cursor, pages and chunks and starts from a fresh catalog.
  const current = await fx.read(); assert.equal(current.snapshotId, fx.manifest.snapshotId);
  assert.deepEqual(Buffer.from(fx.cache.chunk(fx.local(), fx.peer).dataBase64, 'base64'), fx.bytes);
});

test('only the validated exact cloud rejection maps to version-unavailable, for catalogs and chunks', async t => {
  for (const leg of ['projection.catalog', 'projection.read']) {
    const fx = fixture(t), original = fx.cache.request;
    fx.cache.request = async (kind, ...args) => kind === leg ? rejected('READ_VERSION_UNAVAILABLE: frozen version expired') : original(kind, ...args);
    await assert.rejects(fx.read(), { code: 'READ_VERSION_UNAVAILABLE' });
    assert.equal(fx.cache.manifests.size, 0);
    assert.equal(fs.existsSync(fx.cache.file(fx.entry)), false);
    for (const reason of ['READ_DENIED', 'MANIFEST_VERSION', 'OBJECT_HASH_OR_SIZE', 'READ_VERSION_UNAVAILABLE:missing space', 'prefix READ_VERSION_UNAVAILABLE: invalid']) {
      fx.cache.request = async (kind, ...args) => kind === leg ? rejected(reason) : original(kind, ...args);
      await assert.rejects(fx.read(), error => error.code !== 'READ_VERSION_UNAVAILABLE');
    }
    fx.cache.request = async (kind, ...args) => kind === leg ? rejected('READ_VERSION_UNAVAILABLE: forged status', 'business_accepted') : original(kind, ...args);
    await assert.rejects(fx.read(), error => error.code !== 'READ_VERSION_UNAVAILABLE');
    const pending = rejected('READ_VERSION_UNAVAILABLE: still pending', 'business_pending'); pending.payload.retryAfterMs = 100;
    fx.cache.request = async (kind, ...args) => kind === leg ? pending : original(kind, ...args);
    await assert.rejects(fx.read(), { code: leg === 'projection.catalog' ? 'MANIFEST_REQUIRED' : 'CHUNK_REQUIRED' });
  }
});

test('pagination binds principal, selector, snapshot and cursor; known evicted pages require complete reread', async t => {
  const fx = fixture(t, { ttlMs: 60000 }); version(fx, 0); fx.manifest.nextPageToken = 'page-two';
  const first = await fx.read();
  const next = { ...fx.request, callId: 'second-page', snapshotId: first.snapshotId, pageToken: first.nextPageToken };
  const original = fx.cache.request;
  await fx.cache.read(next, fx.peer, { timeoutMs: 1000 });
  for (const patch of [{ snapshotId: 'other-version' }, { ledgerCursor: { seq: 500, hash: 'b'.repeat(64) } },
    { scope: { ...first.scope, authorityEpoch: first.scope.authorityEpoch + 1 } }]) {
    fx.cache.request = async (kind, payload, ...args) => {
      const reply = await original(kind, payload, ...args);
      if (kind !== 'projection.catalog') return reply;
      const manifest = { ...reply.payload, ...patch };
      manifest.entries = manifest.entries.map(entry => ({ ...entry, snapshotId: manifest.snapshotId, ledgerCursor: manifest.ledgerCursor }));
      return { kind: 'projection.manifest', payload: manifest };
    };
    await assert.rejects(fx.cache.read(next, fx.peer, { timeoutMs: 1000 }), { code: 'MANIFEST_VERSION' });
  }
  fx.cache.request = original;
  await assert.rejects(fx.cache.read({ ...next, pageToken: 'forged' }, fx.peer, { timeoutMs: 1000 }), { code: 'CACHE_MANIFEST_UNKNOWN' });
  await assert.rejects(fx.cache.read(next, { sid: 'another-reader' }, { timeoutMs: 1000 }), { code: 'CACHE_MANIFEST_UNKNOWN' });
  for (let i = 1; i < 67; i++) { version(fx, i); fx.manifest.nextPageToken = null; await fx.read(); }
  await assert.rejects(fx.cache.read(next, fx.peer, { timeoutMs: 1000 }), { code: 'READ_VERSION_UNAVAILABLE' });
  await assert.rejects(fx.cache.read({ ...next, snapshotId: 'unissued', pageToken: null }, fx.peer, { timeoutMs: 1000 }), { code: 'CACHE_MANIFEST_UNKNOWN' });
});

test('LRU access preserves a hot version without extending its receipt TTL', async t => {
  const fx = fixture(t, { ttlMs: 60000 }); version(fx, 0); await fx.read();
  const hot = structuredClone(fx.local()), record = [...fx.cache.manifests.values()][0], deadline = record.deadline;
  let cold;
  for (let i = 1; i < 64; i++) { version(fx, i); await fx.read(); if (i === 1) cold = structuredClone(fx.local()); }
  fx.cache.chunk(hot, fx.peer); assert.equal(record.deadline, deadline);
  version(fx, 64); await fx.read();
  assert.deepEqual(Buffer.from(fx.cache.chunk(hot, fx.peer).dataBase64, 'base64'), fx.bytes);
  assert.throws(() => fx.cache.chunk(cold, fx.peer), { code: 'READ_VERSION_UNAVAILABLE' });
  assert.equal(record.deadline, deadline);
  // Deterministic clock advancement past the original receive deadline; no sleeps or mtime refresh.
  t.mock.method(require('node:perf_hooks').performance, 'now', () => deadline + 1);
  assert.throws(() => fx.cache.chunk(hot, fx.peer), { code: 'CACHE_STALE' });
});

test('disk replacement retires old readers while files pinned by an unfinished page remain intact', { timeout: 10000 }, async t => {
  const fx = fixture(t, { bytes: Buffer.alloc(64, 1), kind: 'snapshot-bundle', ttlMs: 60000 });
  fx.cache.config.maxObjectBytes = 64; fx.cache.config.maxCacheBytes = 128;
  const objects = [1, 2, 3, 4].map(n => {
    const bytes = Buffer.alloc(64, n);
    return { bytes, entry: { ...structuredClone(fx.entry), object: { objectId: `binary-${n}`, hash: hash(bytes), size: bytes.length } } };
  });
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  fx.cache.request = async (kind, payload) => {
    if (kind === 'projection.catalog') {
      const indexes = payload.requestId === 'pinned-page' ? [0, 1] : [Number(payload.requestId.slice(-1))];
      const entries = indexes.map(i => ({ ...objects[i].entry, snapshotId: payload.requestId }));
      return { kind: 'projection.manifest', payload: { ...fx.manifest, requestId: payload.requestId, snapshotId: payload.requestId, entries } };
    }
    const object = objects.find(item => item.entry.object.hash === payload.entry.object.hash);
    if (object === objects[1]) { entered(); await gate; }
    const piece = object.bytes.subarray(payload.offset, payload.offset + payload.length);
    return { kind: 'projection.chunk', payload: { ...payload, dataBase64: piece.toString('base64'), chunkHash: hash(piece) } };
  };
  const read = callId => fx.cache.read({ ...fx.request, callId }, fx.peer, { timeoutMs: 1000 });
  const first = await read('page-0');
  const pending = read('pinned-page'); pending.catch(() => {});
  try {
    await Promise.race([waiting, pending.then(() => assert.fail('the two-object page must wait for its second download'))]);
    await read('page-2'); await read('page-3');
    assert.equal(fs.existsSync(fx.cache.file(objects[0].entry)), true, 'unfinished page pins its already cached first object');
  } finally { release(); }
  const published = await pending;
  for (const entry of published.entries) {
    const result = fx.cache.chunk({ ...fx.local(), snapshotId: published.snapshotId, ledgerCursor: published.ledgerCursor, entry }, fx.peer);
    assert.deepEqual(Buffer.from(result.dataBase64, 'base64'), objects.find(item => item.entry.object.hash === entry.object.hash).bytes);
  }
  const files = fs.readdirSync(fx.root).filter(name => name.endsWith('.object'));
  assert.equal(files.length, 2); assert.equal(files.reduce((n, name) => n + fs.statSync(path.join(fx.root, name)).size, 0), 128);
  await read('page-3');
  // Whichever object was evicted, a matching issued receipt has a precise reread signal.
  const evicted = published.entries.find(entry => !fs.existsSync(fx.cache.file(entry)));
  assert.ok(evicted);
  assert.throws(() => fx.cache.chunk({ ...fx.local(), snapshotId: published.snapshotId, ledgerCursor: published.ledgerCursor, entry: evicted }, fx.peer),
    { code: 'READ_VERSION_UNAVAILABLE' });
  assert.equal(first.entries[0].object.hash, objects[0].entry.object.hash);
});

test('empty first lookup is a valid catalog; unauthorized entry never becomes a version retry', async t => {
  const fx = fixture(t), original = fx.cache.request;
  fx.cache.request = async (kind, payload, ...args) => {
    if (kind === 'projection.catalog') return { kind: 'projection.manifest', payload: { ...fx.manifest, requestId: payload.requestId, entries: [] } };
    return original(kind, payload, ...args);
  };
  assert.deepEqual((await fx.read()).entries, []);
  assert.equal(fx.counts().chunks, 0);
  fx.cache.request = original;
  fx.entry.audience = { kind: 'owner' };
  fx.cache.accessForPeer = () => ({ ...f.trust().principal, role: 'windows', readAccess: {
    role: 'node', machine: f.machine, projects: [], authorityKinds: [] } });
  await assert.rejects(fx.read(), { code: 'READ_DENIED' });
  assert.equal(fx.counts().chunks, 0, 'authorization fails before any remote chunk rejection can be remapped');
});

test('large immutable object is fetched in bounded chunks and assembled without losing bytes', async t => {
  const bytes = Buffer.alloc(400000, 119), fx = fixture(t, { bytes, kind: 'log-segment' });
  await fx.read(); assert.equal(fx.counts().chunks, 4);
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 131072) {
    const reply = fx.cache.chunk(fx.local(offset, Math.min(131072, bytes.length - offset)), fx.peer);
    assert.ok(reply.length <= 131072); parts.push(Buffer.from(reply.dataBase64, 'base64'));
  }
  assert.deepEqual(Buffer.concat(parts), bytes);
});

test('shape-valid bytes with a matching hash are rejected by original domain validator', async t => {
  const fx = fixture(t, { bytes: Buffer.from('{"machine":42,"createdAt":"not-a-date","createdBy":"fixture"}') });
  await assert.rejects(fx.read());
  assert.equal(fs.existsSync(fx.cache.file(fx.entry)), false);
  assert.throws(() => fx.cache.chunk(fx.local(), fx.peer), { code: 'CACHE_MANIFEST_UNKNOWN' });
});

test('chunk corruption and changed snapshot/cursor fail closed before atomic publication', async t => {
  const corrupt = fixture(t, { mutateChunk: chunk => ({ ...chunk, chunkHash: '0'.repeat(64) }) });
  await assert.rejects(corrupt.read(), /CHUNK_HASH/);
  assert.equal(fs.existsSync(corrupt.cache.file(corrupt.entry)), false);
  const wrong = fixture(t, { mutateChunk: chunk => ({ ...chunk, snapshotId: 'different-snapshot' }) });
  await assert.rejects(wrong.read(), /MANIFEST_VERSION/);
  assert.equal(fs.existsSync(wrong.cache.file(wrong.entry)), false);
});

test('cache mtime and rereads never refresh TTL; reconnect cannot resurrect the old manifest', async t => {
  // Filesystem work can itself exceed 30 ms on a shared runner. Advance the
  // monotonic clock explicitly so this tests expiry, not disk scheduling speed.
  let now = 1000;
  t.mock.method(require('node:perf_hooks').performance, 'now', () => now);
  const fx = fixture(t, { ttlMs: 30 }); await fx.read();
  fx.cache.chunk(fx.local(), fx.peer);
  now += 29;
  fx.cache.chunk(fx.local(), fx.peer);
  fs.utimesSync(fx.cache.file(fx.entry), new Date(), new Date());
  now += 1;
  assert.throws(() => fx.cache.chunk(fx.local(), fx.peer), /CACHE_STALE/);
  fx.cache.disconnect(); fx.cache.connect('next-session');
  assert.throws(() => fx.cache.chunk(fx.local(), fx.peer), /CACHE_MANIFEST_UNKNOWN/);
});

test('corrupt previously cached object is never repaired by silently trusting its filename', async t => {
  const fx = fixture(t); await fx.read();
  const file = fx.cache.file(fx.entry); fs.writeFileSync(file, Buffer.alloc(fx.bytes.length, 32));
  await assert.rejects(fx.read(), /OBJECT_HASH_OR_SIZE/);
  assert.throws(() => fx.cache.chunk(fx.local(), fx.peer), /OBJECT_HASH_OR_SIZE/);
  assert.equal(fx.counts().chunks, 1);
});

test('manifest cannot grant unconfigured peer read access or substitute a different object', async t => {
  const fx = fixture(t); await fx.read();
  const local = fx.local(); local.entry = { ...local.entry, object: { ...local.entry.object, objectId: 'other' } };
  assert.throws(() => fx.cache.chunk(local, fx.peer), /CACHE_MANIFEST_UNKNOWN/);
  fx.cache.accessForPeer = () => undefined;
  assert.throws(() => fx.cache.chunk(fx.local(), fx.peer), /READ_DENIED/);
});
