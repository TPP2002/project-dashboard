'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../packages/scheduler/src/protocol/contract.cjs');
const f = require('../packages/scheduler/fixtures/protocol/messages.cjs');
const d = require('../packages/scheduler/fixtures/protocol/read-directory.cjs');
require('../packages/scheduler/src/sched/client/deployment-config.cjs').configureDeployment({
  schemaVersion: 1, machines: [{ name: f.machine, dedicated: true }],
  projects: [{ id: f.payloads.submission.project, repo: '.', accepted: true, machines: [f.machine], menu: [{
    id: 'test:targeted', category: 'shared', cores: 1, args: { kind: 'paths' }, forms: [{ cmd: ['node', '--test'], tail: 'args' }],
  }] }], jobs: { 'test:targeted': { desc: 'Synthetic permission check', argv: ['node', '--test'], acceptsTarget: true, jobClass: 'shared' } },
});
const { createRemoteClient } = require('../packages/scheduler/src/sched/client/remote.cjs');

function fixture() {
  const calls = [], reads = [], bodies = new Map(d.bodies);
  const configEntry = { ...structuredClone(f.payloads['projection.manifest'].entries[0]),
    snapshotId: d.manifest.snapshotId, ledgerCursor: d.manifest.ledgerCursor };
  bodies.set(configEntry.object.objectId, f.configBytes);
  let generation = 1, connection = 'connected';
  const port = {
    runtime: { current: async () => ({ generation, connection, scope: f.scope }) },
    async call(request) {
      p.validateLocalSemanticRequest(request); calls.push(structuredClone(request));
      if (request.kind === 'read') {
        const manifest = { ...structuredClone(d.manifest), requestId: request.callId,
          issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
          entries: [configEntry, ...d.manifest.entries].filter(e => request.selectors.some(s => Object.keys(s).every(k => s[k] === e[k]))) };
        return { kind: 'read', manifest: p.validateReadManifest(manifest) };
      }
      if (request.kind === 'wait') return { kind: 'pending', callId: request.callId, retryAfterMs: 1 };
      return { kind: 'business', result: {
        messageId: 'fixture-business', envelopeHash: 'a'.repeat(64), operationKey: null, operationHash: null,
        status: 'business_accepted', businessCursor: { seq: 1, hash: 'b'.repeat(64) }, outcome: { kind: 'applied' },
      } };
    },
    async readObject(entry, manifest) {
      reads.push(entry);
      const context = { principal: { readAccess: { role: 'owner' } }, authorityId: f.scope.authorityId,
        authorityEpoch: f.scope.authorityEpoch, now: new Date().toISOString(), maxObjectBytes: 1024 * 1024 };
      const verified = p.verifyProjectionObject(bodies.get(entry.object.objectId), entry, manifest, context);
      return JSON.parse(Buffer.from(verified.bytes).toString('utf8'));
    },
  };
  return { client: createRemoteClient({ port, pollMs: 1, timeoutMs: 1000 }), port, calls, reads,
    replace: () => generation++, disconnect: () => { connection = 'disconnected'; } };
}

test('reads retain complete queued, unsatisfiable, registerOnly, resident and terminal domain bodies', async () => {
  const x = fixture();
  for (const original of d.tickets) assert.deepEqual(await x.client.ticket(original.ticketId), original);
  assert.equal(x.reads.length, d.tickets.length);
  const status = await x.client.status();
  assert.ok(status.objects.some(x => x.entry.kind === 'dispatcher-config'));
  assert.ok(status.objects.some(x => x.entry.kind === 'dispatcher-heartbeat'));
  assert.ok(status.objects.some(x => x.entry.kind === 'ticket-index'));
});

