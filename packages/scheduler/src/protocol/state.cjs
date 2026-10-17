'use strict';
const s = require('./schema.cjs');
const { clone, contentHash, fail, ProtocolValidationError } = require('./json.cjs');
const { validateEnvelope, validateShape } = require('./envelope.cjs');
const { LIVE_ONLY_KINDS, validateResult } = require('./messages.cjs');
function initialProtocolState({ authorityId, authorityEpoch, nodeId }) {
  s.id(authorityId); s.positive(authorityEpoch); s.id(nodeId);
  return { authorityId, authorityEpoch, nodeId, activeSession: null, sessionGeneration: 0, retiredSessions: [],
    lastSequence: 0, lastSeenMonotonicMs: null, businessCursor: { seq: 0, hash: null }, sessionResult: null,
    messages: [], operations: [], waiting: [], liveStreams: [] };
}
function semanticHash(e) {
  return contentHash({ authorityId: e.authorityId, nodeId: e.nodeId, kind: e.kind, payload: e.payload,
    ...(e.execution ? { execution: e.execution } : {}) });
}
// Client-side handshake completion: the first reply is checked against a locally saved open, not
// accepted by inventing an active session from an arbitrary inbound frame. Returns a persistence proposal.
function acceptSessionReply(state, pendingOpen, input, context, receivedMonotonicMs) {
  try {
    s.finite()(receivedMonotonicMs);
    const open = validateShape(pendingOpen);
    if (open.kind !== 'session.open' || open.sequence !== 1 || state.authorityId !== open.authorityId ||
      state.authorityEpoch !== open.authorityEpoch || state.nodeId !== open.nodeId) fail('HANDSHAKE_REQUIRED');
    const duplicate = state.activeSession === open.nodeSession && state.sessionGeneration === open.payload.sessionGeneration;
    if (!duplicate && (open.payload.replacesSession !== state.activeSession || state.retiredSessions.includes(open.nodeSession) ||
      open.payload.sessionGeneration <= state.sessionGeneration)) fail('SESSION_REPLAY');
    const reply = validateEnvelope(input, { ...context, activeSession: open.nodeSession, lastSequence: 0 }).envelope;
    if (reply.kind !== 'result' || reply.nodeId !== open.nodeId || reply.nodeSession !== open.nodeSession ||
      reply.payload.messageId !== open.messageId || reply.payload.envelopeHash !== open.contentHash ||
      reply.payload.operationKey !== null || reply.payload.operationHash !== null || reply.payload.status !== 'business_accepted' ||
      reply.payload.outcome.kind !== 'applied') fail('HANDSHAKE_REPLY');
    if (state.lastSeenMonotonicMs !== null && receivedMonotonicMs < state.lastSeenMonotonicMs) fail('CLOCK_ROLLBACK');
    const previous = state.messages.find(x => x.messageId === reply.messageId);
    if (previous && previous.semanticHash !== semanticHash(reply)) fail('MESSAGE_ID_CONFLICT');
    if (duplicate) return { allowed: true, duplicate: true, nextState: clone(state) };
    if (reply.payload.businessCursor.seq < state.businessCursor.seq ||
      (reply.payload.businessCursor.seq === state.businessCursor.seq && reply.payload.businessCursor.hash !== state.businessCursor.hash)) fail('CURSOR_ROLLBACK');
    const nextState = clone(state);
    if (nextState.activeSession !== null) nextState.retiredSessions.push(nextState.activeSession);
    nextState.activeSession = open.nodeSession; nextState.sessionGeneration = open.payload.sessionGeneration;
    nextState.lastSequence = reply.sequence; nextState.lastSeenMonotonicMs = receivedMonotonicMs;
    nextState.businessCursor = reply.payload.businessCursor; nextState.liveStreams = [];
    nextState.sessionResult = reply.payload;
    nextState.messages.push({ messageId: reply.messageId, semanticHash: semanticHash(reply) });
    return { allowed: true, duplicate: false, nextState };
  } catch (error) {
    if (error instanceof ProtocolValidationError) return { allowed: false, reason: error.code };
    throw error;
  }
}
// Returns a proposed transaction only. No return value from this function is an ACK.
function prepareAcceptance(state, input, context, receivedMonotonicMs) {
  try {
    s.finite()(receivedMonotonicMs);
    if (!context || state.authorityId !== context.authorityId || state.authorityEpoch !== context.authorityEpoch || input?.nodeId !== state.nodeId) fail('STATE_SCOPE');
    if (state.lastSeenMonotonicMs !== null && receivedMonotonicMs < state.lastSeenMonotonicMs) fail('CLOCK_ROLLBACK');
    const validated = validateEnvelope(input, { ...context, activeSession: state.activeSession, lastSequence: state.lastSequence });
    const e = validated.envelope, operation = validated.operation;
    const nextState = clone(state), fingerprint = semanticHash(e);
    const ignore = reason => {
      // A transport-rejected immutable request has not reserved a business identity.
      if (!operation && !nextState.messages.some(x => x.messageId === e.messageId)) nextState.messages.push({ messageId: e.messageId, semanticHash: fingerprint });
      return { status: 'ignored', reason, nextState, validated, operation: null };
    };
    const previousMessage = state.messages.find(x => x.messageId === e.messageId);
    if (previousMessage && previousMessage.semanticHash !== fingerprint) fail('MESSAGE_ID_CONFLICT');
    const prior = operation && state.operations.find(x => x.operationKey === operation.operationKey);
    if (prior && prior.operationHash !== operation.operationHash) fail('OPERATION_CONFLICT');
    if (e.kind === 'session.open' && validated.transport.disposition === 'handshake') {
      if (state.retiredSessions.includes(e.nodeSession) || e.payload.sessionGeneration <= state.sessionGeneration) fail('SESSION_REPLAY');
      if (previousMessage) fail('SESSION_REPLAY');
      if (state.activeSession !== null) nextState.retiredSessions.push(state.activeSession);
      nextState.activeSession = e.nodeSession; nextState.sessionGeneration = e.payload.sessionGeneration;
      nextState.lastSequence = 1;
      nextState.liveStreams = [];
      nextState.sessionResult = null;
    } else {
      // Sequence is a transport watermark, not a business replay cursor. Gaps are legal.
      if (validated.transport.disposition !== 'next') {
        if (e.kind === 'session.open' && previousMessage && state.sessionResult) return {
          status: 'duplicate', nextState, validated, replayResult: state.sessionResult, operation: null,
        };
        if ((prior || previousMessage) && operation) return { status: 'duplicate', nextState, validated,
          replayResult: prior?.result ?? null, operation };
        return ignore('SEQUENCE_NOT_NEW');
      }
      nextState.lastSequence = e.sequence;
    }
    if (previousMessage || prior) {
      if (!previousMessage) nextState.messages.push({ messageId: e.messageId, semanticHash: fingerprint });
      return { status: 'duplicate', nextState, validated, replayResult: prior?.result ?? null, operation };
    }
    let effect = { kind: 'message', messageKind: e.kind };
    if (e.kind === 'waiting.upsert' || e.kind === 'waiting.delete') {
      const old = state.waiting.find(x => x.ticketId === e.payload.ticketId);
      if (old && e.payload.seq <= old.seq) return ignore('WAITING_TOMBSTONE_OR_SEQUENCE');
      const entry = { ticketId: e.payload.ticketId, seq: e.payload.seq, deleted: e.kind === 'waiting.delete',
        nodeSession: e.nodeSession, transportSequence: e.sequence };
      nextState.waiting = nextState.waiting.filter(x => x.ticketId !== entry.ticketId).concat(entry);
      effect = { kind: 'waiting', entry };
    }
    if (['origin.proof', 'machine.observation', 'process.stop-proof', 'handoff.observe'].includes(e.kind)) {
      const streamKey = contentHash([e.kind, e.payload.machine ?? e.payload.ownerMachine, e.execution ?? null]);
      const priorStream = state.liveStreams.find(x => x.streamKey === streamKey);
      if (priorStream && e.payload.observationSequence <= priorStream.sequence) return ignore('OBSERVATION_NOT_NEW');
      nextState.liveStreams = nextState.liveStreams.filter(x => x.streamKey !== streamKey).concat({ streamKey, sequence: e.payload.observationSequence });
    }
    nextState.messages.push({ messageId: e.messageId, semanticHash: fingerprint });
    if (operation) nextState.operations.push({ ...operation, result: null });
    nextState.lastSeenMonotonicMs = receivedMonotonicMs;
    return { status: 'ready', nextState, validated, operation, effect,
      liveOnly: LIVE_ONLY_KINDS.includes(e.kind) };
  } catch (error) {
    if (error instanceof ProtocolValidationError) return { status: 'rejected', reason: error.code };
    throw error;
  }
}
// Pure completion of a proposed transaction. The adapter must fence+persist this state AND its domain event
// atomically (or recoverably with fsync), then and only then send the receipt. This is not durability proof.
function completeAcceptance(prepared, input) {
  if (!['ready', 'duplicate', 'ignored'].includes(prepared.status)) fail('NOT_PREPARED');
  const receipt = validateResult(input), e = prepared.validated.envelope, op = prepared.operation;
  if (receipt.messageId !== e.messageId || receipt.envelopeHash !== e.contentHash || receipt.operationKey !== (op?.operationKey ?? null)
    || receipt.operationHash !== (op?.operationHash ?? null)) fail('RESULT_BINDING');
  const nextState = clone(prepared.nextState);
  if (e.kind === 'session.open') {
    if (receipt.status !== 'business_accepted' || receipt.outcome.kind !== 'applied') fail('HANDSHAKE_NOT_ACCEPTED');
    if (nextState.sessionResult) {
      if (contentHash(businessResult(nextState.sessionResult)) !== contentHash(businessResult(receipt))) fail('RESULT_CONFLICT');
      return nextState;
    }
  }
  if (prepared.status === 'ignored' && receipt.status !== 'business_rejected') fail('IGNORED_NOT_ACCEPTED');
  if (receipt.status === 'durably_received') return nextState;
  const requiredOutcome = { submission: 'submission', command: 'command', 'report.started': 'report', 'report.finished': 'report' }[e.kind];
  if (receipt.status === 'business_accepted' && requiredOutcome && receipt.outcome.kind !== requiredOutcome) fail('RESULT_OUTCOME');
  const prior = op && nextState.operations.find(x => x.operationKey === op.operationKey);
  if (prior?.result && ['business_accepted', 'business_rejected'].includes(prior.result.status)) {
    if (contentHash(businessResult(prior.result)) !== contentHash(businessResult(receipt))) fail('RESULT_CONFLICT');
    return nextState; // The original operation cursor can precede the current global cursor.
  }
  if (receipt.businessCursor.seq < nextState.businessCursor.seq ||
    (receipt.businessCursor.seq === nextState.businessCursor.seq && receipt.businessCursor.hash !== nextState.businessCursor.hash)) fail('CURSOR_ROLLBACK');
  if (op) {
    nextState.operations = nextState.operations.filter(x => x.operationKey !== op.operationKey).concat({ ...op, result: receipt });
  }
  nextState.businessCursor = receipt.businessCursor;
  if (e.kind === 'session.open') nextState.sessionResult = receipt;
  return nextState;
}
function businessResult(result) {
  const { messageId, envelopeHash, ...business } = result;
  return business;
}
function replayResult(prepared) {
  if (prepared.status !== 'duplicate' || !prepared.replayResult) fail('RESULT_NOT_AVAILABLE');
  return { ...clone(prepared.replayResult), messageId: prepared.validated.envelope.messageId, envelopeHash: prepared.validated.envelope.contentHash };
}
function isBusinessSuccess(input) { return validateResult(input).status === 'business_accepted'; }
module.exports = { initialProtocolState, acceptSessionReply, prepareAcceptance, completeAcceptance, replayResult, isBusinessSuccess };
