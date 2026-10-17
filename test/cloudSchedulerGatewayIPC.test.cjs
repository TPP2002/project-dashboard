'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const p = require('../packages/scheduler/src/protocol/contract.cjs');
const f = require('../packages/scheduler/fixtures/protocol/messages.cjs');
const { createNativeServer, createNativeClientSession, checkPeer, readParentIdentity } = require('../packages/scheduler/src/transport/local-ipc.cjs');
const { FramedStream, failure, jsonCodec } = require('../packages/scheduler/src/transport/framed.cjs');
const { createWindowsGateway } = require('../packages/scheduler/src/gateway/windows.cjs');
const { createSemanticClient } = require('../packages/scheduler/src/gateway/client.cjs');
const windows = process.platform === 'win32';
const finalizers = new WeakMap();
const cleanup = (t, fn) => finalizers.get(t).push(fn);

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-native-fixture-'));
  finalizers.set(t, []);
  t.after(async () => {
    const errors = [];
    for (const close of finalizers.get(t).reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `Fixture shutdown failed; retained ${root}`);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('gateway-native-fixture-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const system = process.env.SystemRoot;
  assert.ok(system, 'Windows system directory is required');
  const powershell = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const whoami = path.join(system, 'System32', 'whoami.exe');
  const sid = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-\d+(?:-\d+)+/)[0];
  const logon = execFileSync(whoami, ['/logonid'], { encoding: 'utf8', windowsHide: true }).match(/S-1-5-5-(\d+)-(\d+)/);
  assert.ok(logon, 'OS logon SID must be available');
  const whoamiLogonSessionId = Number(logon[1]).toString(16).padStart(8, '0') + Number(logon[2]).toString(16).padStart(8, '0');
  const actual = await readParentIdentity({ powershell }, { timeoutMs: 15000 });
  assert.equal(actual.sid, sid);
  const logonSessionId = actual.logonSessionId;
  // ACL mutation is restricted to this disposable synthetic fixture, never a deployment path.
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $env:PSModulePath=[System.IO.Path]::Combine($PSHOME,"Modules"); $a=New-Object System.Security.AccessControl.DirectorySecurity; $s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a.SetOwner($s); $a.SetAccessRuleProtection($true,$false); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,"FullControl","ContainerInherit,ObjectInherit","None","Allow"); $a.AddAccessRule($r); Set-Acl -LiteralPath $env:GATEWAY_FIXTURE_ROOT -AclObject $a'],
  { env: { ...process.env, GATEWAY_FIXTURE_ROOT: root }, windowsHide: true, timeout: 10000 });
  fs.mkdirSync(path.join(root, 'cache'));
  const otherSid = sid === 'S-1-5-18' ? 'S-1-5-19' : 'S-1-5-18';
  const config = { powershell, timeoutMs: 8000, startupTimeoutMs: 15000, serviceSid: sid, serviceLogonSessionId: logonSessionId,
    // Elevated Windows tokens create children owned by Administrators even
    // under our user-only inherited DACL. This fixture explicitly trusts that
    // existing administrative principal; production policy is never changed.
    protectedWriterSids: [sid, 'S-1-5-32-544'], protectedPaths: [root],
    cli: { name: `gateway-cli-${randomUUID()}`, peers: [{ sid, logonSessionId }] },
    execution: { name: `gateway-execution-${randomUUID()}`, peers: [{ sid: otherSid, logonSessionId: '00000000000003e7' }] } };
  return { root, sid, logonSessionId, whoamiLogonSessionId, config };
}

test('read-only native parent identity and synthetic ACL evidence', { skip: !windows, timeout: 45000 }, async t => {
  const { root, config, whoamiLogonSessionId } = await setup(t);
  const actual = await readParentIdentity(config, { timeoutMs: 15000 });
  assert.equal(actual.pid, process.pid);
  assert.equal(actual.sid, config.serviceSid);
  assert.deepEqual(await readParentIdentity(config, { timeoutMs: 15000 }), actual);
  fs.writeFileSync(path.join(root, 'synthetic-state.json'), '{}');
  const acl = JSON.parse(execFileSync(config.powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $env:PSModulePath=[System.IO.Path]::Combine($PSHOME,"Modules"); $items=@($env:GATEWAY_FIXTURE_ROOT,(Join-Path $env:GATEWAY_FIXTURE_ROOT "cache"),(Join-Path $env:GATEWAY_FIXTURE_ROOT "synthetic-state.json")); @($items | ForEach-Object { $a=Get-Acl -LiteralPath $_; @{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value; inherited=$_.IsInherited; rights=[int]$_.FileSystemRights; type=[string]$_.AccessControlType} })} }) | ConvertTo-Json -Depth 5 -Compress'],
    { env: { ...process.env, GATEWAY_FIXTURE_ROOT: root }, encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  t.diagnostic(JSON.stringify({ nativeAuthenticationId: actual.logonSessionId, whoamiDerived: whoamiLogonSessionId, acl }));
});

