'use strict';
const s = require('./schema.cjs');
const { canonicalJson, ProtocolValidationError, fail } = require('./json.cjs');
const { validateLease, validateProjection } = require('./messages.cjs');
const scopeKeys = ['authorityId', 'authorityEpoch', 'nodeId', 'nodeSession', 'gatewayInstance', 'nodeInstance'];
const sameExecution = (a, b) => a.stage === 'started' && b.stage === 'started' && ['ticketId', 'attemptId', 'permitToken'].every(k => a[k] === b[k]) && canonicalJson(a.controller) === canonicalJson(b.controller);
function scopeMatches(a, b) { return scopeKeys.every(k => a[k] === b[k]); }
function isFactFresh(fact, context) {
  try {
    if (!fact || !context || fact.known !== true || !scopeMatches(fact, context) || fact.clockId !== context.clockId || fact.clockDomain !== context.clockDomain) return false;
    s.enumeration(['native-stopwatch', 'node-performance'])(context.clockDomain);
    s.id(context.clockId); s.finite()(fact.observedMonotonicMs); s.finite()(context.nowMonotonicMs);
    s.finite()(context.lastMonotonicMs); s.integer(1, 60000)(context.maxAgeMs);
    for (const key of scopeKeys) (key === 'authorityEpoch' ? s.positive : s.id)(context[key]);
    return context.nowMonotonicMs >= context.lastMonotonicMs && fact.observedMonotonicMs <= context.nowMonotonicMs &&
      context.nowMonotonicMs - fact.observedMonotonicMs < context.maxAgeMs;
  } catch (error) { if (error instanceof ProtocolValidationError) return false; throw error; }
}
function evaluateProjection(input, context) {
  try {
    const p = validateProjection(input);
    if (!scopeMatches(p, context)) return { allowed: false, reason: 'PROJECTION_SCOPE' };
    if (!isFactFresh(context.freshness, context)) return { allowed: false, reason: 'PROJECTION_NOT_FRESH' };
    s.count(context.minLedgerSeq); s.count(context.minBusinessCursor); s.count(context.minSessionWatermark); s.count(context.minLiveWatermark);
    if (p.ledgerSeq < context.minLedgerSeq || p.businessCursor.seq < context.minBusinessCursor ||
      p.sessionWatermark < context.minSessionWatermark || p.liveWatermark < context.minLiveWatermark) return { allowed: false, reason: 'PROJECTION_WATERMARK' };
    return { allowed: true, projection: p };
  } catch (error) {
    if (error instanceof ProtocolValidationError) return { allowed: false, reason: error.code };
    if (error instanceof TypeError) return { allowed: false, reason: 'PROJECTION_CONTEXT_UNKNOWN' };
    throw error;
  }
}
// Only consumes an outstanding native-local challenge, never starts a new TTL on receipt.
function evaluateExecutionLease(input, context) {
  try {
    const lease = validateLease(input), c = context, q = c.challengeRecord;
    if (c.clockDomain !== 'native-stopwatch' || q?.clockDomain !== 'native-stopwatch') fail('NATIVE_CLOCK_REQUIRED');
    if (!q || !scopeMatches(lease, c) || !scopeMatches(q, c) || !sameExecution(lease, c) || !sameExecution(q, c)) fail('LEASE_IDENTITY');
    s.id(c.clockId); s.id(q.clockId);
    s.finite()(c.nowMonotonicMs); s.finite()(c.lastMonotonicMs); s.finite()(q.sentAtMonotonicMs);
    s.integer(1, 60000)(q.requestedTtlMs); s.positive(q.challengeSequence); s.positive(q.ledgerSeq);
    s.count(c.lastConsumedChallengeSequence); s.count(c.lastLeaseSequence); s.count(c.minLedgerSeq);
    if (c.clockId !== q.clockId || c.nowMonotonicMs < c.lastMonotonicMs || c.nowMonotonicMs < q.sentAtMonotonicMs) fail('CLOCK_ROLLBACK');
    if (lease.challenge !== q.challenge || lease.challengeSequence !== q.challengeSequence ||
      lease.challengeSequence <= c.lastConsumedChallengeSequence || lease.leaseSequence <= c.lastLeaseSequence ||
      c.consumedLeaseIds?.includes(lease.leaseId)) fail('LEASE_REPLAY');
    if (!Array.isArray(c.consumedLeaseIds)) fail('LEASE_WATERMARK_UNKNOWN');
    s.list(s.id, 0, 4096, true)(c.consumedLeaseIds);
    if (lease.ledgerSeq < c.minLedgerSeq || lease.ledgerSeq !== q.ledgerSeq || lease.ttlMs > q.requestedTtlMs) fail('LEASE_WATERMARK');
    const deadlineMonotonicMs = q.sentAtMonotonicMs + lease.ttlMs;
    if (!Number.isFinite(deadlineMonotonicMs) || c.nowMonotonicMs >= deadlineMonotonicMs || c.nowMonotonicMs >= q.sentAtMonotonicMs + q.requestedTtlMs) fail('LEASE_EXPIRED');
    s.segment(c.machine);
    if (c.executionKnown !== true || c.controllerVerified !== true || c.nativeWatchdogArmed !== true || !isFactFresh(c.facts, c) ||
      c.facts.machine !== c.machine || !sameExecution(c.facts, c)) fail('EXECUTION_FACT_UNKNOWN');
    return { allowed: true, lease, deadlineMonotonicMs, clockId: c.clockId,
      watermarks: { lastConsumedChallengeSequence: lease.challengeSequence, lastLeaseSequence: lease.leaseSequence,
        consumedLeaseIds: [...c.consumedLeaseIds, lease.leaseId], lastMonotonicMs: c.nowMonotonicMs } };
  } catch (error) {
    if (error instanceof ProtocolValidationError) return { allowed: false, reason: error.code };
    // Missing context is unknown, never an execution grant.
    if (error instanceof TypeError) return { allowed: false, reason: 'EXECUTION_CONTEXT_UNKNOWN' };
    throw error;
  }
}
function evaluateActiveExecutionLease(accepted, context) {
  try {
    if (!accepted || accepted.allowed !== true) fail('NO_ACCEPTED_LEASE');
    const lease = validateLease(accepted.lease);
    if (context.clockDomain !== 'native-stopwatch') fail('NATIVE_CLOCK_REQUIRED');
    s.finite()(accepted.deadlineMonotonicMs);
    s.finite()(accepted.watermarks?.lastMonotonicMs);
    s.finite()(context.nowMonotonicMs); s.finite()(context.lastMonotonicMs); s.count(context.minLedgerSeq);
    if (!scopeMatches(lease, context) || !sameExecution(lease, context) || accepted.clockId !== context.clockId) fail('LEASE_IDENTITY');
    if (context.nowMonotonicMs < context.lastMonotonicMs || context.nowMonotonicMs < accepted.watermarks.lastMonotonicMs) fail('CLOCK_ROLLBACK');
    if (context.nowMonotonicMs >= accepted.deadlineMonotonicMs) fail('LEASE_EXPIRED');
    s.segment(context.machine);
    if (lease.ledgerSeq < context.minLedgerSeq || context.executionKnown !== true || context.controllerVerified !== true ||
      context.nativeWatchdogArmed !== true || !isFactFresh(context.facts, context) || context.facts.machine !== context.machine ||
      !sameExecution(context.facts, context)) fail('EXECUTION_FACT_UNKNOWN');
    return { allowed: true, deadlineMonotonicMs: accepted.deadlineMonotonicMs };
  } catch (error) {
    if (error instanceof ProtocolValidationError) return { allowed: false, reason: error.code };
    if (error instanceof TypeError) return { allowed: false, reason: 'EXECUTION_CONTEXT_UNKNOWN' };
    throw error;
  }
}
module.exports = { isFactFresh, evaluateProjection, evaluateExecutionLease, evaluateActiveExecutionLease };
