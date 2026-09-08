'use strict';
// 独立服务 + 临时注册表；读盘观察器只计数，所有读取仍调用真实 fs。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { atomicWriteFileSync, atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
const { mutate, readBoard } = require('../cli/store.cjs');
const freePort = require('../scripts/free-port.cjs');

const ROOT = path.resolve(__dirname, '..');
let srv;

function startServer(env, preload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', preload, path.join(ROOT, 'server/server.cjs')], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
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

function readCounts() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { srv.child.off('message', receive); reject(new Error('读取计数超时')); }, 3000);
    function receive(message) { clearTimeout(timer); resolve(message.reads); }
    srv.child.once('message', receive);
    srv.child.send('reads');
  });
}

before(async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'api-slim-')));
  const reg = path.join(dir, 'registry.json');
  const preload = path.join(dir, 'observe-reads.cjs');
  srv = { dir, reg };
  atomicWriteJsonSync(reg, { schemaVersion: '1.0', projects: {} });
  atomicWriteFileSync(preload, [
    "const fs = require('node:fs');",
    'const reads = {}; const read = fs.readFileSync;',
    'fs.readFileSync = function(file, ...args) {',
    "  if (typeof file === 'string' && /(?:board|activity-\\d{6})\\.json$/.test(file)) reads[file] = (reads[file] || 0) + 1;",
    '  return read.call(this, file, ...args);',
    '};',
    "process.on('message', (msg) => { if (msg === 'reads') process.send({ reads }); });",
  ].join('\n'));
  Object.assign(srv, await startServer({ DASHBOARD_REGISTRY: reg, DASHBOARD_HOME: dir, DASHBOARD_PORT: String(await freePort()) }, preload));
});

