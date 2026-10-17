'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../packages/scheduler/src/protocol/contract.cjs');
const f = require('../packages/scheduler/fixtures/protocol/messages.cjs');
const context = (kind = 'submission') => ({ ...f.trust(kind), activeSession: f.scope.nodeSession, lastSequence: 1 });
const sign = value => ({ ...value, contentHash: p.envelopeHash(value) });
const throws = (fn, code) => assert.throws(fn, error => error instanceof p.ProtocolValidationError && (!code || error.code === code));
function opened() {
  const state = p.initialProtocolState(f.scope);
  const prepared = p.prepareAcceptance(state, f.envelope('session.open', { sequence: 1 }), f.trust(), 100);
  assert.equal(prepared.status, 'ready');
  return p.completeAcceptance(prepared, f.receipt(prepared));
}

test('real CJS entrypoint and every shared kind survive framing and validation with typed payloads', () => {
  assert.equal(p.PROTOCOL_VERSION, 'scheduler-remote.v1');
  assert.deepEqual(Object.keys(f.payloads).sort(), [...p.KINDS].sort());
  for (const kind of p.KINDS) {
    const e = f.envelope(kind, kind === 'session.open' ? { sequence: 1 } : {});
    const c = context(kind); if (kind === 'session.open') c.activeSession = null;
    const frame = p.encodeFrame(e);
    assert.deepEqual(p.decodeFrame(Buffer.from(frame)), e, kind);
    assert.deepEqual(p.validateEnvelope(e, c).envelope, e, kind);
    assert.deepEqual(p.validateRequest(kind, e.payload), e.payload, kind);
    throws(() => p.validateRequest(kind, { ...e.payload, arbitrary: true }), 'UNKNOWN_FIELD');
  }
});

test('strict JSON is canonical and rejects prototype keys, getters, cycles and nonfinite values', () => {
  assert.equal(p.canonicalJson({ z: [2, 1], a: { b: 1, a: 2 } }), '{"a":{"a":2,"b":1},"z":[2,1]}');
  assert.equal(p.contentHash({ b: 2, a: 1 }), p.contentHash({ a: 1, b: 2 }));
  assert.notEqual(p.contentHash([1, 2]), p.contentHash([2, 1]));
  for (const key of ['__proto__', 'constructor', 'prototype']) throws(() => p.canonicalJson(JSON.parse(`{"${key}":1}`)), 'JSON_KEY');
  for (const value of [NaN, Infinity, -Infinity, undefined, 1n, () => 0, new Date(), Object.create({ x: 1 }), new Array(2)]) throws(() => p.canonicalJson(value));
  let invoked = false;
  const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { invoked = true; return 1; } });
  throws(() => p.canonicalJson(getter), 'JSON_DESCRIPTOR'); assert.equal(invoked, false);
  const cycle = {}; cycle.x = cycle; throws(() => p.canonicalJson(cycle), 'JSON_CYCLE');
  throws(() => p.canonicalJson({ [Symbol('x')]: 1 }), 'JSON_KEY');
  throws(() => p.canonicalJson('\uD800'), 'JSON_STRING');
  throws(() => p.canonicalJson(Array(4097).fill(0)), 'JSON_ARRAY');
  throws(() => p.canonicalJson('x'.repeat(262145)), 'JSON_STRING');
});

test('unknown versions, operations, envelope fields, untrusted principals and epochs fail closed', () => {
  const e = f.envelope('submission');
  for (const mutation of [
    v => { v.protocolVersion = 'scheduler-remote.v99'; }, v => { v.kind = 'shell'; },
    v => { v.principal = 'self-claimed'; }, v => { v.authorityId = 'other'; },
    v => { v.authorityEpoch++; }, v => { v.nodeId = 'other'; }, v => { v.nodeSession = 'other'; },
    v => { v.sequence = 0; }, v => { v.sequence = Number.MAX_SAFE_INTEGER + 1; },
  ]) { const value = f.copy(e); mutation(value); throws(() => p.validateEnvelope(sign(value), context())); }
  for (const patch of [
    { principal: null }, { allowedNodes: [] }, { allowedNodes: ['other'] },
    { principal: { ...f.trust().principal, nodeIds: ['other'] } },
    { principal: { ...f.trust().principal, allowedKinds: ['session.open'] } },
  ]) throws(() => p.validateEnvelope(e, { ...context(), ...patch }));
  const machine = f.envelope('machine.observation'); machine.payload.machine = 'unmanaged-machine';
  machine.payload.lifecycle.control.configuredMachines = ['unmanaged-machine'];
  machine.payload.lifecycle.machines[0].machine = 'unmanaged-machine';
  machine.payload.lifecycle.machines[0].heartbeat.machine = 'unmanaged-machine';
  throws(() => p.validateEnvelope(sign(machine), context()), 'MACHINE_DENIED');
});

test('hash binds session, sequence, payload and execution identity', () => {
  const original = f.envelope('report.started');
  for (const mutate of [v => { v.payload.codeRef.value = '2'.repeat(40); }, v => { v.nodeSession += '-old'; },
    v => { v.sequence++; }, v => { v.execution.controller.creationFileTime = '133700000000000002'; }]) {
    const changed = f.copy(original); mutate(changed); throws(() => p.validateEnvelope(changed, context()), 'ENVELOPE_HASH');
  }
  for (const mutate of [v => { v.payload.token = 'other'; }, v => { v.payload.pid++; },
    v => { v.payload.ticketId = 'tk-22222222222222222222'; }, v => { v.payload.creationFileTime = '133700000000000002'; }]) {
    const changed = f.copy(original); mutate(changed); throws(() => p.validateEnvelope(sign(changed), context()));
  }
  const missing = f.copy(original); delete missing.execution; throws(() => p.validateEnvelope(sign(missing), context()), 'MISSING');
  const lease = f.envelope('lease.renewal'); lease.payload.authorityEpoch++;
  throws(() => p.validateEnvelope(sign(lease), context()), 'LEASE_SCOPE');
  const projection = f.envelope('state.snapshot'); projection.payload.nodeSession = 'old';
  throws(() => p.validateEnvelope(sign(projection), context()), 'PROJECTION_SCOPE');
});

test('framing rejects oversized, multi-line, malformed UTF8, duplicate keys and partial frames', () => {
  const frame = p.encodeFrame(f.envelope('submission'));
  throws(() => p.decodeFrame(Buffer.alloc(p.MAX_FRAME_BYTES + 1)), 'FRAME_TOO_LARGE');
  throws(() => p.decodeFrame(frame + frame), 'FRAME_LINE');
  throws(() => p.decodeFrame(frame.slice(0, -1)), 'FRAME_LINE');
  throws(() => p.decodeFrame(Buffer.from([255, 10])), 'FRAME_UTF8');
  throws(() => p.decodeFrame('\uFEFF' + frame), 'FRAME_LINE');
  throws(() => p.decodeFrame(frame.replace('{', '{"sequence":999,')), 'FRAME_CANONICAL');
  throws(() => p.decodeFrame(frame.replace('{', '{ ')), 'FRAME_CANONICAL');
});

