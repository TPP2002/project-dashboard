'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID, createHash } = require('node:crypto');
const { fixture, p, principal, owner, authority, call } = require('./cloudSchedulerAuthority.test.cjs');
const scope = f => ({ kind: 'authority-read', authorityId: authority.id, authorityEpoch: f.service.health().authorityEpoch });
async function catalog(f, selectors, who = owner, previous = null, limit = 64, pageToken = null) {
  const response = await f.send('projection.catalog', { requestId: randomUUID(), scope: scope(f),
    snapshotId: previous?.snapshotId ?? null, pageToken, selectors, limit }, undefined, who);
  assert.equal(response.kind, 'projection.manifest', JSON.stringify(response.payload));
  p.validateReadManifest(response.payload); return response.payload;
}
async function object(f, manifest, entry, who = owner) {
  const parts = [];
  for (let offset = 0; offset < entry.object.size; offset += 131072) {
    const response = await f.send('projection.read', { requestId: randomUUID(), scope: scope(f), snapshotId: manifest.snapshotId,
      ledgerCursor: manifest.ledgerCursor, entry, offset, length: Math.min(131072, entry.object.size - offset) }, undefined, who);
    assert.equal(response.kind, 'projection.chunk', JSON.stringify(response.payload));
    parts.push(Buffer.from(response.payload.dataBase64, 'base64'));
  }
  const bytes = Buffer.concat(parts);
  p.verifyProjectionObject(bytes, entry, manifest, { principal: who, authorityId: authority.id,
    authorityEpoch: f.service.health().authorityEpoch, now: f.now(), maxObjectBytes: 64 * 1024 * 1024 });
  return bytes;
}
async function denied(f, selectors, who = principal, previous = null, pageToken = null) {
  const response = await f.send('projection.catalog', { requestId: randomUUID(), scope: scope(f),
    snapshotId: previous?.snapshotId ?? null, pageToken, selectors, limit: 64 }, undefined, who);
  assert.equal(response.kind, 'result'); assert.equal(response.payload.status, 'business_rejected');
  assert.equal(f.service.health().stopped, false); return response;
}

test('empty service exposes immutable empty directory, original format/config/heartbeat and default policy', async () => {
  const f = await fixture();
  try {
    await f.open(owner); await f.service.tick();
    const manifest = await catalog(f, ['ticket-index', 'command-receipt-index', 'scheduler-format', 'dispatcher-config', 'dispatcher-heartbeat', 'hub-switch', 'ci-policy'].map(kind => ({ kind })));
    assert.equal(manifest.entries.length, 7);
    const bodies = new Map();
    for (const entry of manifest.entries) bodies.set(entry.kind, JSON.parse((await object(f, manifest, entry)).toString('utf8')));
    assert.deepEqual(bodies.get('ticket-index').entries, []);
    assert.deepEqual(bodies.get('command-receipt-index').entries, []);
    assert.equal(bodies.get('dispatcher-config').machine, 'fixture-win');
    assert.equal(bodies.get('dispatcher-heartbeat').machine, 'fixture-win');
    assert.equal(bodies.get('dispatcher-heartbeat').machines[0].fresh, false);
    assert.equal(bodies.get('ci-policy').mode, 'freeze');
  } finally { await f.dispose(); }
});

test('full original ticket remains fixed at its read cursor after domain changes', async () => {
  const f = await fixture();
  try {
    await f.open(); await f.observe(); await f.open(owner);
    const job = await f.submit('read-full', { category: 'codex-build', requestedCores: 0 });
    const manifest = await catalog(f, [{ kind: 'ticket', ticketId: job.id }]);
    const before = await object(f, manifest, manifest.entries[0]);
    assert.deepEqual(JSON.parse(before), f.ticket(job.id));
    await f.send('command', { commandId: 'read-finish', kind: 'finish', data: { ticketId: job.id, result: 'passed' },
      submitter: 'fixture', createdAt: f.now(), expiresAt: '2026-01-02T00:00:00.000Z' });
    await f.service.tick();
    assert.equal(f.ticket(job.id).state, 'passed');
    assert.deepEqual(await object(f, manifest, manifest.entries[0]), before);
    const later = await catalog(f, [{ kind: 'ticket', ticketId: job.id }, { kind: 'command-receipt', commandId: 'read-finish' }]);
    assert.ok(later.ledgerCursor.seq > manifest.ledgerCursor.seq);
    assert.equal(JSON.parse(await object(f, later, later.entries.find(e => e.kind === 'ticket'))).state, 'passed');
    assert.equal(JSON.parse(await object(f, later, later.entries.find(e => e.kind === 'command-receipt'))).status, 'executed');
  } finally { await f.dispose(); }
});