test('peer policy rejects wrong SID, birth and logon without trusting JSON claims', () => {
  const peer = { sid: 'S-1-5-18', pid: 42, creationFileTime: '133700000000000001', logonSessionId: '00000000000003e7' };
  const policy = [{ ...peer }]; assert.deepEqual(checkPeer(peer, policy), peer);
  for (const changed of [{ sid: 'S-1-5-19' }, { creationFileTime: '133700000000000002' }, { logonSessionId: '00000000000003e8' }]) {
    assert.throws(() => checkPeer({ ...peer, ...changed }, policy), /PEER_DENIED/);
  }
  assert.throws(() => p.validateLocalSemanticRequest({ kind: 'submit', callId: 'fixture', request: f.payloads.submission,
    localContext: { cwd: path.resolve('synthetic-worktree') }, sid: peer.sid, trusted: true }));
  assert.throws(() => p.validateLocalSemanticRequest({ kind: 'report.started', callId: 'fixture', payload: f.payloads['report.started'] }));
});

test('native protected storage rejects an owner outside the explicit fixture policy', { skip: !windows, timeout: 45000 }, async t => {
  const { config } = await setup(t);
  config.protectedWriterSids = [config.serviceSid === 'S-1-5-19' ? 'S-1-5-20' : 'S-1-5-19'];
  await assert.rejects(createNativeServer(config, async () => assert.fail('storage check must precede any request')), /UNTRUSTED_OWNER/);
});

test('real native pipe probe supplies OS PID/birth/SID/logon; persistent client retains identity', { skip: !windows, timeout: 45000 }, async t => {
  const { config, sid, logonSessionId } = await setup(t), seen = [];
  const server = await createNativeServer(config, async (endpoint, peer, rpc) => { seen.push(peer); return { endpoint, call: rpc.request.callId, peer }; });
  cleanup(t, () => { if (server.diagnostics()) t.diagnostic(server.diagnostics()); });
  const client = createNativeClientSession(config); cleanup(t, async () => { client.close(); await server.close(); });
  const a = await client.call('cli', { method: 'call', request: { callId: 'one' } }, { timeoutMs: 15000 });
  const b = await client.call('cli', { method: 'call', request: { callId: 'two' } }, { timeoutMs: 15000 });
  assert.equal(a.peer.sid, sid); assert.equal(a.peer.logonSessionId, logonSessionId);
  assert.ok(a.peer.pid > 0); assert.match(a.peer.creationFileTime, /^[1-9]\d+$/);
  assert.deepEqual(a.peer, b.peer); assert.equal(seen.length, 2);
  assert.notEqual(a.peer.pid, process.pid, 'the persistent client transport process is the actual OS pipe peer');
});

