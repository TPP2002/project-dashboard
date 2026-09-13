'use strict';
/** 施工方只取数据里的短标识；缺字段、空白或非字符串都归未标注，不猜平台。 */
function normalizeEngine(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const records = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
const compareEngines = (a, b) => a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

/** 筛选值加标签，避免未来的平台标识与“全部”或“未标注”碰撞；空值仍表示全部。 */
function engineFilterValue(value) {
  const engine = normalizeEngine(value);
  return engine === null ? 'missing:' : `engine:${engine}`;
}
function matchesEngine(value, filter) {
  return !filter || engineFilterValue(value) === filter;
}
function engineOptions(tickets) {
  const engines = new Set(records(tickets).map(ticket => normalizeEngine(ticket.engine)));
  return [...engines].sort(compareEngines).map(engine => ({ value: engineFilterValue(engine), label: engine ?? '未标注' }));
}

/**
 * 已知外派单提供窗口名单，结束的单只保留空组；窗口内容仍取 registerOnly 在跑快照。
 * 有效标识不做平台白名单，未来的新标识直接成组；无有效标识的单留在原外派单窗口（engine 为 null）。
 */
function groupExternalTickets(activeTickets, knownTickets = activeTickets) {
  const groups = new Map();
  function groupFor(ticket) {
    const engine = normalizeEngine(ticket.engine);
    if (!groups.has(engine)) groups.set(engine, { engine, tickets: [] });
    return groups.get(engine);
  }
  for (const ticket of records(knownTickets)) if (ticket.registerOnly === true) groupFor(ticket);
  for (const ticket of records(activeTickets)) {
    if (ticket.registerOnly === true && ticket.state === 'running') groupFor(ticket).tickets.push(ticket);
  }
  return [...groups.values()].sort((a, b) => compareEngines(a.engine, b.engine));
}

module.exports = { normalizeEngine, engineFilterValue, matchesEngine, engineOptions, groupExternalTickets };
