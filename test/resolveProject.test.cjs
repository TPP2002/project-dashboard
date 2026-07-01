'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolveProject } = require('../core/resolveProject.cjs');

test('resolveProject 解析注册项目（board 默认落 <root>/.dashboard）', () => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')));
  const reg = path.join(d, 'registry.json');
  const repo = path.join(d, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: { game: { name: 'A股', mainRepo: repo } } }));
  const r = resolveProject('game', { registryPath: reg });
  assert.strictEqual(r.mainRepo, repo);
  assert.strictEqual(r.board, path.join(repo, '.dashboard', 'board.json'));
  assert.strictEqual(r.lock, r.board + '.lock');
  fs.rmSync(d, { recursive: true, force: true });
});

test('未注册项目报错', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  const reg = path.join(d, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  assert.throws(() => resolveProject('nope', { registryPath: reg }), /未注册/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('缺 --project 报错（禁 cwd 猜）', () => {
  assert.throws(() => resolveProject('', {}), /--project/);
});
