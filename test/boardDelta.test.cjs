'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const freePort = require('../scripts/free-port.cjs');
const { mutate } = require('../cli/store.cjs');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
const { versionOf, snapshotBoard, createVersionCache, makeDelta } = require('../core/boardDelta.cjs');

const board = () => ({ project: { id: 'demo' }, tasks: [{ id: 'T1', title: 'one' }, { id: 'T2', title: 'two' }], activity: [{ text: 'first' }] });
test('versions and bounded cache', () => {
  assert.match(versionOf('private/path'), /^[a-f0-9]{16}$/);
  const cache = createVersionCache();
  for (let i = 0; i < 9; i++) cache.set('demo', String(i), snapshotBoard(board()));
  assert.equal(cache.get('demo', '0'), undefined);
  assert.ok(cache.get('demo', '1'));
});
test('changed, added, deleted and reordered tasks with appended activity', () => {
  const old = board();
  const snapshot = snapshotBoard(old);
  const reordered = makeDelta(snapshot, { ...old, tasks: [...old.tasks].reverse() });
  assert.deepEqual(reordered.order, ['T2', 'T1']);
  assert.deepEqual(reordered.tasks, []);
  const deleted = makeDelta(snapshot, { ...old, tasks: [old.tasks[1]] });
  assert.deepEqual(deleted.order, ['T2']);
  assert.deepEqual(deleted.tasks, []);
  const added = makeDelta(snapshot, { ...old, tasks: [...old.tasks, { id: 'T3' }] });
  assert.deepEqual(added.tasks, [{ id: 'T3' }]);
  const next = { ...old, tasks: [{ id: 'T3' }, { ...old.tasks[0], title: 'changed' }], activity: [...old.activity, { text: 'last' }] };
  const delta = makeDelta(snapshotBoard(old), next);
  assert.deepEqual(delta.order, ['T3', 'T1']);
  assert.deepEqual(delta.tasks, next.tasks);
  assert.deepEqual(delta.activityAppend, [{ text: 'last' }]);
  assert.deepEqual(delta.rest, { project: { id: 'demo' } });
});
test('non-append activity cannot produce a delta', () => {
  const old = board();
  old.activity.push({ text: 'second' });
  const snapshot = snapshotBoard(old);
  for (const activity of [[{ text: 'inserted' }, ...old.activity], [old.activity[1], { text: 'last' }], [old.activity[1]], []]) {
    assert.equal(makeDelta(snapshot, { ...old, activity }), null);
  }
});

test('board endpoint and static cache policy', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'board-delta-')));
  const root = path.resolve(__dirname, '..');
  const registry = path.join(dir, 'registry.json');
  const file = path.join(dir, 'demo', '.dashboard', 'board.json');
  const dist = path.join(dir, 'dist');
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), 'index');
  fs.writeFileSync(path.join(dist, 'assets', 'index-Abc_1234.js'), 'asset');
  fs.writeFileSync(path.join(dist, 'assets', 'plain.js'), 'plain');
  fs.writeFileSync(path.join(dist, 'assets', '-Abc_1234.js'), 'plain');
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const path = require('node:path');
const original = ${JSON.stringify(path.join(root, 'web', 'dist'))}; const replacement = ${JSON.stringify(dist)};
for (const name of ['stat', 'createReadStream']) { const fn = fs[name]; fs[name] = function(file, ...args) { if (typeof file === 'string' && (file === original || file.startsWith(original + path.sep))) file = replacement + file.slice(original.length); return fn.call(this, file, ...args); }; }`);
  fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true });
  atomicWriteJsonSync(registry, { schemaVersion: '1.0', projects: { demo: { name: 'demo', mainRepo: path.dirname(path.dirname(file)), board: file } } });
  const project = { id: 'demo', name: 'demo', mainRepo: path.dirname(path.dirname(file)), board: file, lock: file + '.lock' };
  mutate(project, b => { b.tasks = [{ id: 'T1', title: 'one', status: '未开工', wave: 1 }, { id: 'T2', title: 'two', status: '未开工', wave: 1 }]; b.activity = []; });
  const port = await freePort();
  child = spawn(process.execPath, ['--require', preload, path.join(root, 'server', 'server.cjs')], {
    cwd: root, windowsHide: true, env: { ...process.env, DASHBOARD_HOME: dir, DASHBOARD_REGISTRY: registry, DASHBOARD_PORT: String(port), DASHBOARD_NO_OPEN: '1', DASHBOARD_EVENT_WEBHOOK: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('server startup timed out')), 15000);
    child.stdout.on('data', data => { output += data; const match = output.match(/http:\/\/[^\s/]+\//); if (match) { clearTimeout(timer); resolve(match[0].slice(0, -1)); } });
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); reject(new Error('server exited: ' + code)); });
  });
  const get = async query => { const res = await fetch(base + '/api/board/demo' + query); return { res, body: await res.json() }; };
  const first = await get('');
  const version = first.res.headers.get('x-board-version');
  assert.match(version, /^[a-f0-9]{16}$/);
  const unchanged = await get('?since=' + version);
  assert.deepEqual(unchanged.body, { ok: true, delta: true, unchanged: true });
  assert.equal(unchanged.res.headers.get('etag'), null);
  mutate(project, b => { b.tasks[0].title = 'changed'; });
  const changed = await get('?since=' + version);
  assert.equal(changed.body.base, version);
  assert.deepEqual(changed.body.order, ['T1', 'T2']);
  assert.deepEqual(changed.body.tasks.map(task => task.id), ['T1']);
  assert.ok(changed.body.rest.project);
  assert.equal(changed.res.headers.get('etag'), null);
  const nextVersion = changed.res.headers.get('x-board-version');
  mutate(project, b => { b.activity.push({ ts: '2026-01-01T00:00:00.000Z', text: 'new' }); });
  const added = await get('?since=' + nextVersion);
  assert.deepEqual(added.body.activityAppend.map(a => a.text), ['new']);
  const full = await get('');
  for (const since of ['bad', 'ffffffffffffffff']) {
    const fallback = await get('?since=' + since);
    assert.deepEqual(fallback.body, full.body);
    assert.equal(fallback.res.headers.get('etag'), full.res.headers.get('etag'));
  }
  for (const fields of ['tasks', 'activity']) {
    const plain = await get('?fields=' + fields);
    const withSince = await get('?fields=' + fields + '&since=' + version);
    assert.deepEqual(withSince.body, plain.body);
    assert.equal(withSince.res.headers.get('etag'), plain.res.headers.get('etag'));
    assert.match(withSince.res.headers.get('x-board-version'), /^[a-f0-9]{16}$/);
  }
  for (let i = 0; i < 10; i++) {
    mutate(project, b => { b.tasks[0].title = 'revision' + i; });
    await get('');
  }
  const evicted = await get('?since=' + version);
  assert.equal(evicted.body.delta, undefined);
  assert.deepEqual(evicted.body, (await get('')).body);
  for (const [route, expected] of [['/', 'no-store, no-cache, must-revalidate, max-age=0'], ['/assets/index-Abc_1234.js', 'public, max-age=31536000, immutable'], ['/assets/plain.js', 'no-cache, must-revalidate'], ['/assets/-Abc_1234.js', 'no-cache, must-revalidate']]) {
    const res = await fetch(base + route);
    assert.equal(res.headers.get('cache-control'), expected);
  }
});
