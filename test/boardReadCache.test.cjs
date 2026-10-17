'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createBoardReadCache, DEFAULT_MAX_BYTES, DEFAULT_IDLE_MS } = require('../core/boardReadCache.cjs');
const { serverFixture } = require('../docs/plans/DASH-RESOURCE-1017/server-fixture.cjs');

test('entry and raw-byte limits, LRU touch, replacement accounting and oversize bypass', () => {
  const cache = createBoardReadCache({ maxEntries: 2, maxBytes: 10 });
  cache.set('a', { a: 1 }, 4); cache.set('b', { b: 1 }, 4);
  assert.deepEqual(cache.get('a'), { a: 1 }); cache.set('c', {}, 4);
  assert.equal(cache.get('b'), undefined); assert.equal(cache.size, 2); assert.equal(cache.weightBytes, 8);
  cache.set('a', { replaced: true }, 7);
  assert.equal(cache.get('c'), undefined); assert.equal(cache.weightBytes, 7); assert.equal(cache.size, 1);
  cache.set('a', { oversize: true }, 11);
  assert.equal(cache.get('a'), undefined); assert.equal(cache.weightBytes, 0);
  cache.set('boundary', {}, 10); assert.equal(cache.weightBytes, 10);
  cache.delete('boundary'); assert.equal(cache.weightBytes, 0); assert.equal(cache.delete('missing'), false);
  cache.set('x', {}, 1); cache.clear(); assert.equal(cache.size, 0); assert.equal(cache.weightBytes, 0);
  assert.equal(DEFAULT_MAX_BYTES, 16 * 1024 * 1024); assert.equal(DEFAULT_IDLE_MS, 600000);
});

test('idle expiration is based on last access, including get without a polling timer', () => {
  let now = 0;
  const cache = createBoardReadCache({ now: () => now, idleMs: 100 });
  cache.set('cold', {}, 1); cache.set('hot', {}, 2);
  now = 90; assert.ok(cache.get('hot'));
  now = 100; assert.equal(cache.sweep(), 1); assert.equal(cache.size, 1); assert.equal(cache.weightBytes, 2);
  now = 190; assert.equal(cache.get('hot'), undefined); assert.equal(cache.size, 0); assert.equal(cache.weightBytes, 0);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-read-cache-'));
  t.after(() => {
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('board-read-cache-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
  });
  return { dir, ...serverFixture(dir) };
}
function writeBoard(dir, id, text = 'one') {
  const home = path.join(dir, id); fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'board.json');
  fs.writeFileSync(file, JSON.stringify({ project: {}, tasks: [{ id, status: '施工中', percent: 10 }], activity: [{ ts: '2026-10-17T00:00:00.000Z', taskId: id, text }] }));
  return file;
}

test('actual server uses 50/64 entry caps, complete reads, replacement, failure and deletion semantics', t => {
  const f = fixture(t);
  const boards = [];
  for (let i = 0; i < 70; i++) {
    const file = writeBoard(f.dir, String(i)); boards.push(file);
    fs.writeFileSync(path.join(path.dirname(file), 'activity-202601.json'), JSON.stringify([{ ts: '2026-01-01T00:00:00.000Z', text: 'archive' }]));
    f.readSummaryCached(file); f.readMergedBoard(file, f.activitySnapshot(file));
  }
  assert.equal(f.summaryCache.size, 50); assert.equal(f.mergedBoardCache.size, 50); assert.equal(f.archiveCache.size, 64);
  const file = boards.at(-1), archive = path.join(path.dirname(file), 'activity-202601.json');
  const board = JSON.parse(fs.readFileSync(file, 'utf8')); board.tasks[0].status = '已完工'; board.activity[0].text = 'new and longer';
  fs.writeFileSync(file, JSON.stringify(board));
  assert.equal(f.readSummaryCached(file).progress, 100);
  assert.equal(f.readMergedBoard(file, f.activitySnapshot(file)).activity.at(-1).text, 'new and longer');
  fs.writeFileSync(archive, '{bad archive');
  assert.throws(() => f.readMergedBoard(file, f.activitySnapshot(file)), /JSON|Unexpected|property/);
  fs.writeFileSync(archive, '{}');
  assert.throws(() => f.readMergedBoard(file, f.activitySnapshot(file)), /归档应为 JSON 数组/);
  fs.unlinkSync(archive);
  assert.equal(f.readMergedBoard(file, f.activitySnapshot(file)).activity.length, 1);
  fs.writeFileSync(file, '{broken board'); assert.throws(() => f.readSummaryCached(file));
  fs.unlinkSync(file); assert.equal(f.readSummaryCached(file), null); assert.equal(f.activitySnapshot(file), null);
});

test('oversize actual board/archive are still returned whole and never retained', t => {
  const f = fixture(t), file = writeBoard(f.dir, 'big');
  const big = 'x'.repeat(DEFAULT_MAX_BYTES + 1);
  fs.writeFileSync(file, JSON.stringify({ project: {}, tasks: [], activity: [{ ts: '2026-10-17T00:00:00Z', text: big }] }));
  assert.ok(f.readSummaryCached(file));
  assert.equal(f.readMergedBoard(file, f.activitySnapshot(file)).activity[0].text.length, big.length);
  assert.equal(f.summaryCache.size, 0); assert.equal(f.mergedBoardCache.size, 0);
  const archive = path.join(path.dirname(file), 'activity-202601.json');
  fs.writeFileSync(archive, JSON.stringify([{ ts: '2026-01-01T00:00:00Z', text: big }]));
  assert.equal(f.readMergedBoard(file, f.activitySnapshot(file)).activity.length, 2);
  assert.equal(f.archiveCache.size, 0); assert.equal(f.archiveCache.weightBytes, 0);
});

test('actual server caches obey aggregate raw-byte budgets below the entry caps', t => {
  const f = fixture(t), padding = 'x'.repeat(2 * 1024 * 1024);
  for (let i = 0; i < 10; i++) {
    const file = writeBoard(f.dir, `weighted-${i}`, padding);
    fs.writeFileSync(path.join(path.dirname(file), 'activity-202601.json'), JSON.stringify([{ ts: '2026-01-01T00:00:00Z', text: padding }]));
    f.readSummaryCached(file); f.readMergedBoard(file, f.activitySnapshot(file));
  }
  for (const cache of [f.summaryCache, f.archiveCache, f.mergedBoardCache]) {
    assert.ok(cache.size > 0 && cache.size < 10, 'byte budget evicts before entry limit');
    assert.ok(cache.weightBytes <= DEFAULT_MAX_BYTES);
  }
});

test('existing server poll reclaims idle caches; close clears all three intervals and caches', t => {
  const f = fixture(t), file = writeBoard(f.dir, 'idle');
  fs.writeFileSync(path.join(path.dirname(file), 'activity-202601.json'), '[]');
  f.readSummaryCached(file); f.readMergedBoard(file, f.activitySnapshot(file));
  f.startIntervals(); assert.equal(f.intervals.size, 3, 'no extra resident interval');
  f.advance(DEFAULT_IDLE_MS + 1); f.poll();
  assert.equal(f.summaryCache.size, 0); assert.equal(f.mergedBoardCache.size, 0); assert.equal(f.archiveCache.size, 0);
  f.readSummaryCached(file); f.readMergedBoard(file, f.activitySnapshot(file));
  f.server.emit('close');
  assert.equal(f.intervals.size, 0);
  for (const cache of [f.summaryCache, f.archiveCache, f.mergedBoardCache]) {
    assert.equal(cache.size, 0); assert.equal(cache.weightBytes, 0);
  }
});
