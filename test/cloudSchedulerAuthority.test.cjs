'use strict';
require('tsx/cjs');
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const p = require('../packages/scheduler/src/protocol/contract.cjs');
const { createCloudService } = require('../packages/scheduler/src/cloud/service.cjs');
const catalog = { schemaVersion: 1, machines: [{ name: 'fixture-win', dedicated: true }],
  projects: ['sample', 'private'].map(id => ({ id, repo: '.', accepted: true, machines: ['fixture-win'], menu: [
    { id: 'test', category: 'vitest', cores: 1, args: { kind: 'paths' }, forms: [{ cmd: ['node', '--test'], tail: 'args' }] },
  ] })), jobs: { test: { desc: 'Synthetic check', argv: ['node', '--test'], acceptsTarget: true, jobClass: 'vitest' } } };
const principal = { id: 'fixture-credential', role: 'windows', nodeIds: ['fixture-node'], machines: ['fixture-win'],
  allowedKinds: p.KINDS, nativeObservation: true,
  readAccess: { role: 'node', machine: 'fixture-win', projects: ['sample'], authorityKinds: p.SHARED_READ_KINDS } };
const owner = { ...principal, id: 'fixture-owner', role: 'client', nodeIds: ['fixture-reader'], nativeObservation: undefined, readAccess: { role: 'owner' } };
delete owner.nativeObservation;
const authority = { id: 'fixture-authority', host: 'fixture-cloud', ownerMachine: 'fixture-win', protocol: 100,
  head: 'a'.repeat(40), principals: [principal, owner] };
