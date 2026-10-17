'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const p = require('../protocol/contract.cjs');
const load = require('./domain.cjs');
const { atomicBytes, hashBytes, failure } = require('./storage.cjs');
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

function createObjects({ root, store, authority, epoch, state, now, catalog: configuration, ledgerIndex }) {
  const snapshots = new Map();
  const file = object => path.join(root, 'objects', object.hash.slice(0, 2), object.hash);
  function save(bytes) {
    if (bytes.length > MAX_OBJECT_BYTES) throw failure('READ_LIMIT', 'read object exceeds configured bound');
    const hash = hashBytes(bytes), ref = { objectId: hash, hash, size: bytes.length };
    atomicBytes(file(ref), bytes, true); return ref;
  }
  function bytes(ref) {
    if (!/^[a-f0-9]{64}$/.test(ref.hash)) throw failure('IO_FAILURE', 'object hash');
    const stat = fs.lstatSync(file(ref));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== ref.size || stat.size > MAX_OBJECT_BYTES) throw failure('IO_FAILURE', 'immutable object size or file type changed');
    const result = fs.readFileSync(file(ref));
    if (result.length !== ref.size || hashBytes(result) !== ref.hash) throw failure('IO_FAILURE', 'immutable object damaged');
    return result;
  }
  const allowed = (principal, audience, kind) => {
    const access = principal.readAccess;
    if (access?.role === 'owner') return true;
    if (principal.role !== 'windows' || access?.role !== 'node' || ['ledger-index', 'ledger-segment'].includes(kind)) return false;
    if (audience.kind === 'authority') return access.authorityKinds.includes(kind);
    if (audience.kind === 'owner') return false;
    return access.projects.includes(audience.project) && (audience.kind !== 'machine-project' || access.machine === audience.machine);
  };
  function expire() {
    for (const [key, value] of snapshots) if (value.expiresAt <= now()) snapshots.delete(key);
  }
  function freeze(principal) {
    expire();
    if (snapshots.size >= 8) throw failure('READ_LIMIT', 'read snapshot capacity reached; retry after expiry');
    const current = state(), snapshotId = randomUUID();
    const cursor = { seq: current.cursor.seq, hash: current.cursor.sha256 };
    const frozen = { principalId: principal.id, snapshotId, ledgerCursor: cursor, issuedAt: now(),
      expiresAt: new Date(Date.parse(now()) + 60000).toISOString(), entries: [], pages: new Map() };
    function add(selector, body, audience, contentType = 'application/json') {
      if (!allowed(principal, audience, selector.kind)) return;
      if (frozen.entries.length >= 16384) throw failure('READ_LIMIT', 'read snapshot entry capacity exceeded');
      const ref = Buffer.isBuffer(body) ? save(body) : save(Buffer.from(JSON.stringify(body)));
      const object = { ...ref, objectId: p.contentHash([snapshotId, selector, frozen.entries.length, ref.hash]) };
      const entry = { ...selector, snapshotId, ledgerCursor: cursor, object, audience, contentType };
      frozen.entries.push(entry); return entry;
    }
    const c = load('sched-contract'), paths = c.schedPaths(path.dirname(root));
    // Freeze local projections only. Transport fetches exactly the requested
    // objects/chunks; no ledger/ticket directory is pushed to a node each tick.
    for (const ticket of Object.values(current.tickets)) {
      const audience = { kind: 'project', project: ticket.request.project };
      const checked = load('sched-tickets').readTicketSnapshot(path.dirname(root), ticket.ticketId);
      const projected = checked.status === 'ok' ? checked.value : null;
      if (!projected || projected.lastSeq !== ticket.lastSeq) throw failure('IO_FAILURE', 'ticket projection is not current');
      add({ kind: 'ticket', ticketId: ticket.ticketId }, projected, audience);
      for (const attempt of ticket.attempts) {
        const extra = store.get('execution-objects', [ticket.ticketId, attempt.attemptId]) ?? {};
        for (const [kind, object] of Object.entries(extra)) {
          if (!object || !p.READ_KINDS.includes(kind) || !allowed(principal, audience, kind)) continue;
          if (frozen.entries.length >= 16384) throw failure('READ_LIMIT', 'read snapshot entry capacity exceeded');
          frozen.entries.push({ kind, ticketId: ticket.ticketId, attemptId: attempt.attemptId,
            snapshotId, ledgerCursor: cursor, object: { ...object, objectId: p.contentHash([snapshotId, ticket.ticketId, attempt.attemptId, kind, object.hash]) }, audience,
            contentType: kind === 'artifact-zip' ? 'application/zip' : kind === 'log-segment' ? 'text/plain' : 'application/json',
            ...(kind === 'log-segment' ? { segmentId: 'complete' } : {}) });
        }
        const segments = frozen.entries.filter(e => e.kind === 'log-segment' && e.ticketId === ticket.ticketId && e.attemptId === attempt.attemptId);
        if (segments.length) add({ kind: 'log-descriptor', ticketId: ticket.ticketId, attemptId: attempt.attemptId },
          { schema: 1, ticketId: ticket.ticketId, attemptId: attempt.attemptId, snapshotId, ledgerCursor: cursor,
            encoding: 'utf-8', totalBytes: segments.reduce((n, e) => n + e.object.size, 0), segments, nextPageToken: null }, audience);
        const metadata = store.get('snapshot', [ticket.ticketId, attempt.attemptId]);
        if (metadata) add({ kind: 'snapshot-metadata', ticketId: ticket.ticketId, attemptId: attempt.attemptId }, metadata, audience);
      }
    }
    for (const entry of Object.values(current.commands)) if (entry.receipt) {
      const ticket = current.tickets[entry.request.data.ticketId];
      add({ kind: 'command-receipt', commandId: entry.request.commandId }, entry.receipt,
        ticket ? { kind: 'project', project: ticket.request.project } : { kind: 'owner' });
    }
    const control = c.schedControlPaths(path.dirname(root));
    const known = [
      ['scheduler-format', paths.format], ['dispatcher-config', control.dispatcher], ['dispatcher-heartbeat', control.heartbeat],
      ['hub-switch', path.join(paths.control, 'hub.json')], ['ci-policy', path.join(paths.control, 'ci-policy.json')],
    ];
    for (const [kind, location] of known) {
      if (!allowed(principal, { kind: 'authority' }, kind)) continue;
      try { add({ kind }, JSON.parse(fs.readFileSync(location, 'utf8')), { kind: 'authority' }); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (kind === 'hub-switch') add({ kind }, load('sched-hub-switch-reader').createHubSwitchReader({ share: path.dirname(root) }).read(), { kind: 'authority' });
        if (kind === 'ci-policy') add({ kind }, { formatVersion: 1, mode: load('sched-ci-policy').CI_POLICY_DEFAULT }, { kind: 'authority' });
      }
    }
    for (const [view, location] of [['config', path.join(paths.control, 'memory-floor.json')], ['state', path.join(paths.root, 'memory-floor', 'state.json')]]) {
      try { add({ kind: 'memory-floor', view }, JSON.parse(fs.readFileSync(location, 'utf8')), { kind: 'authority' }); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (view === 'config') add({ kind: 'memory-floor', view }, { formatVersion: 1, ...load('sched-memory-floor').createMemoryFloorConfigReader({ share: path.dirname(root) }).read() }, { kind: 'authority' });
      }
    }
    for (const project of configuration.projects.map(project => project.id)) {
      const audience = { kind: 'project', project };
      if (!allowed(principal, audience, 'usage-history')) continue;
      const headFile = project === configuration.legacyProjectId ? path.join(path.dirname(root), 'code-head.txt') : path.join(paths.root, 'repos', `${project}.head`);
      try {
        const head = fs.readFileSync(headFile, 'utf8').split(/\r?\n/, 1)[0].trim();
        if (!/^[a-f0-9]{40}$/.test(head)) throw failure('IO_FAILURE', 'project head corrupt');
        add({ kind: 'project-trunk-head', project }, head, audience);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const usage = load('sched-usage-history');
      let history;
      try { history = JSON.parse(fs.readFileSync(usage.usageStatsPath(path.dirname(root)), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; history = { formatVersion: 1, groups: {} }; }
      if (history.formatVersion !== 1 || !history.groups || Array.isArray(history.groups)) throw failure('IO_FAILURE', 'usage history corrupt');
      add({ kind: 'usage-history', project }, { formatVersion: 1,
        groups: Object.fromEntries(Object.entries(history.groups).map(([key, entries]) => [key, entries.filter(e => e.project === project)]).filter(([, entries]) => entries.length)) }, audience);
      const overuse = Object.values(current.tickets).filter(t => t.request.project === project).flatMap(t => {
        const body = JSON.parse(fs.readFileSync(path.join(paths.tickets, `${t.ticketId}.json`), 'utf8'));
        return body.overuse ? [{ ...body.overuse, ticketId: t.ticketId }] : [];
      });
      add({ kind: 'managed-overuse', project }, { formatVersion: 1, at: now(), tickets: overuse }, audience);
    }
    frozen.add = add;
    snapshots.set(snapshotId, frozen); return frozen;
  }
  function ledgerPage(frozen) {
    // One request materializes at most 128 original events. The immutable
    // directory's continuation fetches the next page, never the whole ledger.
    const scan = frozen.ledgerScan ??= { seq: 0, pages: 0 };
    if (scan.pages && scan.seq === frozen.ledgerCursor.seq) return;
    const batch = [];
    for (let i = 0; i < 128 && scan.seq < frozen.ledgerCursor.seq; i++) batch.push(ledgerIndex.read(++scan.seq, frozen.ledgerCursor));
    const entries = batch.length ? [frozen.add({ kind: 'ledger-segment', segmentId: `seq-${batch[0].seq}`,
      fromSeq: batch[0].seq, throughSeq: batch.at(-1).seq }, batch, { kind: 'owner' })] : [];
    const nextPageToken = scan.seq < frozen.ledgerCursor.seq ? randomUUID() : null;
    scan.pages++;
    if (nextPageToken) {
      if (frozen.pages.size >= 4096) throw failure('READ_LIMIT', 'page bound exceeded');
      frozen.pages.set(nextPageToken, { selectorHash: p.contentHash([{ kind: 'ledger-index' }]), offset: scan.pages, ledger: true });
    }
    const body = { schema: 1, snapshotId: frozen.snapshotId, ledgerCursor: frozen.ledgerCursor, entries, nextPageToken };
    p.validateObjectDirectory(body); frozen.add({ kind: 'ledger-index' }, body, { kind: 'owner' });
  }
  function directory(frozen, selector) {
    const kinds = { 'ticket-index': ['ticket'], 'command-receipt-index': ['command-receipt'],
      'execution-index': ['snapshot-metadata', 'artifact-manifest', 'artifact-zip', 'log-descriptor', 'log-segment', 'job-result'] };
    if (!kinds[selector.kind]) return;
    if (frozen.entries.some(e => Object.keys(selector).every(k => e[k] === selector[k]))) return;
    const all = frozen.entries.filter(e => kinds[selector.kind].includes(e.kind)
      && (!selector.ticketId || e.ticketId === selector.ticketId && e.attemptId === selector.attemptId));
    // Directory pages are themselves immutable objects; their cursor names are
    // opaque and are valid only through this snapshot's catalog.
    for (let offset = 0; offset < Math.max(1, all.length); offset += 64) {
      const nextPageToken = offset + 64 < all.length ? randomUUID() : null;
      if (nextPageToken) {
        if (frozen.pages.size >= 4096) throw failure('READ_LIMIT', 'page bound exceeded');
        frozen.pages.set(nextPageToken, { selectorHash: p.contentHash([selector]), offset: offset / 64 + 1 });
      }
      const body = { schema: 1, snapshotId: frozen.snapshotId, ledgerCursor: frozen.ledgerCursor,
        entries: all.slice(offset, offset + 64), nextPageToken };
      p.validateObjectDirectory(body);
      const audience = selector.kind === 'ledger-index' ? { kind: 'owner' } : selector.kind === 'execution-index'
        ? all[0]?.audience ?? { kind: 'owner' } : { kind: 'owner' };
      // A node's index contains only already-authorized entries. It receives a
      // project audience, never an authority audience for ticket metadata.
      const access = authority.principals.find(x => x.id === frozen.principalId)?.readAccess;
      const nodeAudience = access?.role === 'node' ? { kind: 'project', project: access.projects[0] } : audience;
      frozen.add(selector, body, nodeAudience);
    }
  }
  function catalog(principal, request) {
    const q = request.payload;
    expire();
    const frozen = q.snapshotId === null ? freeze(principal) : snapshots.get(q.snapshotId);
    if (!frozen || frozen.principalId !== principal.id) throw failure('FENCED', 'read version expired or belongs to another principal');
    for (const selector of q.selectors) {
      if (selector.kind.startsWith('ledger-')) {
        if (principal.readAccess?.role !== 'owner') throw failure('FENCED', 'owner-only ledger');
        if (selector.kind === 'ledger-index') {
          const continuation = q.pageToken && frozen.pages.get(q.pageToken);
          if (!frozen.ledgerScan || continuation?.ledger && continuation.offset === frozen.ledgerScan.pages) ledgerPage(frozen);
        } else if (!frozen.entries.some(e => Object.keys(selector).every(key => e[key] === selector[key]))) {
          if (selector.throughSeq < selector.fromSeq || selector.throughSeq - selector.fromSeq >= 128
            || selector.throughSeq > frozen.ledgerCursor.seq) throw failure('READ_LIMIT', 'ledger range exceeds bounded cutoff');
          const events = [];
          for (let seq = selector.fromSeq; seq <= selector.throughSeq; seq++) events.push(ledgerIndex.read(seq, frozen.ledgerCursor));
          frozen.add(selector, events, { kind: 'owner' });
        }
      }
      if (selector.ticketId) {
        const entry = frozen.entries.find(e => e.kind === 'ticket' && e.ticketId === selector.ticketId);
        if (!entry) throw failure('FENCED', 'ticket is outside read access');
      }
      if (selector.project && principal.readAccess?.role === 'node' && !principal.readAccess.projects.includes(selector.project)) throw failure('FENCED', 'project denied');
      directory(frozen, selector);
    }
    const selected = frozen.entries.filter(e => q.selectors.some(s => Object.keys(s).every(k => e[k] === s[k])));
    const selectorHash = p.contentHash(q.selectors);
    let offset = 0;
    if (q.pageToken !== null) {
      const page = frozen.pages.get(q.pageToken);
      if (!page || page.selectorHash !== selectorHash) throw failure('FENCED', 'page cursor mismatch');
      offset = page.offset;
    }
    const nextPageToken = offset + q.limit < selected.length ? randomUUID() : null;
    if (nextPageToken) {
      if (frozen.pages.size >= 4096) throw failure('READ_LIMIT', 'page bound exceeded');
      frozen.pages.set(nextPageToken, { selectorHash, offset: offset + q.limit });
    }
    const manifest = { requestId: q.requestId, scope: q.scope, snapshotId: frozen.snapshotId, ledgerCursor: frozen.ledgerCursor,
      issuedAt: frozen.issuedAt, expiresAt: frozen.expiresAt, entries: selected.slice(offset, offset + q.limit), nextPageToken };
    p.validateReadManifest(manifest); return manifest;
  }
  function read(principal, request) {
    expire(); const q = request.payload, frozen = snapshots.get(q.snapshotId);
    if (!frozen || frozen.principalId !== principal.id) throw failure('FENCED', 'read version expired');
    const entry = frozen.entries.find(e => p.canonicalJson(e) === p.canonicalJson(q.entry));
    if (!entry) throw failure('FENCED', 'object not in fixed snapshot');
    const manifest = { requestId: q.requestId, scope: q.scope, snapshotId: q.snapshotId, ledgerCursor: frozen.ledgerCursor,
      issuedAt: frozen.issuedAt, expiresAt: frozen.expiresAt, entries: [entry], nextPageToken: null };
    const checked = p.authorizeProjectionRead(q, manifest, { principal, authorityId: authority.id, authorityEpoch: epoch, now: now(), maxObjectBytes: MAX_OBJECT_BYTES });
    if (!checked.allowed) throw failure('FENCED', checked.reason);
    const chunk = bytes(entry.object).subarray(q.offset, q.offset + q.length);
    return { ...q, dataBase64: chunk.toString('base64'), chunkHash: hashBytes(chunk) };
  }
  function queue(item) {
    const key = p.contentHash([item.key, item.kind, item.ref]);
    const pending = store.get('meta', 'downloads') ?? [];
    if (pending.includes(key)) return;
    if (pending.length >= 128) throw failure('IO_FAILURE', 'object fetch queue full');
    store.commit(store.revision(), [{ table: 'download-items', key, value: item },
      { table: 'meta', key: 'downloads', value: pending.concat(key) }]);
  }
  return {
    save, bytes, catalog, read, maxObjectBytes: MAX_OBJECT_BYTES,
    snapshotSize(ticket) {
      const key = [ticket.ticketId, ticket.currentAttemptId], metadata = store.get('snapshot', key);
      const object = store.get('execution-objects', key)?.['snapshot-bundle'];
      if (metadata?.state !== 'ready' || !object || object.hash !== metadata.object.hash) throw failure('DISCONNECTED', 'snapshot bytes not verified');
      return bytes(object).length;
    },
    directRead(principal, envelope) {
      const e = envelope.execution, q = envelope.payload;
      const ticket = state().tickets[e.ticketId];
      if (!ticket || !allowed(principal, { kind: 'project', project: ticket.request.project }, 'job-result')) throw failure('FENCED', 'object project denied');
      const aliases = store.get('object-alias', [e.ticketId, e.attemptId, q.object.objectId]);
      const known = store.get('execution-objects', [e.ticketId, e.attemptId]) ?? {};
      const ref = aliases && p.canonicalJson(aliases.remote) === p.canonicalJson(q.object) ? aliases.local
        : Object.values(known).find(ref => p.canonicalJson(ref) === p.canonicalJson(q.object));
      if (!ref) throw failure('FENCED', 'object was not verified for this execution');
      if (envelope.kind === 'log.read' && known['log-segment']?.hash !== ref.hash) throw failure('FENCED', 'not a log object');
      const chunk = bytes(ref).subarray(q.offset, q.offset + q.length);
      return { ...q, dataBase64: chunk.toString('base64'), chunkHash: hashBytes(chunk) };
    },
    registerSnapshot(envelope) {
      if (envelope.payload.state !== 'ready') return;
      const key = [envelope.execution.ticketId, envelope.execution.attemptId];
      queue({ key, kind: 'snapshot-bundle', ref: envelope.payload.object, nodeId: envelope.nodeId, execution: envelope.execution });
    },
    registerObservation(ticket, envelope) {
      const q = envelope.payload, key = [ticket.ticketId, ticket.currentAttemptId];
      const current = store.get('execution-objects', key) ?? {};
      if (q.result && !q.resultObject) current['job-result'] = save(Buffer.from(JSON.stringify(q.result)));
      store.put('execution-objects', key, current);
      for (const [kind, ref] of Object.entries({ ...(q.resultObject ? { 'job-result': q.resultObject } : {}),
        ...(q.log ? { 'log-segment': q.log } : {}),
        ...(q.artifactObjects?.state === 'ready' ? { 'artifact-manifest': q.artifactObjects.manifest, 'artifact-zip': q.artifactObjects.zip } : {}) })) {
        if (!ref) continue;
        if (current[kind]?.hash === ref.hash) continue;
        queue({ key, kind, ref, nodeId: envelope.nodeId, execution: envelope.execution });
      }
    },
    async pump(fetch, commit) {
      let remaining = 8 * 131072;
      for (const key of store.get('meta', 'downloads') ?? []) {
        const item = store.get('download-items', key);
        if (!item) throw failure('IO_FAILURE', 'download index missing');
        if (item.ref.size > MAX_OBJECT_BYTES) throw failure('IO_FAILURE', 'remote object exceeds bound');
        let progress = store.get('downloads', key) ?? { offset: 0, chunks: [] };
        const total = item.ref.size;
        for (let offset = progress.offset; offset < total && remaining > 0;) {
          const length = Math.min(131072, total - offset, remaining);
          let reply;
          try { reply = await fetch(item, { requestId: randomUUID(), object: item.ref, offset, length }); }
          catch (error) { if (['DISCONNECTED', 'TIMEOUT', 'FENCED'].includes(error.code)) return; throw error; }
          if (reply.kind === 'result') return;
          const chunk = Buffer.from(reply.payload.dataBase64, 'base64');
          if (reply.kind !== (item.kind === 'log-segment' ? 'log.chunk' : 'artifact.chunk') || chunk.length !== length) throw failure('IO_FAILURE', 'chunk unavailable');
          offset += length; remaining -= length;
          commit(() => {
            progress = { offset, chunks: progress.chunks.concat(save(chunk)) };
            store.put('downloads', key, progress);
          });
        }
        if (progress.offset < total) break;
        const data = Buffer.concat(progress.chunks.map(bytes));
        if (data.length !== total || hashBytes(data) !== item.ref.hash) throw failure('IO_FAILURE', 'remote whole-object hash mismatch');
        if (item.kind === 'job-result') {
          const { suspension, ...result } = JSON.parse(data.toString('utf8'));
          p.validateJobResult(result);
          if (suspension !== undefined) {
            if (suspension.ticketId !== item.key[0] || suspension.attemptId !== item.key[1] || suspension.token !== item.execution.permitToken) throw failure('IO_FAILURE', 'suspension result identity');
            load('sched-contract').validateSuspensionObservation(load('sched-suspend-store').recordObservation(suspension));
          }
        }
        if (item.kind === 'artifact-manifest') {
          const body = JSON.parse(data.toString('utf8'));
          if (body.schema !== 1 || body.ticketId !== item.key[0] || body.attemptId !== item.key[1] || !Array.isArray(body.files) || !Array.isArray(body.rejected)) throw failure('IO_FAILURE', 'artifact manifest identity');
          for (const entry of body.files) if (typeof entry.path !== 'string' || path.isAbsolute(entry.path) || /^[A-Za-z]:/.test(entry.path) || entry.path.split(/[\\/]/).includes('..')) throw failure('IO_FAILURE', 'artifact manifest path');
        }
        commit(() => {
          const object = save(data), prior = store.get('execution-objects', item.key) ?? {};
          store.commit(store.revision(), [
            { table: 'execution-objects', key: item.key, value: { ...prior, [item.kind]: object } },
            { table: 'object-alias', key: [...item.key, item.ref.objectId], value: { remote: item.ref, local: object } },
            { table: 'meta', key: 'downloads', value: (store.get('meta', 'downloads') ?? []).filter(value => value !== key) },
          ]);
        });
      }
    },
  };
}
module.exports = { createObjects, MAX_OBJECT_BYTES };
