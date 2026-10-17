'use strict';
const f = require('./messages.cjs');
// This models the real order. A grant is a projection, not a made-up process launch.
const grant = f.copy(f.payloads['state.snapshot']);
grant.attempts = [{ ...f.granted, state: 'granted', grantedCores: 2, permitLedgerSeq: 9, cancelRequested: false }];
const descriptors = [
  { kind: 'submission', stage: null },
  { kind: 'origin.request', stage: 'submission' },
  { kind: 'origin.proof', stage: 'submission' },
  { kind: 'artifact.read', stage: 'submission', execution: f.submissionIdentity },
  { kind: 'artifact.chunk', stage: 'submission', execution: f.submissionIdentity },
  { kind: 'state.read', stage: null },
  { kind: 'state.snapshot', stage: null, payload: grant },
  { kind: 'snapshot.request', stage: 'granted' },
  { kind: 'snapshot.metadata', stage: 'granted' },
  { kind: 'artifact.read', stage: 'granted', execution: f.granted },
  { kind: 'artifact.chunk', stage: 'granted', execution: f.granted },
  { kind: 'handoff.intent', stage: 'granted' },
  { kind: 'handoff.publish', stage: 'granted' },
  { kind: 'handoff.observe-request', stage: 'granted' },
  { kind: 'handoff.observe', stage: 'granted', payload: { ...f.payloads['handoff.observe'], state: 'inbox' } },
  { kind: 'launch.notice', stage: 'granted' },
  { kind: 'report.started', stage: 'started' },
  { kind: 'execution.heartbeat', stage: 'started' },
  { kind: 'lease.challenge', stage: 'started' },
  { kind: 'lease.renewal', stage: 'started' },
  { kind: 'process.stop-request', stage: 'started' },
  { kind: 'process.stop-proof', stage: 'started' },
  { kind: 'report.finished', stage: 'started' },
];
module.exports = descriptors.map(({ kind, stage, ...overrides }, index) => ({ expectedStage: stage,
  envelope: f.envelope(kind, { ...overrides, sequence: index + 2, messageId: `synthetic-flow-${index}` }) }));
