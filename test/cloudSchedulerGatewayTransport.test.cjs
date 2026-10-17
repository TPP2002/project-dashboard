'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { PassThrough, Writable } = require('node:stream');
const { once } = require('node:events');
const p = require('../packages/scheduler/src/protocol/contract.cjs');
const f = require('../packages/scheduler/fixtures/protocol/messages.cjs');
const { FramedStream, EnvelopeLink, failure } = require('../packages/scheduler/src/transport/framed.cjs');

// Real child process with bounded framed stdio; all authority state below is synthetic and fixture-local.
if (process.argv[2] === '--fixture-cloud') {
  const file = process.argv[3], mode = process.argv[4];
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { opens: 0, operations: {}, sessions: [], applied: 0 };
  let sequence = 0;
  const wire = new FramedStream(process.stdin, process.stdout);
  wire.sendGreeting({ transport: 'scheduler-gateway-hello.v1', authorityId: process.argv[6] ?? f.scope.authorityId,
    authorityEpoch: Number(process.argv[5] ?? f.scope.authorityEpoch) });
  wire.on('closed', () => process.exit());
  wire.on('frame', request => {
    if (mode === 'no-ack') return;
    if (mode === 'require-original' && request.kind === 'submission') {
      const persisted = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'gateway-state.json')));
      const hash = p.contentHash(request.payload);
      const ticketId = require('../packages/scheduler/src/sched/client/sched.cjs').deriveTicketId(request.payload.project, request.payload.idempotencyKey);
      const original = persisted.originals?.[ticketId], source = persisted.sources[hash];
      if (!original || !source || p.canonicalJson(original.request) !== p.canonicalJson(request.payload) ||
          p.canonicalJson(original.source) !== p.canonicalJson(source) || source.observedOwnerSid !== original.peer.sid ||
          !original.localContext.cwd || !original.peer.creationFileTime) return wire.close(failure('SOURCE_ORIGINAL_MISSING'));
      state.originalBeforeSubmission = (state.originalBeforeSubmission ?? 0) + 1;
    }
    state.frames = [...(state.frames ?? []), { kind: request.kind, sequence: request.sequence, messageId: request.messageId }].slice(-32);
    if (request.kind === 'session.open') { state.opens++; state.sessions.push(request.nodeSession); }
    const operation = p.IMMUTABLE_KINDS.includes(request.kind) ? p.operationIdentity(request) : null;
    if (operation) {
      const previous = state.operations[operation.operationKey];
      if (previous && previous !== operation.operationHash) return wire.close(failure('OPERATION_CONFLICT'));
      if (!previous) { state.operations[operation.operationKey] = operation.operationHash; state.applied++; }
    }
    fs.writeFileSync(file, JSON.stringify(state));
    if (mode === 'drop-first' && operation && !state.dropped) { state.dropped = true; fs.writeFileSync(file, JSON.stringify(state)); return wire.close(); }
    const receipt = f.receipt({ validated: { envelope: request }, operation });
    const response = { protocolVersion: p.PROTOCOL_VERSION, authorityId: request.authorityId, authorityEpoch: request.authorityEpoch,
      nodeId: request.nodeId, nodeSession: request.nodeSession, sequence: ++sequence, messageId: `fixture-reply-${sequence}`,
      kind: 'result', payload: receipt };
    if (request.kind === 'lease.challenge') {
      response.kind = 'lease.renewal'; response.execution = request.execution;
      response.payload = { authorityId: request.authorityId, authorityEpoch: request.authorityEpoch, nodeId: request.nodeId,
        nodeSession: request.nodeSession, gatewayInstance: request.payload.gatewayInstance, nodeInstance: request.payload.nodeInstance,
        ...request.execution, ledgerSeq: request.payload.ledgerSeq, challenge: request.payload.challenge,
        challengeSequence: request.payload.challengeSequence, leaseId: `synthetic-lease-${sequence}`, leaseSequence: sequence,
        ttlMs: request.payload.requestedTtlMs };
    }
    response.contentHash = p.envelopeHash(response);
    wire.send(response).catch(() => {});
  });
  return;
}
if (process.argv[2] === '--fixture-echo') { process.stdin.pipe(process.stdout); return; }

