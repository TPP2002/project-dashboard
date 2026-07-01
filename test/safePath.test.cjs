'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { normalizeReal, resolveInsideRoot } = require('../core/safePath.cjs');

function realTmp(prefix) { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }

test('正常相对路径解析进 root 内', () => {
  const d = realTmp('sp-');
  fs.mkdirSync(path.join(d, 'docs'));
  fs.writeFileSync(path.join(d, 'docs', 'a.md'), 'x');
  assert.strictEqual(resolveInsideRoot(d, 'docs/a.md'), path.join(d, 'docs', 'a.md'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('../ 逃逸返回 null（不被 startsWith 骗过）', () => {
  const d = realTmp('sp-');
  assert.strictEqual(resolveInsideRoot(d, '../secret.txt'), null);
  assert.strictEqual(resolveInsideRoot(d, '..\\secret.txt'), null);
  assert.strictEqual(resolveInsideRoot(d, 'a/../../secret'), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('前缀伪装 root-evil 不被放行', () => {
  const base = realTmp('sp-');
  const root = path.join(base, 'game'); fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, 'game-evil'));
  fs.writeFileSync(path.join(base, 'game-evil', 's.txt'), 'x');
  assert.strictEqual(resolveInsideRoot(root, '../game-evil/s.txt'), null);
  fs.rmSync(base, { recursive: true, force: true });
});

test('含 NUL 或非字符串返回 null', () => {
  const d = os.tmpdir();
  assert.strictEqual(resolveInsideRoot(d, 'a\0b'), null);
  assert.strictEqual(resolveInsideRoot(d, 123), null);
});

test('junction 逃逸被挡（有权限造 junction 时）', () => {
  const base = realTmp('sp-');
  const root = path.join(base, 'root'); fs.mkdirSync(root);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  let made = false;
  try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); made = true; }
  catch { /* 无权限造 junction，跳过该断言 */ }
  if (made) {
    assert.strictEqual(resolveInsideRoot(root, 'link/secret.txt'), null, 'junction 逃逸必须被挡');
  }
  fs.rmSync(base, { recursive: true, force: true });
});