test('submission and command retain real semantic rules instead of arbitrary shell or path operations', () => {
  const original = f.copy(f.payloads.submission);
  const auto = { ...original, execution: 'auto', origin: f.machine, work: { type: original.work.type, targetPaths: original.work.targetPaths }, menu: { item: original.work.type, args: ['synthetic'] } };
  assert.deepEqual(p.validateRequest('submission', auto), auto);
  const local = { ...original }; delete local.execution;
  assert.deepEqual(p.validateRequest('submission', local), local);
  for (const mutate of [v => { v.requestedCores = 0; }, v => { v.work.shard = 's2of2'; v.work.round = 'r1'; },
    v => { v.origin = f.machine; }, v => { v.work.command = 'echo'; }, v => { v.work.targetPaths = []; },
    v => { v.resident = true; v.execution = 'cluster'; }, v => { v.requestedCoresOriginal = 1; },
  ]) { const request = f.copy(original); mutate(request); throws(() => p.validateRequest('submission', request)); }
  for (const [kind, data] of Object.entries({ 'jump-queue': { ticketId: f.execution.ticketId }, cancel: { ticketId: f.execution.ticketId },
    finish: { ticketId: f.execution.ticketId, result: 'failed' }, 'pause-one': { ticketId: f.execution.ticketId }, 'resume-one': { ticketId: f.execution.ticketId },
    reserve: { machine: f.machine, requestedCores: 5, durationMinutes: 60 }, 'owner-hold': { machine: f.machine }, 'owner-release': { machine: f.machine } })) {
    p.validateRequest('command', { ...f.payloads.command, kind, data });
  }
  throws(() => p.validateRequest('command', { ...f.payloads.command, kind: 'read', data: { path: 'anything' } }));
  throws(() => p.validateRequest('command', { ...f.payloads.command, kind: 'reserve', data: { machine: f.machine, requestedCores: 0, durationMinutes: 60 } }));
  // Resident pid is the real renewal wrapper, separate from a managed controller or pre-existing application.
  p.validateEnvelope(f.envelope('resident.renewal', { payload: { ...f.payloads['resident.renewal'], pid: 4244 } }), context());
});

test('same operation under new transport keeps operation identity but changes envelope hash', () => {
  const one = f.envelope('submission');
  const two = f.envelope('submission', { nodeSession: 'synthetic-session-2', sequence: 9, messageId: 'retry' });
  assert.notEqual(one.contentHash, two.contentHash);
  assert.deepEqual(p.operationIdentity(one), p.operationIdentity(two));
  const changed = f.envelope('submission', { payload: { ...one.payload, title: 'different' } });
  assert.equal(p.operationIdentity(one).operationKey, p.operationIdentity(changed).operationKey);
  assert.notEqual(p.operationIdentity(one).operationHash, p.operationIdentity(changed).operationHash);
  throws(() => p.operationIdentity(f.envelope('execution.heartbeat')), 'NOT_IMMUTABLE');
});

test('client handshake consumes only the business ACK bound to its saved open, independently of server sequence', () => {
  const state = p.initialProtocolState(f.scope);
  const open = f.envelope('session.open', { sequence: 1 });
  const server = p.prepareAcceptance(state, open, f.trust(), 100);
  const reply = f.envelope('result', { sequence: 1, messageId: 'open-ack', payload: f.receipt(server) });
  const accepted = p.acceptSessionReply(state, open, reply, f.trust('state.snapshot'), 101);
  assert.equal(accepted.allowed, true); assert.equal(accepted.nextState.activeSession, open.nodeSession);
  assert.equal(accepted.nextState.lastSequence, 1);
  const duplicate = p.acceptSessionReply(accepted.nextState, open, reply, f.trust('state.snapshot'), 102);
  assert.equal(duplicate.allowed, true); assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.nextState.lastSeenMonotonicMs, 101);
  for (const status of ['durably_received', 'business_pending', 'business_rejected']) {
    const bad = f.envelope('result', { sequence: 1, payload: f.receipt(server, status) });
    assert.equal(p.acceptSessionReply(state, open, bad, f.trust('state.snapshot'), 101).allowed, false);
  }
  const wrong = f.copy(reply); wrong.payload.envelopeHash = '0'.repeat(64);
  assert.equal(p.acceptSessionReply(state, open, sign(wrong), f.trust('state.snapshot'), 101).reason, 'HANDSHAKE_REPLY');
  assert.equal(p.prepareAcceptance(state, reply, f.trust(), 101).reason, 'SESSION_MISMATCH');
  // A lost accepted open ACK can be recovered without opening another session or refreshing lastSeen.
  const serverState = p.completeAcceptance(server, f.receipt(server));
  const retry = p.prepareAcceptance(serverState, open, f.trust(), 200);
  assert.equal(retry.status, 'duplicate');
  assert.deepEqual(p.replayResult(retry), f.receipt(server));
  assert.equal(p.completeAcceptance(retry, p.replayResult(retry)).lastSeenMonotonicMs, 100);
  throws(() => p.completeAcceptance(server, f.receipt(server, 'durably_received')), 'HANDSHAKE_NOT_ACCEPTED');
});

test('business results are distinct from durable ACKs and immutable outcomes replay after reconnect', () => {
  let state = opened();
  const original = f.envelope('submission');
  const prepared = p.prepareAcceptance(state, original, f.trust(), 101);
  assert.equal(prepared.status, 'ready');
  const durable = f.receipt(prepared, 'durably_received');
  assert.equal(p.isBusinessSuccess(durable), false);
  const received = p.completeAcceptance(prepared, durable);
  assert.equal(received.operations.length, 1); // Reserved immutable identity, no fabricated business effect.
  assert.equal(received.operations[0].result, null);
  const inflightConflict = f.envelope('submission', { messageId: 'different-inflight', sequence: 3, payload: { ...original.payload, title: 'conflicting inflight request' } });
  assert.equal(p.prepareAcceptance(received, inflightConflict, f.trust(), 102).reason, 'OPERATION_CONFLICT');
  for (const status of ['business_pending', 'business_rejected']) assert.equal(p.isBusinessSuccess(f.receipt(prepared, status)), false);
  const accepted = f.receipt(prepared);
  assert.equal(p.isBusinessSuccess(accepted), true);
  state = p.completeAcceptance(prepared, accepted);
  const conflicting = { ...accepted, outcome: { kind: 'submission', ticketId: 'tk-22222222222222222222' } };
  throws(() => p.completeAcceptance({ ...prepared, nextState: state }, conflicting), 'RESULT_CONFLICT');
  const open2 = f.envelope('session.open', { nodeSession: 'synthetic-session-2', messageId: 'open-2', sequence: 1,
    payload: { replacesSession: f.scope.nodeSession, sessionGeneration: 2 } });
  const opened2 = p.prepareAcceptance(state, open2, f.trust(), 102);
  state = p.completeAcceptance(opened2, f.receipt(opened2));
  for (const messageId of [original.messageId, 'new-message-same-operation']) {
    const retry = f.envelope('submission', { nodeSession: open2.nodeSession, sequence: 3, messageId });
    const duplicate = p.prepareAcceptance(state, retry, f.trust(), 103);
    assert.equal(duplicate.status, 'duplicate');
    assert.deepEqual(p.replayResult(duplicate), { ...accepted, messageId: retry.messageId, envelopeHash: retry.contentHash });
    const completed = p.completeAcceptance(duplicate, p.replayResult(duplicate));
    assert.equal(completed.lastSeenMonotonicMs, 102);
    assert.equal(completed.operations.length, 1);
  }
  const changed = f.envelope('submission', { nodeSession: open2.nodeSession, sequence: 3, payload: { ...original.payload, title: 'changed' } });
  assert.equal(p.prepareAcceptance(state, changed, f.trust(), 103).reason, 'MESSAGE_ID_CONFLICT');
  changed.messageId = 'different-id'; changed.contentHash = p.envelopeHash(changed);
  assert.equal(p.prepareAcceptance(state, changed, f.trust(), 103).reason, 'OPERATION_CONFLICT');
});