test('same-account execution endpoint binds exact composition process; other OS peers and forged births fail',
  { skip: !windows, timeout: 45000 }, async t => {
    const { config } = await setup(t); config.execution.peers = structuredClone(config.cli.peers);
    const accepted = [];
    const server = await createNativeServer(config, async (endpoint, peer) => { accepted.push({ endpoint, peer }); return peer; });
    const ordinary = createNativeClientSession(config);
    cleanup(t, async () => { ordinary.close(); await server.close(); });
    const local = server.localExecutionPeer(); assert.equal(local.pid, process.pid);
    assert.deepEqual(await server.verifyExecution(local), local);
    const other = await ordinary.call('cli', { method: 'call' }, { timeoutMs: 15000 });
    assert.equal(other.sid, local.sid); assert.notEqual(other.pid, local.pid);
    await assert.rejects(ordinary.call('execution', { method: 'prepare', request: { trusted: true, ...local } }, { timeoutMs: 15000 }), /PEER_DENIED/);
    await assert.rejects(server.verifyExecution({ ...local, creationFileTime: String(BigInt(local.creationFileTime) + 1n) }), /PEER_DENIED/);
    await assert.rejects(server.verifyExecution(other), /PEER_DENIED/);
    const socket = net.createConnection(`\\\\.\\pipe\\${config.execution.name}`);
    const wire = new FramedStream(socket, socket, { codec: jsonCodec, timeoutMs: 5000 });
    cleanup(t, () => wire.close());
    const response = new Promise((resolve, reject) => { wire.once('frame', resolve); wire.once('closed', reject); });
    await wire.send({ id: 'synthetic-trusted-call', method: 'prepare' });
    assert.deepEqual((await response).value, local, 'actual pipe client is the exact bound composition process');
    assert.equal(accepted.filter(value => value.endpoint === 'execution').length, 1);
    await server.close(); await assert.rejects(server.verifyExecution(local), /DISCONNECTED/);
  });

test('real native IPC rejects wrong expected birth and cannot use ordinary endpoint for trusted facts', { skip: !windows, timeout: 45000 }, async t => {
  const { config } = await setup(t);
  let admitted = 0;
  const server = await createNativeServer(config, async () => { admitted++; return {}; });
  const client = createNativeClientSession(config); cleanup(t, async () => { client.close(); await server.close(); });
  config.cli.peers[0].pid = process.pid; config.cli.peers[0].creationFileTime = '1';
  await assert.rejects(client.call('cli', { method: 'call', request: {} }, { timeoutMs: 15000 }), /PEER_DENIED/);
  assert.equal(admitted, 0);
  await assert.rejects(client.call('execution', { method: 'observe', request: { kind: 'report.started' } }, { timeoutMs: 15000 }));
  assert.equal(admitted, 0);
});

test('public semantic client validates execution replies, correlation, offsets and combined request byte budget',
  { skip: !windows, timeout: 45000 }, async t => {
    const { config } = await setup(t);
    const chunk = (offset, text) => {
      const bytes = Buffer.from(text, 'utf8');
      return { offset, nextOffset: offset + bytes.length, bytesBase64: bytes.toString('base64') };
    };
    const terminal = { ok: false, exitCode: 7, reason: 'synthetic exit seven' };
    const valid = { kind: 'execution', runId: 'synthetic-run', state: 'terminal',
      stdout: chunk(24, '中文'), stderr: chunk(71, 'é'), terminal };
    let response = structuredClone(valid), calls = 0;
    const server = await createNativeServer(config, async (endpoint, peer, rpc) => {
      assert.equal(endpoint, 'cli'); assert.equal(rpc.method, 'call');
      assert.equal(peer.sid, config.cli.peers[0].sid); calls++;
      return response;
    });
    const client = createSemanticClient(config);
    cleanup(t, async () => { client.close(); await server.close(); });
    const options = { timeoutMs: 15000 };
    const run = { kind: 'local-run', callId: 'client-run', submission: f.envelope('origin.request').execution,
      command: 'synthetic-command', args: [], cwd: 'C:/path/to/worktree', env: {} };
    const read = { kind: 'local-run-read', callId: 'client-read', runId: valid.runId,
      stdoutOffset: 24, stderrOffset: 71, maxBytes: 8, waitMs: 0 };
    const cancel = { kind: 'local-run-cancel', callId: 'client-cancel', runId: valid.runId };
    for (const request of [run, read, cancel]) {
      const result = await client.call(request, options);
      assert.deepEqual(result, valid); assert.equal(result.terminal.exitCode, 7);
      assert.equal(Buffer.from(result.stdout.bytesBase64, 'base64').toString('utf8'), '中文');
      assert.equal(Buffer.from(result.stderr.bytesBase64, 'base64').toString('utf8'), 'é');
    }
    // These are valid shared shapes that must still fail request-specific correlation.
    for (const [request, reply, error] of [
      [read, { ...valid, runId: 'different-run' }, /LOCAL_REPLY_ID/],
      [cancel, { ...valid, runId: 'different-run' }, /LOCAL_REPLY_ID/],
      [read, { ...valid, stdout: chunk(25, '中文') }, /LOCAL_REPLY_OFFSET/],
      [read, { ...valid, stderr: chunk(72, 'é') }, /LOCAL_REPLY_OFFSET/],
      [read, { ...valid, stderr: chunk(71, 'éx') }, /LOCAL_REPLY_LIMIT/],
      [{ kind: 'submit', callId: 'wrong-kind', request: f.payloads.submission, localContext: { cwd: 'C:/path/to/worktree' } }, valid, /LOCAL_REPLY_KIND/],
      [run, { kind: 'pending', callId: run.callId, retryAfterMs: 1 }, /LOCAL_REPLY_KIND/],
    ]) {
      response = reply; await assert.rejects(client.call(request, options), error);
    }
    for (const [reply, error] of [
      [{ ...valid, terminal: { ok: false } }, /LOCAL_TERMINAL/],
      [{ ...valid, terminal: { ok: true, exitCode: null } }, /LOCAL_TERMINAL/],
      [{ ...valid, stdout: { offset: 24, nextOffset: 25, bytesBase64: '!' } }, /LOCAL_OUTPUT_RANGE/],
      [{ ...valid, trusted: true }, /UNKNOWN_FIELD/],
    ]) {
      response = reply; await assert.rejects(client.call(run, options), error);
    }
    response = { ...valid, terminal: { ok: false, exitCode: null,
      notStarted: { attemptId: 'a1', state: 'granted', waitedMs: 1 } } };
    assert.deepEqual((await client.call(run, options)).terminal, response.terminal, 'unknown exit stays null, never success');
    const before = calls;
    await assert.rejects(client.call({ kind: 'report.started', callId: 'not-an-intent', payload: f.payloads['report.started'], identity: f.execution }, options));
    await assert.rejects(client.call({ ...run, peer: config.cli.peers[0], trusted: true }, options));
    assert.equal(calls, before, 'execution replies do not add native observation or peer-injection methods');
  });

