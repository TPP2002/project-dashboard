'use strict';
const s = require('./schema.cjs');
const { fail } = require('./json.cjs');
const ci = (v, p) => {
  s.fields({ state: s.enumeration(['active', 'idle', 'unknown']), ciWorkers: s.integer(0, 64), observedAt: s.iso, stateSince: s.iso },
    { runners: s.list(s.text(256), 1, 64, true), stale: s.literalTrue, staleSince: s.iso })(v, p);
  if ((v.state === 'active') !== (v.ciWorkers > 0) || (v.runners && v.state !== 'active') ||
    (v.stale && (v.state !== 'active' || !v.staleSince)) || (!v.stale && v.staleSince !== undefined)) fail('CI_FACT', p);
};
const memory = (v, p) => {
  s.fields({ totalMb: s.positive, freeMb: s.count, windowSec: s.enumeration([30]), sampledAt: s.iso })(v, p);
  if (v.freeMb > v.totalMb) fail('MEMORY_FACT', p);
};
const load = (v, p) => {
  s.fields({ schema: s.enumeration([1]), ci }, { memory, cores: s.positive, busyCores: s.finite(), busyPct: s.finite(),
    windowSec: s.enumeration([30]), sampledAt: s.iso })(v, p);
  const group = ['cores', 'busyCores', 'busyPct', 'windowSec', 'sampledAt'];
  const present = group.filter(key => Object.hasOwn(v, key)).length;
  if (present !== 0 && present !== group.length) fail('CPU_PARTIAL', p);
  if (present && (v.busyCores > v.cores || v.busyPct > 100)) fail('CPU_FACT', p);
};
const attemptLoad = (v, p) => {
  s.fields({ schema: s.enumeration([1]), sampledAt: s.iso, windowSec: s.enumeration([30]),
    attempts: s.list(s.fields({ ticketId: s.ticketId, attemptId: s.attemptId, cores: s.finite() }), 0, 64) })(v, p);
  const keys = v.attempts.map(x => `${x.ticketId}--${x.attemptId}`);
  if (new Set(keys).size !== keys.length) fail('ATTEMPT_LOAD_DUPLICATE', p);
};
const ciTreeLoad = (v, p) => {
  s.fields({ schema: s.enumeration([1]), sampledAt: s.iso, windowSec: s.enumeration([30]), cores: s.finite(), workers: s.integer(0, 64) })(v, p);
  if (v.cores > 1024) fail('CI_TREE_LOAD', p);
};
const heartbeat = s.fields({ machine: s.segment,
  state: s.enumeration(['idle', 'maintenance', 'running', 'installing-deps', 'self-upgrading', 'crashed', 'code-mismatch']),
  at: s.iso, pid: s.pid, protocol: s.integer(13), head: s.sha1, ownerPid: s.pid, ownerToken: s.text(256),
}, { ciYield: s.fields({ ciWorkers: s.positive, since: s.iso }), load,
  jobSlots: (v, p) => { s.fields({ max: s.integer(1, 64), running: s.integer(0, 64) })(v, p); if (v.running > v.max) fail('JOB_SLOTS', p); },
  attemptLoad, ciTreeLoad });
const counts = s.fields({ inbox: s.count, running: s.count, done: s.count, failed: s.count, quarantine: s.count });
const fault = s.fields({ kind: s.enumeration(['record-corrupt', 'identity-drift', 'record-missing']), reason: s.text() });
const machineStatus = (v, p) => {
  s.fields({ machine: s.segment, heartbeat: s.nullable(heartbeat), counts }, { fault })(v, p);
  if (v.heartbeat && v.heartbeat.machine !== v.machine) fail('MACHINE_HEARTBEAT_IDENTITY', p);
};
// Read-only control facts. These do not grant cloud write ownership of jobs-v12.
const control = s.fields({ namespace: s.enumeration(['jobs-v12']), lifecycleSchema: s.enumeration([12]), epoch: s.segment,
  state: s.enumeration(['ACTIVE']), codeVersion: s.sha1, configuredMachines: s.list(s.segment, 1, 256, true), createdAt: s.iso, createdBy: s.text(256) });
const lifecycleSnapshot = (v, p) => {
  s.fields({ control, machines: s.list(machineStatus, 0, 256) })(v, p);
  const seen = new Set();
  for (const m of v.machines) {
    if (seen.has(m.machine) || !v.control.configuredMachines.includes(m.machine)) fail('LIFECYCLE_MACHINE_SET', p);
    seen.add(m.machine);
  }
  if (seen.size !== v.control.configuredMachines.length) fail('LIFECYCLE_INCOMPLETE', p);
};
const observation = (v, p) => {
  s.fields({ machine: s.segment, observedAt: s.iso, observationSequence: s.positive, lifecycle: lifecycleSnapshot })(v, p);
  if (!v.lifecycle.control.configuredMachines.includes(v.machine)) fail('LIFECYCLE_MACHINE_SET', p);
};
const validateLifecycleSnapshot = input => s.validate(lifecycleSnapshot, input);
// Shape conversion only. Caller must first authenticate and evaluate freshness. No IO, no default facts.
function toLifecycleStatusSnapshot(input) {
  const value = validateLifecycleSnapshot(input);
  return { control: value.control, machines: value.machines.map(({ heartbeat: beat, ...machine }) => ({
    ...machine, heartbeat: beat === null ? undefined : beat,
  })) };
}
module.exports = { observation, lifecycleSnapshot, validateLifecycleSnapshot, toLifecycleStatusSnapshot };