test('version eviction restarts the whole paged read once with fresh calls and no old objects', async () => {
  for (const failureAt of ['initial', 'page', 'object']) {
    const x = fixture(), readObject = x.port.readObject, calls = [], readVersions = [];
    const selectors = d.tickets.slice(0, 2).map(t => ({ kind: 'ticket', ticketId: t.ticketId }));
    const unavailable = Object.assign(new Error('frozen version evicted'), { code: 'READ_VERSION_UNAVAILABLE' });
    let version = 0;
    x.port.call = async request => {
      p.validateLocalSemanticRequest(request); calls.push(structuredClone(request));
      assert.equal(request.kind, 'read'); assert.deepEqual(request.selectors, selectors);
      if (request.snapshotId === null) { version++; assert.equal(request.pageToken, null); }
      else { assert.equal(request.snapshotId, `version-${version}`); assert.equal(request.pageToken, 'page-two'); }
      if (version === 1 && (failureAt === 'initial' || failureAt === 'page' && request.pageToken !== null)) throw unavailable;
      const index = request.pageToken === null ? 0 : 1;
      const ledgerCursor = { seq: d.manifest.ledgerCursor.seq + version, hash: String(version).repeat(64) };
      return { kind: 'read', manifest: { ...structuredClone(d.manifest), requestId: request.callId,
        snapshotId: `version-${version}`, ledgerCursor,
        issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
        entries: [{ ...structuredClone(d.manifest.entries[index]), snapshotId: `version-${version}`, ledgerCursor }],
        nextPageToken: index === 0 ? 'page-two' : null } };
    };
    x.port.readObject = async (entry, manifest) => {
      readVersions.push(manifest.snapshotId);
      if (version === 1 && failureAt === 'object' && entry.ticketId === selectors[1].ticketId) throw unavailable;
      return readObject(entry, manifest);
    };
    const result = await x.client.read(selectors);
    assert.equal(version, 2); assert.equal(result.snapshotId, 'version-2');
    assert.equal(result.objects.length, 2, 'discard objects accepted before eviction');
    assert.deepEqual(result.objects.map(row => row.value), d.tickets.slice(0, 2));
    for (const { entry } of result.objects) {
      assert.equal(entry.snapshotId, 'version-2'); assert.deepEqual(entry.ledgerCursor, result.ledgerCursor);
    }
    assert.equal(new Set(calls.map(c => c.callId)).size, calls.length);
    assert.equal(calls.filter(c => c.snapshotId === null && c.pageToken === null).length, 2);
    if (failureAt !== 'initial') assert.ok(readVersions.includes('version-1'), 'failure follows actual partial read');
  }
});

test('read retry budget is one and only the exact version-unavailable code permits it', async () => {
  for (const phase of ['catalog', 'object']) {
    for (const code of ['READ_VERSION_UNAVAILABLE', 'READ_DENIED', 'OBJECT_HASH', 'READ_STALE', undefined]) {
      const x = fixture(), original = x.port.call;
      const first = Object.assign(new Error('READ_VERSION_UNAVAILABLE: text alone grants no retry'), { code });
      const second = Object.assign(new Error('second version evicted'), { code: 'READ_VERSION_UNAVAILABLE' });
      let attempts = 0;
      x.port.call = async request => {
        attempts++;
        if (phase === 'catalog') throw attempts === 1 ? first : second;
        return original(request);
      };
      x.port.readObject = async () => { throw attempts === 1 ? first : second; };
      const retries = code === 'READ_VERSION_UNAVAILABLE';
      await assert.rejects(x.client.ticket(d.tickets[0].ticketId), error => error === (retries ? second : first));
      assert.equal(attempts, retries ? 2 : 1);
    }
  }
});

test('a manifest for a different read call is rejected without a version retry', async () => {
  const x = fixture(), original = x.port.call;
  x.port.call = async request => {
    const reply = await original(request); reply.manifest.requestId = 'wrong-call'; return reply;
  };
  await assert.rejects(x.client.ticket(d.tickets[0].ticketId), /READ_REQUEST_IDENTITY/);
  assert.equal(x.calls.length, 1); assert.equal(x.reads.length, 0);
});

test('a deterministic ticket absent before submission stays absent without retry or fabrication', async () => {
  const x = fixture();
  assert.equal(await x.client.ticket('tk-00000000000000000000'), null);
  assert.equal(x.calls.length, 1); assert.equal(x.reads.length, 0);
  assert.equal(x.calls[0].kind, 'read');
});