test('shared sequence fixture gives server/direct and client/framed consumers identical decisions and tombstones', () => {
  let server = p.initialProtocolState(f.scope), client = p.initialProtocolState(f.scope);
  for (const [index, step] of f.scenario.sequence.entries()) {
    const input = f.envelope(step.kind, { messageId: step.messageId, sequence: step.sequence, payload: step.payload });
    const a = p.prepareAcceptance(server, input, f.trust(), 100 + index);
    const b = p.prepareAcceptance(client, p.decodeFrame(p.encodeFrame(input)), f.trust(), 100 + index);
    assert.equal(a.status, step.expected); assert.deepEqual(a, b);
    if (a.status === 'ready' || a.status === 'ignored') {
      const status = a.status === 'ignored' ? 'business_rejected' : 'business_accepted';
      server = p.completeAcceptance(a, f.receipt(a, status)); client = p.completeAcceptance(b, f.receipt(b, status));
    }
    assert.equal(server.lastSeenMonotonicMs, step.seen); assert.deepEqual(server, client);
  }
  assert.equal(server.waiting[0].deleted, true); assert.equal(server.waiting[0].seq, 3);
});

test('old/duplicate heartbeats and old sessions never refresh lastSeen; replacement requires handshake', () => {
  let state = opened();
  const beat = f.envelope('execution.heartbeat', { sequence: 4 });
  const prepared = p.prepareAcceptance(state, beat, f.trust(), 200);
  state = p.completeAcceptance(prepared, f.receipt(prepared));
  assert.equal(state.lastSeenMonotonicMs, 200);
  for (const e of [beat, f.envelope('execution.heartbeat', { sequence: 3, messageId: 'late' })]) {
    const duplicate = p.prepareAcceptance(state, e, f.trust(), 300);
    assert.equal(duplicate.status, 'ignored'); assert.equal(state.lastSeenMonotonicMs, 200);
  }
  const newTransport = f.envelope('execution.heartbeat', { sequence: 5 });
  const duplicate = p.prepareAcceptance(state, newTransport, f.trust(), 300);
  assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.nextState.lastSeenMonotonicMs, 200);
  assert.equal(p.prepareAcceptance(state, f.envelope('execution.heartbeat', { nodeSession: 'other', sequence: 6 }), f.trust(), 300).reason, 'SESSION_MISMATCH');
  const replacement = f.envelope('session.open', { nodeSession: 'synthetic-session-2', sequence: 1, messageId: 'open-2', payload: { replacesSession: state.activeSession, sessionGeneration: 2 } });
  const plan = p.prepareAcceptance(state, replacement, f.trust(), 301);
  state = p.completeAcceptance(plan, f.receipt(plan));
  assert.equal(p.prepareAcceptance(state, beat, f.trust(), 302).reason, 'SESSION_MISMATCH');
  const reuse = f.envelope('session.open', { sequence: 1, messageId: 'open-3', payload: { replacesSession: state.activeSession, sessionGeneration: 3 } });
  assert.equal(p.prepareAcceptance(state, reuse, f.trust(), 302).reason, 'SESSION_REPLAY');
  assert.equal(p.prepareAcceptance(state, f.envelope('submission', { nodeSession: state.activeSession }), f.trust(), 1).reason, 'CLOCK_ROLLBACK');
});

test('freshness requires authenticated local receive facts, complete projection and all watermarks', () => {
  const lc = f.leaseContext();
  const c = { ...lc, freshness: lc.facts, minLedgerSeq: 9, minBusinessCursor: 10, minSessionWatermark: 1, minLiveWatermark: 20 };
  assert.equal(p.evaluateProjection(f.payloads['state.snapshot'], c).allowed, true);
  assert.equal(p.isFactFresh(lc.facts, lc), true);
  for (const change of [v => { v.nodeSession = 'old'; }, v => { v.gatewayInstance = 'old'; }, v => { v.nodeInstance = 'old'; },
    v => { v.authorityEpoch--; }, v => { v.known = false; }, v => { v.clockId = 'old'; }, v => { v.observedMonotonicMs = 3000; }]) {
    const fact = f.copy(lc.facts); change(fact); assert.equal(p.isFactFresh(fact, lc), false);
  }
  assert.equal(p.isFactFresh(lc.facts, { ...lc, nowMonotonicMs: 31500 }), false);
  assert.equal(p.isFactFresh(lc.facts, { ...lc, nowMonotonicMs: 1400 }), false);
  for (const mutate of [v => { v.complete = false; }, v => { v.nodeSession = 'old'; }, v => { v.ledgerSeq = 8; },
    v => { v.liveWatermark = 19; }, v => { v.sessionWatermark = 0; }, v => { v.businessCursor.seq = 9; },
    v => { v.attempts[0].controller.creationFileTime = ''; }]) {
    const projection = f.copy(f.payloads['state.snapshot']); mutate(projection); assert.equal(p.evaluateProjection(projection, c).allowed, false);
  }
});

test('lease deadline is challenge sentAt + TTL, delayed ACK cannot restart TTL', () => {
  const c = f.leaseContext(), lease = f.payloads['lease.renewal'];
  assert.equal(p.DEFAULT_LEASE_TTL_MS, 30000); assert.equal(p.MAX_LEASE_TTL_MS, 60000);
  const accepted = p.evaluateExecutionLease(lease, c);
  assert.equal(accepted.allowed, true); assert.equal(accepted.deadlineMonotonicMs, 31000);
  const delayed = p.evaluateExecutionLease(lease, { ...c, nowMonotonicMs: 30000, facts: { ...c.facts, observedMonotonicMs: 29999 } });
  assert.equal(delayed.allowed, true); assert.equal(delayed.deadlineMonotonicMs, 31000);
  assert.equal(p.evaluateExecutionLease(lease, { ...c, nowMonotonicMs: 31000 }).reason, 'LEASE_EXPIRED');
  assert.equal(p.evaluateExecutionLease({ ...lease, ttlMs: 100 }, { ...c, challengeRecord: { ...c.challengeRecord, requestedTtlMs: 100 } }).reason, 'LEASE_EXPIRED');
  const consumed = { ...c, ...accepted.watermarks, nowMonotonicMs: 2001 };
  assert.equal(p.evaluateExecutionLease(lease, consumed).reason, 'LEASE_REPLAY');
  assert.equal(p.evaluateActiveExecutionLease(accepted, { ...c, nowMonotonicMs: 30000, facts: { ...c.facts, observedMonotonicMs: 29999 } }).allowed, true);
  assert.equal(p.evaluateActiveExecutionLease(accepted, { ...c, nowMonotonicMs: 31000 }).reason, 'LEASE_EXPIRED');
});

