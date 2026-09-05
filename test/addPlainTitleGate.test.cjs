'use strict';
// CLI-ADD-NO-PLAINTITLE-FILESCOPE:CLI 命令行建卡必须带 --plain-title 人话标题,缺了拒收
// (仿 ADD-MODEL-GATE 先例)。同时补 add 对 --plain-title / --scope 的实际落库行为——
// 此前 add 传 --plain-title 会被静默吞掉(不报错、字段不写),fileScope 只能靠 claim 补,
// 建卡的人不看源码根本不知道。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');

const INDEX = path.join(__dirname, '..', 'cli', 'index.cjs');

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apg-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  cmds.register({ id: 't', name: 'd', root, registry: reg });
  return { dir, reg, board: path.join(root, '.dashboard', 'board.json') };
}
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 偶发句柄滞留 */ } };

/** 跑真 CLI 入口,返回 {code, out} */
function cli(reg, ...args) {
  try {
    const out = execFileSync('node', [INDEX, ...args, '--registry', reg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

test('CLI add 带 --model 但缺 --plain-title → 拒收,报错提示 --plain-title', () => {
  const { dir, reg, board } = setup();
  const r = cli(reg, 'add', 'T1', '--project', 't', '--title', 'x', '--model', 'sonnet·低');
  assert.notEqual(r.code, 0, '缺 --plain-title 应拒收,实际 code=' + r.code);
  assert.match(r.out, /--plain-title/, '报错应指明缺 --plain-title');
  const b = JSON.parse(fs.readFileSync(board, 'utf8'));
  assert.equal((b.tasks || []).length, 0, '拒收时不应建卡');
  clean(dir);
});

test('CLI add 裸 --plain-title(无值)→ 同样拒收', () => {
  const { dir, reg, board } = setup();
  const r = cli(reg, 'add', 'T1', '--project', 't', '--title', 'x', '--model', 'sonnet·低', '--plain-title');
  assert.notEqual(r.code, 0);
  const b = JSON.parse(fs.readFileSync(board, 'utf8'));
  assert.equal((b.tasks || []).length, 0);
  clean(dir);
});

test('CLI add 带 --model 与 --plain-title → 建卡成功且 plainTitle 落库(不再静默吞掉)', () => {
  const { dir, reg, board } = setup();
  const r = cli(reg, 'add', 'T1', '--project', 't', '--title', '技术详细说明', '--model', 'sonnet·低',
    '--plain-title', '负责人看得懂的一句话');
  assert.equal(r.code, 0, '带齐三件套应成功,输出:' + r.out);
  const b = JSON.parse(fs.readFileSync(board, 'utf8'));
  assert.equal(b.tasks[0].plainTitle, '负责人看得懂的一句话');
  clean(dir);
});

test('CLI add 带 --scope(可重复)→ fileScope 落库,不必等 claim 才补', () => {
  const { dir, reg, board } = setup();
  const r = cli(reg, 'add', 'T1', '--project', 't', '--title', 'x', '--model', 'sonnet·低',
    '--plain-title', 'ph', '--scope', 'src/a/**', '--scope', 'src/b/**');
  assert.equal(r.code, 0, r.out);
  const b = JSON.parse(fs.readFileSync(board, 'utf8'));
  assert.deepEqual(b.tasks[0].fileScope, ['src/a/**', 'src/b/**']);
  clean(dir);
});

test('内部编程调用 cmds.add 不带 plain-title → 不受闸影响(importCmd/测试搭环境依赖此口)', () => {
  const { dir, reg } = setup();
  const r = cmds.add({ _: ['T1'], title: 'x', project: 't', registry: reg });
  assert.equal(r.ok, true);
  clean(dir);
});
