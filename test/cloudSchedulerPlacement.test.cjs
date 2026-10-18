'use strict';
require('tsx/cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const p = require('../packages/scheduler/src/protocol/contract.cjs');
const { createCloudService } = require('../packages/scheduler/src/cloud/service.cjs');

// Acceptance source: the owner requires cloud decisions to use both workers'
// available capacity. This exercises the real authority with authenticated,
// synthetic machine facts. It is not proof of SSH or two-device execution.
const machines = ['example-primary', 'example-secondary'];
const catalog = { schemaVersion: 1, machines: machines.map(name => ({ name, dedicated: true })),
  projects: [{ id: 'sample', repo: '.', accepted: true, machines, menu: [{ id: 'typecheck',
    category: 'shared', cores: 1, args: { kind: 'none' }, forms: [{ cmd: ['node', 'check.cjs'], tail: 'none' }] }] }], jobs: {} };
const principals = machines.map((machine, index) => ({ id: `credential-${index}`, role: 'windows',
  nodeIds: [`node-${index}`], machines: [machine], allowedKinds: p.KINDS, nativeObservation: true,
  readAccess: { role: 'node', machine, projects: ['sample'], authorityKinds: p.SHARED_READ_KINDS } }));
const authority = { id: 'example-authority', host: 'example-cloud', ownerMachine: machines[0],
  protocol: 100, head: 'a'.repeat(40), principals };
const options = { timeoutMs: 10000 };

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-placement-'));
  const streams = principals.map(() => ({ session: randomUUID(), sequence: 0 }));
  let time = Date.parse('2026-01-01T00:00:00.000Z'), service;
  const now = () => new Date(time).toISOString();
  function frame(index, kind, payload, execution) {
    const stream = streams[index];
    const envelope = { protocolVersion: p.PROTOCOL_VERSION, authorityId: authority.id,
      authorityEpoch: service.health().authorityEpoch, nodeId: principals[index].nodeIds[0],
      nodeSession: stream.session, messageId: randomUUID(), sequence: ++stream.sequence,
      kind, payload, ...(execution ? { execution } : {}) };
    envelope.contentHash = p.envelopeHash(envelope);
    p.encodeFrame(envelope);
    return envelope;
  }
  async function send(index, kind, payload, execution) {
    return service.authority.accept(principals[index], frame(index, kind, payload, execution), options);
  }
  service = await createCloudService({ dataRoot: root, catalog, authority, clock: now, monotonicClock: () => time,
    sendToNode: async (nodeId, request) => {
      const index = principals.findIndex(principal => principal.nodeIds.includes(nodeId));
      assert.notEqual(index, -1);
      // Snapshot/execution are deliberately outside this decision-level test.
      if (request.kind !== 'origin.request') throw Object.assign(new Error('execution not connected in this fixture'), { code: 'DISCONNECTED' });
      const response = frame(index, 'origin.proof', { machine: machines[index], ownerMachine: machines[index],
        requestId: request.payload.requestId, observationSequence: streams[index].sequence + 1,
        observedAt: now(), codeRef: request.payload.codeRef, verdict: 'verified', observedOwnerSid: 'S-1-5-21-1',
        source: { method: 'ipc-peer', proofId: 'fixture-source', submissionHash: request.execution.submissionHash,
          observedOwnerSid: 'S-1-5-21-1', callId: 'fixture-call' } }, request.execution);
      p.validateResponse(request, response);
      return response;
    } });
  fs.writeFileSync(path.join(root, 'sched', '_control', 'hub.json'), JSON.stringify({
    schema: 1, portable: 'on', projects: ['sample'], workTypes: ['typecheck'], managedLoad: true,
  }));
  for (let index = 0; index < principals.length; index++) {
    await send(index, 'session.open', { replacesSession: null, sessionGeneration: 1 });
  }
  async function observe(index, busyCores) {
    const machine = machines[index], at = now();
    return send(index, 'machine.observation', { machine, observedAt: at, observationSequence: streams[index].sequence + 1,
      lifecycle: { control: { namespace: 'jobs-v12', lifecycleSchema: 12, epoch: `fixture-${index}`, state: 'ACTIVE',
        codeVersion: authority.head, configuredMachines: [machine], createdAt: at, createdBy: 'fixture' },
      machines: [{ machine, counts: { inbox: 0, running: 0, done: 0, failed: 0, quarantine: 0 },
        heartbeat: { machine, state: 'idle', at, pid: 321 + index, protocol: 100, head: authority.head,
          ownerPid: 321 + index, ownerToken: `owner-${index}`, jobSlots: { max: 4, running: 0 },
          load: { schema: 1, cores: 8, busyCores, busyPct: busyCores / 8 * 100, windowSec: 30, sampledAt: at,
            ci: { state: 'idle', ciWorkers: 0, observedAt: at, stateSince: at } } } }] } });
  }
  async function submit() {
    const envelope = frame(0, 'submission', { idempotencyKey: 'load-choice', project: 'sample', submitter: 'fixture',
      category: 'other', title: 'Cloud capacity selection', work: { type: 'typecheck', targetPaths: ['check.cjs'] },
      requestedCores: 1, allowedMachines: machines, codeRef: { kind: 'commit', value: authority.head },
      resources: { exclusive: [] }, createdAt: now(), execution: 'auto', origin: machines[0],
      menu: { item: 'typecheck', args: [] } });
    await service.authority.accept(principals[0], envelope, options);
    await service.tick(); await service.tick();
    const result = await service.authority.accept(principals[0], envelope, options);
    assert.equal(result.payload.status, 'business_accepted');
    return JSON.parse(fs.readFileSync(path.join(root, 'sched', 'tickets', `${result.payload.outcome.ticketId}.json`), 'utf8'));
  }
  return { observe, submit, advance(ms) { time += ms; }, async close() {
    await service.close(); fs.rmSync(root, { recursive: true, force: true });
  } };
}

test('cloud selects either worker from current capacity without a fixed preferred machine', async () => {
  for (const [loads, chosen] of [[[8, 0], machines[1]], [[0, 8], machines[0]]]) {
    const f = await fixture();
    try {
      await f.observe(0, loads[0]); await f.observe(1, loads[1]);
      const ticket = await f.submit();
      assert.equal(ticket.state, 'granted');
      assert.equal(ticket.placement.portable, true);
      assert.equal(ticket.attempts.at(-1).permit.machine, chosen);
    } finally { await f.close(); }
  }
});

test('stale secondary capacity is unavailable instead of being treated as idle', async () => {
  const f = await fixture();
  try {
    await f.observe(1, 0); f.advance(31000); await f.observe(0, 8);
    const ticket = await f.submit();
    assert.equal(ticket.state, 'queued');
    assert.equal(ticket.attempts.at(-1).permit, null);
  } finally { await f.close(); }
});
