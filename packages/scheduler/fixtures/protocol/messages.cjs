'use strict';
// Synthetic examples only. These are data builders, never implementations of a cloud/gateway/node port.
const p = require('../../src/protocol/contract.cjs');
const scenario = require('./scenario.json');
const copy = v => JSON.parse(JSON.stringify(v));
const { scope, machine, authorityHost, at, clockId } = scenario;
const execution = { stage: 'started', ...scenario.execution };
const granted = { stage: 'granted', ticketId: execution.ticketId, attemptId: execution.attemptId, permitToken: execution.permitToken };
const codeRef = { kind: 'commit', value: '1'.repeat(40) };
const object = { objectId: 'synthetic-object', hash: '2'.repeat(64), size: 8192 };
const cursor = { seq: 10, hash: '3'.repeat(64) };
const handoff = { submissionId: `${execution.ticketId}--${execution.attemptId}`, ownerMachine: machine, authorityHost, intentId: 'synthetic-intent', lifecycleEpoch: 'synthetic-lifecycle-epoch' };
const lifecycleIdentity = { namespace: 'jobs-v12', lifecycleSchema: 12, epoch: handoff.lifecycleEpoch, jobId: handoff.submissionId,
  submissionId: handoff.submissionId, machine, codeVersion: codeRef.value, createdAt: at, createdBy: 'synthetic-actor', payloadSha256: '7'.repeat(64) };
const snapshot = { schema: 1, ticketId: execution.ticketId, attemptId: execution.attemptId, requestId: 'synthetic-snapshot-request',
  state: 'ready', commit: codeRef.value, base: '5'.repeat(40), object, bundle: `${execution.ticketId}.bundle`, bundleBytes: object.size, createdAt: at };
const submission = { idempotencyKey: 'synthetic-submit', project: 'synthetic-project', submitter: 'synthetic-actor',
  category: 'unit-test', title: 'Synthetic bounded job', work: { type: 'test:targeted', targetPaths: ['test/synthetic.test.cjs'], workers: 1 },
  requestedCores: 2, allowedMachines: [machine], codeRef, resources: { exclusive: [] }, createdAt: at, execution: 'cluster' };
const submissionIdentity = { stage: 'submission', ticketId: execution.ticketId, submissionHash: p.contentHash(submission), project: submission.project };
const source = { proofId: 'synthetic-source-proof', submissionHash: submissionIdentity.submissionHash,
  observedOwnerSid: 'S-1-5-21-1001-1002-1003-1004', method: 'original-object-acl',
  originalObject: { objectId: 'synthetic-original-submission', hash: p.contentHash(submission), size: Buffer.byteLength(p.canonicalJson(submission)) } };
const residentSubmission = { ...submission, execution: undefined, resident: true, category: 'other' };
delete residentSubmission.execution;
const residentSource = { ...source, submissionHash: p.contentHash(residentSubmission),
  originalObject: { objectId: 'synthetic-original-resident', hash: p.contentHash(residentSubmission), size: Buffer.byteLength(p.canonicalJson(residentSubmission)) } };
const resident = { ...granted, stage: 'resident', renewer: { pid: 4244, creationFileTime: '133700000000000003' }, source: residentSource };
const permit = { ticketId: execution.ticketId, attemptId: execution.attemptId, token: execution.permitToken, machine,
  category: submission.category, grantedCores: 2, issuedAt: at, ciAware: true };
const publication = { ...handoff, requestId: 'synthetic-publish', timeoutMs: 10000, expected: lifecycleIdentity, codeRef, snapshot, grantedCores: 2,
  createdAt: at, submission, permit, queueRank: { band: 0, queuedAt: at } };
const lifecycle = { control: { namespace: 'jobs-v12', lifecycleSchema: 12, epoch: handoff.lifecycleEpoch, state: 'ACTIVE',
  codeVersion: codeRef.value, configuredMachines: [machine], createdAt: at, createdBy: 'synthetic-actor' },
  machines: [{ machine, heartbeat: { machine, state: 'running', at, pid: 4200, protocol: 200, head: codeRef.value, ownerPid: 4201,
    ownerToken: 'synthetic-lifecycle-owner', load: { schema: 1, ci: { state: 'active', ciWorkers: 1, observedAt: at, stateSince: at,
      runners: ['synthetic-runner'] }, cores: 8, busyCores: 1.5, busyPct: 18.75, windowSec: 30, sampledAt: at,
      memory: { totalMb: 32768, freeMb: 16384, windowSec: 30, sampledAt: at } },
    jobSlots: { max: 4, running: 1 }, attemptLoad: { schema: 1, sampledAt: at, windowSec: 30,
      attempts: [{ ticketId: execution.ticketId, attemptId: execution.attemptId, cores: 0.5 }] },
    ciTreeLoad: { schema: 1, sampledAt: at, windowSec: 30, cores: 1, workers: 1 } },
    counts: { inbox: 0, running: 1, done: 2, failed: 0, quarantine: 0 } }] };
