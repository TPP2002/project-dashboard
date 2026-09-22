'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { refreshDocsIndex } = require('../cli/docsIndexRefresh.cjs');
const { precheck } = require('../cli/precheck.cjs');
const cmds = require('../cli/commands.cjs');

function fixture(t, script, deps = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs index '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: script ? { 'docs:index': script } : {} }));
  if (deps) fs.mkdirSync(path.join(dir, 'node_modules'));
  return dir;
}
test('没脚本或没依赖就不启动命令', t => {
  for (const dir of [fixture(t, null), fixture(t, 'node index.cjs', false)]) {
    assert.equal(refreshDocsIndex(dir, { run: () => assert.fail('不得开跑') }).status, 'skipped');
  }
});
test('真实 npm run docs:index 在指定含空格工位写出文档', t => {
  const dir = fixture(t, 'node index.cjs');
  fs.writeFileSync(path.join(dir, 'index.cjs'), "require('fs').writeFileSync('map.md', 'updated')");
  assert.equal(refreshDocsIndex(dir).status, 'refreshed');
  assert.equal(fs.readFileSync(path.join(dir, 'map.md'), 'utf8'), 'updated');
});
test('脚本失败、坏 package 只提醒，precheck 仍成功', t => {
  const dir = fixture(t, 'node -e "process.exit(7)"');
  const warning = refreshDocsIndex(dir);
  assert.equal(warning.status, 'warning');
  assert.match(warning.text, /docs:index.*失败/);
  const registry = path.join(dir, 'registry.json');
  cmds.register({ id: 'fixture', name: 'fixture', root: dir, registry });
  const result = precheck({ project: 'fixture', registry, repo: dir, 'no-fetch': true });
  assert.equal(result.ok, true);
  assert.match(result.text, /docs:index.*失败/);
  fs.writeFileSync(path.join(dir, 'package.json'), '{bad');
  assert.equal(refreshDocsIndex(dir).status, 'warning');
});