const test = require('node:test');
const assert = require('node:assert/strict');
const { sshArgv } = require('../packages/scheduler/src/transport/ssh.cjs');
const { GatewayStore } = require('../packages/scheduler/src/gateway/store.cjs');
const { createRuntimeScope } = require('../packages/scheduler/src/gateway/runtime.cjs');
const { SerialSender } = require('../packages/scheduler/src/transport/sender.cjs');
function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-transport-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function subprocess(t, args) {
  const child = spawn(process.execPath, [__filename, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-4096); });
  const stream = new FramedStream(child.stdout, child.stdin, { timeoutMs: 2000, expectGreeting: args[0] === '--fixture-cloud' });
  child.on('error', error => stream.close(error)); child.on('exit', () => stream.close(failure('DISCONNECTED')));
  t.after(() => { stream.close(); child.kill(); });
  return { child, stream, errors: () => errors };
}
function linkFor(stream) {
  let lastSequence = 0, lastSeen = 0;
  const link = new EnvelopeLink(stream, { requestKinds: [], onRequest: async () => assert.fail('unexpected request'), authenticate(reply) {
    const checked = p.validateEnvelope(reply, { ...f.trust('state.snapshot'), activeSession: f.scope.nodeSession, lastSequence });
    if (!checked.transport.updatesLastSeen) return false;
    lastSequence = reply.sequence; lastSeen++; return true;
  } });
  return { link, lastSeen: () => lastSeen };
}

test('real subprocess accepts fragmented canonical frames in both directions; payload stays literal', { timeout: 8000 }, async t => {
  const { child, stream } = subprocess(t, ['--fixture-echo']);
  const value = f.envelope('submission', { payload: { ...f.payloads.submission, title: "literal ' ; $(never-execute) `also-literal`" } });
  const seen = once(stream, 'frame'), bytes = Buffer.from(p.encodeFrame(value));
  child.stdin.write(bytes.subarray(0, 11)); child.stdin.write(bytes.subarray(11));
  assert.deepEqual((await seen)[0], value);
  const next = once(stream, 'frame'); await stream.send(value); assert.deepEqual((await next)[0], value);
});

