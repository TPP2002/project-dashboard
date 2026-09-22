'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');

test('真实 CLI：开销闸失败与 collect 保留下一步，默认 done 删除下一步', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-milestone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = path.join(dir, 'registry.json'), flags = { project: 'fixture', registry, _: ['T1'] };
  cmds.register({ id: 'fixture', name: 'fixture', root: dir, registry });
  cmds.add({ ...flags, title: 'fixture' });
  cmds.progress({ ...flags, percent: 60, next: '等测试结论' });
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, '.dashboard/board.json'), 'utf8')).tasks[0];
  const cli = (...args) => spawnSync(process.execPath, [path.resolve(__dirname, '../cli/index.cjs'), 'done', 'T1',
    '--project', 'fixture', '--registry', registry, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(cli().status, 1);
  assert.equal(read().nextMilestone, '等测试结论');
  assert.equal(cli('--collect').status, 0);
  assert.equal(read().nextMilestone, '等测试结论');
  cmds.cost({ ...flags, agents: 'fixture:1', unknown: '测试夹具不产生计费' });
  assert.equal(cli().status, 0);
  assert.equal(read().status, '已完工');
  assert.equal(Object.hasOwn(read(), 'nextMilestone'), false);
});