test('lease rejects rollback, expired challenge, reused PID, restart/session/epoch and unknown native facts', () => {
  const lease = f.payloads['lease.renewal'];
  for (const mutate of [v => { v.nowMonotonicMs = 1499; }, v => { v.clockId = 'other'; }, v => { v.nodeInstance = 'restarted'; },
    v => { v.gatewayInstance = 'restarted'; }, v => { v.nodeSession = 'replaced'; }, v => { v.authorityEpoch++; },
    v => { v.controller.creationFileTime = '133700000000000002'; }, v => { v.controller.pid++; },
    v => { v.challengeRecord.challenge = 'other'; }, v => { v.challengeRecord.sentAtMonotonicMs = 3000; },
    v => { v.challengeRecord.requestedTtlMs = 100; }, v => { v.minLedgerSeq = 11; }, v => { v.lastConsumedChallengeSequence = 4; },
    v => { v.lastLeaseSequence = 8; }, v => { v.consumedLeaseIds = [lease.leaseId]; }, v => { delete v.consumedLeaseIds; },
    v => { v.executionKnown = false; }, v => { v.controllerVerified = false; }, v => { v.nativeWatchdogArmed = false; },
    v => { v.facts.known = false; }, v => { v.facts.observedMonotonicMs = 3000; },
    v => { v.facts.machine = 'other'; }, v => { v.facts.attemptId = 'a2'; }, v => { v.facts.permitToken = 'other'; },
    v => { v.facts.controller.creationFileTime = '133700000000000002'; },
  ]) { const c = f.leaseContext(); mutate(c); assert.equal(p.evaluateExecutionLease(lease, c).allowed, false); }
  for (const ttlMs of [0, 60001, Infinity]) assert.equal(p.evaluateExecutionLease({ ...lease, ttlMs }, f.leaseContext()).allowed, false);
  const accepted = p.evaluateExecutionLease(lease, f.leaseContext());
  assert.equal(p.evaluateActiveExecutionLease(accepted, { ...f.leaseContext(), nodeInstance: 'restarted' }).allowed, false);
  assert.equal(p.evaluateExecutionLease(lease, null).allowed, false);
});

test('object reads are bounded by immutable id/hash/size and chunks are integrity checked', () => {
  const read = f.copy(f.payloads['artifact.read']);
  throws(() => p.validateRequest('artifact.read', { ...read, path: 'arbitrary' }), 'UNKNOWN_FIELD');
  for (const value of [{ ...read, offset: 8190, length: 4 }, { ...read, length: 131073 }, { ...read, offset: -1 }, { ...read, length: 0 }]) throws(() => p.validateRequest('artifact.read', value));
  const chunk = f.copy(f.payloads['artifact.chunk']); chunk.dataBase64 = 'YmFkIQ==';
  throws(() => p.validateRequest('artifact.chunk', chunk), 'CHUNK_HASH');
  const notice = f.envelope('launch.notice'); notice.payload.submissionId = 'wrong';
  throws(() => p.validateEnvelope(sign(notice), context()), 'LAUNCH_IDENTITY');
  throws(() => p.validateRequest('state.read', { requestId: 'synthetic-read', afterCursor: { seq: 1, hash: null }, limit: 1 }), 'CURSOR');
});

test('real pregrant -> grant -> handoff/snapshot -> started fixture never invents pre-start PID or token', () => {
  const flow = require('../packages/scheduler/fixtures/protocol/phase-flow.cjs');
  let started = false;
  for (const step of flow) {
    const e = step.envelope;
    p.validateEnvelope(p.decodeFrame(p.encodeFrame(e)), context(e.kind));
    assert.equal(e.execution?.stage ?? null, step.expectedStage);
    if (e.kind === 'report.started') started = true;
    if (!started) {
      assert.equal(p.canonicalJson(e).includes('"controller"'), false, e.kind);
      assert.equal(p.canonicalJson(e).includes('"creationFileTime"'), false, e.kind);
      assert.equal(p.canonicalJson(e).includes('"pid"'), false, e.kind);
      if (e.execution?.stage === 'submission') assert.equal(Object.hasOwn(e.execution, 'permitToken'), false);
    }
    if (e.execution?.stage === 'granted') assert.equal(e.execution.permitToken.length > 0, true);
  }
  const pregrant = f.envelope('origin.proof');
  throws(() => p.validateEnvelope(sign({ ...pregrant, execution: f.execution }), context('origin.proof')), 'ENUM');
  const granted = f.envelope('handoff.publish');
  throws(() => p.validateEnvelope(sign({ ...granted, execution: { ...f.granted, controller: f.execution.controller } }), context('handoff.publish')), 'UNKNOWN_FIELD');
  throws(() => p.validateEnvelope(sign({ ...granted, execution: { ...f.granted, permitToken: '' } }), context('handoff.publish')), 'TEXT');
  throws(() => p.validateEnvelope(sign({ ...f.envelope('report.finished'), execution: f.granted }), context('report.finished')), 'ENUM');
  const unstarted = f.copy(f.payloads['state.snapshot']);
  unstarted.attempts = [{ ...f.granted, state: 'granted', grantedCores: 2, permitLedgerSeq: 9, cancelRequested: false }];
  p.validateProjection(unstarted);
  unstarted.attempts[0].state = 'running';
  throws(() => p.validateProjection(unstarted), 'ENUM');
  for (const kind of ['artifact.read', 'log.read']) for (const execution of [f.submissionIdentity, f.granted, f.execution]) {
    p.validateEnvelope(f.envelope(kind, { execution }), context(kind));
  }
  const autoPublication = f.copy(f.payloads['handoff.publish']);
  autoPublication.submission = { ...f.payloads.submission, execution: 'auto', origin: 'synthetic-origin-machine',
    allowedMachines: ['synthetic-origin-machine', f.machine], work: { type: 'test:targeted', targetPaths: ['test/synthetic.test.cjs'] },
    menu: { item: 'test:targeted', args: ['test/synthetic.test.cjs'] } };
  const auto = f.envelope('handoff.publish', { payload: autoPublication });
  p.validateEnvelope(auto, context('handoff.publish'));
  assert.deepEqual(p.operationIdentity(auto), p.operationIdentity(f.envelope('handoff.publish', {
    payload: autoPublication, nodeSession: 'synthetic-session-2', sequence: 9, messageId: 'synthetic-publish-retry',
  })));
  const badSnapshot = f.copy(autoPublication); badSnapshot.snapshot.bundleBytes++;
  throws(() => p.validateRequest('handoff.publish', badSnapshot), 'SNAPSHOT_OBJECT');
  const wrongPermit = f.copy(auto); wrongPermit.payload.permit.token = 'wrong-permit';
  throws(() => p.validateEnvelope(sign(wrongPermit), context('handoff.publish')), 'PERMIT_BINDING');
});

