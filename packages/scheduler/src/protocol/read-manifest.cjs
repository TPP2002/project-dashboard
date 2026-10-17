'use strict';
const { createHash } = require('node:crypto');
const s = require('./schema.cjs');
const { fail, canonicalJson, ProtocolValidationError } = require('./json.cjs');
const READ_KINDS = Object.freeze(['ticket-index', 'ticket', 'scheduler-format', 'dispatcher-config', 'dispatcher-heartbeat',
  'command-receipt-index', 'command-receipt', 'ledger-index', 'ledger-segment', 'hub-switch', 'ci-policy', 'memory-floor',
  'managed-overuse', 'usage-history', 'project-trunk-head', 'execution-index', 'snapshot-metadata', 'snapshot-bundle', 'artifact-manifest', 'artifact-zip', 'log-descriptor', 'log-segment', 'job-result']);
const SHARED_READ_KINDS = Object.freeze(['scheduler-format', 'dispatcher-config', 'dispatcher-heartbeat', 'hub-switch', 'ci-policy', 'memory-floor']);
const OWNER_ONLY_READ_KINDS = Object.freeze(['ledger-index', 'ledger-segment']);
const objectRef = s.fields({ objectId: s.id, hash: s.hash, size: s.count });
const cursor = (v, p) => { s.fields({ seq: s.count, hash: s.nullable(s.hash) })(v, p); if ((v.seq === 0) !== (v.hash === null)) fail('CURSOR', p); };
const readScope = s.fields({ kind: s.enumeration(['authority-read']), authorityId: s.id, authorityEpoch: s.positive });
const executionKinds = ['execution-index', 'snapshot-metadata', 'snapshot-bundle', 'artifact-manifest', 'artifact-zip', 'log-descriptor', 'log-segment', 'job-result'];
function selectorFields(kind) {
  if (kind === 'memory-floor') return { view: s.enumeration(['config', 'state']) };
  if (kind === 'ticket') return { ticketId: s.ticketId };
  if (kind === 'command-receipt') return { commandId: s.segment };
  if (['project-trunk-head', 'usage-history', 'managed-overuse'].includes(kind)) return { project: s.text(128) };
  if (executionKinds.includes(kind)) return { ticketId: s.ticketId, attemptId: s.attemptId, ...(kind === 'log-segment' ? { segmentId: s.id } : {}) };
  if (kind === 'ledger-segment') return { segmentId: s.id, fromSeq: s.positive, throughSeq: s.positive };
  return {};
}
const selector = (v, p) => { s.enumeration(READ_KINDS)(v?.kind, `${p}.kind`); s.fields({ kind: s.enumeration([v.kind]), ...selectorFields(v.kind) })(v, p); };
const audience = (v, p) => {
  s.enumeration(['owner', 'authority', 'project', 'machine-project'])(v?.kind, `${p}.kind`);
  s.fields({ kind: s.enumeration([v.kind]), ...(['project', 'machine-project'].includes(v.kind) ? { project: s.text(128) } : {}),
    ...(v.kind === 'machine-project' ? { machine: s.segment } : {}) })(v, p);
};
const entry = (v, p) => {
  s.enumeration(READ_KINDS)(v?.kind, `${p}.kind`);
  s.fields({ kind: s.enumeration([v.kind]), ...selectorFields(v.kind), snapshotId: s.id, ledgerCursor: cursor,
    object: objectRef, audience, contentType: s.enumeration(['application/json', 'application/x-ndjson', 'application/zip', 'application/octet-stream', 'text/plain']),
  })(v, p);
  if (OWNER_ONLY_READ_KINDS.includes(v.kind) && v.audience.kind !== 'owner') fail('READ_OWNER_ONLY', p);
  if (v.audience.kind === 'authority' && !SHARED_READ_KINDS.includes(v.kind)) fail('READ_NOT_SHARED', p);
  if (!OWNER_ONLY_READ_KINDS.includes(v.kind) && !SHARED_READ_KINDS.includes(v.kind) && !['owner', 'project', 'machine-project'].includes(v.audience.kind)) fail('READ_AUDIENCE', p);
  if (v.project !== undefined && v.audience.project !== undefined && v.project !== v.audience.project) fail('READ_PROJECT', p);
  if (v.kind === 'ledger-segment' && (v.fromSeq > v.throughSeq || v.throughSeq > v.ledgerCursor.seq)) fail('LEDGER_CUTOFF', p);
};
const catalog = (v, p) => {
  s.fields({ requestId: s.id, scope: readScope, snapshotId: s.nullable(s.id), pageToken: s.nullable(s.id),
    selectors: s.list(selector, 1, 32, true), limit: s.integer(1, 64) },
  { knownObjects: s.list(s.fields({ objectId: s.id, hash: s.hash }), 0, 64) })(v, p);
  if (v.pageToken !== null && v.snapshotId === null) fail('PAGE_SNAPSHOT_REQUIRED', p);
};
const manifest = (v, p) => {
  s.fields({ requestId: s.id, scope: readScope, snapshotId: s.id, ledgerCursor: cursor, issuedAt: s.iso, expiresAt: s.iso,
    entries: s.list(entry, 0, 64), nextPageToken: s.nullable(s.id) })(v, p);
  if (v.expiresAt <= v.issuedAt) fail('MANIFEST_EXPIRY', p);
  const keys = new Set();
  for (const e of v.entries) {
    if (e.snapshotId !== v.snapshotId || canonicalJson(e.ledgerCursor) !== canonicalJson(v.ledgerCursor) || keys.has(e.object.objectId)) fail('MANIFEST_VERSION', p);
    keys.add(e.object.objectId);
  }
};
const directory = (v, p) => {
  s.fields({ schema: s.enumeration([1]), snapshotId: s.id, ledgerCursor: cursor,
    entries: s.list(entry, 0, 64), nextPageToken: s.nullable(s.id) })(v, p);
  const keys = new Set();
  for (const e of v.entries) {
    if (e.snapshotId !== v.snapshotId || canonicalJson(e.ledgerCursor) !== canonicalJson(v.ledgerCursor) || keys.has(e.object.objectId)) fail('MANIFEST_VERSION', p);
    keys.add(e.object.objectId);
  }
};
const read = (v, p) => {
  s.fields({ requestId: s.id, scope: readScope, snapshotId: s.id, ledgerCursor: cursor, entry,
    offset: s.count, length: s.integer(1, 131072) })(v, p);
  if (v.entry.snapshotId !== v.snapshotId || canonicalJson(v.entry.ledgerCursor) !== canonicalJson(v.ledgerCursor)) fail('MANIFEST_VERSION', p);
  if (v.offset > v.entry.object.size || v.length > v.entry.object.size - v.offset) fail('OBJECT_RANGE', p);
};
const localRead = (v, p) => {
  s.fields({ kind: s.enumeration(['read-object']), callId: s.id, snapshotId: s.id, ledgerCursor: cursor, entry,
    offset: s.count, length: s.integer(1, 131072) })(v, p);
  if (v.entry.snapshotId !== v.snapshotId || canonicalJson(v.entry.ledgerCursor) !== canonicalJson(v.ledgerCursor)) fail('MANIFEST_VERSION', p);
  if (v.offset > v.entry.object.size || v.length > v.entry.object.size - v.offset) fail('OBJECT_RANGE', p);
};
const chunk = (v, p) => {
  s.fields({ requestId: s.id, scope: readScope, snapshotId: s.id, ledgerCursor: cursor, entry,
    offset: s.count, length: s.integer(1, 131072), dataBase64: s.text(174764), chunkHash: s.hash })(v, p);
  const { dataBase64, chunkHash, ...request } = v; read(request, p);
  const raw = Buffer.from(dataBase64, 'base64');
  if (raw.toString('base64') !== dataBase64 || raw.length !== v.length || createHash('sha256').update(raw).digest('hex') !== chunkHash) fail('CHUNK_HASH', p);
};
function validateReadManifest(v) { return s.validate(manifest, v); }
function authorizeReadEntry(e, principal) {
  if (principal?.readAccess?.role === 'owner') return true;
  const a = principal?.readAccess;
  if (!a || a.role !== 'node' || principal.role !== 'windows') return false;
  if (e.audience.kind === 'owner') return false;
  if (e.audience.kind === 'authority') return SHARED_READ_KINDS.includes(e.kind) && a.authorityKinds.includes(e.kind);
  return a.projects.includes(e.audience.project) && (e.audience.kind === 'project' || e.audience.machine === a.machine && principal.machines.includes(a.machine));
}
// m is cloud's stored immutable manifest, NOT a manifest supplied by the requester.
function authorizeProjectionRead(input, storedManifest, context) {
  try {
    const request = s.validate(read, input), m = validateReadManifest(storedManifest);
    s.iso(context.now);
    if (Date.parse(context.now) < Date.parse(m.issuedAt) || Date.parse(context.now) >= Date.parse(m.expiresAt)) fail('MANIFEST_EXPIRED');
    if (m.scope.authorityId !== context.authorityId || m.scope.authorityEpoch !== context.authorityEpoch ||
      canonicalJson(request.scope) !== canonicalJson(m.scope) || request.snapshotId !== m.snapshotId ||
      canonicalJson(request.ledgerCursor) !== canonicalJson(m.ledgerCursor)) fail('MANIFEST_VERSION');
    const found = m.entries.find(e => e.object.objectId === request.entry.object.objectId);
    if (!found || canonicalJson(found) !== canonicalJson(request.entry)) fail('MANIFEST_ENTRY_MISSING');
    if (!authorizeReadEntry(found, context.principal)) fail('READ_DENIED');
    return { allowed: true, entry: found };
  } catch (error) {
    if (error instanceof ProtocolValidationError || error instanceof TypeError) return { allowed: false, reason: error.code ?? 'READ_CONTEXT_UNKNOWN' };
    throw error;
  }
}
function verifyProjectionObject(bytes, entryInput, storedManifest, context) {
  const e = s.validate(entry, entryInput);
  if (!(bytes instanceof Uint8Array)) fail('OBJECT_BYTES');
  // Authorize zero-byte objects via a manifest membership check without inventing a positive read range.
  const m = validateReadManifest(storedManifest); s.iso(context.now);
  if (!m.entries.some(x => canonicalJson(x) === canonicalJson(e)) || e.snapshotId !== m.snapshotId ||
    m.scope.authorityId !== context.authorityId || m.scope.authorityEpoch !== context.authorityEpoch ||
    Date.parse(context.now) < Date.parse(m.issuedAt) || Date.parse(context.now) >= Date.parse(m.expiresAt) || !authorizeReadEntry(e, context.principal)) fail('READ_DENIED');
  s.positive(context.maxObjectBytes);
  if (e.object.size > context.maxObjectBytes || bytes.byteLength !== e.object.size || createHash('sha256').update(bytes).digest('hex') !== e.object.hash) fail('OBJECT_HASH_OR_SIZE');
  return { bytes: new Uint8Array(bytes), snapshotId: m.snapshotId, ledgerCursor: m.ledgerCursor, kind: e.kind, domainValidated: false };
}
function dispatcherCompatibilityIdentity(input) {
  s.validate(s.fields({ authorityHost: s.id, ownerMachine: s.segment, authorityPid: s.pid, protocol: s.positive, head: s.sha1, createdAt: s.iso, createdBy: s.text(256) }), input);
  return { authorityHost: input.authorityHost, ownerMachine: input.ownerMachine,
    dispatcherConfig: { machine: input.ownerMachine, createdAt: input.createdAt, createdBy: input.createdBy },
    heartbeatIdentity: { machine: input.ownerMachine, pid: input.authorityPid, protocol: input.protocol, head: input.head } };
}
module.exports = { READ_KINDS, SHARED_READ_KINDS, OWNER_ONLY_READ_KINDS, selector, catalog, manifest, read, chunk, localRead,
  validateReadManifest, authorizeProjectionRead, verifyProjectionObject, dispatcherCompatibilityIdentity };
module.exports.validateObjectDirectory = input => s.validate(directory, input);
