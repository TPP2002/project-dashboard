'use strict';
const s = require('./schema.cjs');
const b = require('./business.cjs');
const identities = require('./identities.cjs');
const machineFacts = require('./machine-facts.cjs');
const { jobResult } = require('./job-result.cjs');
const { sourceProof } = require('./resident.cjs');
const reads = require('./read-manifest.cjs');
const { fail } = require('./json.cjs');
const PROTOCOL_VERSION = 'scheduler-remote.v1';
const DEFAULT_LEASE_TTL_MS = 30000;
const MAX_LEASE_TTL_MS = 60000;
const executionFields = identities.startedFields;
const scopeFields = { authorityId: s.id, authorityEpoch: s.positive, nodeId: s.id, nodeSession: s.id };
const binding = s.fields(executionFields);
const objectRef = s.fields({ objectId: s.id, hash: s.hash, size: s.count });
const cursor = (v, p) => {
  s.fields({ seq: s.count, hash: s.nullable(s.hash) })(v, p);
  if ((v.seq === 0) !== (v.hash === null)) fail('CURSOR', p);
};
const lease = s.fields({ ...scopeFields, ...executionFields, ledgerSeq: s.positive, challenge: s.id, challengeSequence: s.positive,
  leaseId: s.id, leaseSequence: s.positive, ttlMs: s.integer(1, MAX_LEASE_TTL_MS), gatewayInstance: s.id, nodeInstance: s.id });
const projection = (v, p) => {
  s.fields({ ...scopeFields, authorityHost: s.id, ownerMachine: s.segment, gatewayInstance: s.id, nodeInstance: s.id,
    snapshotId: s.id, complete: s.enumeration([true]), ledgerSeq: s.count, businessCursor: cursor,
    requestId: s.id,
    sessionWatermark: s.positive, liveWatermark: s.count, generatedAt: s.iso,
    attempts: s.list((a, path) => {
      s.enumeration(['granted', 'started'])(a?.stage, `${path}.stage`);
      const fields = a.stage === 'granted' ? identities.grantedFields : identities.startedFields;
      s.fields({ ...fields, state: s.enumeration(a.stage === 'granted' ? ['granted', 'passed', 'failed', 'voided', 'cancelled']
        : ['running', 'paused', 'slow', 'passed', 'failed', 'voided', 'cancelled']), grantedCores: s.positive, permitLedgerSeq: s.positive, cancelRequested: s.bool })(a, path);
    }, 0, 1024),
  })(v, p);
  if (v.businessCursor.seq > v.ledgerSeq) fail('CURSOR', p);
  const keys = new Set();
  for (const a of v.attempts) {
    if (a.permitLedgerSeq > v.ledgerSeq || keys.has(a.ticketId)) fail('PROJECTION_ATTEMPT', p);
    keys.add(a.ticketId);
  }
};
const outcome = (v, p) => {
  s.fields({ kind: s.enumeration(['submission', 'command', 'report', 'applied', 'object']) }, {
    ticketId: s.ticketId, commandId: s.segment, attemptId: s.attemptId, phase: s.enumeration(['started', 'finished']), object: objectRef,
  })(v, p);
  const shapes = {
    submission: { kind: s.enumeration(['submission']), ticketId: s.ticketId },
    command: { kind: s.enumeration(['command']), commandId: s.segment },
    report: { kind: s.enumeration(['report']), ticketId: s.ticketId, attemptId: s.attemptId, phase: s.enumeration(['started', 'finished']) },
    applied: { kind: s.enumeration(['applied']) }, object: { kind: s.enumeration(['object']), object: objectRef },
  };
  s.fields(shapes[v.kind])(v, p);
};
const result = (v, p) => {
  const base = { messageId: s.id, envelopeHash: s.hash, operationKey: s.nullable(s.text(1024)), operationHash: s.nullable(s.hash),
    status: s.enumeration(['durably_received', 'business_accepted', 'business_rejected', 'business_pending']) };
  const variants = {
    durably_received: { durableSeq: s.positive },
    business_accepted: { businessCursor: cursor, outcome },
    business_rejected: { businessCursor: cursor, reason: s.text() },
    business_pending: { businessCursor: cursor, reason: s.text(), retryAfterMs: s.integer(1, 60000) },
  };
  s.enumeration(Object.keys(variants))(v?.status, `${p}.status`);
  s.fields({ ...base, ...variants[v.status] })(v, p);
  if ((v.operationKey === null) !== (v.operationHash === null)) fail('OPERATION_PAIR', p);
};
const read = (v, p) => {
  s.fields({ requestId: s.id, object: objectRef, offset: s.count, length: s.integer(1, 131072) })(v, p);
  if (v.offset > v.object.size || v.length > v.object.size - v.offset) fail('OBJECT_RANGE', p);
};
const chunk = (v, p) => {
  s.fields({ requestId: s.id, object: objectRef, offset: s.count, length: s.integer(1, 131072), dataBase64: s.text(174764), chunkHash: s.hash })(v, p);
  read({ requestId: v.requestId, object: v.object, offset: v.offset, length: v.length }, p);
  const raw = Buffer.from(v.dataBase64, 'base64');
  if (raw.toString('base64') !== v.dataBase64 || raw.length !== v.length || require('node:crypto').createHash('sha256').update(raw).digest('hex') !== v.chunkHash) fail('CHUNK_HASH', p);
};
const handoffIdentity = { submissionId: s.segment, ownerMachine: s.segment, authorityHost: s.id, intentId: s.id, lifecycleEpoch: s.segment };
const lifecycleIdentity = s.fields({ namespace: s.enumeration(['jobs-v12']), lifecycleSchema: s.enumeration([12]), epoch: s.segment,
  jobId: s.segment, submissionId: s.segment, machine: s.segment, codeVersion: s.sha1, createdAt: s.iso, createdBy: s.text(256), payloadSha256: s.hash });