after(async () => {
  if (!srv) return;
  await stopServer(srv.child);
  fs.rmSync(srv.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const activity = (day, text = '活动' + day) => ({ ts: '2026-08-' + String(day).padStart(2, '0') + 'T12:00:00.000Z', taskId: 'T1', type: 'note', text });
function newProject(id, items = [activity(3), activity(1), activity(2)]) {
  const root = path.join(srv.dir, id);
  const board = path.join(root, '.dashboard', 'board.json');
  fs.mkdirSync(root, { recursive: true });
  const reg = JSON.parse(fs.readFileSync(srv.reg, 'utf8'));
  reg.projects[id] = { name: id, mainRepo: root, board, color: '#112233', icon: 'chart' };
  atomicWriteJsonSync(srv.reg, reg);
  const proj = { id, name: id, mainRepo: root, board, lock: board + '.lock' };
  mutate(proj, (b) => {
    b.tasks = [
      { id: 'T1', title: '完整任务一', status: '施工中', wave: 1, percent: 40, docs: ['notes.md'] },
      { id: 'T2', title: '完整任务二', status: '未开工', wave: 2, percent: 0 },
    ];
    b.activity = items;
  });
  return proj;
}
async function get(route, etag) {
  const res = await fetch(srv.base + route, { headers: etag ? { 'If-None-Match': etag } : {} });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get('etag'), text, body: text ? JSON.parse(text) : null };
}

test('fields 保留完整任务，activityLimit 在排序后截最新条目且不改变默认缓存', async () => {
  const p = newProject('fields');
  const tasks = await get('/api/board/fields?fields=tasks&activityLimit=2');
  assert.equal(tasks.status, 200);
  assert.deepEqual(tasks.body.tasks, readBoard(p.board).tasks);
  assert.deepEqual(tasks.body.activity, []);
  const limited = await get('/api/board/fields?fields=all&activityLimit=2');
  assert.deepEqual(limited.body.activity, [activity(2), activity(3)]);
  const acts = await get('/api/board/fields?fields=activity');
  assert.deepEqual(acts.body.tasks, []);
  assert.deepEqual(acts.body.activity, [activity(1), activity(2), activity(3)]);
  for (const suffix of ['', '?activityLimit=0', '?activityLimit=-1', '?activityLimit=1.5', '?activityLimit=bad']) {
    assert.equal((await get('/api/board/fields' + suffix)).body.activity.length, 3);
  }
});

test('分页排他 before、倒序、默认值与上限、空页游标', async () => {
  newProject('pages');
  const first = await get('/api/activity/pages?limit=2');
  assert.equal(first.body.ok, true);
  assert.deepEqual(first.body.items, [activity(3), activity(2)]);
  assert.equal(first.body.nextBefore, activity(2).ts);
  const second = await get('/api/activity/pages?limit=2&before=' + encodeURIComponent(first.body.nextBefore));
  assert.deepEqual(second.body.items, [activity(1)]);
  assert.equal(second.body.nextBefore, activity(1).ts);
  const empty = await get('/api/activity/pages?before=' + encodeURIComponent(second.body.nextBefore));
  assert.deepEqual(empty.body, { ok: true, items: [], nextBefore: null });
  assert.equal((await get('/api/activity/pages?before=bad')).status, 400);
  assert.equal((await get('/api/activity/missing')).status, 404);
  const many = Array.from({ length: 1005 }, (_, i) => ({ ...activity(1), ts: new Date(Date.UTC(2026, 7, 1) + i * 1000).toISOString(), text: String(i) }));
  newProject('many', many);
  assert.equal((await get('/api/activity/many')).body.items.length, 100);
  assert.equal((await get('/api/activity/many?limit=2000')).body.items.length, 1000);
  assert.equal((await get('/api/activity/many?limit=-1')).body.items.length, 100);
});

test('两条接口 ETag 命中时 304、空体且不读取板/归档；板更新使 ETag 改变', async () => {
  const p = newProject('etag');
  const archive = path.join(path.dirname(p.board), 'activity-202607.json');
  atomicWriteJsonSync(archive, [activity(1, '归档记录')]);
  for (const route of ['/api/board/etag?fields=tasks', '/api/board/etag?fields=all&activityLimit=2', '/api/activity/etag?limit=2']) {
    const first = await get(route);
    assert.match(first.etag, /^W\/"[a-f0-9]{16}"$/);
    const counts = await readCounts();
    const second = await get(route, first.etag);
    assert.equal(second.status, 304);
    assert.equal(second.text, '');
    assert.equal(second.etag, first.etag);
    const nextCounts = await readCounts();
    assert.equal(nextCounts[p.board], counts[p.board]);
    assert.equal(nextCounts[archive], counts[archive]);
    mutate(p, (b) => { b.tasks[0].title += '更新'; b.activity.push(activity(4, route)); });
    const changed = await get(route, first.etag);
    assert.equal(changed.status, 200);
    assert.notEqual(changed.etag, first.etag);
  }
  const a = await get('/api/board/etag?fields=tasks');
  assert.equal((await get('/api/board/etag?fields=all', a.etag)).status, 200, '不同查询不共用标签');
});

test('默认/all/activity 均合并归档去重；合并缓存和归档缓存避免重复解析', async () => {
  const p = newProject('merged');
  const file = path.join(path.dirname(p.board), 'activity-202607.json');
  const old = { ...activity(1, '旧活动'), ts: '2026-07-01T12:00:00.000Z' };
  atomicWriteJsonSync(file, [activity(1), old]);
  const first = await get('/api/board/merged');
  assert.deepEqual(first.body.activity, [old, activity(1), activity(2), activity(3)]);
  const counts = await readCounts();
  assert.deepEqual((await get('/api/board/merged?fields=activity')).body.activity, first.body.activity);
  assert.deepEqual((await get('/api/activity/merged?limit=1000')).body.items, [...first.body.activity].reverse());
  assert.equal((await get('/api/board/merged?activityLimit=2')).body.activity.length, 2);
  const cached = await readCounts();
  assert.equal(cached[p.board], counts[p.board]);
  assert.equal(cached[file], counts[file]);
  mutate(p, (b) => { b.tasks[0].title += '有变'; });
  const boardChanged = await get('/api/board/merged');
  assert.equal((await readCounts())[file], cached[file], '只变板时复用未变归档');
  const stamp = fs.statSync(file);
  fs.utimesSync(file, stamp.atime, new Date(stamp.mtimeMs + 2000));
  const touched = await get('/api/board/merged', boardChanged.etag);
  assert.equal(touched.status, 200);
  assert.notEqual(touched.etag, boardChanged.etag);
  assert.equal((await readCounts())[file], cached[file] + 1, 'mtime 变化重读归档');
  const page = await get('/api/activity/merged');
  atomicWriteJsonSync(file, [old, activity(4, '新归档内容')]);
  const changed = await get('/api/activity/merged', page.etag);
  assert.equal(changed.status, 200);
  assert.notEqual(changed.etag, page.etag);
  assert.equal(changed.body.items[0].text, '新归档内容');
  assert.equal((await get('/api/board/merged')).body.activity.at(-1).text, '新归档内容');
  fs.unlinkSync(file);
  const removed = await get('/api/board/merged', touched.etag);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.activity.length, 3);
});

test('项目摘要缓存保持结果与 color/icon，板变化后更新摘要', async () => {
  const p = newProject('summary');
  const first = await get('/api/projects');
  const counts = await readCounts();
  const second = await get('/api/projects');
  assert.deepEqual(second.body, first.body);
  assert.equal((await readCounts())[p.board], counts[p.board], '缓存命中不重新解析板');
  mutate(p, (b) => { b.tasks[0].status = '已完工'; b.activity.push(activity(5)); });
  const changed = await get('/api/projects');
  const entry = changed.body.projects.find((project) => project.id === p.id);
  assert.equal(entry.color, '#112233'); assert.equal(entry.icon, 'chart');
  assert.equal(entry.summary.total, 2);
  assert.equal(entry.summary.byStatus['已完工'], 1);
  assert.equal(entry.summary.progress, 50);
  assert.equal(entry.summary.lastActivityTs, activity(5).ts);
  assert.equal((await readCounts())[p.board], counts[p.board] + 1);
});
