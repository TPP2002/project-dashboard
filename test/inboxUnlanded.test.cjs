'use strict';
// 临时 registry / board；历史未标数据也经 CLI 命令层建立，不手写 board.json。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');

const CLI = path.resolve(__dirname, '../cli/index.cjs');
const decision = (id, extra = {}) => ({
  id, question: `问题 ${id}`, options: ['A', 'B'], recommended: 'A',
  answer: 'A', decidedAt: '2026-01-01', ...extra,
});

function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-unlanded-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const reg = path.join(dir, 'registry.json');
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const { board } = cmds.register({ id: 't', name: '落地口径测试', root, registry: reg });
  const P = { project: 't', registry: reg };
  const add = (id, status, decisions) => {
    cmds.add({ _: [id], title: `任务 ${id}`, status, ...P });
    // 直接构造旧卡存量；不能用 done 建夹具，因为新版 done 已自动标记落地。
    cmds.set({ _: [id], field: 'decisions', value: JSON.stringify(decisions), ...P });
  };
  const run = (...args) => execFileSync(process.execPath, [CLI, 'inbox', '--project', 't', '--registry', reg, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, DASHBOARD_HOME: path.join(dir, 'home') },
  });
  return { add, run, board };
}

for (const status of ['已完工', '已作废']) {
  test(`inbox --tid 对${status}卡给出推定落地条数；列表态不再列出它`, (t) => {
    const { add, run, board } = setup(t);
    add('CLOSED-1', status, [decision('d1'), decision('d2', { landed: false }),
      decision('d3', { answer: null }), decision('d4', { landed: true })]);
    add('ACTIVE-1', '施工中', [decision('d1')]);
    const before = fs.readFileSync(board, 'utf8');
    const text = run('--tid', 'CLOSED-1');
    assert.match(text, new RegExp(`任务 CLOSED-1 ${status}，其 2 条未标记的拍板视为随卡落地，无需接手。`));
    assert.doesNotMatch(text, /claim CLOSED-1/);
    for (const args of [[], ['--all']]) {
      const list = run(...args);
      assert.match(list, /ACTIVE-1/);
      assert.match(list, /共 1 个/);
      assert.doesNotMatch(list, /CLOSED-1/);
    }
    assert.equal(fs.readFileSync(board, 'utf8'), before, '接单查询不得迁移历史数据');
  });
}

test('没有推定项时沿用原提示；只有终态存量时列表为空', (t) => {
  const { add, run } = setup(t);
  add('CLOSED-1', '已完工', [decision('d1')]);
  add('EMPTY-1', '已作废', [decision('d1', { landed: true }), decision('d2', { answer: null })]);
  assert.match(run(), /没有待落地任务/);
  const text = run('--tid', 'EMPTY-1');
  assert.match(text, /任务 EMPTY-1 没有待落地决策\(可能都已落地\)。无需接手。/);
  assert.doesNotMatch(text, /视为随卡落地/);
});

test('施工中卡仍可接手，只打包已答未标决策', (t) => {
  const { add, run } = setup(t);
  add('ACTIVE-1', '施工中', [decision('d1'), decision('d2', { landed: true })]);
  const text = run('--tid', 'ACTIVE-1');
  assert.match(text, /claim ACTIVE-1/);
  assert.match(text, /mark-landed ACTIVE-1 --did d1/);
  assert.doesNotMatch(text, /mark-landed ACTIVE-1 --did d2/);
});
