'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const { atomicWriteJsonSync: write } = require('../core/atomicWrite.cjs');
const { resolveProject } = require('../core/resolveProject.cjs');
const { mutate } = require('../cli/store.cjs');
const { readOutbox } = require('../core/syncOutbox.cjs');
const { createSyncAgent, buildSshArgs, backoffDelay } = require('../core/syncAgent.cjs');
const { createSyncClient } = require('../core/syncClient.cjs');
const { writeConfig, syncRoot, saveDeviceCredential } = require('../core/syncCredential.cjs');
const SERVER = path.resolve(__dirname, '../server/server.cjs');
const INDEX = path.resolve(__dirname, '../cli/index.cjs');
const AGENT = path.resolve(__dirname, '../cli/cloudSync.cjs');
const ORIGIN = 'http://127.0.0.1:47123';
const PASSWORD = 'Agent-only-test-password';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(25); }
  assert.fail(message);
}
function localFixture(t, enabled = true) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-agent-local-')));
  const registryPath = path.join(home, 'registry.json'), boardFile = path.join(home, 'board.json');
  write(boardFile, emptyBoard({ id: 'local', name: 'Local' }));
  write(registryPath, { projects: { local: { mainRepo: home, board: boardFile,
    ...(enabled ? { cloud: { enabled: true, remoteProjectId: 'remote' } } : {}) } } });
  const proj = resolveProject('local', { registryPath });
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { home, registryPath, boardFile, proj, state: () => read(path.join(proj.syncDir, 'state.json')),
    status: () => read(path.join(syncRoot(registryPath), 'status.json')) };
}
function command(f, args, file = INDEX) {
  return new Promise(resolve => {
    execFile(process.execPath, [file, ...args], { windowsHide: true, timeout: 30000, cwd: f.home,
      env: { ...process.env, DASHBOARD_HOME: f.home, DASHBOARD_REGISTRY: f.registryPath, CLAUDE_CODE_SESSION_ID: '' } },
    (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr }));
  });
}
async function cli(f, ...args) {
  const result = await command(f, [...args, '--project', 'local', '--registry', f.registryPath]);
  assert.equal(result.code, 0, result.stderr); return result;
}
const add = (f, id) => cli(f, 'add', id, '--title', 'Task ' + id, '--plain-title', '同步验收任务', '--model', 'test');
function startServer(home, port = 0) {
  const child = fork(SERVER, [], { windowsHide: true, silent: true, env: { ...process.env,
    DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json'), DASHBOARD_MODE: 'collaboration',
    DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: String(port),
    DASHBOARD_NO_OPEN: '1', DASHBOARD_POLL_MS: '100', DASHBOARD_EVENT_WEBHOOK: '' } });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  return new Promise((resolve, reject) => {
    const ready = actualPort => { clearTimeout(timer); resolve({ child, port: actualPort, base: `http://127.0.0.1:${actualPort}`, output: () => output }); };
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server readiness timeout: ' + output)); }, 15000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code + ' ' + output)); });
    child.on('message', msg => { if (msg.type === 'dashboard-ready') ready(msg.port); });
    // The production server emits IPC readiness only when DASHBOARD_PORT=0.
    // Fixed-port restart announces its listening address on stdout instead.
    child.stdout.on('data', () => { if (port && output.includes(`http://127.0.0.1:${port}/`)) ready(port); });
  });
}
async function stopServer(srv) {
  if (srv && srv.child.exitCode === null && srv.child.signalCode === null) await new Promise(resolve => { srv.child.once('exit', resolve); srv.child.kill(); });
}
async function memberRequest(srv, session, id, action, data = {}) {
  const response = await fetch(`${srv.base}/api/collaboration/projects/remote/tasks/${id}/${action}`, {
    method: 'POST', headers: { Cookie: 'dashboard_session=' + session.token, Origin: ORIGIN,
      'Content-Type': 'application/json', 'X-Dashboard-Request': '1', 'X-Dashboard-CSRF': session.csrfToken }, body: JSON.stringify(data),
  });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
}
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return value;
  const ignored = ['ts', 'updatedAt', 'lastProgressAt', 'createdAt', 'userId', 'via', 'clientTs', 'device', 'opId'];
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.includes(key)).map(([key, v]) => [key, comparable(v)]));
}

