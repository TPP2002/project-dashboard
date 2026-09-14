'use strict';
/**
 * 静态文件服务:客户端中途断开不许泄句柄(DASH-RELEASE-BLOCKED-BY-OWN-SERVER,0914 治本)。
 *
 * 【这条为什么值一个测试】`fs.createReadStream(...).pipe(res)` 在客户端中途断开时**不会**关掉
 * 源流,那个文件句柄一直开到进程退出。攒够几个,`cli release` 换名发布副本就报 EPERM
 * (Windows:目录里有进程开着文件 = 换不了名),而发布是"让改动生效"的唯一通道。
 *
 * 【判据为什么是 rename 而不是数句柄】Node 没有可移植的"列出我开了哪些 fd"接口,数不出来;
 * 而**换名成不成**正是这个 bug 真正伤到的那件事 —— 直接量它,一步不隔。这也是 0914 前五轮
 * 复现失败的教训:那五轮量的是「服务在跑」「有请求」这类**间接**条件,全是绿的,病根照样在。
 * 第六轮把变量换成「请求读完 vs 中途掐断」,一次就抓到。
 *
 * 【为什么必须用真进程 + 真 socket】句柄泄漏是跨进程、跨内核的事实,替身会把这条边界整个抹掉,
 * 而这条边界正是病根所在。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';

/**
 * 造一份能跑的最小"发布副本":整份拷本仓的运行期文件 + 一个够大的静态资源。
 * 够大是必须的 —— 小文件一个 chunk 就发完了,掐不住,实验会假绿。
 */
function stage(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sfl-')));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* 句柄滞留 */ } });
  const dest = path.join(root, 'copy');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  for (const dir of ['server', 'core', 'cli']) {
    fs.cpSync(path.join(ROOT, dir), path.join(dest, dir), { recursive: true });
  }
  fs.cpSync(path.join(ROOT, 'package.json'), path.join(dest, 'package.json'));
  const dist = path.join(dest, 'web', 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><p>x</p>', 'utf8');
  // 2MB:保证分成很多 chunk,首个 chunk 到达时后面还没发完,掐得住
  fs.writeFileSync(path.join(dist, 'assets', 'big.js'), 'x'.repeat(2 * 1024 * 1024), 'utf8');
  return { root, dest, outside };
}

function startServer(t, dest, outside, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dest, 'server', 'server.cjs')], {
      cwd: outside,
      env: { ...process.env, DASHBOARD_PORT: String(port), DASHBOARD_NO_OPEN: '1', DASHBOARD_NO_RESTART: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { try { child.kill(); } catch (_) { /* 已退出 */ } });
    let out = '';
    const done = setTimeout(() => resolve({ child, out, ok: false }), 15000);
    const onData = (d) => {
      out += d.toString();
      if (out.includes(String(port))) { clearTimeout(done); resolve({ child, out, ok: true }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

/** 发请求,收到首个数据块就掐断(浏览器刷新 / 关标签 / 导航走就是这个形状)。 */
const abortMidStream = (port, urlPath) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 8000 }, (res) => {
    res.once('data', () => { req.destroy(); resolve('aborted'); });
    res.once('end', () => resolve('finished-too-fast'));
  });
  req.on('error', () => resolve('err'));
  req.on('timeout', () => { req.destroy(); resolve('timeout'); });
});

/** 完整读完(对照组)。 */
const readFull = (port, urlPath) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 8000 }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', () => resolve(0));
  req.on('timeout', () => { req.destroy(); resolve(0); });
});

const renameCode = (root, dest) => {
  const to = path.join(root, 'copy.renamed');
  try { fs.renameSync(dest, to); fs.renameSync(to, dest); return 'OK'; } catch (e) { return e.code; }
};

test('静态文件被中途掐断 20 次之后,发布副本目录仍然换得了名(句柄没泄)', {
  skip: !WIN && '句柄占用导致换名失败是 Windows 语义;别的平台本来就换得了名,测不出这个 bug',
}, async (t) => {
  const { root, dest, outside } = stage(t);
  const started = await startServer(t, dest, outside, 6191);
  assert.ok(started.ok, '服务没起来,后面的结论都不算数。它说:' + started.out.slice(0, 300));

  // 对照组先跑:完整读完不该有任何影响 —— 它同时证明"换名失败"不是环境本来就换不了名
  for (let i = 0; i < 20; i++) await readFull(6191, '/assets/big.js');
  assert.equal(renameCode(root, dest), 'OK', '完整读完不该影响换名(基线)');

  const how = [];
  for (let i = 0; i < 20; i++) how.push(await abortMidStream(6191, '/assets/big.js'));
  const aborted = how.filter((h) => h === 'aborted').length;
  // 掐不住就等于这一轮什么都没验:宁可测试报"实验没做成",也不许它假绿
  assert.ok(aborted >= 15, '至少要真掐断 15 次,否则实验没做成。实际:' + JSON.stringify(
    how.reduce((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {})));

  assert.equal(renameCode(root, dest), 'OK',
    '中途掐断之后换名失败 = 源流没被关掉、句柄泄在副本里,这正是 release 报 EPERM 的病根');
});

test('掐断之后服务照常服务下一个请求(善后不许把服务本身弄坏)', async (t) => {
  const { dest, outside } = stage(t);
  const started = await startServer(t, dest, outside, 6192);
  assert.ok(started.ok, '服务没起来:' + started.out.slice(0, 300));
  for (let i = 0; i < 5; i++) await abortMidStream(6192, '/assets/big.js');
  assert.equal(await readFull(6192, '/assets/big.js'), 200, '掐断过之后还得能正常发完整文件');
  assert.equal(await readFull(6192, '/'), 200, '首页也得照常');
});