test('two actual CLI clients share exactly one gateway uplink and cannot mint execution facts', { skip: !windows, timeout: 60000 }, async t => {
  const { root, config: ipc, sid } = await setup(t), fixtureState = path.join(root, 'authority-fixture.json');
  let children = 0; const localCalls = [];
  const cwd = path.join(root, 'actual-worktree'); fs.mkdirSync(cwd);
  const gateway = createWindowsGateway({ config: {
    authorityId: f.scope.authorityId, authorityEpoch: f.scope.authorityEpoch, nodeId: f.scope.nodeId, machine: f.machine,
    cloudPrincipal: f.trust('state.snapshot').principal, stateRoot: root, ipc, timeoutMs: 5000, startupTimeoutMs: 15000,
    maxReconnectAttempts: 2, reconnectBaseMs: 50, reconnectMaxMs: 100, projectionTtlMs: 30000,
    cache: { root: path.join(root, 'cache'), ttlMs: 30000, maxObjectBytes: 1048576, maxCacheBytes: 2097152 },
    readPrincipals: [{ sid, principal: f.trust().principal }],
    transportFactory() {
      children++;
      const child = spawn(process.execPath, [path.join(__dirname, 'cloudSchedulerGatewayTransport.test.cjs'), '--fixture-cloud', fixtureState, 'require-original'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', () => {});
      const wire = new FramedStream(child.stdout, child.stdin, { expectGreeting: true });
      child.on('error', error => wire.close(error)); child.on('exit', () => wire.close(failure('DISCONNECTED')));
      wire.on('closed', () => child.kill()); return wire;
    },
  }, onCloudRequest: async () => assert.fail('no synthetic cloud action was requested'),
  async onLocalExecution(peer, request, options) {
    assert.deepEqual(Object.keys(peer).sort(), ['creationFileTime', 'logonSessionId', 'pid', 'sid']);
    assert.equal(peer.sid, sid); assert.notEqual(peer.pid, process.pid);
    assert.equal(typeof peer.creationFileTime, 'string');
    localCalls.push({ peer, request });
    if (request.kind === 'local-run') {
      const original = await gateway.submissionSources.get(request.submission, undefined, options);
      assert.equal(original.status, 'found'); assert.equal(original.peer.sid, peer.sid);
      assert.equal(original.localContext.cwd, cwd);
    }
    const output = { offset: 0, nextOffset: 0, bytesBase64: '' };
    return { kind: 'execution', runId: 'synthetic-run', state: 'terminal', stdout: output, stderr: output,
      terminal: request.callId === 'invalid-result' ? { ok: false } : { ok: false, exitCode: 7, reason: 'synthetic exit seven' } };
  } });
  cleanup(t, () => gateway.close()); await gateway.start();
  const a = createSemanticClient(ipc), b = createSemanticClient(ipc), raw = createNativeClientSession(ipc);
  cleanup(t, () => { a.close(); b.close(); raw.close(); });
  const results = await Promise.all([a, b].map((client, index) => client.call({ kind: 'submit', callId: `call-${index}`,
    localContext: { cwd: `${cwd}${path.sep}.` },
    request: { ...f.payloads.submission, idempotencyKey: `fixture-${index}` } }, { timeoutMs: 15000 })));
  assert.ok(results.every(result => result.kind === 'business' && result.result.status === 'business_accepted'));
  assert.equal(children, 1);
  const state = JSON.parse(fs.readFileSync(fixtureState)); assert.equal(state.opens, 1); assert.equal(state.applied, 2);
  assert.equal(state.originalBeforeSubmission, 2, 'authority received each submission only after original and proof were atomically saved');
  const request = { ...f.payloads.submission, idempotencyKey: 'fixture-0' };
  const identity = { stage: 'submission', ticketId: require('../packages/scheduler/src/sched/client/sched.cjs').deriveTicketId(request.project, request.idempotencyKey),
    submissionHash: p.contentHash(request), project: request.project };
  const original = await gateway.submissionSources.get(identity, undefined, { timeoutMs: 1000 });
  assert.equal(original.status, 'found'); assert.deepEqual(original.request, request);
  assert.equal(original.localContext.cwd, cwd); assert.equal(original.peer.sid, sid);
  assert.equal(original.source.observedOwnerSid, original.peer.sid); assert.equal(original.source.submissionHash, identity.submissionHash);
  const again = await gateway.submissionSources.get(identity, original.source, { timeoutMs: 1000 });
  assert.deepEqual(again, original);
  original.request.title = 'caller mutation'; original.localContext.cwd = root;
  assert.deepEqual(await gateway.submissionSources.get(identity, again.source, { timeoutMs: 1000 }), again);
  assert.equal((await gateway.submissionSources.get({ ...identity, project: 'wrong-project' }, undefined, { timeoutMs: 1000 })).status, 'unknown');
  assert.equal((await gateway.submissionSources.get(identity, { ...again.source, proofId: 'wrong-proof' }, { timeoutMs: 1000 })).status, 'unknown');
  const run = { kind: 'local-run', callId: 'local-intent', submission: identity, command: 'synthetic-command', args: ['literal;not-a-shell'], cwd, env: {} };
  for (const local of [run, { kind: 'local-run-read', callId: 'read-intent', runId: 'synthetic-run', stdoutOffset: 0, stderrOffset: 0, maxBytes: 1024, waitMs: 0 },
    { kind: 'local-run-cancel', callId: 'cancel-intent', runId: 'synthetic-run' }]) {
    const reply = await a.call(local, { timeoutMs: 15000 });
    assert.equal(reply.terminal.exitCode, 7); assert.equal(reply.terminal.ok, false);
  }
  assert.deepEqual(localCalls.map(value => value.request.kind), ['local-run', 'local-run-read', 'local-run-cancel']);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixtureState)), state, 'local execution intents never become SSH messages');
  await assert.rejects(raw.call('cli', { method: 'call', request: { ...run, sid, pid: process.pid, trusted: true } }, { timeoutMs: 15000 }));
  await assert.rejects(raw.call('cli', { method: 'call', request: { kind: 'submit', callId: 'spoof', request,
    localContext: { cwd }, peer: again.peer } }, { timeoutMs: 15000 }));
  assert.equal(localCalls.length, 3);
  await assert.rejects(a.call({ ...run, callId: 'invalid-result' }, { timeoutMs: 15000 }), /LOCAL_TERMINAL/);
  await assert.rejects(raw.call('cli', { method: 'sources.get', request: identity }, { timeoutMs: 15000 }), /LOCAL_METHOD_DENIED/);
  await assert.rejects(raw.call('cli', { method: 'prepare', request: { kind: 'report.started', payload: f.payloads['report.started'], identity: f.execution } }, { timeoutMs: 15000 }), /LOCAL_METHOD_DENIED/);
  await assert.rejects(raw.call('cli', { method: 'observe', request: { kind: 'report.started', payload: f.payloads['report.started'], identity: f.execution } }, { timeoutMs: 15000 }), /LOCAL_METHOD_DENIED/);
  assert.equal(children, 1); assert.equal(gateway.health().connected, true);
  const notice = await a.runtime.current({ timeoutMs: 10000 }); assert.equal(notice.connection, 'connected');
  await gateway.close(); assert.equal(gateway.health().connected, false);
});

