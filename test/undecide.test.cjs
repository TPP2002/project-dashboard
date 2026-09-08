'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '../cli/index.cjs');
const TASK = 'FRESH-1';

function setup(t, status = '已拍板', fields = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'undecide-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const env = { ...process.env, DASHBOARD_HOME: dir, DASHBOARD_REGISTRY: registry,
    DASHBOARD_GLOBAL_SETTINGS: path.join(dir, 'global-settings.json'), DASHBOARD_SKIP_SERVICE_PROBE: '1' };
  const run = args => spawnSync(process.execPath, [CLI, ...args, '--project', 'fresh', '--registry', registry, '--json'], {
    cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  const ok = args => {
    const result = run(args);
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return JSON.parse(result.stdout);
  };
  ok(['register', '--id', 'fresh', '--name', '撤销拍板测试', '--root', root]);
  ok(['add', TASK, '--title', '撤销的状态与留痕', '--plain-title', '拍错的答案可以及时撤销', '--model', '测试', '--status', status]);
  const decision = { id: 'd1', question: '采用哪个方案？', options: ['A', 'B'], recommended: 'A',
    answer: 'A', decidedAt: '2026-09-08', decidedBy: '负责人', context: '保留的问题背景', ...fields };
  const other = { id: 'd2', question: '另一条决策', options: ['C'], recommended: 'C', answer: 'C', decidedAt: '2026-09-08' };
  // 夹具也通过 CLI 写板，保持与实际写入路径相同的校验和留痕。
  ok(['set', TASK, '--field', 'decisions', '--value', JSON.stringify([decision, other])]);
  ok(['set', TASK, '--field', 'percent', '--value', '45']);
  const board = path.join(root, '.dashboard', 'board.json');
  return { run, ok, board, other, read: () => JSON.parse(fs.readFileSync(board, 'utf8')) };
}

test('撤销清空答案、日期与拍板人，已拍板卡退回待拍板，JSON 只给真实变更摘要', t => {
  const { ok, read, other } = setup(t);
  const result = ok(['undecide', TASK, '--did', 'd1']);
  assert.deepEqual(result, { ok: true, id: TASK, status: '待拍板', percent: 45, changed: ['decisions', 'status'] });
  const saved = read().tasks[0];
  const decision = saved.decisions[0];
  assert.equal(decision.answer, null);
  assert.equal(decision.decidedAt, null);
  assert.equal(Object.hasOwn(decision, 'decidedBy'), false);
  assert.equal(decision.context, '保留的问题背景');
  assert.deepEqual(saved.decisions[1], other);
  assert.equal(saved.status, '待拍板');
  assert.equal(saved.percent, 45);
});

test('施工中卡撤销只清答案，施工状态与进度保持不变', t => {
  const { ok, read } = setup(t, '施工中');
  assert.deepEqual(ok(['undecide', TASK, '--did', 'd1']), {
    ok: true, id: TASK, status: '施工中', percent: 45, changed: ['decisions'],
  });
  assert.equal(read().tasks[0].decisions[0].answer, null);
  assert.equal(read().tasks[0].status, '施工中');
  assert.equal(read().tasks[0].percent, 45);
});

test('已落地拒绝撤销并提示查看落地情况，失败不改板也不追加活动', t => {
  const { run, board } = setup(t, '已拍板', { landed: true, landedAt: '2026-09-08', landedCommit: 'abcdef1' });
  const before = fs.readFileSync(board, 'utf8');
  const result = run(['undecide', TASK, '--did', 'd1']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /已落地.*先查看落地情况/);
  assert.equal(fs.readFileSync(board, 'utf8'), before);
});

test('未答决策拒绝，包括历史记录中缺失 answer 的情况', t => {
  for (const answer of [null, undefined]) {
    const { run, board } = setup(t, '待拍板', { answer, decidedAt: null });
    const before = fs.readFileSync(board, 'utf8');
    const result = run(['undecide', TASK, '--did', 'd1']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /尚未拍板/);
    assert.equal(fs.readFileSync(board, 'utf8'), before);
  }
});

test('不存在的卡、决策与缺失参数均拒绝，不产生部分写入', t => {
  const { run, board } = setup(t);
  const before = fs.readFileSync(board, 'utf8');
  for (const args of [
    ['undecide', TASK, '--did', 'd99'], ['undecide', 'MISSING-1', '--did', 'd1'], ['undecide', TASK],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /不存在|缺参数/);
    assert.equal(fs.readFileSync(board, 'utf8'), before);
  }
});

test('撤销活动保留精确时间、卡号、署名与可选理由，并允许重新拍板', t => {
  const { ok, read } = setup(t, '已拍板', { decidedAt: '2000-01-01' });
  const count = read().activity.length;
  ok(['undecide', TASK, '--did', 'd1', '--reason', '需要重新核对', '--author', '审阅人']);
  const first = read().activity.at(-1);
  assert.equal(read().activity.length, count + 1);
  assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(first, { ts: first.ts, type: 'undecide', author: '审阅人', taskId: TASK, text: `撤销拍板 ${TASK}·d1：需要重新核对` });
  ok(['decide', TASK, '--did', 'd1', '--answer', 'B']);
  assert.equal(read().tasks[0].status, '已拍板');
  assert.equal(read().tasks[0].decisions[0].answer, 'B');
  ok(['undecide', TASK, '--did', 'd1']);
  const second = read().activity.at(-1);
  assert.equal(second.author, '看板');
  assert.equal(second.text, `撤销拍板 ${TASK}·d1`);
  assert.equal(read().activity.filter(entry => entry.type === 'undecide').length, 2);
});
