'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validate } = require('../core/boardSchema.cjs');

test('演示 seed 在指定目录生成注册表与两块通过校验的示例板', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-seed-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.resolve(__dirname, '../packaging/demo-seed.cjs'), dir], {
    windowsHide: true, encoding: 'utf8', timeout: 15000,
  });
  const registryPath = path.join(dir, 'registry.json');
  assert.ok(fs.existsSync(registryPath));
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.deepEqual(Object.keys(registry.projects).sort(), ['blog', 'shopfast']);
  for (const [id, project] of Object.entries(registry.projects)) {
    const expected = path.join(dir, 'boards', `${id}.json`);
    assert.equal(project.board, expected, '示例板必须留在本次临时目录');
    assert.ok(fs.existsSync(expected));
    const board = JSON.parse(fs.readFileSync(expected, 'utf8'));
    assert.equal(board.project.id, id);
    assert.ok(board.tasks.length > 0);
    const result = validate(board);
    assert.equal(result.ok, true, result.errors.join('\n'));
  }
});
