'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validate, emptyBoard, STATUS, emojiFor } = require('../core/boardSchema.cjs');

function baseBoard() {
  const b = emptyBoard({ id: 'game', name: '示例项目·模拟器', mainRepo: 'F:\\app-repo' });
  b.tasks.push({
    id: 'P01', title: 'R9挂单改价', status: '已完工', wave: 0, percent: 100,
    dates: { design: '2026-06-02', start: '2026-06-03', done: '2026-06-09' },
    gitBranch: ['stock-r14-21'], prNumbers: [24], commitShas: ['a1b2c3d'],
    decisions: [{ id: 'd1', question: '改价保留时间戳?', options: ['保留', '刷新'], recommended: '刷新', answer: '刷新', decidedAt: '2026-06-04' }],
    deps: { dependsOn: [], blockedBy: [], relatedTasks: [] },
  });
  return b;
}

test('合法 board 通过', () => {
  const { ok, errors } = validate(baseBoard());
  assert.strictEqual(ok, true, errors.join('\n'));
});

test('非法 status 被拒', () => {
  const b = baseBoard(); b.tasks[0].status = '瞎写';
  const { ok, errors } = validate(b);
  assert.strictEqual(ok, false);
  assert.ok(errors.some((e) => e.includes('status')));
});

test('缺必填 title 被拒', () => {
  const b = baseBoard(); delete b.tasks[0].title;
  assert.strictEqual(validate(b).ok, false);
});

test('answer 不在 options 中被拒', () => {
  const b = baseBoard(); b.tasks[0].decisions[0].answer = '第三个';
  const { ok, errors } = validate(b);
  assert.strictEqual(ok, false);
  assert.ok(errors.some((e) => e.includes('options')));
});

test('依赖引用不存在的 task 被拒', () => {
  const b = baseBoard(); b.tasks[0].deps.dependsOn = ['P99'];
  const { ok, errors } = validate(b);
  assert.strictEqual(ok, false);
  assert.ok(errors.some((e) => e.includes('P99')));
});

test('重复 id 被拒', () => {
  const b = baseBoard(); b.tasks.push({ ...b.tasks[0] });
  assert.strictEqual(validate(b).ok, false);
});

test('activity.taskId 引用不存在被拒', () => {
  const b = baseBoard();
  b.activity.push({ ts: new Date().toISOString(), author: 'x', type: 'note', text: 'hi', taskId: 'P77' });
  assert.strictEqual(validate(b).ok, false);
});

test('emptyBoard 自身合法', () => {
  assert.strictEqual(validate(emptyBoard({ id: 'p', name: 'P' })).ok, true);
});

test('emojiFor 覆盖所有 status', () => {
  for (const s of STATUS) assert.ok(typeof emojiFor(s) === 'string' && emojiFor(s).length > 0);
});

// ---------------------------------------------------------------------------
// 已作废（审计 §4-C1）：10 个状态里没有「取消」，被否掉的卡只能一直挂着假装还要做。
// 新增枚举后要保证：状态本身合法、STATUS_EMOJI 有显式条目（不许靠 emojiFor 的兜底 ⬜
// 蒙混——那样终端里作废卡跟未开工卡长得一模一样）。
// ---------------------------------------------------------------------------

test('已作废是合法 status', () => {
  const b = baseBoard(); b.tasks[0].status = '已作废';
  const { ok, errors } = validate(b);
  assert.strictEqual(ok, true, errors.join('\n'));
});

test('STATUS_EMOJI 每个状态都有显式条目（不靠 emojiFor 兜底）', () => {
  const { STATUS_EMOJI } = require('../core/boardSchema.cjs');
  for (const s of STATUS) {
    assert.ok(Object.prototype.hasOwnProperty.call(STATUS_EMOJI, s), `STATUS_EMOJI 缺「${s}」`);
  }
});

test('VOID_STATUSES 是完成度分母的排除口径（CLI/server/INDEX 共用一份）', () => {
  const { VOID_STATUSES } = require('../core/boardSchema.cjs');
  assert.ok(Array.isArray(VOID_STATUSES) && VOID_STATUSES.includes('已作废'));
  for (const s of VOID_STATUSES) assert.ok(STATUS.includes(s), `VOID_STATUSES 里的「${s}」不在 STATUS 枚举内`);
});
