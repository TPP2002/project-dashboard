'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validate, emptyBoard, STATUS, emojiFor } = require('../core/boardSchema.cjs');

function baseBoard() {
  const b = emptyBoard({ id: 'game', name: 'A股', mainRepo: 'F:\\game' });
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
