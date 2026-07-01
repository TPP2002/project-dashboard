'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { atomicWriteFileSync, atomicWriteJsonSync } = require('../core/atomicWrite.cjs');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-test-')); }

test('目标不存在时能创建', () => {
  const d = tmpDir(); const f = path.join(d, 'a.json');
  atomicWriteFileSync(f, 'hello');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'hello');
  fs.rmSync(d, { recursive: true, force: true });
});

test('目标已存在时覆盖成功（Windows rename 覆盖坑 R1）', () => {
  const d = tmpDir(); const f = path.join(d, 'a.json');
  atomicWriteFileSync(f, 'v1');
  atomicWriteFileSync(f, 'v2'); // 目标已存在 —— 裸 renameSync 在 Windows 会 EPERM
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'v2');
  fs.rmSync(d, { recursive: true, force: true });
});

test('连续覆盖 200 次，内容正确且无 .tmp 残留', () => {
  const d = tmpDir(); const f = path.join(d, 'b.json');
  for (let i = 0; i < 200; i++) atomicWriteJsonSync(f, { i });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { i: 199 });
  const leftovers = fs.readdirSync(d).filter((n) => n.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, [], `不应有残留 tmp: ${leftovers}`);
  fs.rmSync(d, { recursive: true, force: true });
});

test('atomicWriteJsonSync 带缩进和末尾换行', () => {
  const d = tmpDir(); const f = path.join(d, 'c.json');
  atomicWriteJsonSync(f, { a: 1 });
  const raw = fs.readFileSync(f, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.ok(raw.includes('\n  "a": 1'));
  fs.rmSync(d, { recursive: true, force: true });
});
