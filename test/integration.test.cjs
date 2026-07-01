'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cmds = require('../cli/commands.cjs');
const { importCmd } = require('../cli/importCmd.cjs');
const { renderIndex } = require('../cli/renderIndex.cjs');
const { snapshot } = require('../cli/snapshot.cjs');

function boot() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'int-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  cmds.register({ id: 'g', name: 'A股', root, registry: reg });
  return { dir, P: { project: 'g', registry: reg } };
}
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('端到端 import → 认领改状态 → render-index（人工段保留）', () => {
  const { dir, P } = boot();
  const idx = path.join(dir, 'INDEX.md');
  fs.writeFileSync(idx, [
    '## 一、核实结论总表', '',
    '| # | 方案 | 核实结论 | 一句话现状 |',
    '|---|---|---|---|',
    '| P01 | [a](P01.md) | ✅ 已完工（stock-r14-1） | done |',
    '| P02 | [b](P02.md) | ✅ 真实待开工 | todo |',
    '', '## 二、别的',
  ].join('\n'));
  assert.equal(importCmd({ ...P, from: idx }).count, 2);
  cmds.claim({ _: ['P02'], branch: 'br', ...P });
  const outIdx = path.join(dir, 'OUT.md');
  fs.writeFileSync(outIdx, '# T\n\n<!--dashboard:status:begin -->\nold\n<!--dashboard:status:end-->\n\n## 人工\nKEEP_ME\n');
  renderIndex({ ...P, index: outIdx });
  const md = fs.readFileSync(outIdx, 'utf8');
  assert.ok(md.includes('| P01 |'), '含 P01 行');
  assert.ok(md.includes('施工中'), 'P02 认领后为施工中');
  assert.ok(md.includes('KEEP_ME'), '人工段保留');
  clean(dir);
});

test('snapshot 导出 board 到 git 外目录', () => {
  const { dir, P } = boot();
  cmds.add({ _: ['P01'], title: 'x', ...P });
  const r = snapshot({ ...P, out: path.join(dir, 'snaps'), stamp: '2026-07-01T00-00-00' });
  assert.ok(fs.existsSync(r.path));
  assert.equal(JSON.parse(fs.readFileSync(r.path, 'utf8')).tasks.length, 1);
  clean(dir);
});

test('onboard 一键：import 骨架 + 波次补丁一步到位', () => {
  const { dir, P } = boot();
  const idx = path.join(dir, 'INDEX.md');
  fs.writeFileSync(idx, [
    '## 一、核实结论总表', '',
    '| # | 方案 | 核实结论 | 一句话现状 |', '|---|---|---|---|',
    '| P07 | [a](P07.md) | ✅ 已完工（stock-r14-37） | x |',
    '| P08 | [b](P08.md) | ✅ 已完工（stock-r14-37） | y |',
    '', '## 二',
  ].join('\n'));
  const patch = path.join(dir, 'patch.json');
  fs.writeFileSync(patch, JSON.stringify({ P07: { wave: 1, 'deps.relatedTasks': ['P08'] }, P08: { wave: 1 } }));
  const { onboard } = require('../cli/onboard.cjs');
  assert.ok(onboard({ ...P, from: idx, patch, 'no-git': true }).text.includes('import'));
  const t = JSON.parse(cmds.show({ _: ['P07'], ...P }).text);
  assert.equal(t.wave, 1);
  assert.deepEqual(t.deps.relatedTasks, ['P08']);
  clean(dir);
});
