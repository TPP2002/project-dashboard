'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const p = require('../protocol/contract.cjs');
const { failure } = require('../transport/framed.cjs');
const { checkPeer } = require('../transport/local-ipc.cjs');
const { identity: validateIdentity } = require('../protocol/identities.cjs');
const { sourceProof: validateSourceProof } = require('../protocol/resident.cjs');
const { validate } = require('../protocol/schema.cjs');

function ticketIdFor(request) {
  // Reuse the existing published domain implementation; do not fork ticket derivation.
  return require('../sched/client/sched.cjs').deriveTicketId(request.project, request.idempotencyKey);
}
function normalizeContext(localContext) {
  const cwd = localContext.cwd;
  const flavor = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') ? path.win32 : path.posix;
  const normalized = flavor.normalize(cwd), root = flavor.parse(normalized).root;
  return { cwd: normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized };
}

function atomicWrite(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); }
  catch (error) { fs.unlinkSync(temporary); throw error; }
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}
class GatewayStore {
  constructor(root, { maxOperations = 4096, maxBytes = 16 * 1024 * 1024 } = {}) {
    if (!path.isAbsolute(root) || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw failure('STATE_ROOT');
    this.file = path.join(root, 'gateway-state.json'); this.maxOperations = maxOperations; this.maxBytes = maxBytes;
    if (fs.existsSync(this.file) && (fs.lstatSync(this.file).isSymbolicLink() || fs.statSync(this.file).size > maxBytes)) throw failure('STATE_CAPACITY');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) :
      { version: 1, generation: 0, session: null, operations: {}, waiting: {}, sources: {} };
    const s = this.state;
    if (s.version !== 1 || !Number.isSafeInteger(s.generation) || s.generation < 0 ||
      !(s.session === null || typeof s.session === 'string') || !s.operations || !s.waiting || !s.sources) throw failure('STATE_CORRUPT');
  }
  commit(next) {
    // Storage may contain multiple individually bounded protocol frames; it is not itself a wire frame.
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > this.maxBytes) throw failure('STATE_CAPACITY');
    atomicWrite(this.file, bytes); this.state = next;
  }
  mutate(change) { const next = structuredClone(this.state); const result = change(next); this.commit(next); return result; }
  newSession() {
    if (this.state.pendingSession) return structuredClone(this.state.pendingSession);
    return this.mutate(state => {
      if (state.generation >= Number.MAX_SAFE_INTEGER) throw failure('GENERATION_EXHAUSTED');
      const replacesSession = state.session; state.session = randomUUID(); state.generation++;
      return state.pendingSession = { nodeSession: state.session, generation: state.generation, replacesSession, messageId: randomUUID() };
    });
  }
  acknowledgeSession() { this.mutate(state => { delete state.pendingSession; }); }
  remember(envelope) {
    const identity = p.operationIdentity(envelope), key = p.contentHash(identity.operationKey);
    const previous = this.state.operations[key];
    if (previous) {
      if (previous.identity.operationHash !== identity.operationHash) throw failure('OPERATION_CONFLICT');
      return previous;
    }
    return this.mutate(state => {
      if (Object.keys(state.operations).length >= this.maxOperations) throw failure('OUTBOX_CAPACITY');
      return state.operations[key] = { identity, kind: envelope.kind, payload: envelope.payload,
        ...(envelope.execution ? { execution: envelope.execution } : {}), result: null };
    });
  }
  settle(envelope, result) {
    if (!['business_accepted', 'business_rejected'].includes(result.status)) return;
    const identity = p.operationIdentity(envelope), key = p.contentHash(identity.operationKey);
    this.mutate(state => { if (!state.operations[key] || state.operations[key].identity.operationHash !== identity.operationHash) throw failure('OPERATION_CONFLICT'); state.operations[key].result = result; });
  }
  pending() { return Object.values(this.state.operations).filter(item => item.result === null); }
  waiting(ticketId, machine, deleted, peer) {
    return this.mutate(state => {
      const key = p.contentHash([ticketId, machine]), previous = state.waiting[key];
      if (!previous && Object.keys(state.waiting).length >= this.maxOperations) throw failure('WAITING_CAPACITY');
      const seq = (previous?.seq ?? 0) + 1;
      if (!Number.isSafeInteger(seq)) throw failure('SEQUENCE_EXHAUSTED');
      state.waiting[key] = { seq, deleted, peer };
      return { schema: 1, ticketId, machine, seq, ...(deleted ? {} : { pid: peer.pid }) };
    });
  }
  source(peer, callId, submissionHash) {
    const key = submissionHash;
    const previous = this.state.sources[key];
    if (previous) {
      if (previous.observedOwnerSid !== peer.sid) throw failure('SOURCE_OWNER_CONFLICT');
      return structuredClone(previous);
    }
    return this.mutate(state => {
      if (Object.keys(state.sources).length >= this.maxOperations) throw failure('SOURCE_CAPACITY');
      return state.sources[key] = { proofId: randomUUID(), submissionHash, observedOwnerSid: peer.sid, method: 'ipc-peer', callId };
    });
  }
  captureOriginal(peer, input) {
    const local = p.validateLocalSemanticRequest(input);
    if (local.kind !== 'submit') throw failure('SOURCE_SUBMISSION_REQUIRED');
    peer = checkPeer(peer, [peer]);
    const request = local.request, submissionHash = p.contentHash(request), ticketId = ticketIdFor(request);
    const localContext = normalizeContext(local.localContext), prior = this.state.originals?.[ticketId];
    if (prior) {
      const found = this.original({ stage: 'submission', ticketId, project: request.project, submissionHash });
      if (found.status !== 'found' || p.canonicalJson(found.request) !== p.canonicalJson(request) ||
          p.canonicalJson(found.peer) !== p.canonicalJson(peer) || found.source.callId !== local.callId ||
          p.canonicalJson(found.localContext) !== p.canonicalJson(localContext)) throw failure('SOURCE_IDENTITY_CONFLICT');
      return found.source;
    }
    // A legacy proof has no original bytes or process identity. Never backfill it by inference.
    if (this.state.sources[submissionHash]) throw failure('SOURCE_ORIGINAL_UNKNOWN');
    const source = validate(validateSourceProof, { proofId: randomUUID(), submissionHash,
      observedOwnerSid: peer.sid, method: 'ipc-peer', callId: local.callId });
    const record = { request, source, peer, localContext };
    this.mutate(state => {
      state.originals ??= {};
      if (Object.keys(state.originals).length >= this.maxOperations || Object.keys(state.sources).length >= this.maxOperations) throw failure('SOURCE_CAPACITY');
      // One fsync/rename commits both the proof and its original; no intermediate source-only state.
      state.sources[submissionHash] = source;
      state.originals[ticketId] = structuredClone(record);
    });
    return structuredClone(source);
  }
  original(identity, expectedSource) {
    try {
      validate((value, at) => validateIdentity(value, at, ['submission']), identity);
      const record = this.state.originals?.[identity.ticketId];
      if (!record) return { status: 'unknown', reason: 'SOURCE_ORIGINAL_MISSING' };
      const { request, source, peer, localContext } = record;
      validate(validateSourceProof, source); checkPeer(peer, [peer]);
      if (source.method !== 'ipc-peer') return { status: 'unknown', reason: 'SOURCE_BINDING_UNKNOWN' };
      p.validateLocalSemanticRequest({ kind: 'submit', callId: source.callId, request, localContext });
      const hash = p.contentHash(request);
      if (hash !== identity.submissionHash || ticketIdFor(request) !== identity.ticketId || request.project !== identity.project ||
          source.submissionHash !== hash || source.observedOwnerSid !== peer.sid ||
          p.canonicalJson(normalizeContext(localContext)) !== p.canonicalJson(localContext) ||
          p.canonicalJson(this.state.sources[hash]) !== p.canonicalJson(source)) return { status: 'unknown', reason: 'SOURCE_BINDING_MISMATCH' };
      if (expectedSource !== undefined && p.canonicalJson(validate(validateSourceProof, expectedSource)) !== p.canonicalJson(source)) {
        return { status: 'unknown', reason: 'SOURCE_PROOF_MISMATCH' };
      }
      return structuredClone({ status: 'found', request, source, peer, localContext });
    } catch { return { status: 'unknown', reason: 'SOURCE_ORIGINAL_INVALID' }; }
  }
}
module.exports = { GatewayStore, atomicWrite };
