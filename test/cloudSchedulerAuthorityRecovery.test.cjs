'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { fixture, p, principal, call } = require('./cloudSchedulerAuthority.test.cjs');

// This branch is invoked only by this scheduled test. It exits at a real fsync
// boundary in the actual service, leaving owner guard and WAL untouched.
async function crashWorker() {
  const root = process.env.CLOUD_AUTHORITY_CRASH_ROOT, boundary = process.env.CLOUD_AUTHORITY_CRASH_BOUNDARY;
  const f = await fixture({ root, fault(point, value) {
    if (boundary === 'domain' && point === 'domain-committed' && value.type === 'submitted') process.exit(71);
    if (boundary === 'receipt' && point === 'receipt-committed' && value.status === 'business_accepted' && value.outcome.kind === 'submission') process.exit(72);
    if (boundary === 'wal' && point === 'index-written' && value.table === 'operations' && value.value.result?.status === 'business_accepted') process.exit(73);
  } });
  await f.open(); await f.observe();
  const envelope = f.frame('submission', f.request('crash-once'));
  fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify(envelope));
  await f.service.authority.accept(principal, envelope, call);
  await f.service.tick(); await f.service.tick();
  throw new Error('fault boundary was not reached');
}

if (process.env.CLOUD_AUTHORITY_CRASH_ROOT && require.main === module) {
  crashWorker().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  for (const boundary of ['domain', 'receipt', 'wal']) test(`real subprocess crash after ${boundary} commit: original operation applies once`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-authority-crash-')); let recovered;
    try {
      const child = spawnSync(process.execPath, [__filename], { timeout: 60000, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, CLOUD_AUTHORITY_CRASH_ROOT: root, CLOUD_AUTHORITY_CRASH_BOUNDARY: boundary } });
      assert.equal(child.status, { domain: 71, receipt: 72, wal: 73 }[boundary], `${child.stdout}\n${child.stderr}`);
      const original = JSON.parse(fs.readFileSync(path.join(root, 'request.json'), 'utf8'));
      recovered = await fixture({ root, time: Date.parse('2026-01-01T00:16:00.000Z'), generation: 2 });
      assert.equal(recovered.service.health().authorityEpoch, 2);
      await recovered.open(); await recovered.observe(); await recovered.service.tick();
      const replay = recovered.frame('submission', original.payload);
      let ack = await recovered.service.authority.accept(principal, replay, call);
      if (ack.payload.status === 'durably_received') { await recovered.service.tick(); ack = await recovered.service.authority.accept(principal, replay, call); }
      assert.equal(ack.payload.status, 'business_accepted');
      const id = ack.payload.outcome.ticketId, ticket = recovered.ticket(id);
      assert.equal(ticket.timeline.filter(event => event.type === 'submitted').length, 1);
      assert.equal(ticket.timeline.filter(event => event.type === 'granted').length, 1);
      const receipt = JSON.stringify(ack.payload.businessCursor);
      const again = await recovered.service.authority.accept(principal, replay, call);
      assert.equal(JSON.stringify(again.payload.businessCursor), receipt);
      await assert.rejects(recovered.service.authority.accept(principal, original, call), /AUTHORITY_EPOCH/);
    } finally { await recovered?.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  test('lost ACK, same-ID different content and current-session replacement use persisted indexes', async () => {
    const f = await fixture();
    try {
      await f.open(); await f.observe(); const job = await f.submit('once');
      const conflicting = { ...job.envelope, payload: { ...job.envelope.payload, title: 'different' } };
      conflicting.contentHash = p.envelopeHash(conflicting);
      await assert.rejects(f.service.authority.accept(principal, conflicting, call), /MESSAGE_ID_CONFLICT|OPERATION_CONFLICT/);
      const previous = f.replace(); await f.open(principal, previous);
      await assert.rejects(f.service.authority.accept(principal, job.envelope, call), /SESSION_MISMATCH/);
      const replay = f.frame('submission', job.envelope.payload);
      const ack = await f.service.authority.accept(principal, replay, call);
      assert.equal(ack.payload.status, 'business_accepted');
      assert.deepEqual(ack.payload.businessCursor, job.accepted.payload.businessCursor);
      assert.equal(f.ticket(job.id).timeline.filter(event => event.type === 'submitted').length, 1);
    } finally { await f.dispose(); }
  });
  test('waiting delete tombstone survives session replacement and does not revive an older seq', async () => {
    const f = await fixture();
    try {
      await f.open(); await f.observe(); const job = await f.submit('waiting');
      await f.send('waiting.delete', { schema: 1, ticketId: job.id, machine: 'fixture-win', seq: 10 });
      await f.open(principal, f.replace());
      const ack = await f.send('waiting.upsert', { schema: 1, ticketId: job.id, machine: 'fixture-win', pid: 890, seq: 9 });
      assert.equal(ack.payload.status, 'business_rejected');
      assert.match(ack.payload.reason, /WAITING_TOMBSTONE_OR_SEQUENCE/);
      assert.equal(f.ticket(job.id).state, 'granted');
    } finally { await f.dispose(); }
  });
  test('fsync failure never ACKs and permanently fences this writer', async () => {
    const f = await fixture(); const original = fs.fsyncSync;
    try {
      await f.open(); await f.observe();
      const envelope = f.frame('submission', f.request('io-fault'));
      fs.fsyncSync = () => { throw Object.assign(new Error('fixture fsync EIO'), { code: 'EIO' }); };
      await assert.rejects(f.service.authority.accept(principal, envelope, call), /fsync EIO/);
      assert.equal(f.service.health().stopped, true);
    } finally { fs.fsyncSync = original; await f.dispose(); }
  });
  test('restart does not restore stale execution facts or grant an offline lease', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-authority-restart-')); let first, second;
    try {
      first = await fixture({ root }); await first.open(); await first.observe();
      const job = await first.submit('running-restart'), started = await first.start(job.id);
      await first.service.close();
      second = await fixture({ root, generation: 2 }); await second.open(); await second.service.tick();
      assert.equal(second.ticket(job.id).state, 'running');
      const denied = await second.send('lease.challenge', { challenge: 'offline', challengeSequence: 1,
        ledgerSeq: second.service.health().cursor.seq, requestedTtlMs: 30000, gatewayInstance: 'gateway-new', nodeInstance: 'node-new' }, started.identity);
      assert.equal(denied.payload.status, 'business_rejected');
      assert.equal(second.ticket(job.id).attempts[0].permit.token, started.identity.permitToken);
    } finally { await second?.dispose(); await first?.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  test('CAS drift refuses the ACK and fences the writer', async () => {
    let armed = false, root;
    const f = await fixture({ fault(point, value) {
      if (armed && point === 'journal-synced') {
        armed = false;
        fs.writeFileSync(path.join(root, 'cloud-authority', 'revision.json'), JSON.stringify({ revision: value.after + 1 }));
      }
    } }); root = f.root;
    try {
      await f.open(); await f.observe(); armed = true;
      await assert.rejects(f.send('submission', f.request('cas-drift')), /revision conflict|CAS/);
      assert.equal(f.service.health().stopped, true);
    } finally { await f.dispose(); }
  });
}
