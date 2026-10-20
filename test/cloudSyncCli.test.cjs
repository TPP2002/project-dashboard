'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork, execFile, execFileSync } = require('node:child_process');
const { emptyBoard } = require('../core/boardSchema.cjs');
const { atomicWriteJsonSync: write } = require('../core/atomicWrite.cjs');
const { resolveProject } = require('../core/resolveProject.cjs');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { createSyncClient } = require('../core/syncClient.cjs');
const { createSyncAgent } = require('../core/syncAgent.cjs');
const { syncRoot, loadDeviceCredential } = require('../core/syncCredential.cjs');
const INDEX = path.resolve(__dirname, '../cli/index.cjs');
const SERVER = path.resolve(__dirname, '../server/server.cjs');
const ORIGIN = 'http://127.0.0.1:47123';
const PASSWORD = 'Cli-stdin-only-test-password-中文';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const text = file => fs.readFileSync(file, 'utf8');
const protector = { protect: async s => Buffer.from(s).toString('base64'),
  unprotect: async s => Buffer.from(s, 'base64').toString() };

function fixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-cli-')));
  const registryPath = path.join(home, 'registry.json');
  write(registryPath, { projects: {} });
  // Only non-Windows test runners inject a protector. Windows goes through
  // real hidden PowerShell/DPAPI, including true CLI stdin enrollment.
  const preload = path.join(home, 'protector.cjs');
  fs.writeFileSync(preload, `
    const c = require(${JSON.stringify(path.resolve(__dirname, '../core/syncCredential.cjs'))});
    const p = {protect:async s=>Buffer.from(s).toString('base64'), unprotect:async s=>Buffer.from(s,'base64').toString()};
    const enroll=c.enrollDevice, load=c.loadDeviceCredential;
    c.enrollDevice=o=>enroll({...o,protector:p}); c.loadDeviceCredential=r=>load(r,p);
  `);
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const f = { home, registryPath, preload, outputs: [], root: syncRoot(registryPath) };
  f.proj = id => resolveProject(id, { registryPath });
  f.addProject = id => {
    const board = path.join(home, id + '.json');
    write(board, emptyBoard({ id, name: id }));
    const registry = read(registryPath);
    registry.projects[id] = { mainRepo: home, board, name: id };
    write(registryPath, registry);
    return f.proj(id);
  };
  return f;
}
function command(f, args, { input = '', preload, runner = INDEX } = {}) {
  const preloads = [...(process.platform === 'win32' ? [] : [f.preload]), ...(preload ? [preload] : [])];
  const childArgs = [...preloads.flatMap(p => ['--require', p]), runner, ...args, '--registry', f.registryPath];
  return new Promise(resolve => {
    const child = execFile(process.execPath, childArgs, { windowsHide: true, timeout: 30000, cwd: f.home,
      env: { ...process.env, DASHBOARD_HOME: f.home, DASHBOARD_REGISTRY: f.registryPath,
        CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '' } },
    (error, stdout, stderr) => {
      const result = { code: error?.code || 0, stdout, stderr };
      f.outputs.push(result); resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function good(f, args, options) {
  const result = await command(f, args, options);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return result;
}
const cloud = (f, ...args) => good(f, ['cloud', ...args]);
const add = (f, project, id) => good(f, ['add', id, '--project', project, '--title', 'Task ' + id,
  '--plain-title', '测试云端同步任务', '--model', 'test']);
function allFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item =>
    item.isDirectory() ? allFiles(path.join(dir, item.name)) : [path.join(dir, item.name)]);
}
async function server(home) {
  const child = fork(SERVER, [], { windowsHide: true, silent: true, env: { ...process.env,
    DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json'), DASHBOARD_MODE: 'collaboration',
    DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0',
    DASHBOARD_NO_OPEN: '1', DASHBOARD_POLL_MS: '100', DASHBOARD_EVENT_WEBHOOK: '' } });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server readiness timeout: ' + output)); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + output)); });
    child.on('message', msg => { if (msg.type === 'dashboard-ready') { clearTimeout(timer); resolve(`http://127.0.0.1:${msg.port}`); } });
  });
  return { child, base, output: () => output };
}
async function stop(srv) {
  if (srv.child.exitCode === null && srv.child.signalCode === null) {
    await new Promise(resolve => { srv.child.once('exit', resolve); srv.child.kill(); });
  }
}

test('① config writes validated settings and refuses host, port and URL injection', async t => {
  const f = fixture(t);
  assert.match((await cloud(f, 'config')).stdout, /尚未配置云端连接/);
  await cloud(f, 'config', '--ssh-host', 'test-host', '--remote-port', '17301', '--local-port', '17302', '--origin', ORIGIN);
  const file = path.join(f.root, 'config.json'), before = text(file);
  assert.deepEqual(read(file), { v: 1, mode: 'ssh', origin: ORIGIN, remotePort: 17301, localPort: 17302, sshHost: 'test-host' });
  const base = ['cloud', 'config', '--ssh-host', 'test-host', '--remote-port', '17301', '--local-port', '17302', '--origin', ORIGIN];
  for (const [key, value, message] of [['--ssh-host', '-oProxyCommand=bad', /SSH 主机名无效/],
    ['--remote-port', '0', /隧道端口/], ['--origin', ORIGIN + '?secret=no', /连接地址不得/]]) {
    const args = [...base]; args[args.indexOf(key) + 1] = value;
    const r = await command(f, args); assert.equal(r.code, 1); assert.match(r.stderr, message); assert.equal(text(file), before);
  }
  assert.equal((await command(f, ['cloud', 'config', '--direct', '--base-url', ORIGIN + '?x=1', '--origin', ORIGIN])).code, 1);
  await cloud(f, 'config', '--direct', '--base-url', ORIGIN, '--origin', ORIGIN, '--json');
  assert.equal(JSON.parse((await cloud(f, 'config', '--json')).stdout).config.mode, 'direct');
});

test('real collaboration CLI login, attachment, notices and detachment', { timeout: 180000 }, async t => {
  const f = fixture(t), local = f.addProject('local'), other = f.addProject('other');
  await add(f, 'local', 'T1'); await add(f, 'local', 'T2'); await add(f, 'other', 'OLD');
  const cloudHome = path.join(f.home, 'server'); fs.mkdirSync(cloudHome);
  const cloudRegistry = path.join(cloudHome, 'registry.json');
  write(cloudRegistry, { projects: {} });
  const auth = createAuth({ home: cloudHome, registryPath: cloudRegistry });
  await auth.bootstrap('owner', PASSWORD);
  const owner = await auth.login('owner', PASSWORD, 'cli-test');
  const srv = await server(cloudHome);
  t.after(() => stop(srv));
  await cloud(f, 'config', '--direct', '--base-url', srv.base, '--origin', ORIGIN);
  let credential, client;
  await t.test('② login stdin only, no secret in output/files, rejects argv before HTTP', async () => {
    const r = await good(f, ['cloud', 'login', '--username', 'owner'], { input: PASSWORD + '\nignored-second-line\n' });
    assert.match(r.stdout, new RegExp('本机同步·' + os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(r.stdout, /到期日/);
    assert.ok(fs.existsSync(path.join(f.root, 'device.cred')));
    assert.ok(fs.existsSync(path.join(f.root, 'reconnect.request')));
    credential = await loadDeviceCredential(f.registryPath, process.platform === 'win32' ? undefined : protector);
    client = createSyncClient({ config: { v: 1, mode: 'direct', origin: ORIGIN, baseUrl: srv.base }, credential });
    t.after(() => client.close());
    const fetchCount = path.join(f.home, 'login-fetch-count.json');
    const fetchMonitor = path.join(f.home, 'login-fetch-monitor.cjs');
    fs.writeFileSync(fetchMonitor, `
      const fs=require('node:fs'), original=globalThis.fetch; let calls=0;
      globalThis.fetch=(...args)=>{ calls++; return original(...args); };
      process.on('exit',()=>fs.writeFileSync(${JSON.stringify(fetchCount)},JSON.stringify(calls)));
    `);
    // A counting loopback listener proves forbidden argv never reaches fetch.
    // Local dashboard startup scans 127.0.0.1:<base..base+range> for /api/health
    // (server/server.cjs findExistingInstance). Concurrent FAST fixtures use
    // ephemeral base ports. Separate the destination by address, not by filtering
    // requests: EVERY request received by the configured endpoint still counts.
    const counterHost = '127.0.0.2';
    let requests = 0, phase = 'config';
    const requestDetails = [];
    const counter = http.createServer((req, res) => {
      requests++;
      const routes = ['/', '/favicon.ico', '/api/health', '/api/auth/login', '/api/auth/device-login', '/api/auth/session', '/api/auth/logout'];
      requestDetails.push({ phase, method: req.method, route: routes.includes(req.url) ? req.url : 'other',
        nodeFetch: req.headers['user-agent'] === 'node', cookiePresent: !!req.headers.cookie });
      res.writeHead(401); res.end('{}');
    });
    let probes = 0;
    const probeTarget = http.createServer((_req, res) => { probes++; res.end('{}'); });
    await new Promise(resolve => probeTarget.listen(0, '127.0.0.1', resolve));
    t.after(() => { counter.close(); probeTarget.close(); });
    await new Promise((resolve, reject) => {
      counter.once('error', reject);
      counter.listen(probeTarget.address().port, counterHost, resolve);
    });
    const configFile = path.join(f.root, 'config.json'), configBytes = fs.readFileSync(configFile);
    try {
      await cloud(f, 'config', '--direct', '--base-url', `http://${counterHost}:${counter.address().port}`, '--origin', ORIGIN);
      // A real health request to the exact same port on the scanner's address
      // must reach the probe control, never the configured cloud destination.
      const probe = await fetch(`http://127.0.0.1:${counter.address().port}/api/health`);
      await probe.text();
      assert.ok(probes >= 1); assert.equal(requests, 0);
      for (const extra of [['--password', 'argv-secret'], ['--password=argv-secret'], ['--pwd', 'argv-secret'],
        ['argv-secret'], ['--label', 'password=argv-secret']]) {
        phase = extra[0];
        const bad = await command(f, ['cloud', 'login', '--username', 'owner', ...extra], { preload: fetchMonitor });
        assert.equal(bad.code, 1); assert.match(bad.stderr, /密码只从标准输入读/);
        assert.equal((bad.stdout + bad.stderr).includes('argv-secret'), false);
        assert.equal(read(fetchCount), 0, 'Rejected argv must not invoke fetch, regardless of destination');
      }
      assert.equal(requests, 0, JSON.stringify(requestDetails));
    } finally {
      fs.writeFileSync(configFile, configBytes);
      await new Promise(resolve => counter.close(resolve));
      await new Promise(resolve => probeTarget.close(resolve));
    }
    const wrong = await command(f, ['cloud', 'login', '--username', 'owner'],
      { input: 'wrong-password\n', preload: fetchMonitor });
    assert.equal(wrong.code, 1); assert.match(wrong.stderr, /账号或密码不对/);
    assert.ok(read(fetchCount) > 0, 'The observer must see real stdin login requests');
    const empty = await command(f, ['cloud', 'login', '--username', 'owner'], { input: '\n' });
    assert.equal(empty.code, 1); assert.match(empty.stderr, /密码/);
    for (const file of allFiles(f.root)) for (const secret of [PASSWORD, credential.token]) assert.equal(text(file).includes(secret), false, file);
    for (const output of f.outputs) for (const secret of [PASSWORD, credential.token, 'wrong-password']) {
      assert.equal((output.stdout + output.stderr).includes(secret), false);
    }
  });
  await t.test('④ upload creates remote project/base and only the next board write enters outbox', async () => {
    // A previous attachment's archived sequence must not be resent on reattach.
    fs.mkdirSync(local.syncDir, { recursive: true });
    fs.writeFileSync(path.join(local.syncDir, 'outbox.seq'), '7\n');
    fs.writeFileSync(path.join(local.syncDir, 'outbox.jsonl'), '');
    const before = fs.readFileSync(local.board);
    await cloud(f, 'attach', 'local', '--remote', 'remote', '--upload');
    assert.deepEqual(fs.readFileSync(local.board), before);
    assert.equal(read(f.registryPath).projects.local.cloud.enabled, true);
    assert.ok((await client.listProjects()).projects.some(p => p.id === 'remote'));
    const snapshot = await client.snapshot('remote'); snapshot.board.project.id = 'local';
    assert.deepEqual(read(path.join(local.syncDir, 'base.json')), snapshot.board);
    const state = read(path.join(local.syncDir, 'state.json'));
    assert.equal(state.ackedSeq, 7); assert.equal(state.etag, snapshot.etag);
    assert.equal(text(path.join(local.syncDir, 'outbox.jsonl')), '');
    await good(f, ['note', 'T2', '--text', 'first queued write', '--project', 'local']);
    const rows = text(path.join(local.syncDir, 'outbox.jsonl')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'op'); assert.equal(rows[0].command, 'note');
    assert.ok(rows[0].seq > state.ackedSeq);
    const repeated = await command(f, ['cloud', 'attach', 'local', '--remote', 'another', '--upload']);
    assert.equal(repeated.code, 1); assert.match(repeated.stderr, /已经开启/);
  });
  await t.test('⑤ duplicate remote upload returns adopt guidance without changing either project', async () => {
    const files = [f.registryPath, local.board, other.board, ...allFiles(local.syncDir)];
    const before = files.map(file => fs.readFileSync(file));
    const r = await command(f, ['cloud', 'attach', 'other', '--remote', 'remote', '--upload']);
    assert.equal(r.code, 1); assert.match(r.stderr, /云上已有这个项目,改用 --adopt/);
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i], file));
    assert.equal(fs.existsSync(other.syncDir), false);
    for (const extra of [[], ['--upload', '--adopt']]) {
      assert.equal((await command(f, ['cloud', 'attach', 'other', '--remote', 'remote', ...extra])).code, 1);
    }
  });
  await t.test('⑥ adopt backs up exact original bytes, writes cloud board and no outbox', async () => {
    const original = fs.readFileSync(other.board);
    const result = JSON.parse((await cloud(f, 'attach', 'other', '--remote', 'remote', '--adopt', '--json')).stdout);
    assert.deepEqual(fs.readFileSync(result.backup), original);
    const snapshot = await client.snapshot('remote'); snapshot.board.project.id = 'other';
    assert.deepEqual(read(other.board), snapshot.board);
    assert.deepEqual(read(path.join(other.syncDir, 'base.json')), snapshot.board);
    assert.equal(read(path.join(other.syncDir, 'state.json')).etag, snapshot.etag);
    assert.equal(fs.existsSync(path.join(other.syncDir, 'outbox.jsonl')), false);
  });
  await t.test('⑨ real member claim rejection reaches stderr/show/brief then ack removes notice', async () => {
    // Keep just one active local project for the agent test.
    await cloud(f, 'detach', 'other');
    const invite = auth.createInvite(owner.token, { projectIds: ['remote'], maxUses: 1, expiresInHours: 1 });
    const member = await auth.register({ inviteToken: invite.token, username: 'member', displayName: '小王', password: PASSWORD });
    const response = await fetch(srv.base + '/api/collaboration/projects/remote/tasks/T1/claim', {
      method: 'POST', headers: { Cookie: 'dashboard_session=' + member.token, Origin: ORIGIN,
        'Content-Type': 'application/json', 'X-Dashboard-Request': '1', 'X-Dashboard-CSRF': member.csrfToken }, body: '{}',
    });
    assert.equal(response.status, 200, await response.text());
    await good(f, ['claim', 'T1', '--branch', 'cli-test', '--builder', '派单器', '--project', 'local']);
    const agent = createSyncAgent({ registryPath: f.registryPath, client });
    await agent.syncOnce();
    const rejected = read(path.join(local.syncDir, 'rejected.json')).items;
    assert.equal(rejected.length, 1); assert.match(rejected[0].reason, /小王.*加入协作/);
    assert.equal(rejected[0].error, '任务归属或状态冲突（HTTP 409）');
    const r = await good(f, ['note', 'T2', '--text', 'after rejection', '--project', 'local']);
    const normal = await good(f, ['note', 'T2', '--text', 'after rejection', '--project', 'other']);
    assert.equal(r.stdout, normal.stdout); assert.equal(normal.stderr, '');
    assert.match(r.stderr, /云端退回了你 1 条改动.*小王.*加入协作/);
    for (const cmd of ['show', 'brief']) {
      assert.match((await good(f, [cmd, 'T1', '--project', 'local'])).stdout, /^⚠ 云端退回了你 1 条改动.*小王.*加入协作/);
      const json = JSON.parse((await good(f, [cmd, 'T1', '--project', 'local', '--json'])).stdout);
      assert.deepEqual(json.cloudRejected, rejected);
      assert.equal(json.text.startsWith('⚠'), false);
      assert.equal((await good(f, [cmd, 'T2', '--project', 'local'])).stdout.includes('云端退回'), false);
    }
    const failed = await command(f, ['note', 'MISSING', '--text', 'fail', '--project', 'local']);
    assert.equal(failed.code, 1); assert.match(failed.stderr, /云端退回了你 1 条改动/);
    const gate = await command(f, ['add', 'NO-MODEL', '--title', 'gate', '--project', 'local']);
    assert.equal(gate.code, 1); assert.match(gate.stderr, /建卡必须带[\s\S]*云端退回/);
    const outbox = text(path.join(local.syncDir, 'outbox.jsonl'));
    await cloud(f, 'ack', '--project', 'local', '--all');
    assert.equal(text(path.join(local.syncDir, 'outbox.jsonl')), outbox);
    assert.equal((await good(f, ['note', 'T2', '--text', 'after ack', '--project', 'local'])).stderr, '');
    assert.equal((await good(f, ['show', 'T1', '--project', 'local'])).stdout.includes('云端退回'), false);
    for (const file of allFiles(path.join(f.root, 'logs'))) assert.equal(text(file).includes('小王'), false);
  });
  await t.test('⑪ detach refuses pending ops, drop preserves exact lines, board and metadata', async () => {
    const board = fs.readFileSync(local.board), registry = text(f.registryPath);
    const raw = text(path.join(local.syncDir, 'outbox.jsonl'));
    const beforeAck = read(path.join(local.syncDir, 'state.json')).ackedSeq;
    const expected = raw.match(/[^\n]*\n|[^\n]+$/g).filter(line => {
      const row = JSON.parse(line); return row.kind === 'op' && row.seq > beforeAck;
    }).join('');
    assert.ok(expected);
    const r = await command(f, ['cloud', 'detach', 'local']);
    assert.equal(r.code, 1); assert.match(r.stderr, /还有 \d+ 条没送上云.*--drop-pending/);
    assert.equal(text(f.registryPath), registry); assert.equal(text(path.join(local.syncDir, 'outbox.jsonl')), raw);
    const result = JSON.parse((await cloud(f, 'detach', 'local', '--drop-pending', '--json')).stdout);
    assert.equal(text(result.dropped), expected);
    assert.equal(text(path.join(local.syncDir, 'outbox.jsonl')), raw);
    assert.deepEqual(fs.readFileSync(local.board), board);
    const before = JSON.parse(registry).projects.local.cloud, after = read(f.registryPath).projects.local.cloud;
    assert.deepEqual(after, { ...before, enabled: false });
    assert.equal(read(path.join(local.syncDir, 'state.json')).ackedSeq,
      Math.max(...raw.trim().split('\n').map(line => JSON.parse(line).seq)));
  });
  await t.test('③ logout deletes credential, keeps queues and requests reconnect; attach needs login', async () => {
    const queue = text(path.join(local.syncDir, 'outbox.jsonl'));
    fs.unlinkSync(path.join(f.root, 'reconnect.request'));
    assert.match((await cloud(f, 'logout')).stdout, /已退出云端登录,队列保留/);
    assert.equal(fs.existsSync(path.join(f.root, 'device.cred')), false);
    assert.ok(fs.existsSync(path.join(f.root, 'reconnect.request')));
    assert.equal(text(path.join(local.syncDir, 'outbox.jsonl')), queue);
    const r = await command(f, ['cloud', 'attach', 'local', '--remote', 'remote', '--adopt']);
    assert.equal(r.code, 1); assert.match(r.stderr, /cloud login/);
    fs.unlinkSync(path.join(f.root, 'reconnect.request'));
    await cloud(f, 'reconnect', '--json');
    assert.ok(fs.existsSync(path.join(f.root, 'reconnect.request')));
    for (const file of allFiles(f.root)) assert.equal(text(file).includes(PASSWORD), false, file);
    for (const r of f.outputs) assert.equal((r.stdout + r.stderr).includes(PASSWORD), false);
    assert.equal(srv.output().includes(PASSWORD), false);
  });
});

