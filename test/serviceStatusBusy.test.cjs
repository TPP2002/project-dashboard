'use strict';
/**
 * serviceStatusBusy.test.cjs —— 连上了但还没回,不许当成"没在跑"(AD-20261112-LAUNCHER-BUSY-REFUSE)。
 *
 * 看板服务是单线程的:忙起来几秒到十几秒不回健康接口,但操作系统照样接受连接。
 * 原来的探活整条链路只有一个 2 秒门槛,于是"正忙"被误判成"没在跑",启动器据此拒绝启动并弹窗。
 * 这里钉住拆开之后的两段门槛:
 *   (a) 连接立刻建立、3 秒后才回:仍判在跑;
 *   (b) 连接建立但永不回应:按 busyWaitMs 放弃;
 *   (c) 端口上没人听:立即判没在跑;
 *   (d) 立即回应:不被拖慢。
 *
 * serviceStatus 是同步的(execFileSync),所以假服务必须起在子进程里;
 * 每次探活都限定单一端口 + 临时 dest,既不读真实发布副本,也不扫真实端口。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const cp = require('node:child_process');
const { serviceStatus } = require('../cli/release.cjs');

const ROOT = path.resolve(__dirname, '..');

function tempDest(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-status-busy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function waitReadyPort(child, t) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('假服务没在 10 秒内报出监听端口')), 10000);
    t.after(() => clearTimeout(timer));
    child.stdout.on('data', (c) => {
      out += c;
      if (/^\d+$/.test(out.trim())) { clearTimeout(timer); resolve(Number(out.trim())); }
    });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`假服务提前退出（${code}）`)); });
  });
}

/** 起一个假服务子进程,等它报出实际监听端口再返回。handlerBody 里可以用 req / res / srv。 */
function startFakeServer(t, handlerBody) {
  const child = cp.spawn(process.execPath, ['-e', `
    const http = require('http');
    const srv = http.createServer((req, res) => {
      ${handlerBody}
    });
    srv.listen(0, '127.0.0.1', () => process.stdout.write(String(srv.address().port)));
  `], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { try { child.kill(); } catch { /* 已退出 */ } });
  return waitReadyPort(child, t);
}

const HEALTH_REPLY = `
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ service: 'claude-dashboard', pid: 4242, port: srv.address().port, mode: 'release', codeRoot: 'x' }));
`;

test('服务正忙:连上了、3 秒后才回健康接口,仍判在跑', { timeout: 60000 }, async (t) => {
  const port = await startFakeServer(t, `setTimeout(() => {${HEALTH_REPLY}}, 3000);`);
  const dest = tempDest(t);
  const startedAt = Date.now();
  const st = serviceStatus({ portBase: port, portRange: 0, dest });
  const elapsed = Date.now() - startedAt;
  assert.equal(st.running, true, st.text);
  assert.equal(st.health.pid, 4242);
  assert.ok(elapsed >= 2500, `应当一直等到慢响应回来,实际只等了 ${elapsed}ms`);
});

test('连上却不回:按 busyWaitMs 放弃,不当成在跑', { timeout: 60000 }, async (t) => {
  const port = await startFakeServer(t, '/* 接受连接但永不回应 */');
  const dest = tempDest(t);
  const startedAt = Date.now();
  const st = serviceStatus({ portBase: port, portRange: 0, dest, busyWaitMs: 1500 });
  const elapsed = Date.now() - startedAt;
  assert.equal(st.running, false, st.text);
  assert.ok(elapsed >= 1300, `应当给满 busyWaitMs 再放弃,实际 ${elapsed}ms 就放弃了`);
  assert.ok(elapsed <= 8000, `放弃得太慢,子进程可能被总超时提前杀掉（实际 ${elapsed}ms）`);
});

test('端口上没人听:立即判没在跑,不干等', { timeout: 60000 }, async (t) => {
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const at = srv.address().port;
      srv.close(() => resolve(at));
    });
  });
  const dest = tempDest(t);
  const startedAt = Date.now();
  const st = serviceStatus({ portBase: port, portRange: 0, dest });
  const elapsed = Date.now() - startedAt;
  assert.equal(st.running, false, st.text);
  assert.ok(elapsed < 5000, `连不上就该立即判没在跑,实际等了 ${elapsed}ms`);
});

test('立即回应:照旧判在跑,不被慢等待拖住', { timeout: 60000 }, async (t) => {
  const port = await startFakeServer(t, HEALTH_REPLY);
  const dest = tempDest(t);
  const startedAt = Date.now();
  const st = serviceStatus({ portBase: port, portRange: 0, dest });
  const elapsed = Date.now() - startedAt;
  assert.equal(st.running, true, st.text);
  assert.equal(st.health.pid, 4242);
  assert.ok(elapsed < 3000, `快服务不该被拖慢,实际 ${elapsed}ms`);
});
