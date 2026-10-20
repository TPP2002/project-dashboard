'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { fork } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const { atomicWriteJsonSync: write } = require('../core/atomicWrite.cjs');
const { protect, unprotect, saveDeviceCredential, loadDeviceCredential, enrollDevice,
  clearDeviceCredential, writeConfig, readConfig, syncRoot } = require('../core/syncCredential.cjs');
const ORIGIN = 'http://127.0.0.1:47123';
function fixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-credential-')));
  const registryPath = path.join(home, 'registry.json');
  write(registryPath, { projects: {} });
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { home, registryPath };
}
test('① Windows current-user DPAPI round trip and encrypted credential file', async t => {
  if (process.platform !== 'win32') { t.skip('设备凭据加密只支持 Windows，非 Windows 无 DPAPI'); return; }
  const { registryPath } = fixture(t);
  const token = 'device-secret-中文-' + Date.now();
  const blob = await protect(token); assert.notEqual(blob, token); assert.equal(await unprotect(blob), token);
  const data = { registryPath, token, origin: ORIGIN, label: '测试电脑', deviceId: 'device-id', expiresAt: '2099-01-01T00:00:00Z' };
  await saveDeviceCredential(data);
  const content = fs.readFileSync(path.join(syncRoot(registryPath), 'device.cred'), 'utf8');
  assert.equal(content.includes(token), false);
  assert.equal(JSON.parse(content).scheme, 'dpapi-user');
  assert.equal((await loadDeviceCredential(registryPath)).token, token);
  clearDeviceCredential(registryPath); assert.equal(await loadDeviceCredential(registryPath), null);
});
test('② PowerShell receives secrets only on stdin and hides its window', async () => {
  for (const operation of [protect, unprotect]) {
    const secret = operation === protect ? 'unique-plaintext' : 'unique-encrypted-base64';
    let received = '', invoked = false;
    const output = operation === protect ? 'ZW5jcnlwdGVk' : 'decoded';
    const spawn = (executable, args, options) => {
      invoked = true; assert.equal(executable, 'powershell.exe');
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
      assert.equal(args.length, 4); assert.equal(args.some(a => a.includes(secret)), false);
      assert.equal(options.windowsHide, true); assert.equal(options.env, undefined);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      child.stdin.on('data', b => { received += b; });
      child.stdin.on('finish', () => { child.stdout.end(output); setImmediate(() => child.emit('close', 0)); });
      return child;
    };
    assert.equal(await operation(secret, { spawn, platform: 'win32' }), output);
    assert.equal(invoked, true); assert.equal(received, secret);
  }
  await assert.rejects(protect('secret', { platform: 'linux' }), /设备凭据加密只支持 Windows/);
});
test('③ enrollment against real server creates usable device and revokes password session', { timeout: 45000 }, async t => {
  const { home, registryPath } = fixture(t);
  const cloud = path.join(home, 'cloud'); fs.mkdirSync(cloud);
  const cloudRegistry = path.join(cloud, 'registry.json');
  write(path.join(cloud, 'board.json'), emptyBoard({ id: 'remote' }));
  write(cloudRegistry, { projects: { remote: { mainRepo: cloud, board: path.join(cloud, 'board.json') } } });
  const auth = createAuth({ home: cloud, registryPath: cloudRegistry });
  const password = 'Enrollment-only-password'; await auth.bootstrap('owner', password);
  const owner = await auth.login('owner', password, 'credential-test');
  const child = fork(path.resolve(__dirname, '../server/server.cjs'), [], { windowsHide: true, silent: true, env: {
    ...process.env, DASHBOARD_HOME: cloud, DASHBOARD_REGISTRY: cloudRegistry, DASHBOARD_MODE: 'collaboration',
    DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1', DASHBOARD_EVENT_WEBHOOK: '',
  } });
  child.stdout.resume(); child.stderr.resume();
  t.after(async () => { if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server readiness timeout')), 15000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited')); });
    child.on('message', msg => { if (msg.type === 'dashboard-ready') { clearTimeout(timer); resolve(`http://127.0.0.1:${msg.port}`); } });
  });
  writeConfig(registryPath, { v: 1, mode: 'direct', origin: ORIGIN, baseUrl: base });
  // An injected protector permits real HTTP coverage on non-Windows runners;
  // Windows always exercises real DPAPI, including this complete enrollment.
  const protector = process.platform === 'win32' ? undefined : {
    protect: async s => Buffer.from(s).toString('base64'), unprotect: async s => Buffer.from(s, 'base64').toString(),
  };
  let passwordSession, passwordCsrf;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).endsWith('/api/auth/login') && response.ok) {
      passwordSession = response.headers.get('set-cookie').match(/dashboard_session=([^;]+)/)[1];
      passwordCsrf = (await response.clone().json()).csrfToken;
    }
    return response;
  };
  let result;
  try { result = await enrollDevice({ registryPath, username: 'owner', password, label: 'Enrollment computer', protector }); }
  finally { globalThis.fetch = originalFetch; }
  assert.ok(result.deviceId); assert.equal(result.label, 'Enrollment computer');
  assert.ok(auth.admin(owner.token).devices.some(d => d.id === result.deviceId && d.label === result.label));
  const credential = await loadDeviceCredential(registryPath, protector);
  assert.equal(credential.deviceId, result.deviceId); assert.ok(auth.deviceLogin(credential.token).deviceId);
  assert.ok(passwordSession); assert.equal(auth.session(passwordSession), null);
  const revoked = await fetch(base + '/api/auth/admin', { headers: { Cookie: 'dashboard_session=' + passwordSession } });
  assert.equal(revoked.status, 401);
  const root = syncRoot(registryPath);
  for (const name of fs.readdirSync(root)) {
    const content = fs.readFileSync(path.join(root, name), 'utf8');
    for (const secret of [password, passwordSession, passwordCsrf, credential.token]) assert.equal(content.includes(secret), false);
  }
});
test('④ connection config validates required fields, origin, ports and host', t => {
  const { registryPath } = fixture(t);
  const ssh = { v: 1, mode: 'ssh', origin: 'https://dashboard.example', sshHost: 'configured-host', remotePort: 16070, localPort: 16071 };
  writeConfig(registryPath, ssh); assert.deepEqual(readConfig(registryPath), ssh);
  const bad = [{ ...ssh, v: 2 }, { ...ssh, mode: 'other' }, { ...ssh, origin: '' }, { ...ssh, origin: 'file:///x' },
    { ...ssh, origin: 'https://user:pass@example.test' }, { ...ssh, origin: 'https://example.test/path' },
    { ...ssh, origin: 'https://example.test?token=secret' }, { ...ssh, sshHost: '' }, { ...ssh, sshHost: '-test' },
    { ...ssh, sshHost: 'host name' }, { ...ssh, sshHost: 'host\tname' }, { ...ssh, sshHost: 'host\x7f' }];
  for (const key of ['remotePort', 'localPort']) for (const value of [undefined, 0, -1, 65536, 2.5, '22']) bad.push({ ...ssh, [key]: value });
  for (const key of ['origin', 'sshHost', 'remotePort', 'localPort']) { const missing = { ...ssh }; delete missing[key]; bad.push(missing); }
  for (const config of bad) assert.throws(() => writeConfig(registryPath, config));
  assert.deepEqual(readConfig(registryPath), ssh, 'Rejected config must not replace valid config');
  for (const baseUrl of [undefined, '', 'file:///x', 'http://u:p@localhost', 'http://localhost?secret=x']) {
    assert.throws(() => writeConfig(registryPath, { v: 1, mode: 'direct', origin: ORIGIN, baseUrl }));
  }
  const direct = { v: 1, mode: 'direct', origin: ORIGIN, baseUrl: ORIGIN };
  writeConfig(registryPath, direct); assert.deepEqual(readConfig(registryPath), direct);
});
