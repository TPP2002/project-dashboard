'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const p = require('../../protocol/contract.cjs');
const same = (a, b) => p.canonicalJson(a) === p.canonicalJson(b);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminal = new Set(['passed', 'failed', 'cancelled', 'voided']);

// This consumer has no share root, filesystem cache, session counter, execution
// observation capability or native host. Gateway owns authentication and all IO.
function createRemoteClient({ port, timeoutMs = 30000, pollMs = 250 }) {
  if (!port || typeof port.call !== 'function' || typeof port.readObject !== 'function' || !port.runtime)
    throw new Error('LOCAL_SEMANTIC_PORT_REQUIRED');
  const callOptions = { timeoutMs };
  const call = request => port.call(p.validateLocalSemanticRequest(request), callOptions);
  const connected = async () => {
    const notice = await port.runtime.current(callOptions);
    if (notice.connection !== 'connected' || !notice.scope) throw new Error('REMOTE_DISCONNECTED');
    return notice;
  };
  async function read(selectors) {
    // One budget for the complete read, including every page and object. Node's
    // chunk adapter propagates errors here; it must not retry individual chunks.
    const selection = structuredClone(selectors);
    try { return await readOnce(selection); }
    catch (error) {
      if (error?.code !== 'READ_VERSION_UNAVAILABLE') throw error;
      return readOnce(selection);
    }
  }
  async function readOnce(selectors) {
    const before = await connected();
    let snapshotId = null, pageToken = null, cursor;
    const objects = [], pages = new Set(), entries = new Set();
    do {
      if (pages.size >= 256 || pages.has(pageToken)) throw new Error('READ_PAGE_CYCLE');
      pages.add(pageToken);
      const callId = randomUUID();
      const reply = await call({ kind: 'read', callId, selectors, snapshotId, pageToken });
      if (reply.kind !== 'read') throw new Error('READ_UNAVAILABLE');
      const manifest = p.validateReadManifest(reply.manifest);
      if (manifest.requestId !== callId) throw new Error('READ_REQUEST_IDENTITY');
      if (manifest.scope.authorityId !== before.scope.authorityId || manifest.scope.authorityEpoch !== before.scope.authorityEpoch
        || Date.now() < Date.parse(manifest.issuedAt) || Date.now() >= Date.parse(manifest.expiresAt)) throw new Error('READ_STALE');
      if (snapshotId !== null && (manifest.snapshotId !== snapshotId || !same(cursor, manifest.ledgerCursor))) throw new Error('READ_MIXED_SNAPSHOT');
      snapshotId = manifest.snapshotId; cursor = manifest.ledgerCursor;
      for (const entry of manifest.entries) {
        const key = p.canonicalJson(entry);
        if (entries.has(key)) throw new Error('READ_DUPLICATE_ENTRY');
        entries.add(key);
        // readObject is the approved gateway adapter: verifies all chunks and
        // complete hash/size, then the original domain validator, before return.
        const value = await port.readObject(entry, manifest);
        if (Date.now() >= Date.parse(manifest.expiresAt)) throw new Error('READ_EXPIRED_DURING_FETCH');
        objects.push({ entry, value });
      }
      pageToken = manifest.nextPageToken;
    } while (pageToken !== null);
    const after = await connected();
    if (before.generation !== after.generation || !same(before.scope, after.scope)) throw new Error('READ_FENCED');
    return { objects, snapshotId, ledgerCursor: cursor, scope: after.scope };
  }
  async function business(request) {
    // Keep callId and body fixed across bounded uncertain transport retries.
    const started = performance.now();
    let reply;
    do {
      await connected(); reply = await call(request);
      if (reply.kind === 'business') {
        const result = p.validateResult(reply.result);
        if (result.status === 'business_accepted' || result.status === 'business_rejected') return result;
      } else if (reply.kind !== 'pending') throw new Error('BUSINESS_REPLY_REQUIRED');
      if (performance.now() - started >= timeoutMs) throw new Error('BUSINESS_ACCEPTANCE_UNKNOWN');
      await sleep(Math.min(reply.retryAfterMs ?? reply.result?.retryAfterMs ?? pollMs, 1000));
    } while (true);
  }
  async function ticket(id) {
    const result = await read([{ kind: 'ticket', ticketId: id }]);
    const rows = result.objects.filter(x => x.entry.kind === 'ticket' && x.entry.ticketId === id);
    if (rows.length > 1) throw new Error('TICKET_NOT_UNIQUE');
    return rows[0]?.value ?? null;
  }
  async function wait(id, { until = 'granted', timeoutMs: budget = timeoutMs, signal } = {}) {
    if (!['granted', 'finished'].includes(until)) throw new Error('WAIT_UNTIL');
    const began = performance.now(); let afterSeq = 0;
    do {
      if (signal?.aborted) throw new Error('WAIT_ABORTED');
      const value = await ticket(id);
      if (value) {
        afterSeq = value.lastSeq;
        if (terminal.has(value.state) || until === 'granted' && ['granted', 'running', 'paused', 'slow'].includes(value.state)) return value;
      }
      if (performance.now() - began >= budget) throw new Error('WAIT_TIMEOUT');
      await call({ kind: 'wait', callId: randomUUID(), ticketId: id, afterSeq });
      await sleep(pollMs);
    } while (true);
  }
  async function command(kind, data, { commandId = randomUUID(), submitter, createdAt = new Date().toISOString(), expiresAt } = {}) {
    const command = { commandId, kind, data, submitter, createdAt,
      expiresAt: expiresAt ?? new Date(Date.parse(createdAt) + timeoutMs).toISOString() };
    p.validateRequest('command', command);
    return business({ kind: 'command', callId: commandId, command });
  }
  return {
    read, ticket, wait, command,
    waiting: (ticketId, afterSeq) => call({ kind: 'wait', callId: randomUUID(), ticketId, afterSeq }),
    submit: (request, callId = request.idempotencyKey, localContext = { cwd: process.cwd() }) => {
      p.validateRequest('submission', request);
      return business({ kind: 'submit', callId, request, localContext });
    },
    async execute(request) { return p.validateLocalExecutionReply(await call(request)); },
    status: id => id ? ticket(id) : read([{ kind: 'dispatcher-config' }, { kind: 'dispatcher-heartbeat' }, { kind: 'ticket-index' }]),
    cancel: (ticketId, options = {}) => command('cancel', { ticketId, ...(options.reason ? { reason: options.reason } : {}) }, options),
    finish: (ticketId, result, options = {}) => command('finish', { ticketId, result, ...(options.reason ? { reason: options.reason } : {}) }, options),
    pause: (ticketId, options) => command('pause-one', { ticketId }, options),
    resume: (ticketId, options) => command('resume-one', { ticketId }, options),
    reserve: (machine, requestedCores, durationMinutes, options) => command('reserve', { machine, requestedCores, ...(durationMinutes ? { durationMinutes } : {}) }, options),
    ownerHold: (machine, options) => command('owner-hold', { machine }, options),
    ownerRelease: (machine, options) => command('owner-release', { machine }, options),
    // The caller is an already-running resident. The gateway derives renewer
    // birth and source from its authenticated OS peer; no caller-supplied PID.
    async renewResident({ ticketId, attemptId, permitToken, cores }) {
      await connected();
      const reply = await call({ kind: 'resident-renew', callId: randomUUID(), ticketId, attemptId, permitToken, cores });
      if (reply.kind !== 'business') throw new Error('RESIDENT_RENEWAL_UNKNOWN');
      const result = p.validateResult(reply.result);
      if (result.status !== 'business_accepted') throw new Error('RESIDENT_RENEWAL_UNKNOWN');
      return result;
    },
  };
}
module.exports = { createRemoteClient };