test('ordinary IPC cannot create native facts, envelopes or a replacement session', async () => {
  const x = fixture();
  await x.client.submit(f.payloads.submission);
  assert.deepEqual(x.calls[0].request, f.payloads.submission);
  for (const kind of ['report.started', 'lease.challenge', 'session.open', 'prepareObservation'])
    await assert.rejects(x.port.call({ kind, callId: 'fixture' }));
  assert.equal(x.calls.length, 1);
});

test('resident renewal is semantic IPC without started, release gate or caller-supplied process identity', async () => {
  const x = fixture(), resident = d.tickets.find(t => t.request.resident);
  const permit = resident.attempts[0].permit;
  await x.client.renewResident({ ticketId: resident.ticketId, attemptId: permit.attemptId, permitToken: permit.token, cores: permit.grantedCores });
  assert.equal(x.calls[0].kind, 'resident-renew');
  assert.deepEqual(Object.keys(x.calls[0]).sort(), ['kind', 'callId', 'ticketId', 'attemptId', 'permitToken', 'cores'].sort());
  x.disconnect();
  await assert.rejects(x.client.renewResident({ ticketId: resident.ticketId, attemptId: permit.attemptId, permitToken: permit.token, cores: 2 }), /DISCONNECTED/);
  assert.equal(x.calls.length, 1, 'disconnect never fabricates finish/cancel');
});

test('cancel/finish/pause/resume/reserve/owner hold preserve original command payloads', async () => {
  const x = fixture(), id = d.tickets[0].ticketId, opts = { submitter: 'fixture-owner' };
  await x.client.cancel(id, { ...opts, reason: 'fixture cancel' });
  await x.client.finish(id, 'failed', opts);
  await x.client.pause(id, opts); await x.client.resume(id, opts);
  await x.client.reserve(f.machine, 5, 60, opts); await x.client.ownerHold(f.machine, opts); await x.client.ownerRelease(f.machine, opts);
  assert.deepEqual(x.calls.map(x => x.command.kind), ['cancel', 'finish', 'pause-one', 'resume-one', 'reserve', 'owner-hold', 'owner-release']);
  assert.equal(x.calls[4].command.data.machine, f.machine); assert.equal(x.calls[4].command.data.durationMinutes, 60);
});

test('connection generation changes during a full object read reject the complete batch', async () => {
  const x = fixture(), read = x.port.readObject;
  x.port.readObject = async (...args) => { const object = await read(...args); x.replace(); return object; };
  await assert.rejects(x.client.ticket(d.tickets[0].ticketId), /READ_FENCED/);
});

test('immutable pending retries preserve the same semantic call and request', async () => {
  const x = fixture(), original = x.port.call;
  let first;
  x.port.call = async request => {
    if (!first) { first = structuredClone(request); return { kind: 'pending', callId: request.callId, retryAfterMs: 1 }; }
    assert.deepEqual(request, first); return original(request);
  };
  await x.client.submit(f.payloads.submission);
  assert.equal(x.calls.length, 1);
});

test('original CLI run calls local execution IPC and does not turn a null exit into success', async () => {
  const x = fixture(), cli = require('../packages/scheduler/src/sched/client/sched.cjs');
  const ticket = d.tickets.find(t => t.state === 'granted' && !t.request.resident), call = x.port.call;
  const runs = [];
  x.port.call = async request => {
    if (!request.kind.startsWith('local-run')) return call(request);
    p.validateLocalSemanticRequest(request); runs.push(request);
    return p.validateLocalExecutionReply({ kind: 'execution', runId: 'fixture-run', state: 'terminal',
      stdout: { offset: 0, nextOffset: 0, bytesBase64: '' }, stderr: { offset: 0, nextOffset: 0, bytesBase64: '' },
      terminal: { ok: false, exitCode: null, reason: 'exit unknown' } });
  };
  const result = await cli.run(ticket.ticketId, { mode: 'remote', remotePort: x.port, command: process.execPath,
    args: ['-e', 'process.exitCode=7'], root: process.cwd(), env: { CALLER_ONLY: 'fixture' } });
  assert.equal(result.exitCode, null); assert.equal(result.jobResult.ok, false); assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args, ['-e', 'process.exitCode=7']); assert.deepEqual(runs[0].env, { CALLER_ONLY: 'fixture' });
});

