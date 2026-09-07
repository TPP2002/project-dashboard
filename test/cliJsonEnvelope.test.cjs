'use strict';
/**
 * AUD-CLI-BRIEF-AND-HELP · 写命令 --json 只回变更摘要(审计 §4-A4)。
 * 病根:`--json` 成功时回吐整个 task 对象——技术说明、全部决策、全部提交号一次全给,
 * 而调用方要的只是"成了没、现在什么状态、动了哪些字段"。
 * changed[] 由锁内前后快照比对得出,不是各命令自报——自报会跟真实行为漂移。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { diffTask } = require('../core/taskDiff.cjs');

const CLI = path.join(__dirname, '..', 'cli', 'index.cjs');
const SPEC = '很长很长的技术说明'.repeat(60);

function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jsonenv-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  run(['register', '--id', 't', '--name', '示例项目', '--root', root, '--registry', reg]);
  return { dir, reg };
}
function run(args, opts) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, ...opts });
}
function json(args, reg) {
  const r = run([...args, '--registry', reg, '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim());
}

const ENVELOPE = ['ok', 'id', 'status', 'percent', 'changed'];

test('写命令 --json 只有五个键,一个不多', (t) => {
  const { reg } = setup(t);
  const added = json(['add', 'FEAT-12', '--project', 't', '--title', SPEC,
    '--plain-title', '一句人话', '--model', 'opus·中'], reg);
  assert.deepEqual(Object.keys(added).sort(), [...ENVELOPE].sort());
  assert.equal(added.id, 'FEAT-12');
  assert.equal(added.ok, true);
  assert.ok(!JSON.stringify(added).includes(SPEC), '技术说明绝不能跟着回来');
});

test('changed[] 反映真实改了哪些字段(不是命令自己声明的)', (t) => {
  const { reg } = setup(t);
  json(['add', 'FEAT-12', '--project', 't', '--title', 'x', '--plain-title', '人话', '--model', 'o'], reg);

  const claimed = json(['claim', 'FEAT-12', '--project', 't', '--branch', 'feat/x'], reg);
  assert.equal(claimed.status, '施工中');
  assert.ok(claimed.changed.includes('status'), 'claim 改了状态');
  assert.ok(claimed.changed.includes('gitBranch'), 'claim 登记了分支');
  assert.ok(claimed.changed.includes('dates.start'), '点路径要下钻到 dates.start');

  const prog = json(['progress', 'FEAT-12', '--project', 't', '--percent', '60', '--next', '下一步'], reg);
  assert.equal(prog.percent, 60);
  assert.deepEqual(prog.changed.filter((k) => k === 'status'), [], '只报进度没改状态');
  assert.ok(prog.changed.includes('percent') && prog.changed.includes('nextMilestone'));

  const fin = json(['done', 'FEAT-12', '--project', 't', '--pr', '42', '--commit', 'a1b2c3d'], reg);
  assert.equal(fin.status, '已完工');
  for (const k of ['status', 'percent', 'dates.done', 'prNumbers', 'commitShas']) {
    assert.ok(fin.changed.includes(k), `done 应报改了 ${k}，实为 ${fin.changed.join(',')}`);
  }
});

test('新建卡的 changed 报 created(此前不存在,没有"改了哪些字段"可言)', (t) => {
  const { reg } = setup(t);
  const added = json(['add', 'FEAT-12', '--project', 't', '--title', 'x', '--plain-title', '人话', '--model', 'o'], reg);
  assert.deepEqual(added.changed, ['created']);
});

test('什么都没改时 changed 为空数组(不假装动过)', (t) => {
  const { reg } = setup(t);
  json(['add', 'FEAT-12', '--project', 't', '--title', 'x', '--plain-title', '人话', '--model', 'o'], reg);
  json(['block', 'FEAT-12', '--project', 't', '--by', 'FEAT-12'], reg); // 自己挡自己:第一次会写进去
  const again = json(['block', 'FEAT-12', '--project', 't', '--by', 'FEAT-12'], reg);
  assert.deepEqual(again.changed, [], '重复登记同一条依赖,字段没变就该报空');
});

test('--json 的体量远小于整卡回吐(旧口径)', (t) => {
  const { reg, dir } = setup(t);
  json(['add', 'FEAT-12', '--project', 't', '--title', SPEC, '--plain-title', '人话', '--model', 'o'], reg);
  const envelope = run(['claim', 'FEAT-12', '--project', 't', '--branch', 'feat/x', '--registry', reg, '--json']).stdout.trim();
  const board = JSON.parse(fs.readFileSync(path.join(dir, 'repo', '.dashboard', 'board.json'), 'utf8'));
  const legacy = JSON.stringify({ ok: true, task: board.tasks[0] });
  assert.ok(envelope.length / legacy.length <= 0.2,
    `信封应降到整卡的 20% 以内,实为 ${(envelope.length / legacy.length * 100).toFixed(1)}%`);
});

test('没有卡的写命令(note)照旧能用,不被信封吃掉', (t) => {
  const { reg } = setup(t);
  json(['add', 'FEAT-12', '--project', 't', '--title', 'x', '--plain-title', '人话', '--model', 'o'], reg);
  const r = json(['note', 'FEAT-12', '--project', 't', '--text', '一句留言'], reg);
  assert.equal(r.ok, true);
  assert.equal(r.taskId, 'FEAT-12');
});

test('只读命令 --json 不受影响(list 还是给它的文本)', (t) => {
  const { reg } = setup(t);
  json(['add', 'FEAT-12', '--project', 't', '--title', 'x', '--plain-title', '人话', '--model', 'o'], reg);
  const r = json(['list', '--project', 't'], reg);
  assert.ok(r.text.includes('FEAT-12'));
});

test('diffTask 本身:一级点路径、数组整体、新建与空改动', () => {
  assert.deepEqual(diffTask(null, { id: 'A' }), ['created']);
  assert.deepEqual(diffTask({ id: 'A' }, null), ['removed']);
  assert.deepEqual(diffTask({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(diffTask({ a: 1 }, { a: 2 }), ['a']);
  assert.deepEqual(diffTask({ d: { x: 1, y: 2 } }, { d: { x: 1, y: 3 } }), ['d.y']);
  assert.deepEqual(diffTask({ arr: [1] }, { arr: [1, 2] }), ['arr']);
  assert.deepEqual(diffTask({}, { n: 1 }), ['n'], '新增字段也算改动');
  assert.deepEqual(diffTask({ n: 1 }, {}), ['n'], '删掉字段也算改动');
});
