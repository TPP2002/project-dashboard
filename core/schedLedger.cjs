'use strict';
/** 台账只读输入；不可读、坏行或校验和不符都不能伪装为没有历史。 */
const fs = require('node:fs');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const c = require('./schedContract.cjs');
const SAMPLE_LIMIT = 20;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const sampleKey = request => JSON.stringify([request.category, request.work.type]);

function readLedger(share) {
  try {
    const directory = path.join(c.schedPaths(share).root, 'ledger');
    const files = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1);
    const events = [];
    let previousSeq = 0;
    for (const file of files) {
      if (!file.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file.name)) throw new Error('台账目录含未知文件');
      c.isoTime(`${file.name.slice(0, 10)}T00:00:00.000Z`);
      const bytes = fs.readFileSync(path.join(directory, file.name));
      if (!isUtf8(bytes)) throw new Error('台账不是有效 UTF-8');
      const lines = bytes.toString('utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      for (const line of lines) {
        const event = c.requireRecord(JSON.parse(line), '台账事件');
        c.oneOf([1])(event.v); c.integer(event.seq, 1); c.isoTime(event.at); c.text(event.type); c.requireRecord(event.data);
        if (event.ticketId !== undefined) { c.ticketId(event.ticketId); c.text(event.attemptId); }
        if (['started', 'finished', 'dispatch-intent', 'dispatched'].includes(event.type)) { c.ticketId(event.ticketId); c.text(event.attemptId); }
        if (event.type === 'dispatch-intent') {
          const intent = c.requireRecord(event.data.intent); c.segment(intent.machine); c.segment(intent.submissionId);
        }
        if (event.type === 'dispatched') c.segment(event.data.submissionId);
        if (event.type === 'submitted') {
          c.ticketId(event.ticketId);
          const request = c.requireRecord(event.data.request);
          c.text(request.project); c.text(request.category); c.text(c.requireRecord(request.work).type);
        }
        const { sha256, ...payload } = event;
        if (sha256 !== c.contentHash(payload) || event.seq <= previousSeq) throw new Error('台账校验和或事件顺序不合法');
        previousSeq = event.seq;
        events.push(event);
      }
    }
    return { readable: true, events, reason: null };
  } catch (error) { return { readable: false, events: [], reason: `读不到调度台账：${error.message}` }; }
}

function requestsByTicket(tickets, events) {
  const requests = new Map(tickets.map(ticket => [ticket.ticketId, ticket.request]));
  for (const event of events) if (event.type === 'submitted') requests.set(event.ticketId, event.data.request);
  return requests;
}

/** 以执行号配对，跨日/重跑不串单；未开跑就撤单的 finished 不算执行样本。单位毫秒。 */
function durationSamples(tickets, events, nowMs) {
  const requests = requestsByTicket(tickets, events), starts = new Map(), groups = new Map();
  const ordered = [...events].filter(event => Date.parse(event.at) <= nowMs).sort((a, b) => a.seq - b.seq);
  for (const event of ordered) {
    if (!event.ticketId || !event.attemptId) continue;
    const key = JSON.stringify([event.ticketId, event.attemptId]);
    if (event.type === 'started' && !starts.has(key)) starts.set(key, Date.parse(event.at));
    if (event.type !== 'finished' || !starts.has(key)) continue;
    const elapsed = Date.parse(event.at) - starts.get(key);
    starts.delete(key);
    const request = requests.get(event.ticketId);
    if (!request || elapsed < 0 || !Number.isFinite(elapsed)) continue;
    const group = sampleKey(request), samples = groups.get(group) || [];
    samples.push({ elapsed, at: event.at, seq: event.seq }); groups.set(group, samples);
  }
  return new Map([...groups].map(([key, samples]) => {
    const recent = samples.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq).slice(0, SAMPLE_LIMIT);
    const durations = recent.map(sample => sample.elapsed).sort((a, b) => a - b), middle = Math.floor(durations.length / 2);
    return [key, { sampleCount: durations.length, medianMs: durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2 }];
  }));
}

/** 名字只来自数据；七天内出现票据事件即算出现，不要求它恰在这七天挂号。 */
function connectedProjects(tickets, history, nowMs) {
  if (!history.readable) return { readable: false, names: [], reason: history.reason };
  const requests = requestsByTicket(tickets, history.events), names = new Set();
  for (const event of history.events) {
    const at = Date.parse(event.at), project = requests.get(event.ticketId)?.project;
    if (project && at >= nowMs - WEEK_MS && at <= nowMs) names.add(project);
  }
  return { readable: true, names: [...names].sort(), reason: null };
}

module.exports = { readLedger, durationSamples, connectedProjects, sampleKey, SAMPLE_LIMIT };