const challenge = { challenge: 'synthetic-challenge', challengeSequence: 4, ledgerSeq: 10, requestedTtlMs: 30000, gatewayInstance: scope.gatewayInstance, nodeInstance: scope.nodeInstance };
const lease = { ...scope, ...execution, ledgerSeq: 10, challenge: challenge.challenge, challengeSequence: 4,
  leaseId: 'synthetic-lease', leaseSequence: 8, ttlMs: 30000 };
const projection = { ...scope, authorityHost, ownerMachine: machine, requestId: 'synthetic-state', snapshotId: 'synthetic-snapshot', complete: true,
  ledgerSeq: 10, businessCursor: cursor, sessionWatermark: 1, liveWatermark: 20, generatedAt: at,
  attempts: [{ ...execution, state: 'running', grantedCores: 2, permitLedgerSeq: 9, cancelRequested: false }] };
const readScope = { kind: 'authority-read', authorityId: scope.authorityId, authorityEpoch: scope.authorityEpoch };
const configBytes = Buffer.from(p.canonicalJson({ machine, createdAt: at, createdBy: 'synthetic-actor' }));
const configObject = { objectId: 'synthetic-dispatcher-config', hash: require('node:crypto').createHash('sha256').update(configBytes).digest('hex'), size: configBytes.length };
const configEntry = { kind: 'dispatcher-config', snapshotId: 'synthetic-read-version-1', ledgerCursor: cursor, object: configObject,
  audience: { kind: 'authority' }, contentType: 'application/json' };
const readManifest = { requestId: 'synthetic-catalog', scope: readScope, snapshotId: configEntry.snapshotId, ledgerCursor: cursor,
  issuedAt: at, expiresAt: '2030-01-02T03:05:05.000Z', entries: [configEntry], nextPageToken: null };
const projectionRead = { requestId: 'synthetic-read', scope: readScope, snapshotId: configEntry.snapshotId, ledgerCursor: cursor,
  entry: configEntry, offset: 0, length: configBytes.length };
