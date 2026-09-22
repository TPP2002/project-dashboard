'use strict';
/** 调度 API：读盘快照、发指令；预留只由统一调度执行。 */
const c = require('../core/schedContract.cjs');
const read = require('../core/schedRead.cjs');

function createSchedApi({ sendJson, readBody, bodyMax, resolveShare, sources = c.productionSources }) {
  let previousStamp;

  function validateInput(body) {
    c.fields(body, { kind: c.text, data: v => c.requireRecord(v, '指令 data') });
    if (body.kind === 'reserve') c.validateReserve(body.data, false);
    else if (['owner-hold', 'owner-release'].includes(body.kind)) c.fields(body.data, {});
    else if (['jump-queue', 'cancel', 'pause-one', 'resume-one'].includes(body.kind)) c.fields(body.data, { ticketId: c.ticketId });
    else throw new Error('本期未开放');
  }
  function handlePost(req, res) {
    readBody(req, bodyMax, (error, raw) => {
      if (error) return sendJson(res, 413, { ok: false, error: error.message });
      let body;
      try {
        body = JSON.parse(raw);
        validateInput(body);
      } catch (error) { return sendJson(res, 400, { ok: false, error: error.message }); }
      const nowMs = sources.now();
      const share = resolveShare();
      try {
        const data = ['reserve', 'owner-hold', 'owner-release'].includes(body.kind)
          ? { ...body.data, machine: read.readConfig(share).machine } : body.data;
        const createdAt = new Date(nowMs).toISOString();
        const commandId = c.segment(`dash-${createdAt.replace(/[-:.]/g, '')}-${sources.nonce()}`);
        const command = { commandId, kind: body.kind, data, submitter: 'dashboard', createdAt,
          expiresAt: new Date(nowMs + 10 * 60000).toISOString() };
        c.writeCommand(share, command, sources);
        return sendJson(res, 200, { ok: true, commandId });
      } catch (error) {
        return sendJson(res, error.code === 'EEXIST' ? 409 : 503, { ok: false, error: `指令未提交:${error.message}` });
      }
    });
  }
  function route(action, req, res, query = {}) {
    if (req.method === 'POST' && action === 'legacy-reserve') {
      sendJson(res, 410, { ok: false, error: '旧算力账本已下线，请通过调度台提交预留指令' }); return true;
    }
    if (req.method === 'POST' && action === 'command') {
      handlePost(req, res); return true;
    }
    if (req.method !== 'GET') return false;
    const share = resolveShare();
    try {
      if (action === 'snapshot') {
        const result = read.snapshot(share, sources.now());
        sendJson(res, result.readable ? 200 : 503, result);
      } else if (action === 'tickets') sendJson(res, 200, read.ticketPage(share, query));
      else if (action === 'tickets.csv') {
        const csv = read.exportTickets(share, query);
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="sched-ledger.csv"', 'cache-control': 'no-store' });
        res.end(csv);
      } else if (action.startsWith('ticket/')) {
        const ticket = read.ticketDetail(share, action.slice(7));
        sendJson(res, 200, { ok: true, ticket, ...(query.related === '0' ? {} : { related: read.relatedTickets(share, ticket) }) });
      } else return false;
    } catch (error) {
      sendJson(res, error.status || 503, error.status ? { ok: false, error: error.message } : read.readFailure(error));
    }
    return true;
  }
  /** 与 board:changed 共用现有轮询；读失败也发变更，促使页面立即呈现不可读状态。 */
  function poll(broadcast, enabled) {
    if (!enabled) { previousStamp = undefined; return; }
    let stamp;
    try { stamp = read.pollStamp(resolveShare()); }
    catch (error) { stamp = { key: `unreadable:${error.message}`, cursorSeq: null }; }
    if (previousStamp !== undefined && stamp.key !== previousStamp) broadcast('sched:changed', { cursorSeq: stamp.cursorSeq });
    previousStamp = stamp.key;
  }
  return { route, poll };
}

module.exports = { createSchedApi };