const call = { timeoutMs: 10000 };
async function fixture(config = {}) {
  const writer = config.principal ?? principal;
  const serviceAuthority = { ...authority, principals: [writer, owner, ...(config.readers ?? [])] };
  const root = config.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-authority-'));
  let time = config.time ?? Date.parse('2026-01-01T00:00:00.000Z');
  const now = () => new Date(time).toISOString();
  let service, sequence = 0, session = randomUUID(), generation = config.generation ?? 1;
  let readerSequence = 0, readerSession = randomUUID();
  const readerStreams = new Map();
  let controller = null, handoffState = 'absent', result = null, stopVerdict = 'unknown', stopRequests = 0;
  let objectFacts = {};
  const sent = [];
  function frame(kind, payload, execution, who = writer) {
    let stream;
    if (who !== owner && who.id !== writer.id) {
      stream = readerStreams.get(who.id);
      if (!stream) { stream = { session: randomUUID(), sequence: 0 }; readerStreams.set(who.id, stream); }
    }
    const nodeSession = who === owner ? readerSession : stream?.session ?? session;
    const value = { protocolVersion: p.PROTOCOL_VERSION, authorityId: authority.id, authorityEpoch: service.health().authorityEpoch,
      nodeId: who.nodeIds[0], nodeSession, messageId: randomUUID(), sequence: who === owner ? ++readerSequence : stream ? ++stream.sequence : ++sequence,
      kind, payload, ...(execution ? { execution } : {}) };
    value.contentHash = p.envelopeHash(value); p.encodeFrame(value); return value;
  }
  const sendToNode = async (nodeId, request) => {
    assert.equal(nodeId, 'fixture-node'); sent.push(request);
    assert.equal(fs.existsSync(path.join(root, 'sched', '_control', 'owner', 'sched-dispatcher.guard.json')), false, 'network must run outside owner commit');
    if (config.transport) { const reply = await config.transport(request, frame); if (reply) return reply; }
    // A strict transport substitute: both route and correlation are checked;
    // fixtures cannot return a permissive arbitrary JSON object.
    let response;
    if (request.kind === 'origin.request') response = frame('origin.proof', { machine: 'fixture-win', ownerMachine: 'fixture-win',
      requestId: request.payload.requestId, observationSequence: sequence + 1, observedAt: now(), codeRef: request.payload.codeRef,
      verdict: 'verified', observedOwnerSid: 'S-1-5-21-1', source: { method: 'ipc-peer', proofId: 'fixture-source',
        submissionHash: request.execution.submissionHash, observedOwnerSid: 'S-1-5-21-1', callId: 'fixture-call' } }, request.execution);
    else if (request.kind === 'process.stop-request') {
      stopRequests++;
      response = frame('process.stop-proof', { machine: 'fixture-win', requestId: request.payload.requestId,
        observationSequence: sequence + 1, observedAt: now(), verdict: stopVerdict, method: 'windows-job-object', evidenceHash: 'b'.repeat(64) }, request.execution);
    } else if (request.kind === 'handoff.observe-request') {
      const q = request.payload;
      response = frame('handoff.observe', { submissionId: q.submissionId, ownerMachine: q.ownerMachine, authorityHost: q.authorityHost,
        intentId: q.intentId, lifecycleEpoch: q.lifecycleEpoch, requestId: q.requestId,
        observationSequence: sequence + 1, observedAt: now(), state: handoffState, identity: q.expected,
        ...(result ? { result } : {}), ...objectFacts }, request.execution);
    } else if (['handoff.intent', 'handoff.publish', 'handoff.quarantine'].includes(request.kind)) {
      if (request.kind === 'handoff.publish') handoffState = 'inbox';
      if (request.kind === 'handoff.quarantine') { handoffState = 'quarantine'; result = { ok: false, reason: request.payload.reason }; }
      const op = p.operationIdentity(request);
      response = frame('result', { messageId: request.messageId, envelopeHash: request.contentHash, ...op,
        status: 'business_accepted', businessCursor: { seq: 0, hash: null }, outcome: { kind: 'applied' } });
    } else throw Object.assign(new Error(`fixture has no route ${request.kind}`), { code: 'NOT_CONFIGURED' });
    p.validateResponse(request, response); return response;
  };
  service = await createCloudService({ dataRoot: root, catalog, authority: serviceAuthority, sendToNode, clock: now, monotonicClock: () => time, fault: config.fault });
  async function send(kind, payload, execution, who = writer) { return service.authority.accept(who, frame(kind, payload, execution, who), call); }
  async function open(who = writer, replacesSession = null) {
    return send('session.open', { replacesSession, sessionGeneration: generation }, undefined, who);
  }
  async function observe() {
    const at = now();
    return send('machine.observation', { machine: 'fixture-win', observedAt: at, observationSequence: sequence + 1,
      lifecycle: { control: { namespace: 'jobs-v12', lifecycleSchema: 12, epoch: 'fixture-lifecycle', state: 'ACTIVE',
        codeVersion: authority.head, configuredMachines: ['fixture-win'], createdAt: at, createdBy: 'fixture' },
      machines: [{ machine: 'fixture-win', counts: { inbox: 0, running: 0, done: 0, failed: 0, quarantine: 0 },
        heartbeat: { machine: 'fixture-win', state: 'idle', at, pid: 321, protocol: 100, head: authority.head, ownerPid: 321,
          ownerToken: 'fixture-owner-token', jobSlots: { max: 4, running: 0 }, load: { schema: 1, cores: 8, busyCores: 0, busyPct: 0,
            windowSec: 30, sampledAt: at, ci: { state: 'idle', ciWorkers: 0, observedAt: at, stateSince: at } } } }] } });
  }
  function request(key, extra = {}) { return { idempotencyKey: key, project: 'sample', submitter: 'fixture', category: 'unit-test',
    title: 'Synthetic task', work: { type: 'test', targetPaths: ['test/sample.cjs'] }, requestedCores: 1,
    allowedMachines: ['fixture-win'], codeRef: { kind: 'commit', value: authority.head }, resources: { exclusive: [] }, createdAt: now(), ...extra }; }
  function ticket(id) { return JSON.parse(fs.readFileSync(path.join(root, 'sched', 'tickets', `${id}.json`), 'utf8')); }
  async function submit(key, extra = {}) {
    const body = request(key, extra), envelope = frame('submission', body);
    const receipt = await service.authority.accept(writer, envelope, call);
    assert.equal(receipt.payload.status, 'durably_received');
    await service.tick(); await service.tick();
    const accepted = await service.authority.accept(writer, envelope, call);
    assert.equal(accepted.payload.status, 'business_accepted');
    return { id: accepted.payload.outcome.ticketId, envelope, accepted };
  }
  async function start(id) {
    const t = ticket(id), permit = t.attempts.at(-1).permit;
    controller = { pid: 456, creationFileTime: '133000000000000001' };
    const identity = { stage: 'started', ticketId: id, attemptId: t.currentAttemptId, permitToken: permit.token, controller };
    const envelope = frame('report.started', { ticketId: id, attemptId: identity.attemptId, token: permit.token, machine: 'fixture-win',
      at: now(), phase: 'started', pid: controller.pid, creationFileTime: controller.creationFileTime, codeRef: t.request.codeRef }, identity);
    await service.authority.accept(writer, envelope, call); await service.tick();
    const ack = await service.authority.accept(writer, envelope, call);
    assert.equal(ack.payload.status, 'business_accepted'); return { envelope, ack, identity };
  }
  return { root, service, now, writer, advance(ms) { time += ms; }, frame, send, open, observe, request, ticket, submit, start, sent,
    setStop(value) { stopVerdict = value; }, setJob(value, body, refs = {}) { handoffState = value; result = body; objectFacts = refs; }, stopRequests: () => stopRequests,
    replace() { const old = session; session = randomUUID(); sequence = 0; generation++; return old; },
    async dispose() { await service.close(); if (!config.root) fs.rmSync(root, { recursive: true, force: true }); } };
}
module.exports = { fixture, p, principal, owner, authority, catalog, call };

