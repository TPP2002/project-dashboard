'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectIndex } = require('../core/projectIndex.cjs');

function fixture() {
  let meta = { mtimeMs: 1, size: 20 }, projects = { a: {}, b: {} }, failure;
  const calls = { reads: 0, resolved: [], logs: [] };
  const index = createProjectIndex({ registryPath: '/registry.json', fs: { promises: {
    stat: async () => { if (failure) throw failure; return meta; },
    readFile: async () => { calls.reads++; if (failure) throw failure; return JSON.stringify({ projects }); },
  } }, resolveProject: id => { calls.resolved.push(id); if (id === 'bad') throw Error('bad path'); return { id, board: '/' + id }; }, log: line => calls.logs.push(line) });
  return { index, calls, change: (next, nextMeta) => { projects = next; meta = nextMeta; }, fail: error => { failure = error; } };
}

test('unchanged registry skips reading and resolving; mtime or size change reparses', async () => {
  const f = fixture();
  assert.equal(await f.index.refresh(), true);
  assert.equal(await f.index.refresh(), false);
  assert.equal(f.calls.reads, 1);
  assert.deepEqual(f.calls.resolved, ['a', 'b']);
  assert.deepEqual(f.index.ids(), ['a', 'b']);
  f.change({ c: {} }, { mtimeMs: 1, size: 21 });
  assert.equal(await f.index.refresh(), true);
  assert.deepEqual(f.index.ids(), ['c']);
  assert.equal(f.index.get('a'), null);
  assert.equal(f.index.get('c').board, '/c');
  f.change({ d: {} }, { mtimeMs: 2, size: 21 });
  await f.index.refresh();
  assert.deepEqual(f.index.ids(), ['d']);
  assert.equal(f.calls.reads, 3);
});

test('one resolver failure is null and does not discard other projects', async () => {
  const f = fixture();
  f.change({ a: {}, bad: {}, b: {} }, { mtimeMs: 2, size: 40 });
  await f.index.refresh();
  assert.deepEqual(f.index.ids(), ['a', 'bad', 'b']);
  assert.equal(f.index.get('bad'), null);
  assert.equal(f.index.get('b').id, 'b');
  assert.equal(f.calls.logs.length, 1);
});

test('registry failure retains the previous snapshot and logs each error once', async () => {
  const f = fixture();
  await f.index.refresh();
  const before = f.index.snapshot();
  f.fail(Object.assign(Error('disk unavailable'), { code: 'EIO' }));
  await f.index.refresh();
  await f.index.refresh();
  assert.deepEqual(f.index.snapshot(), before);
  assert.deepEqual(f.index.ids(), ['a', 'b']);
  assert.equal(f.calls.logs.length, 1);
  f.fail(null);
  await f.index.refresh();
  f.fail(Error('disk unavailable'));
  await f.index.refresh();
  assert.equal(f.calls.logs.length, 2);
});

test('failed read or malformed JSON retains the old table and retries the changed registry', async () => {
  let meta = { mtimeMs: 1, size: 1 }, text = '{"projects":{"a":{}}}', failure = null;
  const index = createProjectIndex({ registryPath: '/registry', fs: { promises: {
    stat: async () => meta,
    readFile: async () => { if (failure) throw failure; return text; },
  } }, resolveProject: id => ({ id }), log() {} });
  await index.refresh();
  meta = { mtimeMs: 2, size: 2 };
  failure = Error('read failed');
  await index.refresh();
  assert.deepEqual(index.ids(), ['a']);
  failure = null;
  text = 'invalid JSON';
  await index.refresh();
  assert.deepEqual(index.ids(), ['a']);
  text = '{"projects":{"b":{}}}';
  await index.refresh();
  assert.deepEqual(index.ids(), ['b']);
});