test('SSH argv is fixed admin configuration; shell-sensitive entry words are single quoted', () => {
  const config = { host: 'fixture.invalid', user: 'fixture', port: 22, knownHostsFile: path.resolve('fixture-known-hosts'),
    identityFile: path.resolve('fixture-key'), connectTimeoutMs: 2500, entryArgv: ['/usr/bin/node', '/opt/a b/entry.cjs', "/opt/it'is/config.json"] };
  const args = sshArgv(config);
  for (const item of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ControlMaster=no', 'IdentitiesOnly=yes']) assert.ok(args.includes(item));
  assert.equal(args.at(-1), "'/usr/bin/node' '/opt/a b/entry.cjs' '/opt/it'\\''is/config.json'");
  assert.throws(() => sshArgv({ ...config, host: '-oProxyCommand=bad' }));
  assert.throws(() => sshArgv({ ...config, entryArgv: ['/usr/bin/node', 'bad\nword'] }));
});

test('bounded parser and blocked writer reject pressure instead of growing queues', async () => {
  const input = new PassThrough(), output = new Writable({ write(_bytes, _encoding, _callback) {} });
  const wire = new FramedStream(input, output, { timeoutMs: 20 });
  const closed = once(wire, 'closed'); input.write(Buffer.alloc(p.MAX_FRAME_BYTES + 1, 65));
  assert.equal((await closed)[0].code, 'FRAME_TOO_LARGE');
  const slow = new FramedStream(new PassThrough(), new Writable({ write() {} }), { timeoutMs: 20 });
  await assert.rejects(slow.send(f.envelope('submission')), { code: 'TIMEOUT' });
  assert.equal(slow.closed, true);
});

test('immutable outbox keeps original operation and waiting tombstone across restart', t => {
  const root = directory(t), store = new GatewayStore(root), message = f.envelope('submission');
  const first = store.remember(message);
  const rebound = f.envelope('submission', { nodeSession: 'new-session', sequence: 3, messageId: 'new-message' });
  assert.deepEqual(store.remember(rebound).payload, first.payload);
  assert.throws(() => store.remember(f.envelope('submission', { payload: { ...message.payload, title: 'changed original operation' } })), { code: 'OPERATION_CONFLICT' });
  assert.throws(() => store.remember(f.envelope('execution.heartbeat')), /NOT_IMMUTABLE/);
  const peer = { sid: 'S-1-5-18', pid: 42, creationFileTime: '1', logonSessionId: '0000000000000001' };
  const up = store.waiting(f.execution.ticketId, f.machine, false, peer), del = store.waiting(f.execution.ticketId, f.machine, true, peer);
  const restarted = new GatewayStore(root);
  assert.equal(restarted.pending().length, 1);
  assert.equal(del.seq, up.seq + 1);
  assert.equal(restarted.waiting(f.execution.ticketId, f.machine, false, peer).seq, del.seq + 1);
  const pending = store.newSession(); assert.deepEqual(new GatewayStore(root).newSession(), pending);
  store.acknowledgeSession(); assert.equal(new GatewayStore(root).newSession().generation, pending.generation + 1);
});

test('lost immutable ACK across real child restart applies original operation exactly once', { timeout: 12000 }, async t => {
  const root = directory(t), file = path.join(root, 'fixture.json'), first = subprocess(t, ['--fixture-cloud', file, 'drop-first']);
  const a = linkFor(first.stream).link, original = f.envelope('report.started');
  await assert.rejects(a.exchange(original, { timeoutMs: 2000 }));
  assert.equal(JSON.parse(fs.readFileSync(file)).applied, 1);
  const second = subprocess(t, ['--fixture-cloud', file, 'normal']);
  const b = linkFor(second.stream).link;
  const reply = await b.exchange(f.envelope('report.started', { messageId: 'retry-original', sequence: 3 }), { timeoutMs: 2000 });
  assert.equal(reply.payload.status, 'business_accepted');
  assert.equal(JSON.parse(fs.readFileSync(file)).applied, 1);
});

test('unknown or mismatched replies close the channel; timeout cannot authorize a start', async () => {
  const incoming = new PassThrough(), outgoing = new PassThrough(), wire = new FramedStream(incoming, outgoing);
  const { link } = linkFor(wire), request = f.envelope('report.started');
  const pending = link.exchange(request, { timeoutMs: 1000 });
  const response = f.envelope('result', { sequence: 5 });
  incoming.write(p.encodeFrame(response));
  await assert.rejects(pending, { code: 'UNKNOWN_REPLY' });
  assert.equal(wire.closed, true);
});

test('duplicate and reordered live frames never refresh observation time', () => {
  const incoming = new PassThrough(), wire = new FramedStream(incoming, new PassThrough());
  const observed = linkFor(wire);
  // Authenticate is checked before request dispatch; a known reply is first delivered to a pending request.
  const request = f.envelope('submission');
  const pending = observed.link.exchange(request, { timeoutMs: 1000 }); pending.catch(() => {});
  const payload = f.receipt({ validated: { envelope: request }, operation: p.operationIdentity(request) });
  const reply = f.envelope('result', { payload, sequence: 5 });
  incoming.write(p.encodeFrame(reply));
  incoming.write(p.encodeFrame(reply)); incoming.write(p.encodeFrame(f.envelope('result', { payload, sequence: 4 })));
  assert.equal(observed.lastSeen(), 1); wire.close();
});

test('runtime subscriptions invalidate scope on disconnect and replacement', async () => {
  const state = createRuntimeScope(), iterator = state.port.changes(0, { timeoutMs: 100 });
  const first = iterator.next(); state.publish('connected', f.scope);
  assert.equal((await first).value.connection, 'connected');
  state.publish('disconnected', null); const disconnected = (await iterator.next()).value;
  assert.equal(disconnected.scope, null);
  state.publish('replacing', null); assert.ok((await iterator.next()).value.generation > disconnected.generation);
  await iterator.return();
});

test('submission originals survive restart, preserve worktree, reject identity conflicts and return copies', t => {
  const root = directory(t), store = new GatewayStore(root);
  const peer = { sid: 'S-1-5-18', pid: 42, creationFileTime: '133700000000000001', logonSessionId: '00000000000003e7' };
  const input = { kind: 'submit', callId: 'source-call', request: structuredClone(f.payloads.submission),
    localContext: { cwd: 'C:/path/to/worktrees/feature/sub/../' } };
  const source = store.captureOriginal(peer, input);
  const identity = { stage: 'submission', ticketId: require('../packages/scheduler/src/sched/client/sched.cjs').deriveTicketId(input.request.project, input.request.idempotencyKey),
    submissionHash: p.contentHash(input.request), project: input.request.project };
  const found = new GatewayStore(root).original(identity, source);
  assert.equal(found.status, 'found'); assert.deepEqual(found.request, input.request); assert.deepEqual(found.peer, peer);
  assert.equal(found.localContext.cwd, path.win32.normalize('C:/path/to/worktrees/feature'));
  assert.deepEqual(store.captureOriginal(peer, { ...input, localContext: found.localContext }), source);
  assert.deepEqual(store.source(peer, input.callId, identity.submissionHash), source, 'compatibility capture returns the bound proof');
  found.request.title = 'caller mutation'; found.peer.pid = 99; found.source.proofId = 'caller-proof';
  input.request.title = 'mutated input after commit';
  assert.equal(store.original(identity, source).request.title, f.payloads.submission.title);
  const unchanged = fs.readFileSync(store.file, 'utf8');
  const originalInput = { ...input, request: f.payloads.submission };
  for (const changed of [input, { ...originalInput, callId: 'different-call' },
    { ...originalInput, localContext: { cwd: 'C:/path/to/another-worktree' } }]) {
    assert.throws(() => store.captureOriginal(peer, changed), /SOURCE_IDENTITY_CONFLICT/);
  }
  for (const changedPeer of [{ ...peer, sid: 'S-1-5-19' }, { ...peer, pid: 43 }, { ...peer, creationFileTime: '133700000000000002' }]) {
    assert.throws(() => store.captureOriginal(changedPeer, originalInput), /SOURCE_IDENTITY_CONFLICT/);
  }
  assert.equal(fs.readFileSync(store.file, 'utf8'), unchanged);
  for (const changed of [{ ...identity, submissionHash: 'f'.repeat(64) }, { ...identity, project: 'wrong-project' },
    { ...identity, ticketId: 'tk-00000000000000000000' }]) assert.equal(store.original(changed, source).status, 'unknown');
  assert.equal(store.original(identity, { ...source, observedOwnerSid: 'S-1-5-19' }).status, 'unknown');
  store.mutate(state => { state.originals[identity.ticketId].request.title = 'tampered persisted original'; });
  assert.equal(new GatewayStore(root).original(identity, source).status, 'unknown');
});

test('source-only legacy records remain unknown; failed or over-capacity commits publish no originals', t => {
  const peer = { sid: 'S-1-5-18', pid: 42, creationFileTime: '133700000000000001', logonSessionId: '00000000000003e7' };
  const request = f.payloads.submission, hash = p.contentHash(request);
  const identity = { stage: 'submission', ticketId: require('../packages/scheduler/src/sched/client/sched.cjs').deriveTicketId(request.project, request.idempotencyKey),
    submissionHash: hash, project: request.project };
  const input = { kind: 'submit', callId: 'legacy-call', request, localContext: { cwd: path.resolve('synthetic-worktree') } };
  const legacy = new GatewayStore(directory(t));
  const proof = legacy.source(peer, input.callId, hash);
  assert.equal(new GatewayStore(path.dirname(legacy.file)).original(identity, proof).status, 'unknown');
  assert.throws(() => legacy.captureOriginal(peer, input), /SOURCE_ORIGINAL_UNKNOWN/);
  assert.equal(legacy.original(identity, proof).status, 'unknown');
  const limited = new GatewayStore(directory(t), { maxOperations: 1 });
  limited.captureOriginal(peer, input);
  assert.throws(() => limited.captureOriginal(peer, { ...input, callId: 'second', request: { ...request, idempotencyKey: 'another-key' } }), /SOURCE_CAPACITY/);
  assert.equal(Object.keys(limited.state.originals).length, 1); assert.equal(Object.keys(limited.state.sources).length, 1);
  const tiny = new GatewayStore(directory(t), { maxBytes: 128 });
  assert.throws(() => tiny.captureOriginal(peer, input), /STATE_CAPACITY/);
  assert.equal(tiny.original(identity, undefined).status, 'unknown'); assert.deepEqual(tiny.state.sources, {});
  const failed = new GatewayStore(directory(t));
  fs.mkdirSync(failed.file); // Real rename failure confined to this disposable fixture.
  assert.throws(() => failed.captureOriginal(peer, input));
  assert.equal(failed.original(identity, undefined).status, 'unknown'); assert.deepEqual(failed.state.sources, {});
  assert.deepEqual(fs.readdirSync(path.dirname(failed.file)), ['gateway-state.json']);
});

test('prepared native frame is sealed, peer-bound, ordered before concurrent CLI and consumed once', async () => {
  const sender = new SerialSender(), sent = [], peer = { sid: 'S-1-5-18', pid: 1, creationFileTime: '1', logonSessionId: '00000000000003e7' };
  const frame = f.envelope('lease.challenge'), options = { timeoutMs: 200 };
  const prepared = sender.prepare(peer, frame, async () => { sent.push(frame.sequence); return f.envelope('lease.renewal'); }, options);
  const later = sender.enqueue(f.envelope('submission', { sequence: 3 }), async () => { sent.push(3); return 'later'; }, options);
  await Promise.resolve(); assert.deepEqual(sent, []);
  await assert.rejects(sender.sendPrepared({ ...peer, creationFileTime: '2' }, prepared.preparationId, options), /PREPARATION_PEER/);
  prepared.envelope.payload.challenge = 'client-cannot-mutate-sealed-frame';
  const response = await sender.sendPrepared(peer, prepared.preparationId, options);
  assert.equal(response.envelope.payload.challenge, f.payloads['lease.challenge'].challenge);
  assert.equal(await later, 'later'); assert.deepEqual(sent, [2, 3]);
  await assert.rejects(sender.sendPrepared(peer, prepared.preparationId, options), /PREPARATION_EXPIRED/);
  sender.close();
});

test('expired and disconnected preparations release the send position without sending live data', async () => {
  const sender = new SerialSender(), peer = { sid: 'fixture' }; let liveSent = false;
  const prepared = sender.prepare(peer, f.envelope('lease.challenge'), async () => { liveSent = true; }, { timeoutMs: 20 });
  assert.equal(await sender.enqueue(f.envelope('submission', { sequence: 3 }), async () => 'continued', { timeoutMs: 200 }), 'continued');
  assert.equal(liveSent, false);
  await assert.rejects(sender.sendPrepared(peer, prepared.preparationId, { timeoutMs: 100 }));
  const next = sender.prepare(peer, f.envelope('lease.challenge', { sequence: 4 }), async () => { liveSent = true; }, { timeoutMs: 200 });
  sender.close(); await assert.rejects(sender.sendPrepared(peer, next.preparationId, { timeoutMs: 100 })); assert.equal(liveSent, false);
});

test('authenticated transport greeting is separate from business frames and cannot grant execution', async () => {
  const reader = new PassThrough(), wire = new FramedStream(reader, new PassThrough(), { expectGreeting: true });
  const waiting = wire.waitGreeting({ timeoutMs: 100 });
  reader.write(p.canonicalJson({ transport: 'scheduler-gateway-hello.v1', authorityId: f.scope.authorityId, authorityEpoch: 9 }) + '\n');
  assert.equal((await waiting).authorityEpoch, 9);
  assert.throws(() => p.isBusinessSuccess(wire.greeting), { name: 'ProtocolValidationError' }); wire.close();
  const badReader = new PassThrough(), bad = new FramedStream(badReader, new PassThrough(), { expectGreeting: true });
  const closed = once(bad, 'closed'); badReader.write(p.encodeFrame(f.envelope('result')));
  assert.equal((await closed)[0].code, 'TRANSPORT_GREETING');
});

test('greeting is at most 4 KiB, first-frame only in both directions, and has a deadline', async () => {
  const greeting = { transport: 'scheduler-gateway-hello.v1', authorityId: f.scope.authorityId, authorityEpoch: 9 };
  const input = new PassThrough(), wire = new FramedStream(input, new PassThrough(), { expectGreeting: true });
  const overflow = once(wire, 'closed'); input.write(Buffer.alloc(4097, 65));
  assert.equal((await overflow)[0].code, 'FRAME_TOO_LARGE');
  const input2 = new PassThrough(), wire2 = new FramedStream(input2, new PassThrough(), { expectGreeting: true });
  input2.write(p.canonicalJson(greeting) + '\n');
  await wire2.waitGreeting({ timeoutMs: 100 });
  const repeated = once(wire2, 'closed'); input2.write(p.canonicalJson(greeting) + '\n');
  await repeated; assert.equal(wire2.closed, true);
  const wire3 = new FramedStream(new PassThrough(), new PassThrough());
  await wire3.sendGreeting(greeting);
  assert.throws(() => wire3.sendGreeting(greeting), /TRANSPORT_GREETING_POSITION/); wire3.close();
  const wire4 = new FramedStream(new PassThrough(), new PassThrough(), { expectGreeting: true });
  await assert.rejects(wire4.waitGreeting({ timeoutMs: 20 }), /TIMEOUT/); assert.equal(wire4.closed, true);
});

// Gateway reconnect is exercised with real subprocess streams and the real Windows native peer
// probe. The authority remains synthetic and all ACL changes stay under this fixture root.
test('gateway automatically accepts epoch+1 only after business ACK; rejects rollback/id and old preparations',
  { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
    const { createWindowsGateway } = require('../packages/scheduler/src/gateway/windows.cjs');
    const root = directory(t), cacheRoot = path.join(root, 'cache');
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const whoami = path.join(process.env.SystemRoot, 'System32/whoami.exe');
    const sid = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-\d+(?:-\d+)+/)[0];
    const actual = await require('../packages/scheduler/src/transport/local-ipc.cjs').readParentIdentity({ powershell }, { timeoutMs: 15000 });
    assert.equal(actual.sid, sid);
    const logonSessionId = actual.logonSessionId;
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; $env:PSModulePath=[System.IO.Path]::Combine($PSHOME,"Modules"); $a=New-Object System.Security.AccessControl.DirectorySecurity; $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a.SetOwner($s); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,"FullControl","ContainerInherit,ObjectInherit","None","Allow"))); Set-Acl -LiteralPath $env:GATEWAY_FIXTURE_ROOT -AclObject $a'],
    { env: { ...process.env, GATEWAY_FIXTURE_ROOT: root }, windowsHide: true, timeout: 10000 });
    fs.mkdirSync(cacheRoot);
    let epoch = f.scope.authorityEpoch, authorityId = f.scope.authorityId, mode = 'normal';
    const wires = [], file = path.join(root, 'synthetic-authority.json');
    const ipc = { powershell, timeoutMs: 3000, startupTimeoutMs: 15000, serviceSid: sid, serviceLogonSessionId: logonSessionId,
      // Synthetic fixture policy includes the default owner of elevated-token files.
      protectedWriterSids: [sid, 'S-1-5-32-544'], protectedPaths: [root],
      cli: { name: `fixture-cli-${require('node:crypto').randomUUID()}`, peers: [{ sid, logonSessionId }] },
      execution: { name: `fixture-exec-${require('node:crypto').randomUUID()}`, peers: [{ sid, logonSessionId }] } };
    const config = { authorityId, authorityEpoch: epoch, nodeId: f.scope.nodeId, machine: f.machine,
      cloudPrincipal: f.trust('state.snapshot').principal, stateRoot: root, ipc, timeoutMs: 800, startupTimeoutMs: 15000,
      maxReconnectAttempts: 4, reconnectBaseMs: 50, reconnectMaxMs: 100, projectionTtlMs: 30000,
      cache: { root: cacheRoot, ttlMs: 30000, maxObjectBytes: 1048576, maxCacheBytes: 2097152 },
      readPrincipals: [{ sid, principal: f.trust().principal }],
      transportFactory() {
        const child = subprocess(t, ['--fixture-cloud', file, mode, String(epoch), authorityId]);
        wires.push(child.stream); return child.stream;
      } };
    const gateway = createWindowsGateway({ config }); t.after(() => gateway.close()); await gateway.start();
    const options = { timeoutMs: 3000 }, peer = gateway.localExecutionPeer();
    const initial = await gateway.runtime.current(options);
    const prepared = await gateway.execution.prepareObservation(peer,
      { kind: 'report.started', payload: f.payloads['report.started'], identity: f.execution }, options);
    const changes = gateway.runtime.changes(initial.generation, options);
    const disconnected = changes.next(); epoch++; wires[0].close();
    assert.equal((await disconnected).value.scope, null);
    let recovered;
    for await (const notice of changes) { if (notice.connection === 'connected') { recovered = notice; break; } }
    assert.equal(recovered.scope.authorityEpoch, epoch); assert.notEqual(recovered.scope.nodeSession, initial.scope.nodeSession);
    assert.equal(JSON.parse(fs.readFileSync(file)).opens, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'gateway-state.json'))).highestEpoch, epoch);
    await assert.rejects(gateway.execution.sendPrepared(peer, prepared.preparationId, options), /PREPARATION_EXPIRED/);
    await assert.rejects(gateway.port.exchange(prepared.envelope, options), /GATEWAY_ENVELOPE_REQUIRED|DISCONNECTED/);
    assert.equal(JSON.parse(fs.readFileSync(file)).applied, 0, 'old prepared fact never sent or replayed');
    const lease = await gateway.execution.prepareObservation(peer, { kind: 'lease.challenge', identity: f.execution,
      payload: { ...f.payloads['lease.challenge'], gatewayInstance: recovered.scope.gatewayInstance, nodeInstance: recovered.scope.nodeInstance } }, options);
    const following = gateway.semantic.accept(peer, { kind: 'submit', callId: 'after-challenge', request: f.payloads.submission,
      localContext: { cwd: root } }, options);
    await Promise.resolve();
    assert.equal(JSON.parse(fs.readFileSync(file)).frames.at(-1).kind, 'session.open', 'prepare reserves position without sending');
    const original = structuredClone(lease.envelope);
    const sent = await gateway.execution.sendPrepared(peer, lease.preparationId, options);
    assert.deepEqual(sent.envelope, original); p.validateResponse(original, sent.reply);
    assert.equal(sent.reply.kind, 'lease.renewal'); await following;
    const ordered = JSON.parse(fs.readFileSync(file)).frames.slice(-2);
    assert.deepEqual(ordered.map(frame => frame.kind), ['lease.challenge', 'submission']);
    assert.ok(ordered[0].sequence < ordered[1].sequence);
    await gateway.close();
    // New processes retain the accepted epoch floor. Neither a hello alone nor bad metadata opens a session.
    const opens = JSON.parse(fs.readFileSync(file)).opens;
    for (const bad of [{ epoch: epoch - 1, id: authorityId, mode: 'normal' },
      { epoch, id: 'wrong-authority', mode: 'normal' }, { epoch: epoch + 1, id: authorityId, mode: 'no-ack' }]) {
      epoch = bad.epoch; authorityId = bad.id; mode = bad.mode;
      const rejected = createWindowsGateway({ config: { ...config, maxReconnectAttempts: 1 } });
      t.after(() => rejected.close());
      await assert.rejects(rejected.start()); assert.equal(rejected.health().connected, false);
      assert.equal((await rejected.runtime.current(options)).scope, null);
      await rejected.close(); assert.equal(JSON.parse(fs.readFileSync(file)).opens, opens);
    }
  });