test('cloud requests have fixed directions, authorization and correlated typed wire replies', () => {
  assert.deepEqual(Object.keys(p.ROUTES).sort(), [...p.KINDS].sort());
  for (const [requestKind, responseKind] of Object.entries(p.REPLY_KINDS)) {
    const request = f.envelope(requestKind), response = f.envelope(responseKind);
    p.validateEnvelope(request, context(requestKind)); p.validateEnvelope(response, context(responseKind));
    assert.deepEqual(p.validateResponse(request, response), response, requestKind);
    const differentSession = sign({ ...response, nodeSession: 'other-session', ...(Object.hasOwn(response.payload, 'nodeSession')
      ? { payload: { ...response.payload, nodeSession: 'other-session' } } : {}) });
    throws(() => p.validateResponse(request, differentSession), 'REPLY_SCOPE');
    if (response.payload.requestId) {
      const wrong = sign({ ...response, payload: { ...response.payload, requestId: 'wrong-request' } });
      throws(() => p.validateResponse(request, wrong), 'REPLY_REQUEST');
    }
  }
  for (const kind of ['origin.request', 'process.stop-request', 'handoff.intent', 'handoff.publish', 'handoff.observe-request', 'handoff.quarantine', 'snapshot.request']) {
    const e = f.envelope(kind);
    throws(() => p.validateEnvelope(e, context('submission')), 'DIRECTION_DENIED');
    const c = context(kind); c.principal.allowedKinds = ['session.open'];
    throws(() => p.validateEnvelope(e, c), 'PRINCIPAL_DENIED');
  }
  const stop = f.envelope('process.stop-request'), proof = f.envelope('process.stop-proof');
  const wrongBirth = sign({ ...proof, execution: { ...f.execution, controller: { ...f.execution.controller, creationFileTime: '133700000000000002' } } });
  throws(() => p.validateResponse(stop, wrongBirth), 'REPLY_BINDING');
  const pub = f.envelope('handoff.publish');
  const receipt = f.receipt({ validated: { envelope: pub }, operation: p.operationIdentity(pub) });
  const reply = f.envelope('result', { payload: receipt });
  p.validateResponse(pub, reply);
  throws(() => p.validateResponse(pub, sign({ ...reply, payload: { ...receipt, envelopeHash: '0'.repeat(64) } })), 'REPLY_REQUEST');
  const origin = p.toOriginProbeResult(f.envelope('origin.request'), f.envelope('origin.proof'), 'a1');
  assert.deepEqual(origin, { ticketId: f.execution.ticketId, attemptId: 'a1', verdict: 'owner', ownerSid: 'S-1-5-21-1001-1002-1003-1004', trusted: true });
  const mismatch = f.envelope('origin.proof', { payload: { ...f.payloads['origin.proof'], verdict: 'mismatch' } });
  assert.equal(p.toOriginProbeResult(f.envelope('origin.request'), mismatch, 'a1').trusted, false);
});

test('machine facts preserve exact readMachines inputs and unknown CPU/startup/missing heartbeat states', () => {
  const fact = f.payloads['machine.observation'];
  const snapshot = p.toLifecycleStatusSnapshot(fact.lifecycle);
  const heartbeat = snapshot.machines[0].heartbeat;
  assert.equal(heartbeat.protocol, 200); assert.equal(heartbeat.head, '1'.repeat(40));
  assert.equal(heartbeat.load.cores, 8); assert.equal(heartbeat.load.busyCores, 1.5);
  assert.equal(heartbeat.load.ci.state, 'active'); assert.deepEqual(heartbeat.load.ci.runners, ['synthetic-runner']);
  assert.deepEqual(heartbeat.jobSlots, { max: 4, running: 1 });
  assert.equal(heartbeat.load.memory.freeMb, 16384); assert.equal(heartbeat.attemptLoad.attempts[0].cores, 0.5);
  assert.equal(heartbeat.ciTreeLoad.cores, 1); assert.equal(snapshot.machines[0].counts.running, 1);
  const starting = f.copy(fact.lifecycle);
  starting.machines[0].heartbeat.load = { schema: 1, ci: { state: 'unknown', ciWorkers: 0, observedAt: f.at, stateSince: f.at } };
  assert.equal(p.toLifecycleStatusSnapshot(starting).machines[0].heartbeat.load.cores, undefined);
  const absent = f.copy(fact.lifecycle); absent.machines[0].heartbeat = null;
  absent.machines[0].fault = { kind: 'record-missing', reason: 'synthetic unavailable' };
  assert.equal(p.toLifecycleStatusSnapshot(absent).machines[0].heartbeat, undefined);
  for (const mutate of [v => { delete v.machines[0].heartbeat.protocol; }, v => { v.machines[0].heartbeat.head = ''; },
    v => { delete v.machines[0].heartbeat.load.busyPct; }, v => { v.machines[0].heartbeat.load.busyCores = 9; },
    v => { v.machines[0].heartbeat.load.memory.freeMb = 40000; }, v => { v.machines[0].heartbeat.jobSlots.running = 5; },
    v => { v.machines[0].heartbeat.machine = 'wrong'; }, v => { v.machines[0].counts.extra = 1; },
    v => { v.machines[0].heartbeat.load.ci.state = 'idle'; }, v => { v.machines = []; },
  ]) { const value = f.copy(fact.lifecycle); mutate(value); throws(() => p.validateLifecycleSnapshot(value)); }
  const c = context('machine.observation'); c.principal.machines = ['other'];
  throws(() => p.validateEnvelope(f.envelope('machine.observation'), c), 'MACHINE_DENIED');
});

test('resident hold renews directly after grant with real renewer birth and never becomes a managed execution', () => {
  const flow = require('../packages/scheduler/fixtures/protocol/resident-flow.cjs');
  assert.deepEqual(flow.map(e => e.kind), ['submission', 'state.snapshot', 'resident.renewal']);
  for (const e of flow) {
    p.validateEnvelope(e, context(e.kind));
    assert.equal(p.canonicalJson(e).includes('"controller"'), false);
  }
  assert.equal(flow[2].execution.source.submissionHash, p.contentHash(flow[0].payload));
  assert.equal(flow[2].execution.ticketId, flow[1].payload.attempts[0].ticketId);
  const renewal = f.envelope('resident.renewal');
  assert.equal(renewal.execution.stage, 'resident');
  assert.equal(Object.hasOwn(renewal.execution, 'controller'), false);
  assert.equal(renewal.payload.pid, renewal.execution.renewer.pid);
  p.validateEnvelope(renewal, context('resident.renewal'));
  throws(() => p.validateEnvelope(sign({ ...renewal, execution: f.execution }), context('resident.renewal')), 'ENUM');
  const c = { expectedIdentity: f.resident, sourceVerified: true, renewalFresh: false, applicationObservation: 'unknown',
    applicationBirthVerified: false, observationFresh: false, expectedApplicationBirth: null, observedApplicationBirth: null };
  assert.equal(p.evaluateResidentReservation(f.resident, c).retain, true);
  assert.equal(p.evaluateResidentReservation(f.resident, { ...c, applicationObservation: 'alive' }).retain, true);
  assert.equal(p.evaluateResidentReservation(f.resident, { ...c, applicationObservation: 'exit-confirmed', applicationBirthVerified: true, observationFresh: true }).retain, true);
  const birth = { pid: 6000, creationFileTime: '133700000000000004' };
  assert.equal(p.evaluateResidentReservation(f.resident, { ...c, applicationObservation: 'exit-confirmed', applicationBirthVerified: true,
    observationFresh: true, expectedApplicationBirth: birth, observedApplicationBirth: birth }).retain, false);
  assert.equal(p.evaluateResidentReservation(f.resident, { ...c, applicationObservation: 'exit-confirmed', applicationBirthVerified: true,
    observationFresh: true, expectedApplicationBirth: birth, observedApplicationBirth: { ...birth, creationFileTime: '133700000000000005' } }).retain, true);
});

