'use strict';
// ADD-MODEL-GATE(0901 负责人拍板):CLI 命令行建卡必须带 --model 建议档位,缺了拒收并打印路由表速查。
// 闸位=index.cjs 入口层(只拦命令行);内部编程调用 cmds.add(importCmd 历史导入/测试搭环境)不受影响。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');

const INDEX = path.join(__dirname, '..', 'cli', 'index.cjs');

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'amg-')));
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

test('CLI add 缺 --model → 拒收,报错含路由表速查', () => {
  const { dir, reg, board } = setup();
  const r = cli(reg, 'add', 'T1', '--project', 't', '--title', 'x');
  assert.notEqual(r.code, 0, '缺 --model 应拒收,实际 code=' + r.code);
  assert.match(r.out, /--model/, '报错应指明缺 --model');
  assert.match(r.out, /sonnet·低.*opus·中.*fable·高/s, '报错应含路由表速查(三档各一例)');
  const b = JSON.parse(fs.readFileSync(board, 'utf8'));
  assert.equal((b.tasks || []).length, 0, '拒收时不应建卡');
  clean(dir);
});

test('CLI add 裸 --model(无值)→ 同样拒收', () => {
  const { dir, reg, board } = setup();
  const r = cli(reg, 'add', 'T1', '--project', 't', '--title', 'x', '--model');
  assert.notEqual(r.code, 0);
  const b = JSON.parse(fs.readFileSync(board, 'utf8'));
  assert.equal((b.tasks || []).length, 0);
  clean(dir);
});

test('CLI add 带 --model 与 --plain-title → 建卡成功且徽章落库', () => {
  const { dir, reg, board } = setup();
  const r = cli(reg, 'add', 'T1', '--project', 't', '--title', 'x', '--model', 'sonnet·低', '--plain-title', 'ph');
  assert.equal(r.code, 0, '带 --model 应成功,输出:' + r.out);
  const b = JSON.parse(fs.readFileSync(board, 'utf8'));
  assert.equal(b.tasks[0].modelHint, 'sonnet·低');
  clean(dir);
});

test('内部编程调用 cmds.add 不带 model → 不受闸影响(importCmd/测试搭环境依赖此口)', () => {
  const { dir, reg } = setup();
  const r = cmds.add({ _: ['T1'], title: 'x', project: 't', registry: reg });
  assert.equal(r.ok, true);
  clean(dir);
});
