'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const c = require('../core/schedContract.cjs');
const { readLedger } = require('../core/schedLedger.cjs');
const { createVerifiedBytesCache } = require('../core/schedVerifiedBytes.cjs');
const { temporary, initialize, AT } = require('./fixtures/sched/support.cjs');

function fixture(t) {
  const share = temporary(t), paths = initialize(share), dir = path.join(paths.root, 'ledger');
  fs.mkdirSync(dir);
  const file = path.join(dir, '2026-09-12.jsonl');
  function save(seq = 1, extra = {}, target = file) {
    const payload = { v: 1, seq, at: AT, type: 'fixture', data: {}, ...extra };
    fs.writeFileSync(target, JSON.stringify({ ...payload, sha256: c.contentHash(payload) }) + '\n');
  }
  save(); return { share, dir, file, save };
}

test('未改变账本复用已校验事件；返回对象保持独立', t => {
  const f = fixture(t), original = c.contentHash;
  let calls = 0;
  c.contentHash = (...args) => { calls++; return original(...args); };
  t.after(() => { c.contentHash = original; });
  const first = readLedger(f.share);
  assert.equal(first.readable, true);
  first.events[0].data.changedByConsumer = true;
  const second = readLedger(f.share);
  assert.equal(second.events[0].data.changedByConsumer, undefined);
  assert.equal(calls, 1);
});

test('追加坏数据仍校验，新值、截断、替换、删除和读取失败不会命中旧验证', t => {
  const f = fixture(t);
  assert.equal(readLedger(f.share).readable, true);
  const stat = fs.statSync(f.file), before = fs.readFileSync(f.file, 'utf8');
  fs.writeFileSync(f.file, before + '{');
  fs.utimesSync(f.file, stat.atime, stat.mtime);
  assert.equal(readLedger(f.share).readable, false);
  f.save(2); assert.equal(readLedger(f.share).events[0].seq, 2);
  fs.writeFileSync(f.file, before.slice(0, -5)); assert.equal(readLedger(f.share).readable, false);
  f.save(3, {}, f.file + '.replacement'); fs.renameSync(f.file + '.replacement', f.file);
  assert.equal(readLedger(f.share).events[0].seq, 3);
  fs.unlinkSync(f.file); assert.deepEqual(readLedger(f.share).events, []);
  fs.mkdirSync(f.file); assert.equal(readLedger(f.share).readable, false);
});

test('新增/跨日/轮转均检查跨文件序号；删除前文件不把旧错误或旧事件留住', t => {
  const f = fixture(t);
  assert.equal(readLedger(f.share).readable, true);
  const next = path.join(f.dir, '2026-09-13.jsonl');
  f.save(2, {}, next); assert.deepEqual(readLedger(f.share).events.map(e => e.seq), [1, 2]);
  f.save(3); fs.unlinkSync(next); assert.equal(readLedger(f.share).events[0].seq, 3);
  f.save(2, {}, next); assert.equal(readLedger(f.share).readable, false);
  fs.unlinkSync(f.file); assert.deepEqual(readLedger(f.share).events.map(e => e.seq), [2]);
  fs.renameSync(next, f.file); assert.deepEqual(readLedger(f.share).events.map(e => e.seq), [2]);
});

test('验证缓存按字节与文件数量双上限淘汰，切换共享根或移除文件立即回收', () => {
  const cache = createVerifiedBytesCache({ maxBytes: 64, maxFiles: 2 });
  cache.begin('one', ['a', 'b', 'c']);
  cache.remember('a', Buffer.from('aa')); cache.remember('b', Buffer.from('bb'));
  assert.equal(cache.has('a', Buffer.from('aa')), true);
  cache.remember('c', Buffer.from('cc'));
  assert.equal(cache.has('b', Buffer.from('bb')), false);
  assert.deepEqual(cache.stats(), { files: 2, bytes: 64, maxFiles: 2, maxBytes: 64 });
  cache.begin('one', ['a']); assert.equal(cache.stats().files, 1);
  cache.begin('two', ['a']); assert.equal(cache.stats().bytes, 0);
  const tiny = createVerifiedBytesCache({ maxBytes: 32, maxFiles: 2 });
  tiny.begin('one', ['a', 'b']); tiny.remember('a', Buffer.from('a')); tiny.remember('b', Buffer.from('b'));
  assert.equal(tiny.stats().files, 1);
  assert.equal(tiny.has('a', Buffer.from('a')), false);
});
