'use strict';
const { createHash } = require('node:crypto');
const p = require('../../src/protocol/contract.cjs');
const f = require('./messages.cjs');
// Original TicketSnapshot bodies, not a second UI DTO. All identities/times are synthetic.
const tickets = [], ledger = [];
function event(type, ticketId, data) {
  const value = { v: 1, seq: ledger.length + 1, at: f.at, type, ticketId, attemptId: 'a1', data };
  value.sha256 = p.contentHash(value); ledger.push(value); return value;
}
for (const mode of ['queued', 'unsatisfiable', 'granted', 'register-only', 'resident', 'passed', 'cancelled']) {
  const request = f.copy(f.payloads.submission); request.idempotencyKey = `synthetic-read-${mode}`;
  if (mode === 'register-only') { request.category = 'codex-build'; request.requestedCores = 0; delete request.execution; }
  if (mode === 'resident') { request.resident = true; request.category = 'other'; delete request.execution; }
  const id = `tk-${p.contentHash([request.project, request.idempotencyKey]).slice(0, 20)}`;
  const timing = { queuedMs: 0, runningMs: 0, pausedMs: 0, slowMs: 0 };
  const timeline = [event('submitted', id, { request, contentHash: p.contentHash(request) })];
  const attempt = { attemptId: 'a1', queuedAt: f.at, startedAt: mode === 'register-only' ? f.at : null, endedAt: null,
    grantedCores: 0, permit: null, intent: null, dispatchedAt: null, codeRef: null, result: null, timing, segments: [] };
  if (!['queued', 'unsatisfiable', 'register-only'].includes(mode)) {
    attempt.grantedCores = 2; attempt.permit = { ticketId: id, attemptId: 'a1', token: `synthetic-permit-${mode}`, machine: f.machine,
      category: request.category, grantedCores: 2, issuedAt: f.at, ...(mode === 'resident' ? { resident: true } : {}) };
    timeline.push(event('granted', id, { permit: attempt.permit }));
  }
  if (mode === 'unsatisfiable') timeline.push(event('marked-unsatisfiable', id, { reason: 'synthetic capacity unavailable' }));
  if (mode === 'passed' || mode === 'cancelled') {
    attempt.startedAt = f.at; attempt.endedAt = f.at; attempt.codeRef = request.codeRef;
    attempt.controller = { machine: f.machine, ...f.execution.controller };
    timeline.push(event('started', id, { codeRef: request.codeRef, controller: attempt.controller }));
    timeline.push(event('finished', id, { result: mode, reason: 'synthetic completion', terminal: true, exitCode: 0 }));
    attempt.result = { outcome: mode, reason: 'synthetic completion', exitCode: 0 };
  }
  const terminal = ['passed', 'cancelled'].includes(mode);
  const state = mode === 'register-only' ? 'running' : mode === 'resident' ? 'granted' : mode;
  tickets.push({ formatVersion: 1, ticketId: id, request, contentHash: p.contentHash(request), state,
    registerOnly: mode === 'register-only', pauseReasons: [], cancelRequested: false, currentAttemptId: 'a1', attempts: [attempt],
    band: 0, queuedAt: f.at, createdAt: f.at, updatedAt: f.at, endedAt: terminal ? f.at : null,
    unsatisfiableReason: mode === 'unsatisfiable' ? 'synthetic capacity unavailable' : null,
    accountedAt: f.at, pendingQueue: null, timing, lastSeq: timeline.at(-1).seq, timeline });
}
const ledgerCursor = { seq: ledger.at(-1).seq, hash: ledger.at(-1).sha256 }, snapshotId = 'synthetic-directory-1';
const bodies = new Map();
function object(kind, body, fields = {}, audience = { kind: 'project', project: 'synthetic-project' }) {
  // The full domain object is not a frame and may exceed the frame's JSON limits.
  const bytes = Buffer.from(JSON.stringify(body)), objectId = `synthetic-${kind}-${bodies.size}`;
  bodies.set(objectId, bytes);
  return { kind, ...fields, snapshotId, ledgerCursor, object: { objectId, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length },
    audience, contentType: 'application/json' };
}
const ticketEntries = tickets.map(ticket => object('ticket', ticket, { ticketId: ticket.ticketId }));
const ticketIndex = object('ticket-index', { schema: 1, snapshotId, ledgerCursor, entries: ticketEntries, nextPageToken: null });
const emptyIndex = object('ticket-index', { schema: 1, snapshotId, ledgerCursor, entries: [], nextPageToken: null }, {}, { kind: 'owner' });
const heartbeat = { machine: f.machine, pid: 900, protocol: 200, head: '1'.repeat(40), at: f.at, tick: 1, cursorSeq: ledgerCursor.seq,
  queued: 0, granted: 0, machines: [{ name: f.machine, preference: 1, quotaCores: 8, grantedCores: 0, externalLoadCores: 1,
    availableCores: 7, overCommitted: false, fresh: true, online: true, ci: 'idle', ownerHold: false,
    reservation: { requestedCores: 0, fulfilledCores: 0, untilAt: null }, heartbeatAt: f.at, loadSampledAt: f.at,
    ciRunners: null, ciReserveCores: 0, agentSlots: { capacity: 4, occupied: 0 } }], queue: [], locks: [] };
const heartbeatEntry = object('dispatcher-heartbeat', heartbeat, {}, { kind: 'authority' });
const manifest = { requestId: 'synthetic-directory-request', scope: { kind: 'authority-read', authorityId: f.scope.authorityId, authorityEpoch: f.scope.authorityEpoch },
  snapshotId, ledgerCursor, issuedAt: f.at, expiresAt: '2030-01-02T03:05:05.000Z', entries: [...ticketEntries, ticketIndex, heartbeatEntry], nextPageToken: null };
const emptyManifest = { ...manifest, entries: [emptyIndex, heartbeatEntry] };
module.exports = { tickets, ledger, bodies, manifest, emptyManifest, ticketIndex, heartbeat };