test('native RPC timeout closes a stalled client and oversized local bytes cannot reach handler', { skip: !windows, timeout: 45000 }, async t => {
  const { config } = await setup(t); config.timeoutMs = 300;
  let calls = 0;
  const server = await createNativeServer(config, async () => { calls++; return new Promise(() => {}); });
  const client = createNativeClientSession({ ...config, timeoutMs: 300 });
  cleanup(t, async () => { client.close(); await server.close(); });
  await assert.rejects(client.call('cli', { method: 'call', request: {} }, { timeoutMs: 10000 }));
  const before = calls;
  const socket = net.createConnection(`\\\\.\\pipe\\${config.cli.name}`);
  cleanup(t, () => socket.destroy());
  socket.on('error', () => {});
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  // Consume EOF so a readable pipe cannot keep the test process alive after
  // the server has correctly rejected and closed an oversized request.
  socket.resume();
  const closed = new Promise(resolve => socket.once('close', resolve)); socket.write(Buffer.alloc(p.MAX_FRAME_BYTES + 1, 65));
  await closed; assert.equal(calls, before);
});

test('trusted native client prepares actual started frame before sending; ordinary pipe cannot send its handle', { skip: !windows, timeout: 60000 }, async t => {
  const context = await setup(t), { root, config: ipc, sid } = context;
  [ipc.cli.peers, ipc.execution.peers] = [ipc.execution.peers, ipc.cli.peers];
  const stateFile = path.join(root, 'fixture-state.json');
  const gateway = createWindowsGateway({ config: {
    authorityId: f.scope.authorityId, authorityEpoch: f.scope.authorityEpoch, nodeId: f.scope.nodeId, machine: f.machine,
    cloudPrincipal: f.trust('state.snapshot').principal, stateRoot: root, ipc, timeoutMs: 5000, startupTimeoutMs: 15000,
    maxReconnectAttempts: 2, reconnectBaseMs: 50, reconnectMaxMs: 100, projectionTtlMs: 30000,
    cache: { root: path.join(root, 'cache'), ttlMs: 30000, maxObjectBytes: 1048576, maxCacheBytes: 2097152 },
    readPrincipals: [{ sid, principal: f.trust().principal }],
    transportFactory() {
      const child = spawn(process.execPath, [path.join(__dirname, 'cloudSchedulerGatewayTransport.test.cjs'), '--fixture-cloud', stateFile, 'normal'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', () => {});
      const wire = new FramedStream(child.stdout, child.stdin, { expectGreeting: true });
      child.on('error', error => wire.close(error)); child.on('exit', () => wire.close(failure('DISCONNECTED')));
      wire.on('closed', () => child.kill()); return wire;
    },
  }, onCloudRequest: async () => assert.fail('unexpected cloud request') });
  cleanup(t, () => gateway.close()); await gateway.start();
  const client = createSemanticClient(ipc); cleanup(t, () => client.close());
  const prepared = await client.execution.prepareObservation({ kind: 'report.started', payload: f.payloads['report.started'], identity: f.execution }, { timeoutMs: 15000 });
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).applied, 0, 'prepare must not send');
  const exact = structuredClone(prepared.envelope);
  const sent = await client.execution.sendPrepared(prepared.preparationId, { timeoutMs: 15000 });
  assert.deepEqual(sent.envelope, exact); p.validateResponse(exact, sent.reply);
  assert.equal(sent.reply.payload.status, 'business_accepted'); assert.equal(JSON.parse(fs.readFileSync(stateFile)).applied, 1);
  await assert.rejects(client.execution.sendPrepared(prepared.preparationId, { timeoutMs: 1000 }), /UNKNOWN_PREPARATION/);
});
