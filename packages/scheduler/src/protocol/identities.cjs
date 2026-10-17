'use strict';
const s = require('./schema.cjs');
const { fail } = require('./json.cjs');
const { residentFields } = require('./resident.cjs');
const submissionFields = { stage: s.enumeration(['submission']), ticketId: s.ticketId, submissionHash: s.hash, project: s.text(128) };
const grantedFields = { stage: s.enumeration(['granted']), ticketId: s.ticketId, attemptId: s.attemptId, permitToken: s.text(256) };
const startedFields = { ...grantedFields, stage: s.enumeration(['started']), controller: s.controller };
const validators = { submission: s.fields(submissionFields), granted: s.fields(grantedFields), started: s.fields(startedFields), resident: s.fields(residentFields) };
function identity(input, path = '$', stages = ['submission', 'granted', 'started', 'resident']) {
  s.enumeration(stages)(input?.stage, `${path}.stage`);
  validators[input.stage](input, path);
}
// Every kind has exactly the stages listed here; omission means it must NOT carry execution.
const BINDING_STAGES = Object.freeze(Object.fromEntries(Object.entries({
  'origin.request': ['submission'], 'origin.proof': ['submission'],
  'handoff.intent': ['granted'], 'handoff.publish': ['granted'], 'handoff.observe-request': ['granted'],
  'handoff.observe': ['granted'], 'handoff.quarantine': ['granted'],
  'snapshot.request': ['granted'], 'snapshot.metadata': ['granted'], 'launch.notice': ['granted'],
  'report.started': ['started'], 'report.finished': ['started'], 'execution.heartbeat': ['started'],
  'resident.renewal': ['resident'], 'process.stop-request': ['started'], 'process.stop-proof': ['started'],
  'lease.challenge': ['started'], 'lease.renewal': ['started'],
  'artifact.read': ['submission', 'granted', 'started'], 'artifact.chunk': ['submission', 'granted', 'started'],
  'log.read': ['submission', 'granted', 'started'], 'log.chunk': ['submission', 'granted', 'started'],
}).map(([kind, stages]) => [kind, Object.freeze(stages)])));
function bindingForKind(kind, value, path) {
  if (!Object.hasOwn(BINDING_STAGES, kind)) fail('UNBOUND_KIND', path);
  identity(value, path, BINDING_STAGES[kind]);
}
module.exports = { submissionFields, grantedFields, startedFields, identity, BINDING_STAGES, bindingForKind };