test('agent real collaboration service: offline, receipts, reconciliation, sessions and events', { timeout: 180000 }, async t => {
  const f = localFixture(t);
  const cloudHome = path.join(f.home, 'cloud'); fs.mkdirSync(cloudHome);
  const cloudRegistry = path.join(cloudHome, 'registry.json'), cloudBoard = path.join(cloudHome, 'board.json');
  write(cloudBoard, emptyBoard({ id: 'remote', name: 'Remote' }));
  write(cloudRegistry, { projects: { remote: { mainRepo: cloudHome, board: cloudBoard } } });
  const auth = createAuth({ home: cloudHome, registryPath: cloudRegistry });
  await auth.bootstrap('owner', PASSWORD);
  const owner = await auth.login('owner', PASSWORD, 'agent-owner');
  const invite = auth.createInvite(owner.token, { projectIds: ['remote'], maxUses: 1, expiresInHours: 1 });
  const member = await auth.register({ inviteToken: invite.token, username: 'member', password: PASSWORD });
  const device = auth.createDevice(owner.token, 'agent-test');
  let srv = await startServer(cloudHome);
  t.after(async () => { await stopServer(srv); });
  const config = { v: 1, mode: 'direct', origin: ORIGIN, baseUrl: srv.base };
  writeConfig(f.registryPath, config);
  const secrets = [PASSWORD, owner.token, member.token, device.token], batches = [];
  const client = createSyncClient({ config, credential: device.token, fetch: async (...args) => {
    const response = await fetch(...args);
    const cookie = response.headers.get('set-cookie')?.match(/dashboard_session=([^;]+)/)?.[1];
    if (cookie) secrets.push(cookie);
    if (String(args[0]).endsWith('/api/auth/session') && response.ok) {
      const data = await response.clone().json(); if (data.csrfToken) secrets.push(data.csrfToken);
    }
    return response;
  } });
  const instrumented = { ...client, sendOps: async (...args) => {
    const result = await client.sendOps(...args); batches.push({ seqs: args[2].map(r => r.seq), result }); return result;
  } };
  const agent = createSyncAgent({ registryPath: f.registryPath, client: instrumented });
  t.after(() => client.close());
  await t.test('① offline 50 true CLI writes survive and replay in ordered batches', async () => {
    const port = srv.port; await stopServer(srv);
    for (let i = 1; i <= 50; i++) await add(f, 'T' + i);
    const bytes = fs.readFileSync(path.join(f.proj.syncDir, 'outbox.jsonl'));
    await assert.rejects(agent.syncOnce());
    assert.deepEqual(fs.readFileSync(path.join(f.proj.syncDir, 'outbox.jsonl')), bytes);
    assert.equal(readOutbox(f.proj).length, 50); assert.ok(f.status().agent.lastError);
    srv = await startServer(cloudHome, port);
    await agent.syncOnce();
    assert.equal(f.state().ackedSeq, 50);
    assert.deepEqual(batches.flatMap(b => b.seqs), Array.from({ length: 50 }, (_, i) => i + 1));
    assert.ok(batches.every(b => b.seqs.length <= 20 && b.result.results.every(r => r.status === 'applied')));
    assert.deepEqual(comparable(read(f.boardFile).tasks), comparable(read(cloudBoard).tasks));
    assert.deepEqual(Array.from({ length: 9 }, (_, i) => backoffDelay(i)), [2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000]);
  });
  await t.test('② member claim rejects local claim and restores cloud task', async () => {
    await memberRequest(srv, member, 'T1', 'claim');
    await cli(f, 'claim', 'T1', '--branch', 'sync-local', '--builder', '派单器');
    const claimOp = readOutbox(f.proj).at(-1);
    assert.equal(claimOp.command, 'claim');
    await agent.syncOnce();
    const receipt = batches.flatMap(batch => batch.result.results).find(row => row.opId === claimOp.opId);
    assert.ok(receipt, 'Cloud must return a receipt for the local claim');
    assert.equal(receipt.status, 'rejected', 'Member-owned task must reject the local claim: ' + JSON.stringify(receipt));
    const rejected = read(path.join(f.proj.syncDir, 'rejected.json')).items;
    assert.equal(rejected.length, 1); assert.equal(rejected[0].seen, false);
    assert.equal(rejected[0].command, 'claim'); assert.deepEqual(rejected[0].taskIds, ['T1']);
    assert.deepEqual(read(f.boardFile).tasks.find(t => t.id === 'T1'), read(cloudBoard).tasks.find(t => t.id === 'T1'));
  });
  await t.test('③ pending local card survives while other cards update, confirmation reconciles', async () => {
    await cli(f, 'edit', 'T2', '--title', 'Local pending title');
    const localTask = read(f.boardFile).tasks.find(t => t.id === 'T2');
    await memberRequest(srv, member, 'T3', 'claim');
    await agent.pull('local');
    assert.deepEqual(read(f.boardFile).tasks.find(t => t.id === 'T2'), localTask);
    assert.deepEqual(read(f.boardFile).tasks.find(t => t.id === 'T3'), read(cloudBoard).tasks.find(t => t.id === 'T3'));
    await agent.sendPending('local'); await agent.pull('local');
    assert.deepEqual(read(f.boardFile).tasks, read(cloudBoard).tasks);
  });
  await t.test('④ pull never records another outbox operation or changes sequence bytes', async () => {
    await cli(f, 'note', 'T2', '--text', 'Local queued note');
    const files = ['outbox.jsonl', 'outbox.seq'].map(n => path.join(f.proj.syncDir, n));
    const before = files.map(p => fs.readFileSync(p));
    await memberRequest(srv, member, 'T3', 'progress', { percent: 17 });
    await agent.pull('local');
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
    await agent.sendPending('local');
  });
  await t.test('⑤ 304 preserves board bytes and modification time', async () => {
    await agent.pull('local');
    const bytes = fs.readFileSync(f.boardFile), mtime = fs.statSync(f.boardFile).mtimeMs;
    await delay(30); await agent.pull('local');
    assert.deepEqual(fs.readFileSync(f.boardFile), bytes); assert.equal(fs.statSync(f.boardFile).mtimeMs, mtime);
  });
  await t.test('⑥ receipt before local persistence replays a note exactly once', async () => {
    await cli(f, 'note', 'T2', '--text', 'Crash receipt note');
    const current = f.state(), rows = readOutbox(f.proj).filter(r => r.seq > current.ackedSeq);
    assert.equal(rows.length, 1);
    const stateBytes = fs.readFileSync(path.join(f.proj.syncDir, 'state.json'));
    assert.equal((await client.sendOps('remote', current.ackedSeq, rows)).results[0].status, 'applied');
    assert.deepEqual(fs.readFileSync(path.join(f.proj.syncDir, 'state.json')), stateBytes);
    await agent.sendPending('local');
    assert.equal(read(cloudBoard).activity.filter(a => a.opId === rows[0].opId).length, 1);
  });
  await t.test('⑧ untracked never sent and cloud overwrite leaves a warning', async () => {
    const before = batches.length;
    mutate(f.proj, board => { board.tasks.find(t => t.id === 'T2').title = 'Untracked local title'; });
    const row = readOutbox(f.proj).at(-1); assert.equal(row.kind, 'untracked');
    await agent.sendPending('local');
    assert.equal(batches.length, before);
    assert.ok(f.state().untracked.some(r => r.seq === row.seq && r.source === row.source));
    assert.ok(f.state().untracked.some(r => r.source === 'overwritten-by-cloud' && r.taskIds.includes('T2')));
    assert.deepEqual(read(f.boardFile).tasks, read(cloudBoard).tasks);
  });
  await t.test('⑩ deleted session renews once; revoked device requires login and retains queue', async () => {
    const d = auth.createDevice(owner.token, 'revocation-test');
    let sessionToken, logins = 0;
    const c = createSyncClient({ config, credential: d.token, fetch: async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]).endsWith('/device-login')) {
        logins++; sessionToken = response.headers.get('set-cookie')?.match(/dashboard_session=([^;]+)/)?.[1];
      }
      return response;
    } });
    await c.listProjects(); assert.equal(logins, 1);
    auth.logout(sessionToken); await c.listProjects(); assert.equal(logins, 2);
    auth.revokeDevice(owner.token, d.device.id);
    await cli(f, 'note', 'T2', '--text', 'Keep while logged out');
    const bytes = fs.readFileSync(path.join(f.proj.syncDir, 'outbox.jsonl'));
    const a = createSyncAgent({ registryPath: f.registryPath, client: c });
    await assert.rejects(a.syncOnce(), { code: 'LOGIN_REQUIRED' });
    assert.equal(f.status().agent.state, 'login-required');
    assert.deepEqual(fs.readFileSync(path.join(f.proj.syncDir, 'outbox.jsonl')), bytes);
    c.close(); await agent.syncOnce();
  });
  await t.test('⑬ real owner-device SSE pulls member changes without polling', async () => {
    let opened = false;
    const liveClient = { ...instrumented, subscribe: (callback, options) => client.subscribe(callback,
      { ...options, onOpen: () => { opened = true; options.onOpen(); } }) };
    const live = createSyncAgent({ registryPath: f.registryPath, client: liveClient,
      intervals: { watch: 20, sync: 60000, poll: 60000, status: 50 } });
    const run = live.run();
    try {
      await until(() => opened, 'Owner device SSE subscription did not open');
      await delay(300);
      await memberRequest(srv, member, 'T4', 'claim');
      await memberRequest(srv, member, 'T4', 'progress', { percent: 46 });
      await until(() => read(f.boardFile).tasks.find(t => t.id === 'T4').percent === 46, 'SSE did not pull member change');
    } finally { await live.stop(); await run; }
    assert.equal(f.status().agent.state, 'stopped');
  });
  await t.test('resident reloads newly saved credential, watches writes and consumes reconnect request', async () => {
    const protector = process.platform === 'win32' ? undefined : {
      protect: async s => Buffer.from(s).toString('base64'), unprotect: async s => Buffer.from(s, 'base64').toString(),
    };
    const live = createSyncAgent({ registryPath: f.registryPath, protector,
      intervals: { watch: 20, credential: 50, sync: 60000, poll: 60000, status: 50 } });
    const run = live.run();
    try {
      await until(() => f.status().agent.state === 'login-required', 'Missing credentials were not reported');
      await saveDeviceCredential({ registryPath: f.registryPath, origin: ORIGIN, token: device.token,
        deviceId: device.device.id, label: device.device.label, expiresAt: device.device.expiresAt, protector });
      await until(() => f.status().agent.state === 'connected', 'Saved credentials were not reloaded');
      await cli(f, 'note', 'T2', '--text', 'Resident outbox watch');
      const row = readOutbox(f.proj).at(-1);
      await until(() => f.state().ackedSeq >= row.seq, 'Outbox watcher did not send the new command');
      assert.equal(read(cloudBoard).activity.filter(a => a.opId === row.opId).length, 1);
      const request = path.join(syncRoot(f.registryPath), 'reconnect.request'); write(request, {});
      await until(() => !fs.existsSync(request) && f.status().agent.state === 'connected', 'Reconnect request was not consumed');
    } finally { await live.stop(); await run; }
  });
  await t.test('⑮ logs and state never contain token, session, CSRF or card text', async () => {
    const root = syncRoot(f.registryPath);
    const files = [path.join(root, 'status.json'), ...['state.json', 'rejected.json'].map(n => path.join(f.proj.syncDir, n)),
      ...fs.readdirSync(path.join(root, 'logs')).map(n => path.join(root, 'logs', n))];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const secret of [...secrets, 'Crash receipt note', 'Local pending title']) assert.equal(content.includes(secret), false, path.basename(file));
    }
  });
  await t.test('⑯ first upload and subsequent pull retain every task', async () => {
    const upload = read(f.boardFile);
    await client.upload('uploaded', upload, 'Uploaded');
    const reg = read(f.registryPath); reg.projects.local.cloud.remoteProjectId = 'uploaded'; write(f.registryPath, reg);
    const next = createSyncAgent({ registryPath: f.registryPath, client });
    await next.pull('local');
    assert.deepEqual(read(f.boardFile).tasks, upload.tasks);
    assert.equal(read(f.boardFile).project.id, 'local');
    assert.ok((await client.listProjects()).projects.some(p => p.id === 'uploaded'));
  });
});

