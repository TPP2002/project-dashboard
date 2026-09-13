'use strict';
/** 调度共享盘只读投影。任何必需文件/目录读坏都整次失败，不能伪装为空队列。 */
const fs = require('node:fs');
const path = require('node:path');
const c = require('./schedContract.cjs');
const { readLedger, connectedProjects } = require('./schedLedger.cjs');
const { estimateTickets } = require('./schedEstimates.cjs');
const { ticketCsv } = require('./schedCsv.cjs');
const { ticketRelations } = require('./schedRelations.cjs');

const STATES = ['queued', 'granted', 'running', 'paused', 'slow', 'unsatisfiable', 'passed', 'failed', 'cancelled', 'voided'];
const ACTIVE = ['granted', 'running', 'paused', 'slow'];
const TIMING_KEYS = ['queuedMs', 'runningMs', 'pausedMs', 'slowMs'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }
function readFailure(error) {
  return { ok: false, readable: false, reason: error.message, error: '读不到调度共享盘' };
}
function readConfig(share) {
  const config = c.readJson(c.schedPaths(share).dispatcher);
  c.fields(config, { machine: c.segment, createdAt: c.isoTime, createdBy: c.text });
  return config;
}
function jsonFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.name.endsWith('.json')).map(entry => {
    if (!entry.isFile()) throw new Error(`[sched] 不是普通快照文件:${entry.name}`);
    return entry.name;
  });
}
function validateTiming(value) { c.fields(value, Object.fromEntries(TIMING_KEYS.map(key => [key, v => c.integer(v)]))); }

/** 快照全文保留；校验展示所消费的字段，不凭缺字段推断为零或成功。 */
function validateTicket(value, id) {
  c.requireRecord(value, '单子快照');
  if (c.ticketId(value.ticketId) !== id || value.formatVersion !== 1) throw new Error('[sched] 单子编号或格式不匹配');
  c.oneOf(STATES)(value.state);
  c.oneOf([true, false])(value.registerOnly); c.oneOf([true, false])(value.cancelRequested);
  c.list(c.oneOf(['ci', 'manual', 'owner-hold']))(value.pauseReasons);
  c.isoTime(value.createdAt); c.isoTime(value.updatedAt);
  if (value.endedAt !== null) c.isoTime(value.endedAt);
  c.text(value.currentAttemptId); validateTiming(value.timing);
  const request = c.requireRecord(value.request, '挂号请求');
  for (const key of ['project', 'title', 'submitter', 'category']) c.text(request[key]);
  c.integer(request.requestedCores); c.list(c.segment, 1, true)(request.allowedMachines);
  c.requireRecord(request.work); c.text(request.work.type); c.list(c.text, 1)(request.work.targetPaths);
  if (request.parentTicketId !== undefined) c.ticketId(request.parentTicketId);
  c.fields(request.codeRef, { kind: c.oneOf(['commit', 'content']), value: c.text });
  c.list(attempt => {
    c.requireRecord(attempt, '执行记录'); c.text(attempt.attemptId); c.integer(attempt.grantedCores);
    c.isoTime(attempt.queuedAt); validateTiming(attempt.timing);
    for (const key of ['startedAt', 'endedAt']) if (attempt[key] !== null) c.isoTime(attempt[key]);
    if (attempt.permit !== null) {
      c.requireRecord(attempt.permit, '许可'); c.segment(attempt.permit.machine); c.integer(attempt.permit.grantedCores);
    }
    if (attempt.intent !== null) { c.requireRecord(attempt.intent, '派发意图'); c.segment(attempt.intent.machine); }
    if (attempt.result !== null) c.fields(attempt.result, { outcome: c.oneOf(['passed', 'failed', 'voided', 'cancelled', 'handoff-interrupted']), reason: c.text });
  })(value.attempts);
  c.list(event => {
    c.requireRecord(event, '时间线'); c.isoTime(event.at); c.text(event.type); c.requireRecord(event.data, '事件 data');
  })(value.timeline);
  return value;
}
function readTickets(share) {
  const directory = c.schedPaths(share).tickets;
  return jsonFiles(directory).map(file => {
    const id = c.ticketId(file.slice(0, -5));
    return validateTicket(c.readJson(path.join(directory, file)), id);
  });
}
function summarize(ticket) {
  const attempt = ticket.attempts.find(a => a.attemptId === ticket.currentAttemptId);
  return {
    ticketId: ticket.ticketId, project: ticket.request.project, title: ticket.request.title, submitter: ticket.request.submitter,
    category: ticket.request.category, machine: attempt?.permit?.machine ?? attempt?.intent?.machine ?? null,
    requestedCores: ticket.request.requestedCores, grantedCores: attempt?.grantedCores ?? 0,
    state: ticket.state, result: ticket.state, resultReason: attempt?.result?.reason ?? null,
    registerOnly: ticket.registerOnly, pauseReasons: ticket.pauseReasons, cancelRequested: ticket.cancelRequested,
    createdAt: ticket.createdAt, endedAt: ticket.endedAt, ...ticket.timing,
  };
}
function recentReceipts(share) {
  const directory = c.schedPaths(share).commandReceipts;
  return jsonFiles(directory).map(file => {
    const receipt = c.validateReceipt(c.readJson(path.join(directory, file)));
    if (receipt.commandId !== c.segment(file.slice(0, -5))) throw new Error('[sched] 指令回执编号与文件名不符');
    return receipt;
  }).sort((a, b) => compare(b.at, a.at) || compare(b.commandId, a.commandId)).slice(0, 20);
}

