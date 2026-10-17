'use strict';
const { TextDecoder } = require('node:util');
const s = require('./schema.cjs');
const { MAX_FRAME_BYTES, canonicalJson, contentHash, clone, fail } = require('./json.cjs');
const m = require('./messages.cjs');
const { validateRoute } = require('./routes.cjs');
function envelopeHash(input) {
  canonicalJson(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('ENVELOPE_OBJECT');
  const { contentHash: ignored, ...body } = input;
  return contentHash(body);
}
function validateShape(input) {
  canonicalJson(input);
  s.enumeration(m.KINDS)(input?.kind, '$.kind');
  const execution = m.EXECUTION_KINDS.includes(input.kind);
  s.fields({ protocolVersion: s.enumeration([m.PROTOCOL_VERSION]), ...m.scopeFields,
    messageId: s.id, sequence: s.positive, kind: s.enumeration(m.KINDS), contentHash: s.hash,
    payload: (v) => m.validateRequest(input.kind, v), ...(execution ? { execution: (v, p) => m.bindingForKind(input.kind, v, p) } : {}),
  })(input);
  if (envelopeHash(input) !== input.contentHash) fail('ENVELOPE_HASH');
  const p = input.payload, e = input.execution;
  if (execution) {
    for (const [key, value] of [['ticketId', e.ticketId], ['attemptId', e.attemptId], ['token', e.permitToken], ['permitToken', e.permitToken],
      ...(e.stage === 'submission' ? [['submissionHash', e.submissionHash], ['project', e.project]] : [])]) {
      if (Object.hasOwn(p, key) && p[key] !== value) fail('EXECUTION_BINDING', `$.payload.${key}`);
    }
    if (p.controller && canonicalJson(p.controller) !== canonicalJson(e.controller)) fail('CONTROLLER_BINDING');
    if (input.kind === 'report.started' && p.pid !== e.controller.pid) fail('CONTROLLER_BINDING');
    if (input.kind === 'resident.renewal' && p.pid !== e.renewer.pid) fail('RESIDENT_RENEWER_BINDING');
    if (e.stage === 'submission' && p.source && p.source.submissionHash !== e.submissionHash) fail('SUBMISSION_SOURCE_BINDING');
    if (p.creationFileTime !== undefined && p.creationFileTime !== e.controller.creationFileTime) fail('CONTROLLER_BINDING');
    if (input.kind.startsWith('handoff.') && p.submissionId !== `${e.ticketId}--${e.attemptId}`) fail('HANDOFF_IDENTITY');
    if (input.kind === 'launch.notice' && p.submissionId !== `${e.ticketId}--${e.attemptId}`) fail('LAUNCH_IDENTITY');
    if (input.kind === 'lease.renewal') for (const key of Object.keys(m.scopeFields)) if (p[key] !== input[key]) fail('LEASE_SCOPE', `$.payload.${key}`);
    if (p.permit && (p.permit.ticketId !== e.ticketId || p.permit.attemptId !== e.attemptId || p.permit.token !== e.permitToken)) fail('PERMIT_BINDING');
    if (p.snapshot && (p.snapshot.ticketId !== e.ticketId || p.snapshot.attemptId !== e.attemptId)) fail('SNAPSHOT_BINDING');
    for (const identity of [p.expected, p.identity, ...(p.legacyIdentities ?? [])].filter(Boolean)) {
      if (identity.submissionId !== p.submissionId || identity.jobId !== p.submissionId || identity.machine !== p.ownerMachine ||
        identity.epoch !== p.lifecycleEpoch) fail('LIFECYCLE_BINDING');
    }
    if (input.kind === 'handoff.observe' && p.state !== 'unknown' && p.identity === null) fail('LIFECYCLE_BINDING');
    if (input.kind === 'handoff.observe' && p.payloadHash && p.payloadHash !== p.identity?.payloadSha256) fail('LIFECYCLE_BINDING');
    if (input.kind === 'handoff.observe' && p.result?.notStarted && p.result.notStarted.attemptId !== e.attemptId) fail('NOT_STARTED_BINDING');
    if (input.kind === 'handoff.observe' && p.result && Object.hasOwn(p, 'exitCode') && p.exitCode !== p.result.exitCode) fail('RESULT_EXIT_CODE');
  }
  if (input.kind === 'state.snapshot') for (const key of Object.keys(m.scopeFields)) if (p[key] !== input[key]) fail('PROJECTION_SCOPE', `$.payload.${key}`);
  if (input.kind.startsWith('projection.') && (p.scope.authorityId !== input.authorityId || p.scope.authorityEpoch !== input.authorityEpoch)) fail('PROJECTION_SCOPE');
  return clone(input);
}
function validateEnvelope(input, context) {
  const envelope = validateShape(input);
  const c = context;
  if (!c || !c.principal || !Array.isArray(c.allowedNodes) || !c.allowedNodes.length) fail('NO_TRUST_CONFIG');
  s.id(c.principal.id, '$context.principal.id');
  validateRoute(envelope.kind, c.principal.role, c.localRole);
  if (['origin.proof', 'process.stop-proof', 'machine.observation', 'report.started', 'report.finished', 'execution.heartbeat',
    'resident.renewal', 'lease.challenge', 'handoff.observe', 'snapshot.metadata', 'launch.notice'].includes(envelope.kind)
    && c.principal.nativeObservation !== true) fail('NATIVE_NODE_REQUIRED');
  if (['projection.catalog', 'projection.read'].includes(envelope.kind) && !['owner', 'node'].includes(c.principal.readAccess?.role)) fail('READ_DENIED');
  if (envelope.kind === 'projection.catalog' && c.principal.readAccess.role === 'node' &&
    envelope.payload.selectors.some(x => ['ledger-index', 'ledger-segment'].includes(x.kind))) fail('READ_OWNER_ONLY');
  s.list(s.id, 1, 256, true)(c.principal.nodeIds, '$context.principal.nodeIds');
  s.list(s.segment, 1, 256, true)(c.principal.machines, '$context.principal.machines');
  s.list(s.enumeration(m.KINDS), 1, m.KINDS.length, true)(c.principal.allowedKinds, '$context.principal.allowedKinds');
  s.list(s.id, 1, 256, true)(c.allowedNodes, '$context.allowedNodes');
  s.id(c.authorityId, '$context.authorityId'); s.positive(c.authorityEpoch, '$context.authorityEpoch');
  s.nullable(s.id)(c.activeSession, '$context.activeSession'); s.count(c.lastSequence, '$context.lastSequence');
  if (envelope.authorityId !== c.authorityId) fail('AUTHORITY_ID');
  if (envelope.authorityEpoch !== c.authorityEpoch) fail('AUTHORITY_EPOCH');
  if (!c.allowedNodes.includes(envelope.nodeId) || !c.principal.nodeIds.includes(envelope.nodeId) || !c.principal.allowedKinds.includes(envelope.kind)) fail('PRINCIPAL_DENIED');
  for (const key of ['machine', 'ownerMachine']) {
    if (Object.hasOwn(envelope.payload, key) && !c.principal.machines.includes(envelope.payload[key])) fail('MACHINE_DENIED');
  }
  if (envelope.kind === 'machine.observation') {
    for (const machine of envelope.payload.lifecycle.control.configuredMachines) {
      if (!c.principal.machines.includes(machine)) fail('MACHINE_DENIED');
    }
  }
  let disposition;
  if (envelope.kind === 'session.open') {
    if (envelope.nodeSession === c.activeSession) {
      if (envelope.sequence !== 1) fail('HANDSHAKE_SEQUENCE');
      disposition = 'duplicate';
    } else {
      if (envelope.sequence !== 1 || envelope.payload.replacesSession !== c.activeSession) fail('HANDSHAKE_REQUIRED');
      disposition = 'handshake';
    }
  } else {
    if (c.activeSession === null || envelope.nodeSession !== c.activeSession) fail('SESSION_MISMATCH');
    disposition = envelope.sequence > c.lastSequence ? 'next' : envelope.sequence === c.lastSequence ? 'duplicate' : 'out_of_order';
  }
  return { envelope, transport: { disposition, updatesLastSeen: disposition === 'next' || disposition === 'handshake' },
    operation: m.IMMUTABLE_KINDS.includes(envelope.kind) ? operationIdentity(envelope) : null };
}
function operationIdentity(input) {
  const e = validateShape(input), p = e.payload;
  if (!m.IMMUTABLE_KINDS.includes(e.kind)) fail('NOT_IMMUTABLE');
  let identity;
  switch (e.kind) {
    case 'submission': identity = [p.idempotencyKey]; break;
    case 'command': identity = [p.commandId]; break;
    case 'report.started': case 'report.finished': identity = [p.ticketId, p.attemptId]; break;
    case 'handoff.intent': case 'handoff.publish': case 'handoff.quarantine': identity = [p.intentId]; break;
    case 'snapshot.metadata': case 'launch.notice': identity = [e.execution.ticketId, e.execution.attemptId]; break;
    default: fail('NOT_IMMUTABLE');
  }
  return { operationKey: canonicalJson([e.authorityId, e.kind, ...identity]),
    operationHash: contentHash({ authorityId: e.authorityId, kind: e.kind, payload: p,
      ...(e.execution ? { execution: e.execution } : {}) }) };
}
function encodeFrame(input) {
  const value = validateShape(input);
  const frame = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) fail('FRAME_TOO_LARGE');
  return frame;
}
function decodeFrame(input) {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) fail('FRAME_TYPE');
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (typeof input === 'string' && bytes.toString('utf8') !== input) fail('FRAME_UTF8');
  if (bytes.byteLength > MAX_FRAME_BYTES) fail('FRAME_TOO_LARGE');
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('FRAME_UTF8'); }
  if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n') || raw.includes('\r') || raw.startsWith('\uFEFF')) fail('FRAME_LINE');
  let value;
  try { value = JSON.parse(raw.slice(0, -1)); } catch { fail('FRAME_JSON'); }
  // Canonical wire form also rules out duplicate object keys, alternate number spellings and ambiguous whitespace.
  if (`${canonicalJson(value)}\n` !== raw) fail('FRAME_CANONICAL');
  return validateShape(value);
}
module.exports = { envelopeHash, validateEnvelope, operationIdentity, encodeFrame, decodeFrame, validateShape };
