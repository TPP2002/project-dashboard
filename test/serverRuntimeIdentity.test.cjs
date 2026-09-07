'use strict';
/**
 * serverRuntimeIdentity.test.cjs —— 服务报家门 + 旧版本自动换新
 * (SERVER-RUNS-ON-LIVE-CHECKOUT,负责人 0906 拍板 d2=A「自动重启」)。
 *
 * 要钉死的行为:
 *   · /api/health 说得出"我这份代码从哪来、是哪个提交、什么身份"——不然谁也判断不了在跑的是不是最新;
 *   · 再起一次:同一份代码 → 复用旧实例(今天的行为不变);
 *   · 版本不一样 → 关掉旧的、接管同一个端口(书签不变),新实例报的是新提交;
 *   · DASHBOARD_NO_RESTART=1 → 不动旧的,但必须把"你看到的仍是旧版本"说出来;
 *   · 老实例(不报 codeRoot 的旧版本)一律判"不是同一份"——迁移当天在跑的就是那种;
 *   · 开发实例(代码根是 git 检出)与发布副本【端口段不重叠】:不重叠才不会互相误杀。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const DASH_ROOT = path.resolve(__dirname, '..');
const realTmp = (p) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = require('../scripts/free-port.cjs');

/** 照发布副本的样子做一份运行期代码:core/cli/server/package.json + RELEASE.json 印章。 */
function makeReleaseCopy(commit, registryPath) {
  const dir = realTmp('srvid-');
  for (const p of ['core', 'cli', 'server']) fs.cpSync(path.join(DASH_ROOT, p), path.join(dir, p), { recursive: true });
  fs.cpSync(path.join(DASH_ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.writeFileSync(path.join(dir, 'RELEASE.json'), JSON.stringify({
    commit, ref: 'origin/master', trunk: 'master', source: DASH_ROOT, releasedAt: new Date().toISOString(),
  }));
  fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  return dir;
}

function getJson(port, p = '/api/health') {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 1000 }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 起一个服务并等它真的能应答;返回 {child, port}。 */
async function startServer(root, port, registryPath, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(root, 'server', 'server.cjs')], {
    cwd: os.tmpdir(),   // 落脚点不在代码目录里(Windows 上那样会锁住目录,发布换名必 EBUSY)
    env: { ...process.env, DASHBOARD_PORT: String(port), DASHBOARD_NO_OPEN: '1', DASHBOARD_REGISTRY: registryPath, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 60; i++) {
    const h = await getJson(port);
    if (h && h.ok) return { child, port, out: () => out };
    if (child.exitCode !== null) throw new Error(`server 起不来(退出码 ${child.exitCode}):\n${out}`);
    await delay(100);
  }
  throw new Error(`server 起了但探不活:\n${out}`);
}

/** 跑一次"再起一次"的启动器动作,等它自己退出,返回它打印了什么。 */
function runOnce(root, port, registryPath, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'server', 'server.cjs')], {
      cwd: os.tmpdir(),
      env: { ...process.env, DASHBOARD_PORT: String(port), DASHBOARD_NO_OPEN: '1', DASHBOARD_REGISTRY: registryPath, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out, child }));
  });
}

