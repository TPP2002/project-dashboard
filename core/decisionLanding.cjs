'use strict';
/**
 * 决策落地口径的单一真相源（审计 §4-A6/B3，拍板 d3=A）。
 * 待落地 = 已答、未标 landed、所在卡非已完工/已作废；终态卡上的同类决策推定随卡落地。
 * 这里只读派生，不改历史数据；显式确认仍由 CLI mark-landed 写入。
 * CLI / server 直接 require，前端经 toEsmSource 注入 virtual:decision-landing，避免口径漂移。
 */
const { VOID_STATUSES } = require('./boardSchema.cjs');

const TERMINAL = new Set(['已完工', ...VOID_STATUSES]);

/** 只有 null / undefined 算未答，空字符串、false、0 都是已答。 */
function isAnswered(decision) {
  return !!decision && decision.answer !== null && decision.answer !== undefined;
}

function isTerminal(task) {
  return !!task && TERMINAL.has(task.status);
}

function isUnlanded(task, decision) {
  return isAnswered(decision) && !decision.landed && !isTerminal(task);
}

function isPresumedLanded(task, decision) {
  return isAnswered(decision) && !decision.landed && isTerminal(task);
}

/** 返回新数组，保留原决策顺序与对象；空任务或未登记决策时返回空数组。 */
function unlandedOf(task) {
  return ((task && task.decisions) || []).filter((decision) => isUnlanded(task, decision));
}

function presumedLandedOf(task) {
  return ((task && task.decisions) || []).filter((decision) => isPresumedLanded(task, decision));
}

/** 直接序列化同一份函数体，生成无 require 依赖的浏览器模块。 */
function toEsmSource() {
  const fns = [isAnswered, isTerminal, isUnlanded, isPresumedLanded, unlandedOf, presumedLandedOf];
  return [
    '// 由 core/decisionLanding.cjs 经 vite 虚拟模块内联生成，勿手改。',
    `const TERMINAL = new Set(${JSON.stringify([...TERMINAL])});`,
    ...fns.map((fn) => `export const ${fn.name} = ${String(fn)};`),
    '',
  ].join('\n');
}

module.exports = { isAnswered, isTerminal, isUnlanded, isPresumedLanded, unlandedOf, presumedLandedOf, toEsmSource };