test('⑦ retry and missing receipt stop contiguous acknowledgements', async t => {
  const f = localFixture(t); for (const id of ['A', 'B', 'C']) await add(f, id);
  const calls = []; let retry = true;
  const client = { sendOps: async (id, ack, ops) => { calls.push({ ack, seqs: ops.map(r => r.seq) });
    return { results: ops.map(r => ({ opId: r.opId, seq: r.seq, status: retry && r.seq === 2 ? 'retry' : 'applied' })) }; },
  snapshot: async () => ({ etag: 'stable', board: emptyBoard({ id: 'remote' }) }) };
  const agent = createSyncAgent({ registryPath: f.registryPath, client });
  await assert.rejects(agent.sendPending('local'), { code: 'RETRY' }); assert.equal(f.state().ackedSeq, 1);
  retry = false; await agent.sendPending('local');
  assert.deepEqual(calls, [{ ack: 0, seqs: [1, 2, 3] }, { ack: 1, seqs: [2, 3] }]); assert.equal(f.state().ackedSeq, 3);
  await add(f, 'D'); client.sendOps = async () => ({ results: [] });
  await assert.rejects(agent.sendPending('local'), { code: 'RETRY' }); assert.equal(f.state().ackedSeq, 3);
});
test('⑨ single instance rejects second true CLI run with exit 3', async t => {
  const f = localFixture(t); writeConfig(f.registryPath, { v: 1, mode: 'direct', origin: ORIGIN, baseUrl: ORIGIN });
  const agent = createSyncAgent({ registryPath: f.registryPath, intervals: { watch: 20, credential: 50 } });
  const run = agent.run();
  try {
    await until(() => f.status().agent.state === 'login-required', 'Missing credential must keep agent alive');
    const second = await command(f, ['run'], AGENT);
    assert.equal(second.code, 3); assert.match(second.stderr, /已经运行/);
    assert.ok(fs.existsSync(path.join(syncRoot(f.registryPath), 'agent.lock')));
  } finally { await agent.stop(); await run; }
  assert.equal(fs.existsSync(path.join(syncRoot(f.registryPath), 'agent.lock')), false);
});
test('⑪ fixed hidden SSH command, rejected host injection, tunnel teardown', async t => {
  const f = localFixture(t);
  const config = { v: 1, mode: 'ssh', origin: ORIGIN, sshHost: 'test-host', localPort: 14321, remotePort: 14322 };
  const expected = ['-N', '-L', '127.0.0.1:14321:127.0.0.1:14322', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', 'test-host'];
  assert.deepEqual(buildSshArgs(config), expected);
  for (const sshHost of ['-oProxyCommand=bad', 'bad host', 'bad\nhost', 'bad\u0000host']) assert.throws(() => writeConfig(f.registryPath, { ...config, sshHost }));
  writeConfig(f.registryPath, config);
  let spawned = 0, killed = 0;
  const client = { snapshot: async () => ({ etag: 'e', board: emptyBoard({ id: 'remote' }) }) };
  const agent = createSyncAgent({ registryPath: f.registryPath, client, intervals: { watch: 10 }, spawn: (exe, args, options) => {
    assert.equal(exe, 'ssh'); assert.deepEqual(args, expected); assert.equal(options.windowsHide, true);
    assert.equal(JSON.stringify(args).includes('token'), false); spawned++;
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.kill = () => { killed++; child.emit('exit', 0); }; return child;
  } });
  const run = agent.run();
  try { await until(() => spawned === 1, 'Tunnel was not launched'); }
  finally { await agent.stop(); await run; }
  assert.equal(killed, 1);
});
test('⑫ archive preserves sequence counter and next real CLI allocation', async t => {
  const f = localFixture(t); await add(f, 'A'); await add(f, 'B');
  const client = { sendOps: async (_, __, ops) => ({ results: ops.map(r => ({ seq: r.seq, opId: r.opId, status: 'applied' })) }),
    snapshot: async () => ({ etag: 'cloud', board: emptyBoard({ id: 'remote' }) }) };
  const agent = createSyncAgent({ registryPath: f.registryPath, client, now: () => Date.UTC(2026, 9, 20) });
  const counter = fs.readFileSync(path.join(f.proj.syncDir, 'outbox.seq'));
  await agent.syncOnce();
  assert.deepEqual(readOutbox(f.proj), []);
  assert.deepEqual(fs.readFileSync(path.join(f.proj.syncDir, 'outbox.seq')), counter);
  const archive = fs.readFileSync(path.join(f.proj.syncDir, 'outbox-archive-202610.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(archive.map(r => r.seq), [1, 2]);
  await add(f, 'C'); assert.equal(readOutbox(f.proj)[0].seq, 3);
});
test('⑭ disabled projects never create outbox, send requests or rewrite board', async t => {
  const f = localFixture(t, false); await add(f, 'A');
  const before = fs.readFileSync(f.boardFile), mtime = fs.statSync(f.boardFile).mtimeMs;
  const client = { sendOps: () => assert.fail('Disabled project sent'), snapshot: () => assert.fail('Disabled project pulled') };
  const agent = createSyncAgent({ registryPath: f.registryPath, client });
  await agent.syncOnce(); await agent.pull('local'); await agent.sendPending('local');
  assert.equal(fs.existsSync(f.proj.syncDir), false);
  assert.deepEqual(fs.readFileSync(f.boardFile), before); assert.equal(fs.statSync(f.boardFile).mtimeMs, mtime);
});
test('invalid snapshots keep board intact and a later healthy project cannot hide failure', async t => {
  const f = localFixture(t);
  const board2 = path.join(f.home, 'second.json'); write(board2, emptyBoard({ id: 'second' }));
  const reg = read(f.registryPath); reg.projects.second = { mainRepo: f.home, board: board2, cloud: { enabled: true, remoteProjectId: 'healthy' } };
  write(f.registryPath, reg);
  const bytes = fs.readFileSync(f.boardFile);
  const client = { snapshot: async id => ({ etag: id, board: id === 'healthy' ? emptyBoard({ id }) : { project: { id }, tasks: 'invalid' } }) };
  const agent = createSyncAgent({ registryPath: f.registryPath, client });
  await assert.rejects(agent.syncOnce(), { code: 'INVALID_BOARD' });
  assert.deepEqual(fs.readFileSync(f.boardFile), bytes);
  assert.match(f.state().lastError, /格式无效/);
  assert.equal(f.status().agent.state, 'reconnecting'); assert.ok(f.status().agent.lastError);
});
