'use strict';
const { validateShape, operationIdentity } = require('./envelope.cjs');
const { validateResult } = require('./messages.cjs');
const { evaluateProjection, evaluateActiveExecutionLease } = require('./lease.cjs');
const { canonicalJson, fail, ProtocolValidationError } = require('./json.cjs');
// A pure gate contract. Only the native host may consume releaseId and actually release the child.
function evaluateNativeRelease(input, context) {
  try {
    const started = validateShape(input.started), ack = validateResult(input.ack), op = operationIdentity(started);
    if (started.kind !== 'report.started' || context.releaseConsumed !== false) fail('RELEASE_ALREADY_CONSUMED');
    if (context.projectionContext?.clockDomain !== 'native-stopwatch' ||
      context.projectionContext.clockId !== context.executionContext?.clockId) fail('NATIVE_CLOCK_REQUIRED');
    if (ack.status !== 'business_accepted' || ack.messageId !== started.messageId || ack.envelopeHash !== started.contentHash ||
      ack.operationKey !== op.operationKey || ack.operationHash !== op.operationHash || ack.outcome.kind !== 'report' ||
      ack.outcome.phase !== 'started' || ack.outcome.ticketId !== started.execution.ticketId || ack.outcome.attemptId !== started.execution.attemptId) fail('STARTED_ACK_REQUIRED');
    const projection = evaluateProjection(input.projection, context.projectionContext);
    if (!projection.allowed) return projection;
    const p = projection.projection;
    // Other tickets may commit after started. A newer authenticated projection
    // is valid only while it still proves this exact execution is running.
    if (p.businessCursor.seq < ack.businessCursor.seq || p.ledgerSeq < ack.businessCursor.seq ||
      (p.businessCursor.seq === ack.businessCursor.seq && p.businessCursor.hash !== ack.businessCursor.hash)) fail('STARTED_CURSOR_REQUIRED');
    const attempt = p.attempts.find(a => a.ticketId === started.execution.ticketId && a.attemptId === started.execution.attemptId);
    if (!attempt || attempt.stage !== 'started' || attempt.state !== 'running' || attempt.cancelRequested !== false ||
      attempt.permitToken !== started.execution.permitToken || canonicalJson(attempt.controller) !== canonicalJson(started.execution.controller)) fail('STARTED_PROJECTION_REQUIRED');
    const active = evaluateActiveExecutionLease(input.lease, context.executionContext);
    if (!active.allowed) return active;
    if (input.lease.lease.ledgerSeq !== p.ledgerSeq || canonicalJson(started.execution) !== canonicalJson({
      stage: input.lease.lease.stage, ticketId: input.lease.lease.ticketId, attemptId: input.lease.lease.attemptId,
      permitToken: input.lease.lease.permitToken, controller: input.lease.lease.controller,
    })) fail('RELEASE_LEASE_BINDING');
    for (const key of ['authorityId', 'authorityEpoch', 'nodeId', 'nodeSession', 'gatewayInstance', 'nodeInstance']) {
      if ((Object.hasOwn(started, key) && started[key] !== p[key]) || p[key] !== input.lease.lease[key]) fail('RELEASE_SCOPE');
    }
    return { allowed: true, deadlineMonotonicMs: active.deadlineMonotonicMs, ticketId: attempt.ticketId, attemptId: attempt.attemptId };
  } catch (error) {
    if (error instanceof ProtocolValidationError || error instanceof TypeError) return { allowed: false, reason: error.code ?? 'RELEASE_CONTEXT_UNKNOWN' };
    throw error;
  }
}
module.exports = { evaluateNativeRelease };