function snapshot(share, cpuBudget, nowMs) {
  try {
    const paths = c.schedPaths(share);
    const format = c.readJson(paths.format);
    c.fields(format, { formatVersion: v => c.integer(v, 1), capabilities: c.list(c.text, 0, true), createdAt: c.isoTime });
    const config = readConfig(share);
    const heartbeat = c.validateHeartbeat(c.readJson(paths.heartbeat));
    if (heartbeat.machine !== config.machine) throw new Error('[sched] 心跳与派单主机配置不一致');
    const records = readTickets(share), tickets = records.map(summarize);
    const history = readLedger(share);
    const estimates = estimateTickets({ readable: true, nowMs, tickets: records, queue: heartbeat.queue,
      machines: heartbeat.machines, locks: heartbeat.locks, heartbeatAt: heartbeat.at, cursorSeq: heartbeat.cursorSeq }, history);
    const receipts = recentReceipts(share);
    const legacy = cpuBudget.cpuStatus();
    return { ok: true, share, readable: true, format,
      dispatcher: { config, heartbeat, heartbeatAgeMs: Math.max(0, nowMs - Date.parse(heartbeat.at)) },
      machines: heartbeat.machines, queue: heartbeat.queue, locks: heartbeat.locks,
      running: tickets.filter(ticket => ACTIVE.includes(ticket.state)),
      registerOnly: tickets.filter(ticket => ticket.registerOnly && ticket.state === 'running'), recentReceipts: receipts,
      legacyReserve: { reservedCores: legacy.reservedCores, reserveExpiresAt: legacy.reserveExpiresAt },
      estimates, estimatesAt: new Date(nowMs).toISOString(), historyError: history.reason,
      connectedProjects: connectedProjects(records, history, nowMs) };
  } catch (error) {
    return { ...readFailure(error), share, format: null, dispatcher: null, machines: null, queue: null, locks: null,
      running: null, registerOnly: null, recentReceipts: null, legacyReserve: null,
      estimates: null, estimatesAt: null, historyError: null, connectedProjects: null };
  }
}

function queryText(value, name) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 500) throw badRequest(`非法筛选参数:${name}`);
  return value;
}
function dateBoundary(value, end) {
  if (!value) return '';
  try { return c.isoTime(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : value); }
  catch (_) { throw badRequest('日期必须为有效日期或 UTC 毫秒 ISO'); }
}