test('Unix forced stdio entry proxies the protected socket to one authority with independent principal', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const { createCloudHub } = require('../packages/scheduler/src/gateway/cloud-hub.cjs');
  const root = directory(t); fs.chmodSync(root, 0o700);
  const socketPath = path.join(root, 'hub.sock'), configPath = path.join(root, 'entry.json'), principal = f.trust().principal;
  const calls = []; let sequence = 0;
  const hub = createCloudHub({ config: { authorityId: f.scope.authorityId, authorityEpoch: f.scope.authorityEpoch,
    timeoutMs: 2000, entries: [{ socketPath, principal }] }, getAuthority: () => ({
    async accept(authenticated, request) {
      calls.push(authenticated);
      const operation = p.IMMUTABLE_KINDS.includes(request.kind) ? p.operationIdentity(request) : null;
      return f.envelope('result', { sequence: ++sequence, payload: f.receipt({ validated: { envelope: request }, operation }) });
    },
  }) });
  await hub.listen(socketPath); t.after(() => hub.close());
  fs.writeFileSync(configPath, JSON.stringify({ socketPath, timeoutMs: 2000 }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.resolve(__dirname, '../packages/scheduler/src/gateway/cloud-stdio.cjs'), configPath],
    { stdio: ['pipe', 'pipe', 'pipe'] }); child.stderr.on('data', () => {});
  const wire = new FramedStream(child.stdout, child.stdin, { expectGreeting: true });
  child.on('error', error => wire.close(error)); child.on('exit', () => wire.close());
  t.after(() => { wire.close(); child.kill(); });
  assert.equal((await wire.waitGreeting({ timeoutMs: 2000 })).authorityEpoch, f.scope.authorityEpoch);
  const { link } = linkFor(wire);
  const open = f.envelope('session.open', { sequence: 1 });
  assert.equal((await link.exchange(open, { timeoutMs: 2000 })).payload.status, 'business_accepted');
  await link.exchange(f.envelope('submission', { sequence: 2 }), { timeoutMs: 2000 });
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], principal);
});