test('handoff preserves real notStarted/null exit, refused and complete rerun plan without fake started identity', () => {
  const results = [
    { ok: false, exitCode: null, reason: 'synthetic start not confirmed', notStarted: { attemptId: 'a1', state: 'granted', waitedMs: 30000 },
      logFile: 'synthetic-machine/synthetic-job.log', machine: f.machine, command: 'synthetic observation only', finishedAt: f.at },
    { ok: false, exitCode: 2, reason: 'synthetic source stale', refused: 'executor-stale', finishedAt: f.at },
    { ok: false, exitCode: 1, reason: 'synthetic suspended timeout', rerunPlan: { complete: true,
      eligible: [{ identity: { file: 'test/synthetic.test.cjs', titlePath: ['synthetic case'], instanceIndex: 0 }, sourceSha256: '1'.repeat(64), overlapMs: 250 }],
      slowTimeouts: 1, otherTimeouts: 0, retainedFailures: 1, sharedHookTimeouts: 0, notes: ['synthetic evidence'] } },
  ];
  for (const result of results) {
    const e = f.envelope('handoff.observe', { payload: { ...f.payloads['handoff.observe'], state: 'failed', result } });
    assert.deepEqual(p.validateEnvelope(e, context('handoff.observe')).envelope.payload.result, result);
    assert.equal(e.execution.stage, 'granted'); assert.equal(Object.hasOwn(e.execution, 'controller'), false);
    throws(() => p.validateJobResult({ ...result, unknown: true }), 'UNKNOWN_FIELD');
  }
  throws(() => p.validateJobResult({ ...results[0], exitCode: 1 }), 'NOT_STARTED_RESULT');
  throws(() => p.validateJobResult({ ...results[1], exitCode: null }), 'REFUSED_RESULT');
  const wrong = f.envelope('handoff.observe', { payload: { ...f.payloads['handoff.observe'], state: 'failed', result: {
    ...results[0], notStarted: { ...results[0].notStarted, attemptId: 'a2' } } } });
  throws(() => p.validateEnvelope(wrong, context('handoff.observe')), 'NOT_STARTED_BINDING');
});

test('handoff discovers authenticated immutable artifact objects before the first bounded read', () => {
  const object = f.payloads['artifact.read'].object;
  const names = { state: 'zipped', manifest: `${f.execution.ticketId}--a1.json`,
    zip: `${f.execution.ticketId}--a1.zip`, zipBytes: object.size };
  const payload = { ...f.payloads['handoff.observe'], state: 'done', result: { ok: true, exitCode: 0, artifacts: names } };
  throws(() => p.validateRequest('handoff.observe', payload), 'ARTIFACT_DISCOVERY_REQUIRED');
  const refs = { state: 'ready', manifest: { ...object, objectId: 'synthetic-manifest' }, zip: object };
  const observed = f.envelope('handoff.observe', { payload: { ...payload, artifactObjects: refs } });
  p.validateEnvelope(observed, context('handoff.observe'));
  const discovered = p.validateResponse(f.envelope('handoff.observe-request'), observed).payload.artifactObjects.zip;
  const read = f.envelope('artifact.read', { execution: f.granted,
    payload: { requestId: 'synthetic-discovered-read', object: discovered, offset: 0, length: 4 } });
  assert.deepEqual(p.validateEnvelope(read, context('artifact.read')).envelope.payload.object, object);
  throws(() => p.validateRequest('handoff.observe', { ...payload, artifactObjects: { ...refs, zip: { ...object, size: object.size + 1 } } }), 'ARTIFACT_DISCOVERY_BINDING');
  throws(() => p.validateRequest('handoff.observe', { ...payload, artifactObjects: { state: 'ready', manifest: refs.manifest } }), 'ARTIFACT_DISCOVERY_BINDING');
  const unavailable = { state: 'unavailable', reason: 'synthetic artifact has not become readable' };
  assert.deepEqual(p.validateRequest('handoff.observe', { ...payload, artifactObjects: unavailable }).artifactObjects, unavailable);
});

test('empty queue authority reads need no ticket and preserve one immutable manifest/object version', () => {
  const manifest = f.payloads['projection.manifest'], read = f.payloads['projection.read'];
  const c = { ...f.trust(), now: f.at, maxObjectBytes: 1024 * 1024 };
  assert.equal(Object.hasOwn(f.envelope('projection.read'), 'execution'), false);
  assert.equal(p.authorizeProjectionRead(read, manifest, c).allowed, true);
  const verified = p.verifyProjectionObject(f.configBytes, read.entry, manifest, c);
  assert.equal(verified.domainValidated, false);
  assert.equal(JSON.parse(Buffer.from(verified.bytes)).machine, f.machine);
  assert.equal(p.authorizeProjectionRead(read, manifest, { ...c, now: manifest.expiresAt }).allowed, false);
  assert.equal(p.authorizeProjectionRead(read, { ...manifest, entries: [] }, c).allowed, false);
  assert.equal(p.authorizeProjectionRead({ ...read, snapshotId: 'other-version' }, manifest, c).allowed, false);
  throws(() => p.verifyProjectionObject(f.configBytes.subarray(0, -1), read.entry, manifest, c), 'OBJECT_HASH_OR_SIZE');
  const corrupt = Buffer.from(f.configBytes); corrupt[0] ^= 1;
  throws(() => p.verifyProjectionObject(corrupt, read.entry, manifest, c), 'OBJECT_HASH_OR_SIZE');
  const request = f.envelope('projection.read'), response = f.envelope('projection.chunk');
  const mixed = sign({ ...response, payload: { ...response.payload, snapshotId: 'other-version',
    entry: { ...response.payload.entry, snapshotId: 'other-version' } } });
  throws(() => p.validateResponse(request, mixed), 'REPLY_OBJECT_RANGE');
  const compatibility = p.dispatcherCompatibilityIdentity({ authorityHost: f.authorityHost, ownerMachine: f.machine,
    authorityPid: 900, protocol: 200, head: '1'.repeat(40), createdAt: f.at, createdBy: 'synthetic-operator' });
  assert.notEqual(compatibility.authorityHost, compatibility.ownerMachine);
  assert.equal(compatibility.dispatcherConfig.machine, f.machine); assert.equal(compatibility.heartbeatIdentity.machine, f.machine);
});

