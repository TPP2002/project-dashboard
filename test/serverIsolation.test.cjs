'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const freePort = require('../scripts/free-port.cjs');

async function launch(t, base, registry, home) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server/server.cjs')], {
    env: { ...process.env, DASHBOARD_PORT: String(base), DASHBOARD_NO_OPEN: '1',
      DASHBOARD_REGISTRY: registry, DASHBOARD_HOME: home, DASHBOARD_MODULES: '' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`服务启动超时：${output}`)), 8000);
    const inspect = chunk => {
      output += chunk;
      const match = /本地地址：http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve({ child, port: Number(match[1]) }); }
    };
    child.stdout.on('data', inspect); child.stderr.on('data', inspect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`服务提前退出 ${code}：${output}`)); });
  });
}

for (const sameRegistry of [false, true]) test(`重叠端口段、${sameRegistry ? '同注册表不同数据根' : '不同注册表'}的两套服务互不复用或停止`, { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-isolation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const a = path.join(dir, 'a.json'), b = sameRegistry ? a : path.join(dir, 'b.json');
  for (const file of [a, b]) fs.writeFileSync(file, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const base = await freePort();
  const first = await launch(t, base, a, path.join(dir, 'home-a'));
  const second = await launch(t, base, b, path.join(dir, 'home-b'));
  assert.notEqual(first.port, second.port);
  const health = async port => (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  const [left, right] = await Promise.all([health(first.port), health(second.port)]);
  assert.equal(left.pid, first.child.pid);
  assert.equal(right.pid, second.child.pid);
  assert.equal(left.registryPath, a);
  assert.equal(right.registryPath, b);
  assert.equal(first.child.exitCode, null);
});

test('端口 0 由系统分配，两份同数据自检也各自持有端口并报告真实地址', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-ephemeral-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const first = await launch(t, 0, registry, dir);
  const second = await launch(t, 0, registry, dir);
  assert.ok(first.port > 0 && second.port > 0, '不能把申请值 0 当成实际监听地址');
  assert.notEqual(first.port, second.port);
  for (const service of [first, second]) {
    const health = await (await fetch(`http://127.0.0.1:${service.port}/api/health`)).json();
    assert.equal(health.port, service.port);
    assert.equal(health.pid, service.child.pid);
  }
});
