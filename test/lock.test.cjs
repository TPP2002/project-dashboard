'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withLock, isStaleLock } = require('../core/lock.cjs');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-')); }

test('withLock 执行 fn 并返回值，用后清理锁', () => {
  const d = tmpDir(); const lock = path.join(d, 'x.lock');
  const r = withLock(lock, () => 42);
  assert.strictEqual(r, 42);
  assert.strictEqual(fs.existsSync(lock), false, '锁应被清理');
  fs.rmSync(d, { recursive: true, force: true });
});

test('陈旧锁（pid 不存在）可被抢占', () => {
  const d = tmpDir(); const lock = path.join(d, 'y.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 30, ts: Date.now() })); // 不存在的 pid
  assert.strictEqual(isStaleLock(lock), true);
  assert.strictEqual(withLock(lock, () => 'ok', { retries: 5 }), 'ok');
  fs.rmSync(d, { recursive: true, force: true });
});

test('异常时锁也被释放', () => {
  const d = tmpDir(); const lock = path.join(d, 'z.lock');
  assert.throws(() => withLock(lock, () => { throw new Error('boom'); }));
  assert.strictEqual(fs.existsSync(lock), false, '异常后锁应被清理');
  fs.rmSync(d, { recursive: true, force: true });
});

test('活着的持有者未超时时不算陈旧', () => {
  const d = tmpDir(); const lock = path.join(d, 'w.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  assert.strictEqual(isStaleLock(lock), false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('Windows 待删除锁文件报 EPERM/EACCES 时退避重试而不是报错', () => {
  const d = tmpDir(); const lock = path.join(d, 'w.lock');
  const real = fs.openSync;
  let calls = 0;
  fs.openSync = (p, flags, ...rest) => {
    if (p === lock && calls++ < 2) throw Object.assign(new Error('EPERM: operation not permitted'), { code: calls === 1 ? 'EPERM' : 'EACCES' });
    return real.call(fs, p, flags, ...rest);
  };
  try {
    assert.strictEqual(withLock(lock, () => 'ok', { retries: 5, baseMs: 1 }), 'ok');
    assert.strictEqual(calls, 3, '前两次瞬时错误后第三次拿到锁');
  } finally { fs.openSync = real; fs.rmSync(d, { recursive: true, force: true }); }
});

test('其他打开错误照旧立即抛出', () => {
  const d = tmpDir(); const lock = path.join(d, 'v.lock');
  const real = fs.openSync;
  fs.openSync = (p, ...rest) => { if (p === lock) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); return real.call(fs, p, ...rest); };
  try { assert.throws(() => withLock(lock, () => 'x', { retries: 5, baseMs: 1 }), /ENOSPC/); }
  finally { fs.openSync = real; fs.rmSync(d, { recursive: true, force: true }); }
});