test('read directory discovers original complete queued/unsatisfiable/register-only/resident/terminal tickets', () => {
  const d = require('../packages/scheduler/fixtures/protocol/read-directory.cjs');
  p.validateReadManifest(d.manifest); p.validateReadManifest(d.emptyManifest);
  const c = { ...f.trust(), now: f.at, maxObjectBytes: 1024 * 1024 };
  for (const e of [d.ticketIndex, ...d.emptyManifest.entries]) {
    const verified = p.verifyProjectionObject(d.bodies.get(e.object.objectId), e, e === d.ticketIndex ? d.manifest : d.emptyManifest, c);
    const body = JSON.parse(Buffer.from(verified.bytes));
    if (e.kind === 'ticket-index') {
      p.validateObjectDirectory(body);
      assert.equal(body.entries.length, e === d.ticketIndex ? 7 : 0);
      throws(() => p.validateObjectDirectory({ ...body, snapshotId: 'other-version', entries: [d.manifest.entries[0]] }), 'MANIFEST_VERSION');
    } else { assert.equal(body.machine, f.machine); assert.equal(body.queued, 0); assert.deepEqual(body.queue, []); }
  }
  for (const entry of d.manifest.entries.filter(e => e.kind === 'ticket')) {
    const verified = p.verifyProjectionObject(d.bodies.get(entry.object.objectId), entry, d.manifest, c);
    const ticket = JSON.parse(Buffer.from(verified.bytes));
    assert.equal(verified.domainValidated, false);
    assert.equal(ticket.ticketId, entry.ticketId); assert.equal(ticket.contentHash, p.contentHash(ticket.request));
    assert.equal(ticket.ticketId, `tk-${p.contentHash([ticket.request.project, ticket.request.idempotencyKey]).slice(0, 20)}`);
    assert.equal(Array.isArray(ticket.attempts), true); assert.equal(Array.isArray(ticket.timeline), true);
    assert.equal(typeof ticket.cancelRequested, 'boolean'); assert.equal(typeof ticket.request.work.type, 'string');
    for (const event of ticket.timeline) {
      const { sha256, ...withoutChecksum } = event;
      assert.equal(sha256, p.contentHash(withoutChecksum));
      assert.equal(event.ticketId, ticket.ticketId); assert.equal(event.seq <= entry.ledgerCursor.seq, true);
    }
    if (ticket.attempts[0].permit) {
      assert.equal(ticket.attempts[0].permit.machine, f.machine);
      assert.equal(ticket.attempts[0].permit.category, ticket.request.category);
    }
  }
  assert.equal(d.tickets.some(t => t.state === 'queued'), true); assert.equal(d.tickets.some(t => t.state === 'unsatisfiable'), true);
  assert.equal(d.tickets.some(t => t.registerOnly === true), true); assert.equal(d.tickets.some(t => t.request.resident === true), true);
  assert.equal(d.tickets.some(t => t.endedAt !== null), true); assert.deepEqual(d.heartbeat.queue, []);
  const node = { ...c, principal: { ...c.principal, readAccess: { role: 'node', machine: f.machine, projects: ['synthetic-project'], authorityKinds: ['dispatcher-heartbeat'] } } };
  const entry = d.manifest.entries.find(e => e.kind === 'ticket');
  const request = { requestId: 'synthetic-read-ticket', scope: d.manifest.scope, snapshotId: entry.snapshotId,
    ledgerCursor: entry.ledgerCursor, entry, offset: 0, length: 1 };
  assert.equal(p.authorizeProjectionRead(request, d.manifest, node).allowed, true);
  assert.equal(p.authorizeProjectionRead(request, d.manifest, { ...node, principal: { ...node.principal,
    readAccess: { ...node.principal.readAccess, projects: ['other-project'] } } }).allowed, false);
  const ownerEntry = { ...entry, audience: { kind: 'owner' } };
  assert.equal(p.authorizeProjectionRead({ ...request, entry: ownerEntry }, { ...d.manifest, entries: [ownerEntry] }, node).allowed, false);
});

test('local semantic IPC cannot supply transport identities or native reports; original source is hash bound', () => {
  const submit = { kind: 'submit', callId: 'synthetic-local-call', request: f.payloads.submission, localContext: { cwd: 'C:/path/to/worktree' } };
  assert.deepEqual(p.validateLocalSemanticRequest(submit), submit);
  const { localContext, ...missingContext } = submit;
  throws(() => p.validateLocalSemanticRequest(missingContext), 'MISSING');
  throws(() => p.validateLocalSemanticRequest({ ...submit, localContext: { cwd: 'relative-tree' } }), 'LOCAL_CWD');
  const r = f.payloads['projection.read'];
  const localRead = { kind: 'read-object', callId: 'synthetic-local-read', snapshotId: r.snapshotId,
    ledgerCursor: r.ledgerCursor, entry: r.entry, offset: r.offset, length: r.length };
  assert.deepEqual(p.validateLocalSemanticRequest(localRead), localRead);
  throws(() => p.validateLocalSemanticRequest({ ...localRead, path: 'arbitrary' }), 'UNKNOWN_FIELD');
  throws(() => p.validateLocalSemanticRequest({ ...localRead, offset: r.entry.object.size }), 'OBJECT_RANGE');
  p.validateLocalSemanticRequest({ kind: 'read', callId: 'synthetic-memory-state', selectors: [{ kind: 'memory-floor', view: 'state' }], snapshotId: null, pageToken: null });
  throws(() => p.validateLocalSemanticRequest({ kind: 'read', callId: 'synthetic-memory-state', selectors: [{ kind: 'memory-floor' }], snapshotId: null, pageToken: null }), 'MISSING');
  for (const key of ['nodeSession', 'sequence', 'messageId', 'principal', 'callerSid', 'source']) {
    throws(() => p.validateLocalSemanticRequest({ ...submit, [key]: 'self-claimed' }), 'UNKNOWN_FIELD');
  }
  throws(() => p.validateLocalSemanticRequest({ kind: 'report.started', callId: 'synthetic-local-call' }), 'ENUM');
  const c = context('origin.proof'); delete c.principal.nativeObservation;
  throws(() => p.validateEnvelope(f.envelope('origin.proof'), c), 'NATIVE_NODE_REQUIRED');
  const wrong = f.envelope('origin.proof', { payload: { ...f.payloads['origin.proof'], source: { ...f.source, submissionHash: '0'.repeat(64) } } });
  throws(() => p.validateEnvelope(wrong, context('origin.proof')), 'SUBMISSION_SOURCE_BINDING');
  const { source: knownSource, ...requestWithoutSource } = f.payloads['origin.request'];
  const initialProbe = f.envelope('origin.request', { payload: requestWithoutSource });
  p.validateEnvelope(initialProbe, context('origin.request'));
  assert.deepEqual(p.validateResponse(initialProbe, f.envelope('origin.proof')).payload.source, knownSource);
  const { observedOwnerSid: missingSid, ...unknownFields } = f.payloads['origin.proof'];
  const unknown = f.envelope('origin.proof', { payload: { ...unknownFields, verdict: 'unknown', source: null, detail: 'synthetic original unavailable' } });
  p.validateEnvelope(unknown, context('origin.proof'));
  assert.equal(p.toOriginProbeResult(initialProbe, unknown, 'a1').verdict, 'failed');
  throws(() => p.validateRequest('origin.proof', { ...unknown.payload, verdict: 'verified', observedOwnerSid: missingSid }), 'ENUM');
});