test('first ticket lookup is empty, then submission and status use the original deterministic identity', async () => {
  const f = await fixture();
  try {
    await f.open(); await f.observe();
    const request = f.request('first-client-submit');
    const id = require('../packages/scheduler/src/cloud/domain.cjs')('sched-contract').deriveTicketId(request.project, request.idempotencyKey);
    const absent = await catalog(f, [{ kind: 'ticket', ticketId: id }], principal);
    assert.deepEqual(absent.entries, []); assert.equal(absent.nextPageToken, null);
    const job = await f.submit(request.idempotencyKey);
    assert.equal(job.id, id);
    const found = await catalog(f, [{ kind: 'ticket', ticketId: id }], principal);
    assert.equal(found.entries.length, 1);
    const ticket = JSON.parse(await object(f, found, found.entries[0], principal));
    assert.equal(ticket.request.createdAt, request.createdAt);
    assert.equal(ticket.request.idempotencyKey, request.idempotencyKey);
    assert.equal(ticket.state, 'granted');
    assert.ok(found.ledgerCursor.seq > absent.ledgerCursor.seq);
    assert.deepEqual((await catalog(f, [{ kind: 'ticket', ticketId: id }], principal, absent)).entries, []);
    // Empty lookup permission does not authorize unrelated execution objects.
    const missing = require('../packages/scheduler/src/cloud/domain.cjs')('sched-contract').deriveTicketId(request.project, 'still-missing');
    await denied(f, [{ kind: 'execution-index', ticketId: missing, attemptId: 'a1' }]);
  } finally { await f.dispose(); }
});

test('32 live status polls stay bounded, see changes, and retain accessed immutable versions without extending TTL', async t => {
  const f = await fixture();
  try {
    await f.open(); await f.observe(); await f.open(owner);
    const job = await f.submit('continuous-status', { category: 'codex-build', requestedCores: 0 });
    const selectors = [{ kind: 'ticket', ticketId: job.id }];
    const held = await catalog(f, selectors), before = await object(f, held, held.entries[0]);
    let evicted;
    for (let i = 0; i < 32; i++) {
      f.advance(250);
      if (i === 16) {
        await f.send('command', { commandId: 'continuous-finish', kind: 'finish', data: { ticketId: job.id, result: 'passed' },
          submitter: 'fixture', createdAt: f.now(), expiresAt: '2026-01-02T00:00:00.000Z' });
        await f.service.tick();
      }
      const current = await catalog(f, selectors);
      if (i === 0) evicted = current;
      const body = JSON.parse(await object(f, current, current.entries[0]));
      assert.equal(body.state, i < 16 ? JSON.parse(before).state : 'passed');
      if (i >= 16) assert.ok(current.ledgerCursor.seq > held.ledgerCursor.seq);
      assert.deepEqual(await object(f, held, held.entries[0]), before);
      const usage = f.service.health().readCache;
      assert.ok(usage.versions <= 8); assert.equal(usage.maxVersions, 8);
      assert.ok(usage.metadataBytes <= 32 * 1024 * 1024);
      assert.equal(usage.metadataBudgetBytes, 32 * 1024 * 1024);
      assert.ok(usage.entries <= 8 * 16384); assert.ok(usage.pageTokens <= 8 * 4096);
    }
    assert.equal(f.service.health().readCache.versions, 8);
    t.diagnostic(`32-poll retained metadata budget evidence: ${JSON.stringify(f.service.health().readCache)}`);
    const stillHeld = await catalog(f, selectors, owner, held);
    assert.equal(stillHeld.issuedAt, held.issuedAt); assert.equal(stillHeld.expiresAt, held.expiresAt);
    const refused = await denied(f, selectors, owner, evicted);
    assert.match(refused.payload.reason, /^READ_VERSION_UNAVAILABLE:/);
    const refusedObject = await f.send('projection.read', { requestId: randomUUID(), scope: scope(f), snapshotId: evicted.snapshotId,
      ledgerCursor: evicted.ledgerCursor, entry: evicted.entries[0], offset: 0, length: 1 }, undefined, owner);
    assert.equal(refusedObject.payload.status, 'business_rejected');
    assert.match(refusedObject.payload.reason, /^READ_VERSION_UNAVAILABLE:/);
    // Restart the whole read under a fresh manifest; never splice old chunks.
    const retried = await catalog(f, selectors);
    assert.equal(JSON.parse(await object(f, retried, retried.entries[0])).state, 'passed');
    f.advance(60001);
    const expired = await denied(f, selectors, owner, held);
    assert.match(expired.payload.reason, /^READ_VERSION_UNAVAILABLE:/);
  } finally { await f.dispose(); }
});