const requestFields = { requestId: s.id, timeoutMs: s.integer(1, 60000) };
const permit = s.fields({ ticketId: s.ticketId, attemptId: s.attemptId, token: s.text(256), machine: s.segment,
  category: s.category, grantedCores: s.positive, issuedAt: s.iso }, { ciAware: s.literalTrue, resident: s.literalTrue });
const snapshot = (v, p) => {
  const base = { schema: s.enumeration([1]), ticketId: s.ticketId, attemptId: s.attemptId, requestId: s.id,
    state: s.enumeration(['ready', 'refused']), createdAt: s.iso };
  s.enumeration(['ready', 'refused'])(v?.state, `${p}.state`);
  s.fields({ ...base, ...(v.state === 'ready' ? { commit: s.sha1, base: s.sha1, object: objectRef,
    bundle: s.pattern(/^tk-[0-9a-f]{20}\.bundle$/), bundleBytes: s.positive } : { reason: s.text(64), detail: s.text(500) }) })(v, p);
  if (v.state === 'ready' && (v.bundle !== `${v.ticketId}.bundle` || v.bundleBytes !== v.object.size)) fail('SNAPSHOT_OBJECT', p);
};
const rerunCase = s.fields({ identity: s.fields({ file: s.text(1024), titlePath: s.list(s.text(1024), 1, 64), instanceIndex: s.count }), sourceSha256: s.hash });
const publication = (v, p) => {
  s.fields({ ...handoffIdentity, ...requestFields, expected: lifecycleIdentity, codeRef: s.codeRef, snapshot: s.nullable(snapshot), grantedCores: s.positive,
    createdAt: s.iso, submission: b.submission, permit,
  }, { queueRank: s.fields({ band: s.enumeration([0, 1]), queuedAt: s.iso }), rerun: s.fields({ selection: s.list(rerunCase, 1, 1024) }) })(v, p);
  if (v.snapshot && v.snapshot.state !== 'ready') fail('SNAPSHOT_NOT_READY', p);
  if (v.expected.codeVersion !== v.codeRef.value || v.expected.createdAt !== v.createdAt || v.expected.createdBy !== v.submission.submitter) fail('HANDOFF_EXPECTED_IDENTITY', p);
  if (!['cluster', 'auto'].includes(v.submission.execution) || v.codeRef.kind !== 'commit' ||
    v.submission.execution === 'cluster' && (v.submission.codeRef.kind !== 'commit' || v.codeRef.value !== v.submission.codeRef.value ||
      !v.submission.allowedMachines.includes(v.permit.machine)) ||
    v.submission.execution === 'auto' && v.permit.machine === v.submission.origin ||
    v.permit.machine !== v.ownerMachine || v.permit.grantedCores !== v.grantedCores || v.permit.category !== v.submission.category ||
    v.submission.execution === 'auto' && (!v.snapshot || v.codeRef.value !== v.snapshot.commit)) fail('HANDOFF_PUBLICATION', p);
};
const schemas = {
  'session.open': s.fields({ replacesSession: s.nullable(s.id), sessionGeneration: s.positive }),
  submission: b.submission,
  command: b.command,
  'report.started': b.started,
  'report.finished': b.finished,
  'waiting.upsert': s.fields({ schema: s.enumeration([1]), ticketId: s.ticketId, machine: s.segment, pid: s.pid, seq: s.count }),
  'waiting.delete': s.fields({ schema: s.enumeration([1]), ticketId: s.ticketId, machine: s.segment, seq: s.count }),
  'execution.heartbeat': b.heartbeat,
  'resident.renewal': s.fields({ schema: s.enumeration([1]), ticketId: s.ticketId, machine: s.segment, cores: s.positive, pid: s.pid, at: s.iso }),
  'origin.request': s.fields({ ...requestFields, machine: s.segment, codeRef: s.codeRef, project: s.text(128) }, { source: sourceProof }),
  'origin.proof': (v, p) => {
    s.enumeration(['verified', 'mismatch', 'unknown'])(v?.verdict, `${p}.verdict`);
    s.fields({ machine: s.segment, requestId: s.id, observationSequence: s.positive, observedAt: s.iso,
      verdict: s.enumeration(['verified', 'mismatch', 'unknown']), ownerMachine: s.segment, codeRef: s.codeRef,
      source: v.verdict === 'unknown' ? s.nullable(sourceProof) : sourceProof,
      ...(v.verdict === 'unknown' ? { detail: s.text(500) } : { observedOwnerSid: s.pattern(/^S-1-[0-9]+(?:-[0-9]+){1,15}$/) }),
    })(v, p);
  },
  'machine.observation': machineFacts.observation,
  'process.stop-request': s.fields({ ...requestFields, machine: s.segment, action: s.enumeration(['observe', 'stop']), reason: s.text() }),
  'process.stop-proof': s.fields({ machine: s.segment, requestId: s.id, observationSequence: s.positive, observedAt: s.iso,
    verdict: s.enumeration(['tree-exited', 'alive', 'unknown']), method: s.enumeration(['windows-job-object']), evidenceHash: s.hash }),
  'handoff.intent': publication,
  'handoff.publish': publication,
  'handoff.observe-request': s.fields({ ...handoffIdentity, ...requestFields, expected: lifecycleIdentity }, { legacyIdentities: s.list(lifecycleIdentity, 0, 8) }),
  'handoff.observe': s.fields({ ...handoffIdentity, requestId: s.id, observationSequence: s.positive, observedAt: s.iso,
    state: s.enumeration(['absent', 'inbox', 'claim', 'transition', 'running', 'done', 'failed', 'quarantine', 'unknown']),
    identity: s.nullable(lifecycleIdentity),
  }, { result: jobResult, exitCode: s.nullable(s.integer(-2147483648, 2147483647)), log: objectRef,
    executionProcess: s.fields({ pid: s.pid, createdAt: s.text(128) }), payloadHash: s.hash, resultObject: objectRef }),
  'handoff.quarantine': s.fields({ ...handoffIdentity, ...requestFields, expected: lifecycleIdentity, reason: s.text(), createdAt: s.iso }),
  'snapshot.request': s.fields({ ...requestFields, machine: s.segment, project: s.text(128), codeRef: s.codeRef }),
  'snapshot.metadata': snapshot,
  'launch.notice': s.fields({ schema: s.enumeration([1]), ticketId: s.ticketId, attemptId: s.attemptId, submissionId: s.segment,
    machine: s.segment, token: s.text(256), launchedAt: s.iso }),
  'artifact.read': read, 'log.read': read, 'artifact.chunk': chunk, 'log.chunk': chunk,
  'state.read': s.fields({ requestId: s.id, afterCursor: cursor, limit: s.integer(1, 1024) }, { ticketId: s.ticketId }),
  'state.snapshot': projection,
  'lease.challenge': s.fields({ challenge: s.id, challengeSequence: s.positive, ledgerSeq: s.positive,
    requestedTtlMs: s.integer(1, MAX_LEASE_TTL_MS), gatewayInstance: s.id, nodeInstance: s.id }),
  'lease.renewal': lease,
  'projection.catalog': reads.catalog, 'projection.manifest': reads.manifest, 'projection.read': reads.read, 'projection.chunk': reads.chunk,
  result,
};
const KINDS = Object.freeze(Object.keys(schemas));
const IMMUTABLE_KINDS = Object.freeze(['submission', 'command', 'report.started', 'report.finished', 'handoff.intent', 'handoff.publish', 'handoff.quarantine', 'snapshot.metadata', 'launch.notice']);
const LIVE_ONLY_KINDS = Object.freeze(['waiting.upsert', 'waiting.delete', 'execution.heartbeat', 'resident.renewal', 'origin.proof', 'machine.observation', 'process.stop-proof', 'handoff.observe', 'lease.challenge', 'lease.renewal']);
const EXECUTION_KINDS = Object.freeze(Object.keys(identities.BINDING_STAGES));
function validateRequest(kind, input) {
  if (typeof kind !== 'string' || !Object.hasOwn(schemas, kind)) fail('UNKNOWN_KIND');
  return s.validate(schemas[kind], input);
}
module.exports = { PROTOCOL_VERSION, DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS, KINDS, IMMUTABLE_KINDS, LIVE_ONLY_KINDS, EXECUTION_KINDS,
  validateRequest, validateResult: input => s.validate(result, input), validateLease: input => s.validate(lease, input),
  validateProjection: input => s.validate(projection, input), executionFields, scopeFields, binding,
  BINDING_STAGES: identities.BINDING_STAGES, bindingForKind: identities.bindingForKind };
