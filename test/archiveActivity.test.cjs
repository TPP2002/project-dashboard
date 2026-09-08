'use strict';
// CLI 与真实服务共用临时注册表，固定时区覆盖月初边界，不接触实际看板。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
const { mutate, readBoard } = require('../cli/store.cjs');
const { validate } = require('../core/boardSchema.cjs');
const freePort = require('../scripts/free-port.cjs');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli/index.cjs');
let srv;

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server/server.cjs')], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, DASHBOARD_NO_OPEN: '1', DASHBOARD_EVENT_WEBHOOK: '', DASHBOARD_POLL_MS: '60000', ...env },
    });
    let out = '', err = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('server 启动超时\n' + out + err)), 15000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      out += data;
      const match = out.match(/127\.0\.0\.1:(\d+)\//);
      if (match) finish(null, { child, base: 'http://127.0.0.1:' + match[1] });
    });
    child.stderr.on('data', (data) => { err += data; });
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => finish(new Error('server 提前退出 ' + code + '\n' + out + err)));
  });
}

function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

before(async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-activity-')));
  const reg = path.join(dir, 'registry.json');
  srv = { dir, reg };
  atomicWriteJsonSync(reg, { schemaVersion: '1.0', projects: {} });
  Object.assign(srv, await startServer({ DASHBOARD_REGISTRY: reg, DASHBOARD_HOME: dir, DASHBOARD_PORT: String(await freePort()) }));
});
after(async () => {
  if (!srv) return;
  await stopServer(srv.child);
  fs.rmSync(srv.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function newProject(id, items) {
  const root = path.join(srv.dir, id);
  const board = path.join(root, '.dashboard', 'board.json');
  fs.mkdirSync(root, { recursive: true });
  const reg = JSON.parse(fs.readFileSync(srv.reg, 'utf8'));
  reg.projects[id] = { name: id, mainRepo: root, board };
  atomicWriteJsonSync(srv.reg, reg);
  const proj = { id, name: id, mainRepo: root, board, lock: board + '.lock' };
  mutate(proj, (b) => {
    b.tasks = [{ id: 'T1', title: '保留完整任务', status: '已完工', wave: 1, dates: { done: '2026-07-01' } }];
    b.activity = items;
  });
  return proj;
}
const item = (ts, text) => ({ ts, taskId: 'T1', type: 'done', text });
function run(id, beforeMonth, json = true, tz = 'Asia/Shanghai') {
  const args = [CLI, 'archive-activity', '--project', id, '--registry', srv.reg];
  if (beforeMonth !== undefined) args.push('--before', beforeMonth);
  if (json) args.push('--json');
  return spawnSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, TZ: tz, DASHBOARD_HOME: srv.dir },
  });
}
function snapshot(files) {
  return files.map((file) => ({ file, bytes: fs.readFileSync(file).toString('base64'), mtime: fs.statSync(file).mtimeMs }));
}
async function get(route, etag) {
  const response = await fetch(srv.base + route, { headers: etag ? { 'If-None-Match': etag } : {} });
  assert.equal(response.status, 200);
  return { body: await response.json(), etag: response.headers.get('etag') };
}

test('按本地月份搬移、合并去重、保持校验、文件变小、再次执行严格幂等', async () => {
  const july = item('2026-06-30T16:00:00.000Z', '本地七月记录');
  const august = item('2026-08-31T15:59:59.999Z', '月初之前');
  const boundary = item('2026-08-31T16:00:00.000Z', '本地九月零点');
  const newer = item('2026-09-08T00:00:00.000Z', '新记录');
  const p = newProject('move', [newer, july, august, boundary, july]);
  const dir = path.dirname(p.board);
  const julyFile = path.join(dir, 'activity-202607.json');
  const augustFile = path.join(dir, 'activity-202608.json');
  // 归档里的旧任务引用不参与 board 内部引用校验。
  const historic = { ...item('2026-07-02T00:00:00.000Z', '旧任务档案'), taskId: 'OLD-TASK' };
  atomicWriteJsonSync(julyFile, [july, historic]);
  const original = readBoard(p.board);
  const size = fs.statSync(p.board).size;
  const beforeApi = await get('/api/board/move');
  const result = run(p.id, '2026-09');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.moved, 3);
  assert.deepEqual(report.files, [{ path: julyFile, count: 2 }, { path: augustFile, count: 1 }]);
  assert.match(report.text, /已归档 3 条/);
  const board = readBoard(p.board);
  assert.deepEqual(board.tasks, original.tasks);
  assert.deepEqual(board.activity, [newer, boundary]);
  assert.deepEqual(JSON.parse(fs.readFileSync(julyFile, 'utf8')), [july, historic]);
  assert.deepEqual(JSON.parse(fs.readFileSync(augustFile, 'utf8')), [august]);
  assert.equal(validate(board).ok, true);
  assert.ok(fs.statSync(p.board).size < size);
  const afterApi = await get('/api/board/move', beforeApi.etag);
  assert.notEqual(afterApi.etag, beforeApi.etag);
  assert.deepEqual(afterApi.body.activity, beforeApi.body.activity, '搬走后仍有完整历史');
  assert.deepEqual((await get('/api/board/move?fields=activity')).body.activity, beforeApi.body.activity);
  const page = await get('/api/activity/move?limit=2');
  const older = await get('/api/activity/move?limit=100&before=' + encodeURIComponent(page.body.nextBefore));
  assert.deepEqual([...page.body.items, ...older.body.items], [...beforeApi.body.activity].reverse());
  const files = [p.board, julyFile, augustFile, srv.reg];
  const saved = snapshot(files);
  const names = fs.readdirSync(dir).sort();
  const again = run(p.id, '2026-09');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).files, []);
  assert.equal(JSON.parse(again.stdout).moved, 0);
  assert.match(JSON.parse(again.stdout).text, /没有可归档/);
  assert.deepEqual(snapshot(files), saved, '字节和 mtime 都不变');
  assert.deepEqual(fs.readdirSync(dir).sort(), names, '不遗留锁或临时文件');
});

test('非默认时区同样使用本地月初，命令人读输出列出文件', () => {
  const old = item('2026-09-01T06:59:59.999Z', '洛杉矶八月末');
  const boundary = item('2026-09-01T07:00:00.000Z', '洛杉矶九月零点');
  const p = newProject('timezone', [old, boundary]);
  const result = run(p.id, '2026-09', false, 'America/Los_Angeles');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /已归档 1 条/);
  assert.match(result.stdout, /activity-202608\.json/);
  assert.deepEqual(readBoard(p.board).activity, [boundary]);
});

test('缺失或非法月份被拒绝；坏归档不改板、不先写其它月', () => {
  const p = newProject('invalid', [item('2026-07-01T12:00:00.000Z', '七月'), item('2026-08-01T12:00:00.000Z', '八月')]);
  const dir = path.dirname(p.board);
  const saved = snapshot([p.board]);
  for (const value of [undefined, '2026-00', '2026-13', '2026-9', 'bad']) {
    const result = run(p.id, value);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /YYYY-MM/);
    assert.deepEqual(snapshot([p.board]), saved);
  }
  const badFile = path.join(dir, 'activity-202608.json');
  atomicWriteJsonSync(badFile, { invalid: true });
  const result = run(p.id, '2026-09');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /JSON 数组/);
  assert.deepEqual(snapshot([p.board]), saved);
  assert.equal(fs.existsSync(path.join(dir, 'activity-202607.json')), false);
  assert.equal(fs.existsSync(p.lock), false);
});
