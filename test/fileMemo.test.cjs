'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileMemo } = require('../core/fileMemo.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('sync checks all fingerprint fields, failures and changes during load', () => {
  let fingerprint = { size: 2, mtimeMs: 1, ctimeMs: 1 }, calls = 0;
  const io = { statSync() { if (!fingerprint) throw new Error('missing'); return { ...fingerprint }; } };
  const memo = createFileMemo({ fs: io });
  const load = () => ({ n: ++calls, nested: { value: 1 } });
  const first = memo.sync('f', 'k', load);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.nested));
  assert.equal(memo.sync('f', 'k', load), first);
  for (const key of ['size', 'mtimeMs', 'ctimeMs']) {
    fingerprint[key]++;
    memo.sync('f', 'k', load);
  }
  assert.equal(calls, 4);
  fingerprint = null;
  memo.sync('f', 'k', load);
  memo.sync('f', 'k', load);
  fingerprint = { size: 3, mtimeMs: 2, ctimeMs: 2 };
  assert.equal(memo.sync('f', 'k', load).n, 7);
  fingerprint.size++;
  assert.throws(() => memo.sync('f', 'k', () => { throw new Error('boom'); }), /boom/);
  assert.equal(memo.sync('f', 'k', load).n, 8);
  fingerprint.size++;
  memo.sync('f', 'k', () => { fingerprint.ctimeMs++; return ++calls; });
  assert.equal(memo.sync('f', 'k', load).n, 10);
  assert.equal(memo.stats().loadsByKey.k, 11);
});

test('missing files are memoized until they appear or disappear', (t) => {
  const root = fixture(t), file = path.join(root, 'file');
  const memo = createFileMemo();
  let calls = 0;
  const load = () => { calls++; try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  assert.equal(memo.sync(file, 'missing', load), null);
  assert.equal(memo.sync(file, 'missing', load), null);
  assert.equal(calls, 1);
  fs.writeFileSync(file, 'hello');
  assert.equal(memo.sync(file, 'missing', load), 'hello');
  assert.equal(calls, 2);
  fs.unlinkSync(file);
  assert.equal(memo.sync(file, 'missing', load), null);
  assert.equal(calls, 3);
});

test('same-size replacement invalidates and async errors are never cached', async (t) => {
  const root = fixture(t), file = path.join(root, 'file');
  fs.writeFileSync(file, 'aaaa');
  const memo = createFileMemo();
  const load = () => fs.readFileSync(file, 'utf8');
  assert.equal(memo.sync(file, 'text', load), 'aaaa');
  const before = fs.statSync(file);
  fs.writeFileSync(file, 'bbbb');
  fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
  assert.equal(memo.sync(file, 'text', load), 'bbbb');
  let attempts = 0;
  const fail = async () => { attempts++; throw new Error('read failure'); };
  await assert.rejects(memo.async(file, 'failure', fail), /read failure/);
  await assert.rejects(memo.async(file, 'failure', fail), /read failure/);
  assert.equal(attempts, 2);
});

test('async deduplicates and LRU evicts the least recently used', async () => {
  const memo = createFileMemo({ fs: { statSync: () => ({ size: 1, mtimeMs: 1, ctimeMs: 1 }) }, maxEntries: 2 });
  let calls = 0, release;
  const load = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  const a = memo.async('a', 'k', load, { persist: false });
  const b = memo.async('a', 'k', load, { persist: false });
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ nested: [1] });
  assert.deepEqual(await a, await b);
  assert.ok(Object.isFrozen((await a).nested));
  memo.sync('b', 'k', () => 2);
  memo.sync('a', 'k', () => 9);
  memo.sync('c', 'k', () => 3);
  assert.equal(memo.sync('b', 'k', () => 4), 4);
  assert.equal(memo.stats().entries, 2);
});

test('persisted entries survive restart, malformed cache is empty and missing files are removed', async (t) => {
  const root = fixture(t), file = path.join(root, 'log'), cache = path.join(root, 'memo.json');
  fs.writeFileSync(file, 'first');
  const memo = createFileMemo({ persistPath: cache, persistDelayMs: 60000 });
  await memo.async(file, 'exec-summary@1', async () => ({ nested: [1] }), { persist: true });
  memo.flush();
  const next = createFileMemo({ persistPath: cache });
  assert.deepEqual(await next.async(file, 'exec-summary@1', () => { throw new Error('unexpected'); }, { persist: true }), { nested: [1] });
  fs.unlinkSync(file);
  await next.async(file, 'exec-summary@1', async () => null, { persist: true });
  next.flush();
  assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).entries['exec-summary@1']?.[file], undefined);
  fs.writeFileSync(file, 'other');
  fs.writeFileSync(cache, '{bad');
  const broken = createFileMemo({ persistPath: cache });
  let calls = 0;
  assert.equal(await broken.async(file, 'exec-summary@1', async () => ++calls, { persist: true }), 1);
  assert.equal(calls, 1);
});

test('a cache hit requested with persistence is written and invalid schema is ignored', async (t) => {
  const root = fixture(t), file = path.join(root, 'data'), cache = path.join(root, 'memo.json');
  fs.writeFileSync(file, 'data');
  fs.writeFileSync(cache, JSON.stringify({ schemaVersion: 99, entries: {} }));
  const memo = createFileMemo({ persistPath: cache });
  let calls = 0;
  assert.equal(await memo.async(file, 'key', async () => ++calls), 1);
  assert.equal(await memo.async(file, 'key', async () => ++calls, { persist: true }), 1);
  memo.flush();
  const again = createFileMemo({ persistPath: cache });
  assert.equal(await again.async(file, 'key', async () => ++calls, { persist: true }), 1);
  assert.equal(calls, 1);
});

test('delayed persistence writes and repeated write failures warn only once', async (t) => {
  const root = fixture(t), file = path.join(root, 'data'), cache = path.join(root, 'memo.json');
  fs.writeFileSync(file, 'data');
  const memo = createFileMemo({ persistPath: cache, persistDelayMs: 10 });
  await memo.async(file, 'key', async () => ({ ok: true }), { persist: true });
  assert.equal(fs.existsSync(cache), false);
  for (let i = 0; i < 100 && !fs.existsSync(cache); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).schemaVersion, 1);
  const original = console.warn;
  let warnings = 0;
  console.warn = () => { warnings++; };
  try {
    const bad = createFileMemo({ persistPath: path.join(root, 'absent', 'memo.json') });
    await bad.async(file, 'key', async () => 1, { persist: true });
    assert.doesNotThrow(() => bad.flush());
    assert.doesNotThrow(() => bad.flush());
    assert.equal(warnings, 1);
  } finally { console.warn = original; }
});
