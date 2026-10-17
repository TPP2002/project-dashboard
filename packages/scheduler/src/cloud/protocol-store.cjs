'use strict';
const p = require('../protocol/contract.cjs');
const { failure } = require('./storage.cjs');

function createProtocolStore(store, authorityId, epoch) {
  const scope = nodeId => ({ authorityId, authorityEpoch: epoch, nodeId });
  function prepare(envelope, principal, now) {
    const node = envelope.nodeId;
    const saved = store.get('sessions', node);
    const state = saved && saved.authorityEpoch === epoch ? { ...saved }
      : { ...p.initialProtocolState(scope(node)), sessionGeneration: saved?.sessionGeneration ?? 0 };
    const message = store.get('messages', [node, envelope.messageId]);
    // validateEnvelope is also called by prepareAcceptance; do it here before
    // using payload-derived keys for disk lookups.
    const context = { principal, localRole: 'cloud', ...scope(node), allowedNodes: principal.nodeIds };
    const validated = p.validateEnvelope(envelope, { ...context, activeSession: state.activeSession, lastSequence: state.lastSequence });
    const op = validated.operation;
    const operation = op && store.get('operations', op.operationKey);
    const waiting = envelope.kind.startsWith('waiting.') ? store.get('waiting', envelope.payload.ticketId) : null;
    const observes = ['origin.proof', 'machine.observation', 'process.stop-proof', 'handoff.observe'].includes(envelope.kind);
    const streamKey = observes ? p.contentHash([envelope.kind, envelope.payload.machine ?? envelope.payload.ownerMachine, envelope.execution ?? null]) : null;
    const stream = observes ? store.get('streams', [node, state.activeSession, streamKey]) : null;
    state.messages = message ? [message] : [];
    state.operations = operation ? [operation] : [];
    state.waiting = waiting ? [waiting] : [];
    state.liveStreams = stream ? [stream] : [];
    state.retiredSessions = store.get('retired', [node, envelope.nodeSession]) ? [envelope.nodeSession] : [];
    // Monotonic freshness is process local, never restored from wall-clock disk.
    state.lastSeenMonotonicMs = null;
    return p.prepareAcceptance(state, envelope, context, now);
  }
  function commit(prepared, result) {
    const next = p.completeAcceptance(prepared, result);
    const node = next.nodeId;
    const changes = [];
    for (const value of next.messages) changes.push({ table: 'messages', key: [node, value.messageId], value });
    for (const value of next.operations) changes.push({ table: 'operations', key: value.operationKey, value });
    for (const value of next.waiting) changes.push({ table: 'waiting', key: value.ticketId, value });
    for (const value of next.liveStreams) changes.push({ table: 'streams', key: [node, next.activeSession, value.streamKey], value });
    for (const session of next.retiredSessions) changes.push({ table: 'retired', key: [node, session], value: true });
    const saved = { ...next, messages: [], operations: [], waiting: [], liveStreams: [], retiredSessions: [], lastSeenMonotonicMs: null };
    changes.push({ table: 'sessions', key: node, value: saved });
    store.commit(store.revision(), changes);
  }
  function identity(envelope) {
    const op = p.IMMUTABLE_KINDS.includes(envelope.kind) ? p.operationIdentity(envelope) : null;
    return { messageId: envelope.messageId, envelopeHash: envelope.contentHash,
      operationKey: op?.operationKey ?? null, operationHash: op?.operationHash ?? null };
  }
  function envelope(nodeId, kind, payload, execution) {
    const session = store.get('sessions', nodeId);
    if (!session || session.authorityEpoch !== epoch || !session.activeSession) throw failure('DISCONNECTED', 'node has no current session');
    const key = [nodeId, session.activeSession, epoch];
    const sequence = (store.get('out-sequence', key) ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw failure('FENCED', 'sequence exhausted');
    const value = { protocolVersion: p.PROTOCOL_VERSION, ...scope(nodeId), nodeSession: session.activeSession,
      messageId: require('node:crypto').randomUUID(), sequence, kind, payload, ...(execution ? { execution } : {}) };
    value.contentHash = p.envelopeHash(value);
    p.encodeFrame(value); // Shape + size gate before assigning this sequence.
    store.put('out-sequence', key, sequence);
    return value;
  }
  return { prepare, commit, identity, envelope };
}
module.exports = { createProtocolStore };