test('⑦ status only consumes public reports, handles missing/stale/missing-project state', async t => {
  const f = fixture(t), proj = f.addProject('local'); f.addProject('unreported'); f.addProject('disabled');
  const reg = read(f.registryPath);
  for (const id of ['local', 'unreported']) reg.projects[id].cloud = { enabled: true, remoteProjectId: 'remote-' + id };
  write(f.registryPath, reg);
  assert.match((await cloud(f, 'status')).stdout, /^同步程序没在运行/);
  fs.mkdirSync(proj.syncDir, { recursive: true });
  const items = [
    { seq: 3, command: 'claim', taskIds: ['T1'], reason: '已被成员 小王 认领,请加入协作', error: '固定错误', at: '2026-10-20T01:00:00Z', seen: false },
    { seq: 4, command: 'note', taskIds: ['T2'], error: '固定错误', at: '2026-10-20T02:00:00Z', seen: true },
  ];
  write(path.join(proj.syncDir, 'rejected.json'), { v: 1, items });
  // These private files are intentionally invalid: status must not infer queues.
  for (const file of ['state.json', 'base.json', 'outbox.jsonl', 'outbox.seq']) fs.writeFileSync(path.join(proj.syncDir, file), 'invalid');
  const statusFile = path.join(f.root, 'status.json');
  const report = { v: 1, updatedAt: new Date().toISOString(), agent: { state: 'connected', nextRetryAt: null },
    projects: { local: { pending: 12, rejectedUnseen: 99, untracked: 2, lastPullAt: '2026-10-20T03:00:00Z' } } };
  write(statusFile, report);
  const r = await cloud(f, 'status');
  assert.match(r.stdout, /^已连接/); assert.match(r.stdout, /待发 12 条.*未读退回 1 条.*未同步提醒 2 条/);
  assert.match(r.stdout, /3、claim、T1、已被成员 小王/); assert.match(r.stdout, /同步程序还没报到/);
  assert.equal(r.stdout.includes('4、note'), false); assert.equal(r.stdout.includes('disabled'), false);
  const result = JSON.parse((await cloud(f, 'status', '--project', 'local', '--json')).stdout);
  assert.equal(result.connection.state, 'connected'); assert.equal(result.projects.length, 1);
  assert.deepEqual(result.projects[0], { id: 'local', remoteProjectId: 'remote-local', pending: 12,
    rejectedUnseen: 1, untracked: 2, lastPullAt: report.projects.local.lastPullAt, rejected: [items[0]] });
  report.updatedAt = new Date(Date.now() - 120000).toISOString(); write(statusFile, report);
  assert.match((await cloud(f, 'status')).stdout, /可能已退出/);
  for (const [state, expected] of [['reconnecting', /正在重连\(下次重试 [0-9]{2}:[0-9]{2}:[0-9]{2}\)/],
    ['login-required', /请重新登录云端/], ['stopped', /^已停止/]]) {
    report.agent = { state, nextRetryAt: new Date().toISOString() }; write(statusFile, report);
    const output = (await cloud(f, 'status')).stdout; assert.match(output, expected);
    if (state === 'stopped') assert.equal(output.includes('可能已退出'), false);
  }
  fs.writeFileSync(statusFile, '{');
  assert.match((await cloud(f, 'status')).stdout, /同步程序没在运行/);
  fs.unlinkSync(statusFile);
  assert.equal(JSON.parse((await cloud(f, 'status', '--json')).stdout).connection, null);
});