const payloads = {
  'session.open': { replacesSession: null, sessionGeneration: 1 },
  submission,
  command: { commandId: 'synthetic-command', kind: 'cancel', data: { ticketId: execution.ticketId, reason: 'synthetic cancellation' },
    submitter: 'synthetic-actor', createdAt: at, expiresAt: '2030-01-02T03:05:05.000Z' },
  'report.started': { ticketId: execution.ticketId, attemptId: execution.attemptId, token: execution.permitToken, machine, at,
    phase: 'started', pid: execution.controller.pid, creationFileTime: execution.controller.creationFileTime, codeRef },
  'report.finished': { ticketId: execution.ticketId, attemptId: execution.attemptId, token: execution.permitToken, machine, at,
    phase: 'finished', result: 'passed', reason: 'synthetic completion' },
  'waiting.upsert': { schema: 1, ticketId: execution.ticketId, machine, pid: execution.controller.pid, seq: 1 },
  'waiting.delete': { schema: 1, ticketId: execution.ticketId, machine, seq: 2 },
  'execution.heartbeat': { ticketId: execution.ticketId, attemptId: execution.attemptId, machine, at,
    token: execution.permitToken, childPid: 4243, suspend: { sequence: 1, at: 1000, mode: 'running', reasons: [], ended: false, intervals: [], slowIntervals: [], alert: null } },
  'resident.renewal': { schema: 1, ticketId: execution.ticketId, machine, cores: 2, pid: resident.renewer.pid, at },
  'origin.proof': { machine, requestId: 'synthetic-origin', observationSequence: 1, observedAt: at, verdict: 'verified',
    observedOwnerSid: 'S-1-5-21-1001-1002-1003-1004', ownerMachine: machine, codeRef, source },
  'origin.request': { machine, requestId: 'synthetic-origin', timeoutMs: 10000, project: submission.project, codeRef, source },
  'machine.observation': { machine, observationSequence: 1, observedAt: at, lifecycle },
  'process.stop-request': { machine, requestId: 'synthetic-stop', timeoutMs: 10000, action: 'stop', reason: 'synthetic cancellation' },
  'process.stop-proof': { machine, requestId: 'synthetic-stop', observationSequence: 1, observedAt: at, verdict: 'tree-exited', method: 'windows-job-object', evidenceHash: '4'.repeat(64) },
  'handoff.intent': publication, 'handoff.publish': publication,
  'handoff.observe-request': { ...handoff, requestId: 'synthetic-observe', timeoutMs: 10000, expected: lifecycleIdentity },
  'handoff.observe': { ...handoff, requestId: 'synthetic-observe', observationSequence: 1, observedAt: at, state: 'running', identity: lifecycleIdentity },
  'handoff.quarantine': { ...handoff, requestId: 'synthetic-quarantine', timeoutMs: 10000, expected: lifecycleIdentity, reason: 'synthetic quarantine', createdAt: at },
  'snapshot.request': { requestId: snapshot.requestId, timeoutMs: 10000, machine, project: submission.project, codeRef },
  'snapshot.metadata': snapshot,
  'launch.notice': { schema: 1, ticketId: execution.ticketId, attemptId: execution.attemptId, submissionId: handoff.submissionId,
    machine, token: execution.permitToken, launchedAt: at },
  'artifact.read': { requestId: 'synthetic-artifact-read', object, offset: 0, length: 4 }, 'log.read': { requestId: 'synthetic-log-read', object, offset: 4, length: 4 },
  'artifact.chunk': { requestId: 'synthetic-artifact-read', object, offset: 0, length: 4, dataBase64: 'dGVzdA==', chunkHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' },
  'log.chunk': { requestId: 'synthetic-log-read', object, offset: 4, length: 4, dataBase64: 'dGVzdA==', chunkHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' },
  'state.read': { requestId: projection.requestId, afterCursor: cursor, limit: 32 }, 'state.snapshot': projection,
  'lease.challenge': challenge, 'lease.renewal': lease,
  'projection.catalog': { requestId: 'synthetic-catalog', scope: readScope, snapshotId: null, pageToken: null, selectors: [{ kind: 'dispatcher-config' }], limit: 8 },
  'projection.manifest': readManifest, 'projection.read': projectionRead,
  'projection.chunk': { ...projectionRead, dataBase64: configBytes.toString('base64'), chunkHash: configObject.hash },
  result: { messageId: 'synthetic-request', envelopeHash: '6'.repeat(64), operationKey: null, operationHash: null,
    status: 'business_accepted', businessCursor: cursor, outcome: { kind: 'applied' } },
};
function envelope(kind, overrides = {}) {
  const { gatewayInstance, nodeInstance, ...wireScope } = scope;
  const stages = p.BINDING_STAGES[kind];
  const binding = stages ? { submission: submissionIdentity, granted, started: execution, resident }[stages[0]] : null;
  const value = { protocolVersion: p.PROTOCOL_VERSION, ...wireScope, messageId: `message-${kind}`, sequence: 2, kind,
    payload: copy(payloads[kind]), ...(binding ? { execution: copy(binding) } : {}), ...copy(overrides) };
  value.contentHash = p.envelopeHash(value);
  return value;
}
function trust(kind = 'submission') {
  const [role, localRole] = p.ROUTES[kind][0];
  return { localRole, principal: { id: 'synthetic-principal', role, nativeObservation: true, readAccess: { role: 'owner' },
    nodeIds: [scope.nodeId], machines: [machine], allowedKinds: [...p.KINDS] },
  authorityId: scope.authorityId, authorityEpoch: scope.authorityEpoch, allowedNodes: [scope.nodeId] }; }
function leaseContext() {
  return copy({ ...scope, ...execution, machine, clockId, clockDomain: 'native-stopwatch', nowMonotonicMs: 2000, lastMonotonicMs: 1500, maxAgeMs: 30000,
    challengeRecord: { ...scope, ...execution, ...challenge, clockId, clockDomain: 'native-stopwatch', sentAtMonotonicMs: 1000 },
    lastConsumedChallengeSequence: 3, lastLeaseSequence: 7, consumedLeaseIds: [], minLedgerSeq: 9,
    executionKnown: true, controllerVerified: true, nativeWatchdogArmed: true,
    facts: { ...scope, ...execution, machine, known: true, clockId, clockDomain: 'native-stopwatch', observedMonotonicMs: 1500 } });
}
function receipt(prepared, status = 'business_accepted') {
  const e = prepared.validated.envelope, operation = prepared.operation;
  const identity = { messageId: e.messageId, envelopeHash: e.contentHash, operationKey: operation?.operationKey ?? null, operationHash: operation?.operationHash ?? null };
  if (status === 'durably_received') return { ...identity, status, durableSeq: 1 };
  let outcome = { kind: 'applied' };
  if (e.kind === 'submission') outcome = { kind: 'submission', ticketId: execution.ticketId };
  if (e.kind === 'command') outcome = { kind: 'command', commandId: e.payload.commandId };
  if (e.kind === 'report.started' || e.kind === 'report.finished') outcome = { kind: 'report', ticketId: e.payload.ticketId, attemptId: e.payload.attemptId, phase: e.payload.phase };
  return { ...identity, status, businessCursor: copy(cursor), ...(status === 'business_accepted' ? { outcome }
    : { reason: 'synthetic reason', ...(status === 'business_pending' ? { retryAfterMs: 1000 } : {}) }) };
}
module.exports = { scenario, scope, execution, granted, resident, residentSubmission, source, submissionIdentity, machine, authorityHost, at, clockId,
  payloads, envelope, trust, leaseContext, receipt, copy, configBytes };