if (require.main === module) {
  test('actual service: durable receipt precedes source verification, grant, strict started and lease', async () => {
    const f = await fixture();
    try {
      await f.open(); await f.observe();
      const job = await f.submit('lifecycle');
      assert.equal(f.ticket(job.id).state, 'granted');
      const started = await f.start(job.id);
      assert.equal(f.ticket(job.id).state, 'running');
      const response = await f.send('lease.challenge', { challenge: randomUUID(), challengeSequence: 1,
        ledgerSeq: f.service.health().cursor.seq, requestedTtlMs: 60000, gatewayInstance: 'fixture-gateway', nodeInstance: 'fixture-runtime' }, started.identity);
      assert.equal(response.kind, 'lease.renewal'); assert.equal(response.payload.ttlMs, 30000);
      const projection = await f.send('state.read', { requestId: randomUUID(), afterCursor: { seq: 0, hash: null }, limit: 1024 });
      assert.equal(projection.kind, 'state.snapshot'); assert.equal(projection.payload.attempts[0].controller.creationFileTime, started.identity.controller.creationFileTime);
      assert.notEqual(projection.payload.authorityHost, projection.payload.ownerMachine);
    } finally { await f.dispose(); }
  });
  test('a stale first challenge can refresh its projection but cannot authorize execution', async () => {
    const f = await fixture();
    try {
      await f.open(); await f.observe(); const job = await f.submit('bootstrap'); const started = await f.start(job.id);
      const challenge = { challenge: randomUUID(), challengeSequence: 1, ledgerSeq: 1,
        requestedTtlMs: 30000, gatewayInstance: 'bootstrap-gateway', nodeInstance: 'bootstrap-node' };
      const denied = await f.send('lease.challenge', challenge, started.identity);
      assert.equal(denied.kind, 'result'); assert.equal(denied.payload.status, 'business_rejected');
      const projection = await f.send('state.read', { requestId: randomUUID(), afterCursor: { seq: 0, hash: null }, limit: 1024 });
      assert.equal(projection.kind, 'state.snapshot');
      assert.equal(projection.payload.gatewayInstance, challenge.gatewayInstance);
      const renewal = await f.send('lease.challenge', { ...challenge, challenge: randomUUID(), challengeSequence: 2,
        ledgerSeq: projection.payload.ledgerSeq }, started.identity);
      assert.equal(renewal.kind, 'lease.renewal');
      await assert.rejects(f.send('lease.challenge', { ...challenge, challenge: randomUUID(), challengeSequence: 3,
        ledgerSeq: projection.payload.ledgerSeq }, { ...started.identity,
        controller: { ...started.identity.controller, creationFileTime: '133000000000000002' } }), /controller birth mismatch/);
    } finally { await f.dispose(); }
  });
  test('unknown stop proof retains occupancy; current native tree-exited evidence releases it', async () => {
    const f = await fixture();
    try {
      await f.open(); await f.observe(); const job = await f.submit('stop'); await f.start(job.id);
      await f.send('command', { commandId: 'cancel-stop', kind: 'cancel', data: { ticketId: job.id }, submitter: 'fixture', createdAt: f.now(), expiresAt: '2026-01-02T00:00:00.000Z' });
      await f.service.tick(); await f.service.tick();
      assert.equal(f.ticket(job.id).state, 'running'); assert.ok(f.stopRequests() > 0);
      f.setStop('tree-exited'); await f.service.tick(); await f.service.tick();
      assert.equal(f.ticket(job.id).state, 'cancelled');
    } finally { await f.dispose(); }
  });
  test('hold retains reservation without started or a native process tree', async () => {
    const f = await fixture();
    try {
      await f.open(); await f.observe(); const job = await f.submit('hold', { resident: true });
      for (let i = 0; i < 4; i++) { f.advance(30000); await f.service.tick(); }
      assert.equal(f.ticket(job.id).state, 'granted');
      assert.equal(f.ticket(job.id).attempts[0].controller, undefined);
      assert.equal(f.stopRequests(), 0);
    } finally { await f.dispose(); }
  });
  test('cluster running directory does not synthesize started; notStarted enters original bounded requeue', async () => {
    const f = await fixture();
    try {
      await f.open(); await f.observe(); const job = await f.submit('cluster', { execution: 'cluster' });
      for (let i = 0; i < 4; i++) await f.service.tick();
      f.setJob('running', null); await f.service.tick(); await f.service.tick();
      assert.equal(f.ticket(job.id).state, 'granted');
      f.setJob('failed', { ok: false, exitCode: null, notStarted: { attemptId: 'a1', state: 'granted', waitedMs: 2000 } });
      await f.service.tick(); await f.service.tick();
      assert.equal(f.ticket(job.id).currentAttemptId, 'a2');
      assert.equal(f.ticket(job.id).attempts[0].result.outcome, 'handoff-interrupted');
    } finally { await f.dispose(); }
  });
  test('cold start has unknown capacity; authenticated facts restore admission without a local jobs writer', async () => {
    const f = await fixture();
    try {
      await f.open(); const envelope = f.frame('submission', f.request('cold'));
      await f.service.authority.accept(principal, envelope, call); await f.service.tick();
      assert.equal(f.sent.length, 0);
      assert.equal(fs.readdirSync(path.join(f.root, 'sched', 'tickets')).length, 0);
      await f.observe(); await f.service.tick(); await f.service.tick();
      const ack = await f.service.authority.accept(principal, envelope, call);
      assert.equal(ack.payload.status, 'business_accepted');
      assert.equal(f.ticket(ack.payload.outcome.ticketId).state, 'granted');
      assert.equal(fs.existsSync(path.join(f.root, 'jobs-v12')), false);
    } finally { await f.dispose(); }
  });
  test('resident renewal uses its real renewer identity, not report.started or a JobObject lease', async () => {
    const f = await fixture();
    try {
      await f.open(); await f.observe(); const job = await f.submit('resident', { resident: true });
      const t = f.ticket(job.id), permit = t.attempts[0].permit;
      const identity = { stage: 'resident', ticketId: job.id, attemptId: 'a1', permitToken: permit.token,
        renewer: { pid: 789, creationFileTime: '133000000000000002' }, source: {
          method: 'ipc-peer', proofId: 'fixture-source', submissionHash: p.contentHash(job.envelope.payload),
          observedOwnerSid: 'S-1-5-21-1', callId: 'fixture-call' } };
      const ack = await f.send('resident.renewal', { schema: 1, ticketId: job.id, machine: 'fixture-win', cores: 1, pid: 789, at: f.now() }, identity);
      assert.equal(ack.payload.status, 'business_accepted');
      assert.equal(f.ticket(job.id).attempts[0].controller, undefined);
      const forged = { ...identity, renewer: { ...identity.renewer, creationFileTime: '133000000000000003' } };
      await assert.rejects(f.send('resident.renewal', { schema: 1, ticketId: job.id, machine: 'fixture-win', cores: 1, pid: 789, at: f.now() }, forged), /renewer/);
      assert.equal(f.service.health().stopped, false);
    } finally { await f.dispose(); }
  });
  test('default local daemon preserves the original registerOnly zero-core lifecycle', async () => {
    const f = await fixture(); let local;
    try {
      await f.service.close();
      const load = require('../packages/scheduler/src/cloud/domain.cjs');
      const sources = { now: f.now, nonce: randomUUID };
      local = load('sched-daemon').startSchedulerDaemon({ share: f.root, machine: 'fixture-win', host: 'fixture-local',
        pid: process.pid, protocol: 100, head: authority.head, sources,
        readMachines: () => ({ machines: [], control: {} }),
        originProbe: { request() {}, pump() {}, take: () => [], inFlight: () => 0, close() {} } });
      load('sched-intake').writeSubmission(f.root, f.request('local-register', { category: 'codex-build', requestedCores: 0 }));
      assert.equal(local.tick(), true);
      const ticket = Object.values(local.state.tickets)[0];
      assert.equal(ticket.registerOnly, true); assert.equal(ticket.state, 'running');
      assert.equal(ticket.attempts[0].permit, null);
    } finally { local?.close(); await f.dispose(); }
  });
  test('pause/resume/owner-hold preserve intent and only native confirmation changes pause accounting', async () => {
    const f = await fixture();
    try {
      await f.open(); await f.observe(); const job = await f.submit('pause'); const started = await f.start(job.id);
      const command = async (id, kind, data) => {
        await f.send('command', { commandId: id, kind, data, submitter: 'fixture', createdAt: f.now(), expiresAt: '2026-01-02T00:00:00.000Z' });
        await f.service.tick();
      };
      await command('pause-one', 'pause-one', { ticketId: job.id });
      assert.equal(f.ticket(job.id).manualPause, true); assert.equal(f.ticket(job.id).state, 'running');
      const childPid = 457; // Synthetic child is distinct from this fixture's controller (456).
      const from = Date.parse(f.now()); f.advance(1000);
      await f.send('execution.heartbeat', { ticketId: job.id, attemptId: 'a1', token: started.identity.permitToken,
        machine: 'fixture-win', childPid, at: f.now(), suspend: { sequence: 1, at: Date.parse(f.now()), mode: 'paused',
          reasons: ['manual'], intervals: [{ from, to: null }], slowIntervals: [], ended: false, alert: null } }, started.identity);
      await f.service.tick(); assert.equal(f.ticket(job.id).state, 'paused');
      await command('resume-one', 'resume-one', { ticketId: job.id });
      assert.equal(f.ticket(job.id).manualPause, false); assert.equal(f.ticket(job.id).state, 'paused');
      f.advance(1000);
      await f.send('execution.heartbeat', { ticketId: job.id, attemptId: 'a1', token: started.identity.permitToken,
        machine: 'fixture-win', childPid, at: f.now(), suspend: { sequence: 2, at: Date.parse(f.now()), mode: 'running',
          reasons: [], intervals: [{ from, to: Date.parse(f.now()) }], slowIntervals: [], ended: false, alert: null } }, started.identity);
      await f.service.tick(); assert.equal(f.ticket(job.id).state, 'running');
      await command('hold-owner', 'owner-hold', { machine: 'fixture-win' });
      assert.equal(f.ticket(job.id).ownerHold, true);
      await command('release-owner', 'owner-release', { machine: 'fixture-win' });
      assert.equal(f.ticket(job.id).ownerHold, false);
    } finally { await f.dispose(); }
  });
  test('cluster rerun result remains intact and uses the original one-rerun branch', async () => {
    const f = await fixture();
    try {
      await f.open(); await f.observe(); const job = await f.submit('rerun', { execution: 'cluster' });
      for (let i = 0; i < 4; i++) await f.service.tick();
      await f.start(job.id);
      const plan = { complete: true, eligible: [{ identity: { file: 'test/sample.cjs', titlePath: ['synthetic case'], instanceIndex: 0 },
        sourceSha256: 'b'.repeat(64), overlapMs: 1000 }], slowTimeouts: 0, otherTimeouts: 0, retainedFailures: 0, sharedHookTimeouts: 0, notes: [] };
      f.setJob('failed', { ok: false, exitCode: 1, reason: 'synthetic suspended timeout', rerunPlan: plan });
      await f.service.tick(); await f.service.tick();
      const ticket = f.ticket(job.id);
      assert.equal(ticket.currentAttemptId, 'a2');
      const requeue = ticket.timeline.find(event => event.type === 'requeued');
      assert.deepEqual(requeue.data.rerun.selection, plan.eligible.map(({ identity, sourceSha256 }) => ({ identity, sourceSha256 })));
      assert.equal(ticket.attempts[0].result.outcome, 'failed');
    } finally { await f.dispose(); }
  });
}