test('⑧ ack selected/all is atomic on missing seq and never records an outbox write', async t => {
  const f = fixture(t), proj = f.addProject('local'), reg = read(f.registryPath);
  reg.projects.local.cloud = { enabled: true, remoteProjectId: 'remote' }; write(f.registryPath, reg);
  fs.mkdirSync(proj.syncDir, { recursive: true });
  const file = path.join(proj.syncDir, 'rejected.json');
  write(file, { v: 1, items: [1, 2, 3].map(seq => ({ seq, seen: false })) });
  const before = text(file);
  const bad = await command(f, ['cloud', 'ack', '--project', 'local', '--seq', '1', '--seq', '999']);
  assert.equal(bad.code, 1); assert.equal(text(file), before);
  assert.match((await cloud(f, 'ack', '--project', 'local', '--seq', '1', '--seq', '3')).stdout, /已标为知道了 2 条/);
  assert.deepEqual(read(file).items.map(item => item.seen), [true, false, true]);
  assert.equal(JSON.parse((await cloud(f, 'ack', '--project', 'local', '--all', '--json')).stdout).count, 1);
  assert.ok(read(file).items.every(item => item.seen));
  assert.deepEqual(fs.readdirSync(proj.syncDir), ['rejected.json']);
});

test('⑩ disabled projects preserve pre-change stdout/stderr/exit bytes and never read sync files', async t => {
  const f = fixture(t), proj = f.addProject('local');
  await add(f, 'local', 'T1');
  const initial = fs.readFileSync(proj.board);
  const oldIndex = execFileSync('git', ['show', 'HEAD:cli/index.cjs'], {
    windowsHide: true, cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
  });
  const source = path.join(f.home, 'original-index.txt'), runner = path.join(f.home, 'old-cli.cjs');
  fs.writeFileSync(source, oldIndex);
  fs.writeFileSync(runner, `
    const Module = require('node:module'), fs = require('node:fs');
    const file=${JSON.stringify(INDEX)}, m=new Module(file);
    m.filename=file; m.paths=Module._nodeModulePaths(require('node:path').dirname(file));
    process.mainModule=m;
    m._compile(fs.readFileSync(${JSON.stringify(source)},'utf8').replace('if (require.main === module) main();','main();'),file);
  `);
  const monitor = path.join(f.home, 'monitor.cjs'), readsFile = path.join(f.home, 'reads.json');
  fs.writeFileSync(monitor, `
    const fs=require('node:fs'), path=require('node:path'), reads=[];
    const root=${JSON.stringify(f.root)};
    for(const key of ['readFileSync','openSync','readdirSync','statSync','lstatSync','existsSync']){
      const original=fs[key]; fs[key]=function(file,...args){
        if(typeof file==='string' && (path.resolve(file)===root || path.resolve(file).startsWith(root+path.sep))) reads.push([key,file]);
        return original.call(this,file,...args);
      };
    }
    process.on('exit',()=>fs.writeFileSync(${JSON.stringify(readsFile)},JSON.stringify(reads)));
  `);
  const commands = [
    ['note', 'T1', '--text', 'a note'], ['edit', 'T1', '--title', 'Updated'],
    ['claim', 'T1', '--branch', 'branch', '--builder', '派单器'],
    ['progress', 'T1', '--percent', '20'], ['show', 'T1'], ['show', 'T1', '--json'],
    ['brief', 'T1'], ['note', 'MISSING', '--text', 'failure'], ['add', 'NO-MODEL', '--title', 'gate'],
  ];
  for (const enabled of [undefined, false]) {
    const reg = read(f.registryPath);
    if (enabled === false) reg.projects.local.cloud = { enabled: false, remoteProjectId: 'unused' };
    else delete reg.projects.local.cloud;
    write(f.registryPath, reg);
    for (const args of commands) {
      fs.writeFileSync(proj.board, initial);
      const before = await command(f, [...args, '--project', 'local'], { runner });
      fs.writeFileSync(proj.board, initial);
      const after = await command(f, [...args, '--project', 'local'], { preload: monitor });
      assert.deepEqual(after, before, args.join(' '));
      assert.deepEqual(read(readsFile), [], args.join(' '));
    }
  }
  assert.equal(fs.existsSync(f.root), false);
});