function ticketFilters(query) {
  const filters = Object.fromEntries(['project', 'machine', 'submitter', 'result', 'from', 'to'].map(key => [key, queryText(query[key], key)]));
  filters.from = dateBoundary(filters.from, false); filters.to = dateBoundary(filters.to, true);
  if (filters.from && filters.to && filters.from > filters.to) throw badRequest('开始日期不能晚于结束日期');
  if (filters.result && !STATES.includes(filters.result)) throw badRequest('非法结果筛选');
  return filters;
}
/** 页面与导出共用同一个筛选谓词；机器匹配历史执行，日期匹配挂号时刻。 */
function filteredTickets(tickets, filters) {
  return tickets.filter(ticket => {
    const request = ticket.request;
    return (!filters.project || request.project === filters.project) && (!filters.submitter || request.submitter === filters.submitter)
      && (!filters.result || ticket.state === filters.result)
      && (!filters.machine || ticket.attempts.some(a => (a.permit?.machine ?? a.intent?.machine) === filters.machine))
      && (!filters.from || ticket.createdAt >= filters.from) && (!filters.to || ticket.createdAt <= filters.to);
  }).sort((a, b) => compare(b.createdAt, a.createdAt) || compare(b.ticketId, a.ticketId));
}

/** 按不可变的挂号时刻、单号倒序；游标绑定筛选，翻页时新单不挤出或重复旧行。 */
function ticketPage(share, query = {}) {
  const filters = ticketFilters(query);
  const rawLimit = queryText(query.limit, 'limit');
  if (rawLimit && (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) < 1)) throw badRequest('limit 必须为正整数');
  const limit = Math.min(200, rawLimit ? Number(rawLimit) : 50);
  const filterHash = c.contentHash(filters);
  const rawCursor = queryText(query.cursor, 'cursor');
  let cursor = null;
  if (rawCursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(rawCursor)) throw new Error('编码');
      cursor = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
      c.fields(cursor, { at: c.isoTime, id: c.ticketId, filterHash: c.text });
      if (cursor.filterHash !== filterHash) throw new Error('筛选已改变');
    } catch (_) { throw badRequest('非法分页游标或筛选已改变'); }
  }
  const tickets = readTickets(share);
  const rows = filteredTickets(tickets, filters);
  const after = rows.filter(ticket => !cursor || ticket.createdAt < cursor.at || (ticket.createdAt === cursor.at && ticket.ticketId < cursor.id));
  const items = after.slice(0, limit).map(summarize);
  const last = items[items.length - 1];
  const unique = values => [...new Set(values)].filter(Boolean).sort(compare);
  return { ok: true, readable: true, items, total: rows.length, limit,
    nextCursor: after.length > limit ? Buffer.from(c.canonicalJson({ at: last.createdAt, id: last.ticketId, filterHash })).toString('base64url') : null,
    filters: { projects: unique(tickets.map(t => t.request.project)), submitters: unique(tickets.map(t => t.request.submitter)),
      machines: unique(tickets.flatMap(t => t.attempts.map(a => a.permit?.machine ?? a.intent?.machine))) } };
}
function exportTickets(share, query = {}) {
  const filters = ticketFilters(query);
  return ticketCsv(filteredTickets(readTickets(share), filters));
}
function ticketDetail(share, id) {
  try { c.ticketId(id); } catch (error) { throw badRequest(error.message); }
  const directory = c.schedPaths(share).tickets;
  // 先证实目录可读，目录本身丢失不能冒充「这张单不存在」。
  const files = jsonFiles(directory);
  if (!files.includes(`${id}.json`)) throw Object.assign(new Error('单子不存在'), { status: 404 });
  return validateTicket(c.readJson(path.join(directory, `${id}.json`)), id);
}
function relatedTickets(share, ticket) {
  try { return ticketRelations(ticket, readTickets(share), readLedger(share)); }
  catch (error) { return { readable: false, reason: `读不到关联单子：${error.message}`, children: null, handoffs: [] }; }
}
function pollStamp(share) {
  const paths = c.schedPaths(share);
  const heartbeat = c.readJson(paths.heartbeat);
  const cursorSeq = c.integer(heartbeat.cursorSeq);
  const receipts = fs.statSync(paths.commandReceipts);
  if (!receipts.isDirectory()) throw new Error('[sched] 指令回执目录不可读');
  return { cursorSeq, key: `${share}:${cursorSeq}:${receipts.mtimeMs}` };
}

module.exports = { snapshot, ticketPage, exportTickets, ticketDetail, relatedTickets, readConfig, readFailure, pollStamp, STATES };
