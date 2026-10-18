'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const p = require('../packages/scheduler/src/protocol/contract.cjs');
const { createNativeGate } = require('../packages/scheduler/src/node/native.cjs');
const scope = { authorityId: 'fixture-authority', authorityEpoch: 1, nodeId: 'fixture-node', nodeSession: 'fixture-session',
  gatewayInstance: 'fixture-gateway', nodeInstance: 'fixture-instance' };
const granted = { stage: 'granted', ticketId: 'tk-12345678901234567890', attemptId: 'a1', permitToken: 'fixture-token' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('native transport reads this process token identity including its actual AuthenticationId', { timeout: 120000 }, async () => {
  assert.equal(process.platform, 'win32', 'requires actual Windows token identity');
  const { readParentIdentity } = require('../packages/scheduler/src/transport/local-ipc.cjs');
  const config = { powershell: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') };
  const peer = await readParentIdentity(config, { timeoutMs: 30000 });
  assert.equal(peer.pid, process.pid);
  assert.match(peer.sid, /^S-1-\d+(?:-\d+)+$/);
  assert.match(peer.creationFileTime, /^[1-9]\d*$/);
  assert.match(peer.logonSessionId, /^[0-9a-f]{16}$/);
  assert.deepEqual(await readParentIdentity(config, { timeoutMs: 30000 }), peer, 'PID, birth, SID and token LUID are stable together');
});
function envelope(kind, payload, identity, sequence = 1) {
  const e = { protocolVersion: p.PROTOCOL_VERSION, authorityId: scope.authorityId, authorityEpoch: scope.authorityEpoch,
    nodeId: scope.nodeId, nodeSession: scope.nodeSession, messageId: `fixture-message-${sequence}`, sequence, kind, payload, execution: identity };
  return { ...e, contentHash: p.envelopeHash(e) };
}
async function fixture(t) {
  assert.equal(process.platform, 'win32', 'NATIVE acceptance requires actual Windows JobObjects');
  const hostBytes = await fs.readFile(path.join(__dirname, '../packages/scheduler/src/sched/native/remote-host.ps1'));
  assert.deepEqual([...hostBytes.subarray(0, 3)], [239, 187, 191], 'Windows PowerShell 5 reads the Chinese dot-source filename as UTF-8');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-node-native-'));
  await fs.writeFile(path.join(root, 'grandchild.cjs'), `require('node:fs').writeFileSync('grandchild.marker',String(process.pid)); setInterval(()=>{},100);`);
  await fs.writeFile(path.join(root, 'child.cjs'), `const fs=require('node:fs'); fs.writeFileSync('child.marker',String(process.pid)); require('node:child_process').spawn(process.execPath,['grandchild.cjs'],{stdio:'ignore',windowsHide:true}); setInterval(()=>{},100);`);
  const gate = createNativeGate({ scope, directory: root, executable: process.execPath, args: [path.join(root, 'child.cjs')], cwd: root,
    env: { ...process.env, LOCALAPPDATA: root, TMP: root, TEMP: root }, timeoutMs: 30000 });
  t.after(async () => {
    await gate.close();
    assert.ok(path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('scheduler-node-native-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const prepared = await gate.prepare(granted), identity = prepared.identity;
  assert.ok(prepared.root.pid > 0); assert.notEqual(prepared.root.pid, identity.controller.pid);
  const initialMembers = await gate.members();
  assert.ok(Array.isArray(initialMembers), 'native singleton array must survive transport');
  assert.equal(initialMembers.length, 1);
  const started = envelope('report.started', { phase: 'started', ticketId: identity.ticketId, attemptId: identity.attemptId,
    token: identity.permitToken, machine: 'fixture-machine', pid: identity.controller.pid, creationFileTime: identity.controller.creationFileTime,
    codeRef: { kind: 'commit', value: 'a'.repeat(40) }, at: new Date().toISOString() }, identity);
  const ack = { messageId: started.messageId, envelopeHash: started.contentHash, ...p.operationIdentity(started),
    status: 'business_accepted', businessCursor: { seq: 10, hash: 'a'.repeat(64) },
    outcome: { kind: 'report', ticketId: identity.ticketId, attemptId: identity.attemptId, phase: 'started' } };
  const projection = { ...scope, authorityHost: 'fixture-linux', ownerMachine: 'fixture-machine', requestId: 'fixture-read', snapshotId: 'fixture-snapshot',
    complete: true, ledgerSeq: 11, businessCursor: { seq: 11, hash: 'b'.repeat(64) }, sessionWatermark: 1, liveWatermark: 0, generatedAt: new Date().toISOString(),
    attempts: [{ ...identity, state: 'running', grantedCores: 1, permitLedgerSeq: 9, cancelRequested: false }] };
  async function challenge(ttl = 30000, sequence = 1) {
    const q = envelope('lease.challenge', { challenge: `fixture-challenge-${sequence}`, challengeSequence: sequence, ledgerSeq: 11,
      requestedTtlMs: ttl, gatewayInstance: scope.gatewayInstance, nodeInstance: scope.nodeInstance }, identity, sequence + 10);
    const record = await gate.recordChallengeSend(gate.gateId, q);
    const renewal = envelope('lease.renewal', { ...scope, ...identity, ledgerSeq: 11, challenge: q.payload.challenge,
      challengeSequence: sequence, leaseId: `fixture-lease-${sequence}`, leaseSequence: sequence, ttlMs: ttl }, identity, sequence + 20);
    return { record, renewal };
  }
  async function lease(ttl, sequence) { const q = await challenge(ttl, sequence); return gate.acceptLease(gate.gateId, q.renewal); }
  return { root, gate, prepared, identity, started, ack, projection, challenge, lease };
}

test('real native child + grandchild exit at lease deadline while JS is blocked and stdin remains open', { timeout: 120000 }, async t => {
  const f = await fixture(t), lease = await f.lease(2500);
  await f.gate.release(f.gate.gateId, f.started, f.ack, f.projection, lease);
  for (let i = 0; i < 60; i++) {
    if ((await f.gate.members()).length >= 2) {
      try { await fs.access(path.join(f.root, 'grandchild.marker')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await sleep(20);
  }
  assert.ok((await f.gate.members()).length >= 2, 'both generations are real JobObject members');
  assert.ok(await fs.readFile(path.join(f.root, 'grandchild.marker'), 'utf8'));
  // No stdin.end, no Node timer, no other process sends kill during this block.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  const result = await f.gate.poll();
  assert.equal(result.expired, true); assert.equal(result.verdict, 'tree-exited');
  assert.equal(result.empty, true); assert.equal(result.released, true);
  assert.deepEqual(await f.gate.members(), [], 'native empty array must survive transport');
  await assert.rejects(f.gate.action('resume'), /GATE_EXPIRED/, 'readable expiry never allows another process action');
});

test('native lease clocks survive exact JSON round trips across repeated renewals', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const ack = { messageId: f.started.messageId, envelopeHash: f.started.contentHash, ...p.operationIdentity(f.started), status: 'durably_received', durableSeq: 1 };
  for (let sequence = 1; sequence <= 32; sequence++) {
    const lease = await f.lease(30000, sequence);
    assert.ok(Number.isSafeInteger(lease.deadlineMonotonicMs));
    assert.ok(Number.isSafeInteger(lease.watermarks.lastMonotonicMs));
    await assert.rejects(f.gate.release(f.gate.gateId, f.started, ack, f.projection, lease), /STARTED_ACK_REQUIRED/);
  }
  await assert.rejects(fs.stat(path.join(f.root, 'child.marker')), { code: 'ENOENT' });
});

test('lost/nonbusiness started ACK cannot run marker; repeated prepare creates only one tree', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.gate.prepare(granted), f.prepared);
  const lease = await f.lease();
  const ack = { messageId: f.started.messageId, envelopeHash: f.started.contentHash, ...p.operationIdentity(f.started), status: 'durably_received', durableSeq: 1 };
  await assert.rejects(f.gate.release(f.gate.gateId, f.started, ack, f.projection, lease));
  await assert.rejects(f.gate.action('resume'), /START_GATE_NOT_RELEASED/);
  await assert.rejects(fs.stat(path.join(f.root, 'child.marker')), { code: 'ENOENT' });
  assert.equal((await f.gate.members()).length, 1);
  await f.gate.release(f.gate.gateId, f.started, f.ack, f.projection, lease);
  await assert.rejects(f.gate.release(f.gate.gateId, f.started, f.ack, f.projection, lease), /RELEASE_ALREADY_CONSUMED/);
});

test('wrong birth/token/scope cannot kill an owned tree or an unrelated process', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const outsider = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { outsider.once('spawn', resolve); outsider.once('error', reject); });
  const outsiderClosed = new Promise(resolve => outsider.once('close', resolve));
  t.after(async () => { if (outsider.exitCode === null && outsider.signalCode === null) outsider.kill(); await outsiderClosed; });
  for (const identity of [
    { ...f.identity, permitToken: 'wrong' },
    { ...f.identity, controller: { ...f.identity.controller, creationFileTime: '1' } },
    { ...f.identity, controller: { ...f.identity.controller, pid: outsider.pid } },
  ]) await assert.rejects(f.gate.stop(identity), /EXECUTION_IDENTITY/);
  const { renewal } = await f.challenge();
  const inconsistent = structuredClone(renewal); inconsistent.payload.nodeSession = 'old-session'; inconsistent.contentHash = p.envelopeHash(inconsistent);
  await assert.rejects(f.gate.acceptLease(f.gate.gateId, inconsistent), /LEASE_SCOPE/);
  const wrong = structuredClone(renewal); wrong.nodeSession = wrong.payload.nodeSession = 'old-session'; wrong.contentHash = p.envelopeHash(wrong);
  p.decodeFrame(p.encodeFrame(wrong)); // Self-consistent old scope reaches native.
  await assert.rejects(f.gate.acceptLease(f.gate.gateId, wrong), error => error.nativeRequestKind === 'lease' && /ENVELOPE_SCOPE/.test(error.message));
  const oldInstance = structuredClone(renewal); oldInstance.payload.gatewayInstance = 'old-gateway'; oldInstance.contentHash = p.envelopeHash(oldInstance);
  p.decodeFrame(p.encodeFrame(oldInstance));
  await assert.rejects(f.gate.acceptLease(f.gate.gateId, oldInstance), error => error.nativeRequestKind === 'lease' && /SCOPE_MISMATCH/.test(error.message));
  assert.equal((await f.gate.poll()).verdict, 'alive');
  assert.equal(outsider.exitCode, null); assert.equal(outsider.signalCode, null);
});

test('late or duplicate lease ACK never grants another TTL from receipt time', { timeout: 120000 }, async t => {
  const f = await fixture(t), q = await f.challenge(200);
  await sleep(350);
  await assert.rejects(f.gate.acceptLease(f.gate.gateId, q.renewal), /EXPIRED/);
  assert.equal((await f.gate.poll()).released, false);
  await assert.rejects(fs.stat(path.join(f.root, 'child.marker')), { code: 'ENOENT' });
});

test('duplicate live lease rejected and cancelled projection cannot release', { timeout: 120000 }, async t => {
  const f = await fixture(t), q = await f.challenge();
  const lease = await f.gate.acceptLease(f.gate.gateId, q.renewal);
  assert.deepEqual(lease.watermarks.consumedLeaseIds, [q.renewal.payload.leaseId], 'nested singleton arrays are preserved too');
  assert.ok(Number.isFinite(lease.deadlineMonotonicMs));
  await assert.rejects(f.gate.release(f.gate.gateId, f.started, f.ack, f.projection,
    { ...lease, deadlineMonotonicMs: lease.deadlineMonotonicMs + 1 }), /LEASE_REQUIRED/);
  const changedClock = lease.watermarks.lastMonotonicMs + Number.EPSILON * Math.max(1, Math.abs(lease.watermarks.lastMonotonicMs));
  assert.notEqual(changedClock, lease.watermarks.lastMonotonicMs);
  await assert.rejects(f.gate.release(f.gate.gateId, f.started, f.ack, f.projection,
    { ...lease, watermarks: { ...lease.watermarks, lastMonotonicMs: changedClock } }), /LEASE_REQUIRED/);
  await assert.rejects(f.gate.acceptLease(f.gate.gateId, q.renewal));
  const projection = structuredClone(f.projection); projection.attempts[0].cancelRequested = true;
  await assert.rejects(f.gate.release(f.gate.gateId, f.started, f.ack, projection, lease), /PROJECTION_REFUSED/);
  await assert.rejects(fs.stat(path.join(f.root, 'child.marker')), { code: 'ENOENT' });
});

test('lease ID reuse with newer sequence is rejected; native member actions require full owned birth', { timeout: 120000 }, async t => {
  const f = await fixture(t), first = await f.challenge();
  const lease = await f.gate.acceptLease(f.gate.gateId, first.renewal);
  await f.gate.release(f.gate.gateId, f.started, f.ack, f.projection, lease);
  const second = await f.challenge(30000, 2);
  second.renewal.payload.leaseId = first.renewal.payload.leaseId;
  second.renewal.contentHash = p.envelopeHash(second.renewal);
  await assert.rejects(f.gate.acceptLease(f.gate.gateId, second.renewal), /LEASE_REPLAY/);
  const member = (await f.gate.members())[0];
  await assert.rejects(f.gate.act('suspend', { ...member, creationFileTime: '1' }, 1), /JOB_MEMBER_IDENTITY_UNKNOWN/);
  const result = await f.gate.act('suspend', member, 1);
  assert.notEqual(result.status, 'error');
  assert.equal((await f.gate.check('suspend', member, 1)).confirmed, true);
  await f.gate.act('resume', member, 2);
  assert.equal((await f.gate.check('resume', member, 2)).confirmed, true);
});

test('native root completion preserves stdout/stderr and exit 7 without waiting for lease expiry', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'child.cjs'), 'process.stdout.write("native-out");process.stderr.write("native-err");process.exitCode=7;');
  const lease = await f.lease(); await f.gate.release(f.gate.gateId, f.started, f.ack, f.projection, lease);
  let fact; const end = Date.now() + 10000;
  do { fact = await f.gate.poll(); if (fact.empty) break; await sleep(20); } while (Date.now() < end);
  assert.equal(fact.verdict, 'tree-exited'); assert.equal(fact.expired, false); assert.equal(fact.exitCode, 7);
  assert.equal(await fs.readFile(path.join(f.root, 'workload.stdout.log'), 'utf8'), 'native-out');
  assert.equal(await fs.readFile(path.join(f.root, 'workload.stderr.log'), 'utf8'), 'native-err');
});