test('⑫ unknown cloud subcommand exits 2 and lists every supported subcommand', async t => {
  const f = fixture(t);
  for (const args of [['cloud', 'not-a-command'], ['cloud', 'not-a-command', '--json']]) {
    const r = await command(f, args); assert.equal(r.code, 2);
    for (const command of ['config', 'login', 'logout', 'reconnect', 'status', 'ack', 'attach', 'detach']) assert.ok(r.stderr.includes(command));
  }
});

test('unreadable rejection records never change successful write exit codes', async t => {
  const f = fixture(t), proj = f.addProject('local');
  await add(f, 'local', 'T1');
  const reg = read(f.registryPath); reg.projects.local.cloud = { enabled: true, remoteProjectId: 'remote' };
  write(f.registryPath, reg); fs.mkdirSync(proj.syncDir, { recursive: true });
  const { unseenRejected, noticeLine } = require('../core/syncNotice.cjs');
  for (const data of ['{', '{}', JSON.stringify({ items: [null, 5, { command: 'claim', taskIds: 1, seen: false }] })]) {
    fs.writeFileSync(path.join(proj.syncDir, 'rejected.json'), data);
    assert.deepEqual(unseenRejected(f.proj('local')), []);
    assert.equal((await good(f, ['note', 'T1', '--text', 'corrupt notice', '--project', 'local'])).stderr, '');
    await cloud(f, 'status', '--json');
  }
  const item = { command: 'claim', taskIds: ['T1'], error: 'fallback', reason: 'preferred', seen: false };
  assert.equal(noticeLine([item, item]), '⚠ 云端退回了你 2 条改动:claim T1(preferred)等。看 board.cmd cloud status');
});
