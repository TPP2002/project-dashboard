'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const SERVER = path.resolve(__dirname, '../server/server.cjs');
const ORIGIN = 'http://127.0.0.1:47123';

function start(home, mode) {
  const child = fork(SERVER, [], { silent: true, windowsHide: true, env: { ...process.env,
    DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json'), DASHBOARD_MODE: mode,
    DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0',
    DASHBOARD_NO_OPEN: '1', DASHBOARD_POLL_MS: '500', DASHBOARD_EVENT_WEBHOOK: '',
  } });
  let output = '', errors = '', readyPort;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out: ' + output + errors)); }, 15000);
    const ready = () => {
      // IPC and stdout are independent pipes; wait for both before inspecting the banner.
      if (!readyPort || !output.includes('按 Ctrl+C 关闭。')) return;
      clearTimeout(timer);
      resolve({ child, base: `http://127.0.0.1:${readyPort}`, port: readyPort, output });
    };
    child.stdout.on('data', b => { output += b; ready(); });
    child.stderr.on('data', b => { errors += b; });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output + errors)); });
    child.on('message', msg => { if (msg.type === 'dashboard-ready') { readyPort = msg.port; ready(); } });
  });
}
async function stop(srv) {
  if (!srv || srv.child.exitCode !== null || srv.child.signalCode !== null) return;
  await new Promise(resolve => { srv.child.once('exit', resolve); srv.child.kill(); });
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-polish-'));
  const registryPath = path.join(home, 'registry.json');
  const board = path.join(home, 'alpha.json');
  fs.writeFileSync(board, JSON.stringify(emptyBoard({ id: 'alpha', name: '项目甲', mainRepo: home })));
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { name: '项目甲', mainRepo: home, board } } }));
  return { home, registryPath, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('empty project invitation is rejected without persistence; valid invitation still succeeds', async t => {
  const { home, registryPath, cleanup } = fixture(t);
  let srv;
  t.after(async () => { await stop(srv); cleanup(); });
  const auth = createAuth({ home, registryPath });
  await auth.bootstrap('owner', 'polish-password');
  const owner = await auth.login('owner', 'polish-password');
  srv = await start(home, 'collaboration');
  async function request(route, data) {
    const response = await fetch(srv.base + route, {
      method: data ? 'POST' : 'GET',
      headers: { Cookie: 'dashboard_session=' + owner.token, Origin: ORIGIN,
        'Content-Type': 'application/json', 'X-Dashboard-Request': '1', 'X-Dashboard-CSRF': owner.csrfToken },
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, body: await response.json() };
  }
  const before = await request('/api/auth/admin');
  assert.equal(before.status, 200);
  const ledger = fs.readFileSync(path.join(home, 'private/collaboration-auth.json'));
  const rejected = await request('/api/auth/invites', { projectIds: [], expiresInHours: 1, maxUses: 1 });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, 'Invalid projectIds');
  assert.deepEqual(fs.readFileSync(path.join(home, 'private/collaboration-auth.json')), ledger);
  const after = await request('/api/auth/admin');
  assert.equal(after.status, 200);
  assert.equal(after.body.invites.length, before.body.invites.length);
  const valid = await request('/api/auth/invites', { projectIds: ['alpha'], expiresInHours: 1, maxUses: 1 });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body.invite.projectIds, ['alpha']);
});

test('collaboration banner uses public origin and container listener; local banner stays unchanged', async t => {
  const { home, registryPath, cleanup } = fixture(t);
  let collaboration, local;
  t.after(async () => { await stop(collaboration); await stop(local); cleanup(); });
  await createAuth({ home, registryPath }).bootstrap('owner', 'polish-password');
  collaboration = await start(home, 'collaboration');
  assert.ok(collaboration.output.includes(`协作模式 · 对外地址:${ORIGIN}`));
  assert.ok(collaboration.output.includes(`容器内监听:127.0.0.1:${collaboration.port}`));
  assert.doesNotMatch(collaboration.output, /浏览器应已自动打开|本地地址/);
  assert.ok(collaboration.output.includes('协作模式不自动打开浏览器;请从对外地址访问。按 Ctrl+C 关闭。'));
  await stop(collaboration);
  local = await start(home, 'local');
  assert.ok(local.output.includes(`  本地地址：http://127.0.0.1:${local.port}/`));
  assert.ok(local.output.includes('浏览器应已自动打开；未打开请手动访问上面地址。按 Ctrl+C 关闭。'));
  assert.doesNotMatch(local.output, /协作模式 · 对外地址|容器内监听/);
});

test('register preserves existing registry mode 0600', {
  skip: process.platform === 'win32' ? 'Windows chmod does not implement POSIX permission bits' : false,
}, t => {
  const { home, registryPath, cleanup } = fixture(t);
  t.after(cleanup);
  fs.chmodSync(registryPath, 0o600);
  execFileSync(process.execPath, [path.resolve(__dirname, '../cli/index.cjs'), 'register',
    '--registry', registryPath, '--id', 'alpha', '--name', '项目甲', '--root', home,
    '--board', path.join(home, 'alpha.json')], {
    windowsHide: true, timeout: 15000, env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_MODE: 'local' },
  });
  assert.equal(fs.statSync(registryPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(registryPath, 'utf8')).projects.alpha.name, '项目甲');
});