test('fixed ReadAccess refuses another project and owner ledger, including forged immutable entries', async () => {
  const writer = { ...principal, readAccess: { ...principal.readAccess, projects: ['sample', 'private'] } };
  const reader = { ...principal, id: 'limited-reader', nodeIds: ['limited-node'], nativeObservation: false };
  const f = await fixture({ principal: writer, readers: [reader] });
  try {
    await f.open(); await f.observe(); await f.open(owner); await f.open(reader);
    const own = await f.submit('public');
    const earlier = await catalog(f, [{ kind: 'ticket', ticketId: own.id }], reader);
    const hidden = await f.submit('private', { project: 'private', category: 'codex-build', requestedCores: 0 });
    await denied(f, [{ kind: 'ticket', ticketId: hidden.id }], reader, earlier);
    await denied(f, [{ kind: 'ticket', ticketId: hidden.id }], reader);
    await denied(f, [{ kind: 'usage-history', project: 'private' }], reader);
    await assert.rejects(f.send('projection.catalog', { requestId: randomUUID(), scope: scope(f), snapshotId: null, pageToken: null,
      selectors: [{ kind: 'ledger-index' }], limit: 64 }, undefined, reader), /READ_OWNER_ONLY/);
    const allowed = await catalog(f, [{ kind: 'ticket-index' }], reader);
    const directory = JSON.parse(await object(f, allowed, allowed.entries[0], reader));
    assert.deepEqual(directory.entries.map(e => e.ticketId), [own.id]);
    const all = await catalog(f, [{ kind: 'ticket', ticketId: hidden.id }]);
    const response = await f.send('projection.read', { requestId: randomUUID(), scope: scope(f), snapshotId: all.snapshotId,
      ledgerCursor: all.ledgerCursor, entry: all.entries[0], offset: 0, length: 1 }, undefined, reader);
    assert.equal(response.payload.status, 'business_rejected');
    assert.equal(f.service.health().stopped, false);
  } finally { await f.dispose(); }
});

test('directory and catalog pagination are bounded; cursor is tied to selectors and immutable version', async () => {
  const f = await fixture();
  try {
    await f.open(); await f.observe(); await f.open(owner);
    for (let i = 0; i < 65; i++) await f.send('submission', f.request(`page-${i}`, { category: 'codex-build', requestedCores: 0 }));
    for (let i = 0; i < 12 && f.service.health().pending; i++) await f.service.tick();
    assert.equal(f.service.health().pending, 0);
    const first = await catalog(f, [{ kind: 'ticket-index' }], owner, null, 1);
    assert.equal(first.entries.length, 1); assert.ok(first.nextPageToken);
    const page1 = JSON.parse(await object(f, first, first.entries[0]));
    assert.equal(page1.entries.length, 64); assert.ok(page1.nextPageToken);
    // Other status requests may replace idle versions, but an actively read
    // directory must retain its original objects/cursor across page boundaries.
    for (let i = 0; i < 10; i++) {
      await catalog(f, [{ kind: 'scheduler-format' }]);
      assert.deepEqual(JSON.parse(await object(f, first, first.entries[0])), page1);
    }
    const next = await catalog(f, [{ kind: 'ticket-index' }], owner, first, 1, page1.nextPageToken);
    const page2 = JSON.parse(await object(f, next, next.entries[0]));
    assert.equal(page2.entries.length, 1); assert.equal(page2.nextPageToken, null);
    assert.equal(new Set([...page1.entries, ...page2.entries].map(e => e.ticketId)).size, 65);
    const other = await catalog(f, [{ kind: 'ticket-index' }]);
    await denied(f, [{ kind: 'ticket-index' }], owner, other, first.nextPageToken);
    await denied(f, [{ kind: 'command-receipt-index' }], owner, first, first.nextPageToken);
    f.advance(60001);
    await denied(f, [{ kind: 'ticket-index' }], owner, first);
    await assert.rejects(f.send('projection.catalog', { requestId: randomUUID(), scope: scope(f), snapshotId: null, pageToken: null,
      selectors: [{ kind: 'ticket-index' }], limit: 65 }, undefined, owner), /INTEGER|RANGE|NUMBER/);
    assert.equal(f.service.health().stopped, false);
  } finally { await f.dispose(); }
});