const kill = (c) => { try { c.kill(); } catch { /* 已经没了 */ } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('health 报家门:身份 / 代码根 / 发布提交 一个都不少', async () => {
  const reg = path.join(realTmp('srvreg-'), 'registry.json');
  const A = makeReleaseCopy('a'.repeat(40), reg);
  const port = await freePort();
  const s = await startServer(A, port, reg);
  try {
    const h = await getJson(port);
    assert.equal(h.mode, 'release', '没有 .git 又有印章 = 发布副本');
    assert.equal(path.resolve(h.codeRoot), path.resolve(A));
    assert.equal(h.releaseCommit, 'a'.repeat(40));
    assert.ok(h.releasedAt, '印章的发布时间要报出来');
  } finally { kill(s.child); clean(A); }
});

test('再起一次:同一份代码 → 复用旧实例,不折腾', async () => {
  const reg = path.join(realTmp('srvreg-'), 'registry.json');
  const A = makeReleaseCopy('b'.repeat(40), reg);
  const port = await freePort();
  const s = await startServer(A, port, reg);
  try {
    const first = (await getJson(port)).pid;
    const again = await runOnce(A, port, reg);
    assert.equal(again.code, 0);
    assert.match(again.out, /复用该实例/);
    assert.equal((await getJson(port)).pid, first, '旧实例必须原地不动');
  } finally { kill(s.child); clean(A); }
});

test('版本不一样 → 关掉旧的、接管同一个端口,新实例报新提交', async () => {
  const reg = path.join(realTmp('srvreg-'), 'registry.json');
  const A = makeReleaseCopy('1'.repeat(40), reg);
  const B = makeReleaseCopy('2'.repeat(40), reg);
  const port = await freePort();
  const s = await startServer(A, port, reg);
  let taker = null;
  try {
    const oldPid = (await getJson(port)).pid;
    taker = spawn(process.execPath, [path.join(B, 'server', 'server.cjs')], {
      cwd: os.tmpdir(),
      env: { ...process.env, DASHBOARD_PORT: String(port), DASHBOARD_NO_OPEN: '1', DASHBOARD_REGISTRY: reg },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let h = null;
    for (let i = 0; i < 100; i++) {
      h = await getJson(port);
      if (h && h.releaseCommit === '2'.repeat(40)) break;
      await delay(100);
    }
    assert.equal(h && h.releaseCommit, '2'.repeat(40), '同一个端口上应换成新版本');
    assert.equal(path.resolve(h.codeRoot), path.resolve(B));
    assert.equal(alive(oldPid), false, '旧进程必须被关掉,不能两份一起跑');
  } finally { kill(s.child); if (taker) kill(taker); clean(A); clean(B); }
});

test('DASHBOARD_NO_RESTART=1:不动旧的,但必须明说"你看到的仍是旧版本"', async () => {
  const reg = path.join(realTmp('srvreg-'), 'registry.json');
  const A = makeReleaseCopy('3'.repeat(40), reg);
  const B = makeReleaseCopy('4'.repeat(40), reg);
  const port = await freePort();
  const s = await startServer(A, port, reg);
  try {
    const oldPid = (await getJson(port)).pid;
    const again = await runOnce(B, port, reg, { DASHBOARD_NO_RESTART: '1' });
    assert.equal(again.code, 0);
    assert.match(again.out, /仍是旧版本/);
    assert.equal(alive(oldPid), true, '设了不重启就不许动人家');
    assert.equal((await getJson(port)).releaseCommit, '3'.repeat(40));
  } finally { kill(s.child); clean(A); clean(B); }
});

test('老实例(不报 codeRoot)一律判"不是同一份"——迁移当天在跑的就是那种', () => {
  const { isSameRuntime, runtimeInfo } = require('../server/server.cjs');
  const me = runtimeInfo();
  assert.equal(isSameRuntime(null), false);
  assert.equal(isSameRuntime({ ok: true, service: 'claude-dashboard', pid: 1 }), false, '老 health 没有 codeRoot → 判不同');
  assert.equal(isSameRuntime({ codeRoot: me.codeRoot, releaseCommit: me.releaseCommit }), true);
  assert.equal(isSameRuntime({ codeRoot: me.codeRoot, releaseCommit: 'ffff' }), false);
  assert.equal(isSameRuntime({ codeRoot: path.join(me.codeRoot, 'nope'), releaseCommit: me.releaseCommit }), false);
});

test('开发实例与发布副本的端口段不重叠(重叠会互相误杀)', () => {
  const reg = path.join(realTmp('srvreg-'), 'registry.json');
  const A = makeReleaseCopy('5'.repeat(40), reg);
  const env = { ...process.env };
  delete env.DASHBOARD_PORT;                     // 问的是默认端口段
  const ask = (root) => JSON.parse(execFileSync(process.execPath,
    ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(root, 'server', 'server.cjs').replace(/\\/g, '/'))}).runtimeInfo()))`],
    { env, encoding: 'utf8', windowsHide: true }));
  try {
    const rel = ask(A);
    const dev = ask(DASH_ROOT);
    assert.equal(rel.mode, 'release');
    assert.equal(dev.mode, 'dev', '本仓是 git 检出 → 开发实例');
    assert.equal(rel.portBase, 6060);
    assert.equal(dev.portBase, 6070);
    assert.ok(rel.portBase + rel.portRange < dev.portBase, `两段必须不重叠:${rel.portBase}+${rel.portRange} < ${dev.portBase}`);
  } finally { clean(A); }
});
