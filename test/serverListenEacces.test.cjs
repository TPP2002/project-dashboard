'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const freePort = require('../scripts/free-port.cjs');

const SERVER = path.resolve(__dirname, '../server/server.cjs');

// 预加载脚本：改写 net.Server.prototype.listen。当要监听的端口等于环境变量
// DASHBOARD_EACCES_PORT 指定的端口（或该变量取值 'all' 时的任意端口）时，不真的监听，
// 而是在下一个事件循环 emit 一个 code 为 EACCES 的 error；其它端口走原实现照常监听。
// 脚本在测试运行时写到临时目录、由 node --require 加载，不进入仓库。
const PRELOAD = `'use strict';
const net = require('node:net');
const target = process.env.DASHBOARD_EACCES_PORT;
const original = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  const port = first && typeof first === 'object' ? first.port : first;
  const hit = target === 'all' || (port !== undefined && Number(port) === Number(target));
  if (hit) {
    const self = this;
    process.nextTick(() => {
      const err = new Error('listen EACCES: permission denied 127.0.0.1:' + port);
      err.code = 'EACCES';
      err.syscall = 'listen';
      self.emit('error', err);
    });
    return this;
  }
  return original.apply(this, args);
};
`;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-listen-eacces-'));
}

function writeRegistry(dir) {
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  return registry;
}

function writePreload(dir) {
  const file = path.join(dir, 'eacces-preload.cjs');
  fs.writeFileSync(file, PRELOAD);
  return file;
}

function canBind(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    probe.once('error', () => done(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });
}

// 起始端口取自 free-port.cjs；再确认下一个端口当下也能监听，
// 避免 Windows 保留段让「加 1」端口报 EACCES 干扰对换端口的断言。
async function freeStartingPort() {
  for (let i = 0; i < 40; i++) {
    const base = await freePort();
    if (base + 1 <= 65535 && (await canBind(base + 1))) return base;
  }
  throw new Error('找不到起始端口及其下一端口都可监听的端口');
}

function makeChild({ base, registry, home, preload, eaccesPort }) {
  const args = preload ? ['--require', preload, SERVER] : [SERVER];
  const env = {
    ...process.env,
    DASHBOARD_PORT: String(base),
    DASHBOARD_NO_OPEN: '1',
    DASHBOARD_REGISTRY: registry,
    DASHBOARD_HOME: home,
    DASHBOARD_MODULES: '',
  };
  if (eaccesPort !== undefined) env.DASHBOARD_EACCES_PORT = String(eaccesPort);
  const child = spawn(process.execPath, args, {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, getOutput: () => output };
}

function registerCleanup(t, svc, dir, blocker) {
  t.after(async () => {
    if (svc.child.exitCode === null && svc.child.signalCode === null) {
      svc.child.kill();
      await once(svc.child, 'exit');
    }
    if (blocker) blocker.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
}

function waitForStart(svc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务启动超时：' + svc.getOutput())), 12000);
    const check = () => {
      const match = /本地地址：http:\/\/127\.0\.0\.1:(\d+)/.exec(svc.getOutput());
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    svc.child.stdout.on('data', check);
    svc.child.stderr.on('data', check);
    svc.child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('服务提前退出 ' + code + '：' + svc.getOutput()));
    });
  });
}

function waitForExit(svc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待退出超时：' + svc.getOutput())), 12000);
    svc.child.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

test('(a) 起始端口报 EACCES 时自动换到下一个端口并正常提供服务', { timeout: 15000 }, async (t) => {
  const dir = makeTempDir();
  const registry = writeRegistry(dir);
  const home = path.join(dir, 'home');
  const preload = writePreload(dir);
  const base = await freeStartingPort();
  const svc = makeChild({ base, registry, home, preload, eaccesPort: base });
  registerCleanup(t, svc, dir);
  const port = await waitForStart(svc);
  assert.equal(port, base + 1, '应监听起始端口的下一个端口');
  const health = await (await fetch('http://127.0.0.1:' + port + '/api/health')).json();
  assert.equal(health.pid, svc.child.pid, '健康检查的 pid 必须是这个子进程');
  assert.match(svc.getOutput(), /被系统保留或独占/);
});

test('(b) 起始端口被占用（EADDRINUSE）时旧行为不变，换到下一个端口', { timeout: 15000 }, async (t) => {
  const dir = makeTempDir();
  const registry = writeRegistry(dir);
  const home = path.join(dir, 'home');
  const base = await freeStartingPort();
  const blocker = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(base, '127.0.0.1', resolve);
  });
  const svc = makeChild({ base, registry, home });
  registerCleanup(t, svc, dir, blocker);
  const port = await waitForStart(svc);
  assert.equal(port, base + 1, '应监听起始端口的下一个端口');
  assert.match(svc.getOutput(), /被占用/);
});

test('(c) 所有端口都报 EACCES 时以退出码 1 结束并报致命错误', { timeout: 15000 }, async (t) => {
  const dir = makeTempDir();
  const registry = writeRegistry(dir);
  const home = path.join(dir, 'home');
  const preload = writePreload(dir);
  const base = await freePort();
  const svc = makeChild({ base, registry, home, preload, eaccesPort: 'all' });
  registerCleanup(t, svc, dir);
  const code = await waitForExit(svc);
  assert.equal(code, 1, '应以退出码 1 结束');
  assert.match(svc.getOutput(), /无法启动服务/);
});
