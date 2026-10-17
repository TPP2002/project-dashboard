'use strict';
const p = require('../protocol/contract.cjs');
const { failure } = require('./storage.cjs');

function createFacts(catalog, now, currentSession, maxAgeMs = 30000) {
  const machines = new Map(), executions = new Map(), observations = new Map(), waiting = new Map();
  const sessions = new Map();
  function current(value) {
    return value && now() >= value.received && now() - value.received < maxAgeMs
      && currentSession(value.envelope.nodeId) === value.envelope.nodeSession;
  }
  function put(envelope) {
    const value = { envelope, received: now() };
    sessions.set(envelope.nodeId, value);
    if (envelope.kind === 'machine.observation') {
      for (const fact of envelope.payload.lifecycle.machines) machines.set(fact.machine, { ...value, fact, control: envelope.payload.lifecycle.control });
    } else if (envelope.kind === 'execution.heartbeat' || envelope.kind === 'resident.renewal') {
      executions.set(envelope.execution.ticketId, value);
    } else if (envelope.kind.startsWith('waiting.')) waiting.set(envelope.payload.ticketId, value);
    else if (envelope.payload.requestId) observations.set(envelope.payload.requestId, value);
    prune();
  }
  function prune(active) {
    for (const [key, value] of observations) if (!current(value)) observations.delete(key);
    for (const [key, value] of executions) if (!current(value) || active && !active.has(key)) executions.delete(key);
    for (const [key, value] of sessions) if (!current(value)) sessions.delete(key);
    for (const [key, value] of waiting) if (active && !active.has(key) || currentSession(value.envelope.nodeId) !== value.envelope.nodeSession) waiting.delete(key);
    if (observations.size > 256 || executions.size > 4096 || waiting.size > 4096) throw failure('IO_FAILURE', 'fact cache capacity exceeded');
  }
  return {
    put, prune,
    connected(node) { return current(sessions.get(node)); },
    get(requestId) { const value = observations.get(requestId); return current(value) ? value.envelope : null; },
    execution(id) { const value = executions.get(id); return current(value) ? value.envelope : null; },
    waiting(id) {
      const value = waiting.get(id);
      // A still-connected authenticated node can report a frozen waiting seq.
      // On disconnect the old observation becomes unknown, not an exit proof.
      if (!value || !current(sessions.get(value.envelope.nodeId))) return { status: 'absent' };
      return value.envelope.kind === 'waiting.delete' ? { status: 'absent' } : { status: 'ok', beat: value.envelope.payload };
    },
    removeWaiting(id) { waiting.delete(id); },
    readMachines() {
      const control = [...machines.values()].find(current)?.control;
      // No synthetic lifecycle owner/control on cold start. The original
      // schedulerInputs consumes machines; missing heartbeat means unknown.
      return { ...(control ? { control } : {}), machines: catalog.machines.map(({ name }) => {
        const value = machines.get(name);
        return current(value) ? { ...value.fact, heartbeat: value.fact.heartbeat ?? undefined }
          : { machine: name, heartbeat: undefined, counts: { inbox: 0, running: 0, done: 0, failed: 0, quarantine: 0 } };
      }) };
    },
    lifecycle(machine) { const value = machines.get(machine); return current(value) ? value.control : null; },
    readBeats() {
      const beats = new Map();
      for (const value of executions.values()) if (current(value) && value.envelope.kind === 'execution.heartbeat') {
        const beat = value.envelope.payload;
        beats.set(`${beat.ticketId}--${beat.attemptId}.json`, beat);
      }
      return { beats, invalid: [] };
    },
  };
}
module.exports = { createFacts };
