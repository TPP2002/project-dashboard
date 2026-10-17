'use strict';
const { validateShape, operationIdentity } = require('./envelope.cjs');
const { IMMUTABLE_KINDS } = require('./messages.cjs');
const { canonicalJson, fail } = require('./json.cjs');
const s = require('./schema.cjs');
const REPLY_KINDS = Object.freeze({
  'origin.request': 'origin.proof', 'process.stop-request': 'process.stop-proof',
  'handoff.observe-request': 'handoff.observe', 'snapshot.request': 'snapshot.metadata',
  'artifact.read': 'artifact.chunk', 'log.read': 'log.chunk', 'state.read': 'state.snapshot', 'lease.challenge': 'lease.renewal',
  'projection.catalog': 'projection.manifest', 'projection.read': 'projection.chunk',
});
// Run AFTER authenticating each envelope. This does not perform IO or authenticate either peer.
function validateResponse(requestInput, responseInput) {
  const request = validateShape(requestInput), response = validateShape(responseInput);
  for (const key of ['authorityId', 'authorityEpoch', 'nodeId', 'nodeSession']) if (request[key] !== response[key]) fail('REPLY_SCOPE');
  if (response.kind === 'result') {
    const op = IMMUTABLE_KINDS.includes(request.kind) ? operationIdentity(request) : null;
    if (response.payload.messageId !== request.messageId || response.payload.envelopeHash !== request.contentHash ||
      response.payload.operationKey !== (op?.operationKey ?? null) || response.payload.operationHash !== (op?.operationHash ?? null)) fail('REPLY_REQUEST');
    return response;
  }
  if (!Object.hasOwn(REPLY_KINDS, request.kind) || response.kind !== REPLY_KINDS[request.kind]) fail('REPLY_KIND');
  if (canonicalJson(request.execution ?? null) !== canonicalJson(response.execution ?? null)) fail('REPLY_BINDING');
  if (request.kind === 'lease.challenge') {
    for (const key of ['challenge', 'challengeSequence', 'ledgerSeq', 'gatewayInstance', 'nodeInstance']) {
      if (request.payload[key] !== response.payload[key]) fail('REPLY_CHALLENGE');
    }
  } else if (request.payload.requestId !== response.payload.requestId) fail('REPLY_REQUEST');
  if (['artifact.read', 'log.read'].includes(request.kind) && (canonicalJson(request.payload.object) !== canonicalJson(response.payload.object) ||
    request.payload.offset !== response.payload.offset || request.payload.length !== response.payload.length)) fail('REPLY_OBJECT_RANGE');
  if (request.kind === 'origin.request' && (request.payload.machine !== response.payload.machine ||
    canonicalJson(request.payload.codeRef) !== canonicalJson(response.payload.codeRef) ||
    request.payload.source !== undefined && response.payload.source !== null && canonicalJson(request.payload.source) !== canonicalJson(response.payload.source))) fail('REPLY_ORIGIN');
  if (request.kind === 'process.stop-request' && request.payload.machine !== response.payload.machine) fail('REPLY_MACHINE');
  if (request.kind.startsWith('projection.')) {
    if (canonicalJson(request.payload.scope) !== canonicalJson(response.payload.scope)) fail('REPLY_SCOPE');
    if (request.kind === 'projection.catalog' && request.payload.snapshotId !== null && request.payload.snapshotId !== response.payload.snapshotId) fail('MANIFEST_VERSION');
    if (request.kind === 'projection.catalog' && (response.payload.entries.length > request.payload.limit || response.payload.entries.some(entry =>
      !request.payload.selectors.some(selector => Object.keys(selector).every(key => canonicalJson(selector[key]) === canonicalJson(entry[key])))))) fail('REPLY_READ_SELECTOR');
    if (request.kind === 'projection.read' && (request.payload.snapshotId !== response.payload.snapshotId ||
      canonicalJson(request.payload.ledgerCursor) !== canonicalJson(response.payload.ledgerCursor) ||
      canonicalJson(request.payload.entry) !== canonicalJson(response.payload.entry) ||
      request.payload.offset !== response.payload.offset || request.payload.length !== response.payload.length)) fail('REPLY_OBJECT_RANGE');
  }
  if (request.kind === 'handoff.observe-request') {
    for (const key of ['intentId', 'submissionId', 'ownerMachine', 'authorityHost', 'lifecycleEpoch']) {
      if (request.payload[key] !== response.payload[key]) fail('REPLY_HANDOFF');
    }
    if (response.payload.identity !== null && ![request.payload.expected, ...(request.payload.legacyIdentities ?? [])]
      .some(identity => canonicalJson(identity) === canonicalJson(response.payload.identity))) fail('REPLY_LIFECYCLE_IDENTITY');
  }
  return response;
}
function toOriginProbeResult(request, response, pendingAttemptId) {
  if (request?.kind !== 'origin.request') fail('REPLY_KIND');
  s.attemptId(pendingAttemptId);
  const reply = validateResponse(request, response);
  if (reply.kind !== 'origin.proof') fail('ORIGIN_PROOF_PENDING');
  const identity = { ticketId: reply.execution.ticketId, attemptId: pendingAttemptId };
  // pendingAttemptId comes from cloud's saved pre-grant request context, NOT from the reply.
  return reply.payload.verdict === 'unknown' ? { ...identity, verdict: 'failed', detail: reply.payload.detail }
    : { ...identity, verdict: 'owner', ownerSid: reply.payload.observedOwnerSid, trusted: reply.payload.verdict === 'verified' };
}
module.exports = { REPLY_KINDS, validateResponse, toOriginProbeResult };
