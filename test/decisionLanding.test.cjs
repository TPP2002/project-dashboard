'use strict';
// 审计 §4-A6/B3、拍板 d3：终态卡的已答未标决策只能推定落地，不能再派单。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const landing = require('../core/decisionLanding.cjs');
const { VOID_STATUSES } = require('../core/boardSchema.cjs');

const FUNCTIONS = ['isAnswered', 'isTerminal', 'isUnlanded', 'isPresumedLanded', 'unlandedOf', 'presumedLandedOf'];
const STATUSES = ['施工中', '未开工', '暂缓', '收官', '已完工', ...VOID_STATUSES];

test('isAnswered 仅排除 null / undefined，不把空字符串、零或 false 当成未答', () => {
  for (const decision of [null, undefined, {}, { answer: null }, { answer: undefined }]) {
    assert.equal(landing.isAnswered(decision), false);
  }
  for (const answer of ['A', '', 0, false]) {
    assert.equal(landing.isAnswered({ answer }), true);
  }
});

test('已答/未答、已标/未标与终态/非终态的组合互斥且覆盖完整', () => {
  for (const status of STATUSES) {
    const task = { status };
    const terminal = status === '已完工' || VOID_STATUSES.includes(status);
    assert.equal(landing.isTerminal(task), terminal, status);
    for (const answer of [null, undefined, 'A', '', 0, false]) {
      for (const landed of [undefined, null, false, true]) {
        const decision = { answer, landed };
        const needsMark = answer !== null && answer !== undefined && !landed;
        const label = JSON.stringify({ status, answer, landed });
        assert.equal(landing.isUnlanded(task, decision), needsMark && !terminal, label);
        assert.equal(landing.isPresumedLanded(task, decision), needsMark && terminal, label);
      }
    }
  }
  assert.equal(landing.isTerminal(null), false);
  assert.equal(landing.isTerminal(undefined), false);
  assert.equal(landing.isTerminal({}), false);
});

test('任务聚合保留原顺序和对象，不改历史数据；缺决策时返回空数组', () => {
  const decisions = Object.freeze([
    Object.freeze({ id: 'd1', answer: 'A' }),
    Object.freeze({ id: 'd2', answer: null }),
    Object.freeze({ id: 'd3', answer: 'B', landed: true }),
    Object.freeze({ id: 'd4', answer: '', landed: false }),
    Object.freeze({ id: 'd5' }),
  ]);
  for (const status of STATUSES) {
    const task = Object.freeze({ status, decisions });
    const terminal = status === '已完工' || VOID_STATUSES.includes(status);
    assert.deepEqual(landing.unlandedOf(task), terminal ? [] : [decisions[0], decisions[3]]);
    assert.deepEqual(landing.presumedLandedOf(task), terminal ? [decisions[0], decisions[3]] : []);
    const selected = terminal ? landing.presumedLandedOf(task) : landing.unlandedOf(task);
    assert.notEqual(selected, decisions);
    assert.equal(selected[0], decisions[0]);
    assert.equal(decisions[0].landed, undefined);
  }
  for (const task of [null, undefined, {}, { decisions: [] }]) {
    assert.deepEqual(landing.unlandedOf(task), []);
    assert.deepEqual(landing.presumedLandedOf(task), []);
  }
});

test('toEsmSource 可在 vm 载入，六个同名函数与 CJS 判据逐项一致', () => {
  const source = landing.toEsmSource();
  for (const name of FUNCTIONS) assert.match(source, new RegExp(`export const ${name} =`));
  assert.doesNotMatch(source, /require\(|module\.exports/);
  // vm.Script 不解析 export；仅去掉导出前缀，函数体与常量原样在独立上下文执行。
  const esm = vm.runInNewContext(source.replace(/^export const /gm, 'const ') + `\n({ ${FUNCTIONS.join(', ')} })`);
  for (const name of FUNCTIONS) assert.equal(typeof esm[name], 'function', name);
  for (const status of STATUSES) {
    const decisions = [{ answer: 'A' }, { answer: null }, {}, { answer: 'B', landed: true }, { answer: '', landed: false }];
    const task = { status, decisions };
    assert.equal(esm.isTerminal(task), landing.isTerminal(task));
    for (const decision of decisions) {
      assert.equal(esm.isAnswered(decision), landing.isAnswered(decision));
      assert.equal(esm.isUnlanded(task, decision), landing.isUnlanded(task, decision));
      assert.equal(esm.isPresumedLanded(task, decision), landing.isPresumedLanded(task, decision));
    }
    assert.deepEqual(Array.from(esm.unlandedOf(task)), landing.unlandedOf(task));
    assert.deepEqual(Array.from(esm.presumedLandedOf(task)), landing.presumedLandedOf(task));
  }
});

test('生成源码也是合法 ESM，真实导出六个约定函数', async () => {
  const source = Buffer.from(landing.toEsmSource()).toString('base64');
  const esm = await import(`data:text/javascript;base64,${source}`);
  assert.deepEqual(Object.keys(esm).sort(), [...FUNCTIONS].sort());
  const task = { status: '已完工', decisions: [{ answer: 'A' }] };
  assert.equal(esm.isPresumedLanded(task, task.decisions[0]), true);
  assert.equal(esm.unlandedOf(task).length, 0);
});
