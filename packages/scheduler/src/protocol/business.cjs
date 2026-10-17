'use strict';
const s = require('./schema.cjs');
const { fail } = require('./json.cjs');
const workType = s.pattern(/^[A-Za-z0-9._:-]{1,64}$/);
const work = s.fields({ type: workType, targetPaths: s.list(s.text(1024), 1, 256) }, {
  workers: s.positive, round: s.segment, shard: (v, p) => {
    s.pattern(/^s(0|[1-9]\d*)of([1-9]\d*)$/)(v, p);
    const [, index, total] = /^s(\d+)of(\d+)$/.exec(v);
    s.positive(Number(total), p); s.count(Number(index), p);
    if (Number(index) >= Number(total)) fail('SHARD', p);
  },
});
const menu = s.fields({ item: workType, args: s.list(s.text(200), 0, 64) }, { elastic: s.literalTrue });
function submission(v, p) {
  s.fields({ idempotencyKey: s.segment, project: s.text(128), submitter: s.text(256), category: s.category, title: s.text(1024),
    work, requestedCores: s.count, allowedMachines: s.list(s.segment, 1, 256, true), codeRef: s.codeRef,
    resources: s.fields({ exclusive: s.list(s.enumeration(['screen', 'word-com']), 0, 2, true) }), createdAt: s.iso,
  }, { parentTicketId: s.ticketId, execution: s.enumeration(['local', 'cluster', 'auto']),
    engine: s.pattern(/^[a-z0-9-]{1,24}$/), origin: s.segment, menu, resident: s.literalTrue,
    usageKey: s.text(120), requestedCoresOriginal: s.positive })(v, p);
  if ((v.category === 'codex-build') !== (v.requestedCores === 0)) fail('CORES_CATEGORY', p);
  if (v.requestedCoresOriginal !== undefined && v.requestedCoresOriginal < v.requestedCores) fail('CORES_ORIGINAL', p);
  if ((v.work.round === undefined) !== (v.work.shard === undefined)) fail('ROUND_SHARD', p);
  if (v.execution === 'auto') {
    if (!v.origin || !v.menu || !v.allowedMachines.includes(v.origin) || v.menu.item !== v.work.type ||
      !['unit-test', 'e2e-test', 'other'].includes(v.category) || v.codeRef.kind !== 'commit' || v.resources.exclusive.length ||
      ['workers', 'round', 'shard'].some(k => Object.hasOwn(v.work, k)) || (v.menu.elastic && v.category !== 'unit-test')) fail('AUTO_SHAPE', p);
  } else if (v.origin !== undefined || v.menu !== undefined) fail('AUTO_ONLY', p);
  if (v.resident && (v.execution !== undefined || v.allowedMachines.length !== 1 || v.category === 'codex-build')) fail('RESIDENT_SHAPE', p);
  // Deployment's needsRound/menu/path authorization is a separate cloud business gate, never a wire default.
}
const commandData = {
  'jump-queue': s.fields({ ticketId: s.ticketId }), cancel: s.fields({ ticketId: s.ticketId }, { reason: s.text() }),
  finish: s.fields({ ticketId: s.ticketId, result: s.enumeration(['passed', 'failed']) }, { reason: s.text() }),
  'pause-one': s.fields({ ticketId: s.ticketId }), 'resume-one': s.fields({ ticketId: s.ticketId }),
  reserve: (v, p) => { s.fields({ machine: s.segment, requestedCores: s.enumeration([0, 5, 10, 15]) }, { durationMinutes: s.enumeration([60, 180]) })(v, p); if (v.requestedCores === 0 && v.durationMinutes !== undefined) fail('RESERVATION', p); },
  'owner-hold': s.fields({ machine: s.segment }), 'owner-release': s.fields({ machine: s.segment }),
};
function command(v, p) {
  s.fields({ commandId: s.segment, kind: s.enumeration(Object.keys(commandData)), data: (x, q) => commandData[v.kind](x, q),
    submitter: s.text(256), createdAt: s.iso, expiresAt: s.iso })(v, p);
  if (v.expiresAt < v.createdAt) fail('COMMAND_EXPIRY', p);
}
const verifier = s.fields({ pipe: s.text(512), publicKey: s.text(8192) });
function report(phase) {
  return s.fields({ ticketId: s.ticketId, attemptId: s.attemptId, token: s.text(256), machine: s.segment, at: s.iso,
    phase: s.enumeration([phase]), ...(phase === 'started' ? { pid: s.pid, codeRef: s.codeRef } : { result: s.result, reason: s.text() }),
  }, phase === 'started' ? { creationFileTime: s.birth, createdAt: s.text(128), verifier } : {});
}
const interval = (v, p) => { s.fields({ from: s.finite(), to: s.nullable(s.finite()) })(v, p); if (v.to !== null && v.to < v.from) fail('INTERVAL', p); };
const suspension = s.fields({ sequence: s.count, at: s.finite(), mode: s.enumeration(['running', 'paused', 'slow']),
  reasons: s.list(s.enumeration(['ci', 'manual', 'owner-hold']), 0, 3, true), ended: s.bool,
  intervals: s.list(interval), slowIntervals: s.list(interval), alert: s.nullable(s.text()) });
const heartbeat = (v, p) => {
  s.fields({ ticketId: s.ticketId, attemptId: s.attemptId, machine: s.segment, at: s.iso }, { childPid: s.pid, token: s.text(256), suspend: suspension })(v, p);
  if (v.suspend && (!v.token || (!v.suspend.ended && !v.childPid))) fail('SUSPEND_IDENTITY', p);
};
module.exports = { submission, command, started: report('started'), finished: report('finished'), heartbeat, suspension };