test('owner ledger segments stop at frozen cutoff and preserve domain checksums', async () => {
  const f = await fixture();
  try {
    await f.open(); await f.observe(); await f.open(owner); await f.submit('ledger-one');
    const frozen = await catalog(f, [{ kind: 'scheduler-format' }]);
    await f.submit('ledger-two');
    const manifest = await catalog(f, [{ kind: 'ledger-index' }], owner, frozen);
    const directory = JSON.parse(await object(f, manifest, manifest.entries[0]));
    const events = [];
    for (const entry of directory.entries) {
      const partManifest = await catalog(f, [{ kind: 'ledger-segment', segmentId: entry.segmentId, fromSeq: entry.fromSeq, throughSeq: entry.throughSeq }], owner, frozen);
      const part = JSON.parse(await object(f, partManifest, partManifest.entries[0]));
      for (const event of part) require('../packages/scheduler/src/cloud/domain.cjs')('sched-ledger').assertLedgerChecksum(event);
      events.push(...part);
    }
    assert.equal(events.at(-1).seq, frozen.ledgerCursor.seq);
    assert.equal(events.at(-1).sha256, frozen.ledgerCursor.hash);
    assert.ok(events.every(event => event.seq <= frozen.ledgerCursor.seq));
  } finally { await f.dispose(); }
});

test('authenticated artifact discovery fetches exact referenced bytes, verifies whole hash and exposes log descriptor', async () => {
  const blobs = new Map();
  const reference = bytes => { const hash = createHash('sha256').update(bytes).digest('hex'); const ref = { objectId: hash, hash, size: bytes.length }; blobs.set(hash, bytes); return ref; };
  const f = await fixture({ transport(request, frame) {
    if (!['artifact.read', 'log.read'].includes(request.kind)) return;
    const bytes = blobs.get(request.payload.object.hash); assert.ok(bytes, 'no arbitrary file lookup');
    const chunk = bytes.subarray(request.payload.offset, request.payload.offset + request.payload.length);
    return frame(request.kind === 'log.read' ? 'log.chunk' : 'artifact.chunk', { ...request.payload,
      dataBase64: chunk.toString('base64'), chunkHash: createHash('sha256').update(chunk).digest('hex') }, request.execution);
  } });
  try {
    await f.open(); await f.observe(); await f.open(owner);
    const job = await f.submit('artifact', { execution: 'cluster' });
    for (let i = 0; i < 4; i++) await f.service.tick();
    await f.start(job.id);
    const zip = Buffer.from('synthetic zip bytes; never extracted'), log = Buffer.from('synthetic log\n'.repeat(12000));
    const manifestBytes = Buffer.from(JSON.stringify({ schema: 1, ticketId: job.id, attemptId: 'a1', machine: 'fixture-win',
      state: 'zipped', zip: `${job.id}--a1.zip`, zipBytes: zip.length, totalBytes: 7, files: [{ path: 'out.txt', bytes: 7 }], rejected: [], createdAt: f.now() }));
    const result = { ok: true, exitCode: 0, artifacts: { state: 'zipped', manifest: `${job.id}--a1.json`, zip: `${job.id}--a1.zip`, zipBytes: zip.length, totalBytes: 7, fileCount: 1 } };
    f.setJob('done', result, { artifactObjects: { state: 'ready', manifest: reference(manifestBytes), zip: reference(zip) }, log: reference(log) });
    await f.service.tick(); await f.service.tick(); await f.service.tick();
    const manifest = await catalog(f, [{ kind: 'execution-index', ticketId: job.id, attemptId: 'a1' }]);
    const directory = JSON.parse(await object(f, manifest, manifest.entries[0]));
    for (const [kind, expected] of [['artifact-zip', zip], ['artifact-manifest', manifestBytes], ['log-segment', log]]) {
      const entry = directory.entries.find(e => e.kind === kind); assert.ok(entry, kind);
      const selector = { kind, ticketId: job.id, attemptId: 'a1', ...(kind === 'log-segment' ? { segmentId: entry.segmentId } : {}) };
      const part = await catalog(f, [selector], owner, manifest);
      assert.deepEqual(await object(f, part, part.entries[0]), expected);
    }
    assert.ok(directory.entries.find(e => e.kind === 'log-descriptor'));
    assert.ok(f.sent.some(request => request.kind === 'artifact.read'));
  } finally { await f.dispose(); }
});