test('local execution intent preserves argv and worktree without accepting native identity or SSH use', () => {
  const run = { kind: 'local-run', callId: 'synthetic-run', submission: f.submissionIdentity,
    command: 'node', args: ['-e', 'process.exit(7)', '', 'space argument'], cwd: 'C:/path/to/worktrees/task', env: { PATH: 'C:/path/to/node', EMPTY: '' } };
  assert.deepEqual(p.validateLocalSemanticRequest(run), run);
  for (const key of ['pid', 'controller', 'permitToken', 'source', 'callerSid', 'lease']) {
    throws(() => p.validateLocalSemanticRequest({ ...run, [key]: 'self-claimed' }), 'UNKNOWN_FIELD');
  }
  throws(() => p.validateLocalSemanticRequest({ ...run, submission: f.execution }), 'ENUM');
  throws(() => p.validateLocalSemanticRequest({ ...run, cwd: 'C:relative' }), 'LOCAL_CWD');
  throws(() => p.validateLocalSemanticRequest({ ...run, args: ['bad\0argument'] }), 'LOCAL_NUL');
  throws(() => p.validateLocalSemanticRequest({ ...run, env: { 'A=B': 'x' } }), 'LOCAL_ENV');
  assert.equal(p.KINDS.includes('local-run'), false);
  throws(() => p.validateRequest('local-run', run));
  const read = { kind: 'local-run-read', callId: 'synthetic-read', runId: 'synthetic-run', stdoutOffset: 2, stderrOffset: 0, maxBytes: 65536, waitMs: 1000 };
  assert.deepEqual(p.validateLocalSemanticRequest(read), read);
  throws(() => p.validateLocalSemanticRequest({ ...read, maxBytes: 65537 }), 'INTEGER');
  throws(() => p.validateLocalSemanticRequest({ ...read, waitMs: 1001 }), 'INTEGER');
  assert.deepEqual(p.validateLocalSemanticRequest({ kind: 'local-run-cancel', callId: 'synthetic-cancel', runId: run.callId }),
    { kind: 'local-run-cancel', callId: 'synthetic-cancel', runId: run.callId });
});

test('local output offsets are bounded and terminal results retain failure and unknown exit semantics', () => {
  const empty = { offset: 0, nextOffset: 0, bytesBase64: '' };
  const reply = { kind: 'execution', runId: 'synthetic-run', state: 'terminal', stdout: { offset: 3, nextOffset: 6, bytesBase64: Buffer.from('out').toString('base64') },
    stderr: { offset: 0, nextOffset: 3, bytesBase64: Buffer.from('err').toString('base64') }, terminal: { ok: false, exitCode: 7, reason: 'child failed' } };
  assert.deepEqual(p.validateLocalExecutionReply(reply), reply);
  const notStarted = { ok: false, exitCode: null, notStarted: { attemptId: 'a1', state: 'granted', waitedMs: 10 } };
  assert.deepEqual(p.validateLocalExecutionReply({ ...reply, terminal: notStarted }).terminal, notStarted);
  throws(() => p.validateLocalExecutionReply({ ...reply, terminal: { ok: true, exitCode: null } }), 'LOCAL_TERMINAL');
  throws(() => p.validateLocalExecutionReply({ ...reply, terminal: { ok: true } }), 'LOCAL_TERMINAL');
  throws(() => p.validateLocalExecutionReply({ ...reply, state: 'running' }), 'LOCAL_TERMINAL');
  throws(() => p.validateLocalExecutionReply({ ...reply, stdout: { ...reply.stdout, nextOffset: 7 } }), 'LOCAL_OUTPUT_RANGE');
  throws(() => p.validateLocalExecutionReply({ ...reply, stderr: { ...empty, bytesBase64: '***' } }), 'LOCAL_OUTPUT_RANGE');
  const large = { offset: 0, nextOffset: 40000, bytesBase64: Buffer.alloc(40000).toString('base64') };
  throws(() => p.validateLocalExecutionReply({ ...reply, stdout: large, stderr: large }), 'LOCAL_OUTPUT_LIMIT');
});

test('native release requires started business ACK, current projection, native clock lease and one release', () => {
  const started = f.envelope('report.started');
  const prepared = { validated: { envelope: started }, operation: p.operationIdentity(started) };
  const ack = f.receipt(prepared), c = f.leaseContext(), lease = p.evaluateExecutionLease(f.payloads['lease.renewal'], c);
  assert.equal(lease.allowed, true);
  const projectionContext = { ...c, freshness: c.facts, minLedgerSeq: 10, minBusinessCursor: 10, minSessionWatermark: 1, minLiveWatermark: 20 };
  const input = { started, ack, projection: f.payloads['state.snapshot'], lease };
  const releaseContext = { releaseConsumed: false, projectionContext, executionContext: c };
  assert.equal(p.evaluateNativeRelease(input, releaseContext).allowed, true);
  const newerProjection = { ...input.projection, ledgerSeq: 11, businessCursor: { seq: 11, hash: '4'.repeat(64) } };
  const newerContext = { ...c, minLedgerSeq: 11, challengeRecord: { ...c.challengeRecord, ledgerSeq: 11 } };
  const newerLease = p.evaluateExecutionLease({ ...f.payloads['lease.renewal'], ledgerSeq: 11 }, newerContext);
  assert.equal(newerLease.allowed, true);
  assert.equal(p.evaluateNativeRelease({ ...input, projection: newerProjection, lease: newerLease },
    { ...releaseContext, executionContext: newerContext }).allowed, true);
  assert.equal(p.evaluateNativeRelease({ ...input, projection: newerProjection }, releaseContext).allowed, false);
  assert.equal(p.evaluateNativeRelease({ ...input, projection: { ...input.projection,
    businessCursor: { ...input.projection.businessCursor, hash: '4'.repeat(64) } } }, releaseContext).allowed, false);
  assert.equal(p.evaluateNativeRelease({ ...input, projection: { ...newerProjection,
    attempts: newerProjection.attempts.map(a => ({ ...a, cancelRequested: true })) }, lease: newerLease },
    { ...releaseContext, executionContext: newerContext }).allowed, false);
  assert.equal(p.evaluateNativeRelease({ ...input, ack: f.receipt(prepared, 'durably_received') }, releaseContext).allowed, false);
  assert.equal(p.evaluateNativeRelease({ ...input, projection: { ...input.projection, businessCursor: { seq: 9, hash: '3'.repeat(64) } } }, releaseContext).allowed, false);
  const grantedProjection = { ...input.projection, attempts: [{ ...f.granted, state: 'granted', cancelRequested: false, grantedCores: 2, permitLedgerSeq: 9 }] };
  assert.equal(p.evaluateNativeRelease({ ...input, projection: grantedProjection }, releaseContext).allowed, false);
  assert.equal(p.evaluateNativeRelease(input, { ...releaseContext, releaseConsumed: true }).allowed, false);
  assert.equal(p.evaluateExecutionLease(f.payloads['lease.renewal'], { ...c, clockDomain: 'node-performance' }).allowed, false);
  assert.equal(p.evaluateActiveExecutionLease(lease, { ...c, nowMonotonicMs: 1800, lastMonotonicMs: 1500 }).allowed, false);
  assert.equal(p.evaluateNativeRelease(input, { ...releaseContext, projectionContext: { ...projectionContext, clockDomain: 'node-performance' } }).allowed, false);
});