test('original CLI hold starts its own harmless child and renews resident identity without started', { timeout: 15000 }, async () => {
  const x = fixture(), cli = require('../packages/scheduler/src/sched/client/sched.cjs'), os = require('node:os');
  const resident = structuredClone(d.tickets.find(t => t.request.resident)), readObject = x.port.readObject;
  // Only the authenticated domain fixture changes machine; no process facts are accepted from the caller.
  x.port.readObject = async (entry, manifest) => {
    const value = await readObject(entry, manifest);
    if (entry.kind === 'ticket' && entry.ticketId === resident.ticketId) value.attempts[0].permit.machine = os.hostname();
    return value;
  };
  const result = await cli.hold({ mode: 'remote', remotePort: x.port, request: resident.request,
    root: process.cwd(), command: process.execPath, args: ['-e', 'process.exitCode=7'], env: { ...process.env }, beatSec: 1 });
  assert.equal(result.exitCode, 7);
  assert.ok(x.calls.some(c => c.kind === 'resident-renew'));
  assert.ok(x.calls.some(c => c.kind === 'command' && c.command.kind === 'cancel'));
  assert.ok(x.calls.every(c => !['local-run', 'report.started', 'lease.challenge'].includes(c.kind)));
});

test('synchronous validatePermit consumes current bounded IPC data and retains original token rejection', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module');
  const root = path.resolve(__dirname, '../packages/scheduler/src/sched/client');
  const ticket = structuredClone(d.tickets.find(t => t.state === 'granted' && !t.request.resident));
  const calls = [];
  const remoteFile = path.join(root, 'remote-cli.cjs'), remoteModule = { exports: {} };
  const remoteRequire = Module.createRequire(remoteFile);
  vm.runInThisContext(Module.wrap(fs.readFileSync(remoteFile, 'utf8')), { filename: remoteFile })(remoteModule.exports, ref => {
    if (ref !== 'node:child_process') return remoteRequire(ref);
    return { ...require(ref), spawnSync(exe, argv, options) {
      calls.push({ exe, argv, options }); return { status: 0, stdout: JSON.stringify({ ok: true, value: ticket }), stderr: '' };
    } };
  }, remoteModule, remoteFile, root);
  const file = path.join(root, 'sched.cjs'), module = { exports: {} }, actualRequire = Module.createRequire(file);
  const source = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '').replace(/^#![^\r\n]*/, '');
  vm.runInThisContext(Module.wrap(source), { filename: file })(module.exports,
    ref => ref === './remote-cli.cjs' ? remoteModule.exports : actualRequire(ref), module, file, root);
  const result = module.exports.validatePermit({ mode: 'remote', remoteConfig: { authorityId: 'fixture-authority' },
    share: 'Z:/forbidden-old-authority', category: ticket.request.category, cores: 1,
    env: { SCHED_MODE: 'remote', SCHED_PERMIT: `${ticket.ticketId}:a1:forged-token` } });
  assert.equal(result.ok, false); assert.match(result.reason, /令牌不符/); assert.equal(calls.length, 1);
  assert.ok(calls[0].argv[0].endsWith('remote-sync.cjs')); assert.ok(calls[0].options.timeout <= 60000);
  assert.deepEqual(JSON.parse(calls[0].options.input), { action: 'ticket', id: ticket.ticketId, config: { authorityId: 'fixture-authority' },
    catalog: require('../packages/scheduler/src/sched/client/deployment-config.cjs').getDeploymentConfig() });
  assert.ok(!calls[0].options.input.includes('forbidden-old-authority'));
});
