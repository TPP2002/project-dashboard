'use strict';
/** 调度 API：读盘快照、发指令；预留只由统一调度执行。 */
const c = require('../core/schedContract.cjs');
const read = require('../core/schedRead.cjs');
const { createSchedReadExecutor } = require('../core/schedReadExecutor.cjs');

function createSchedApi({ sendJson, readBody, bodyMax, resolveShare, sources = c.productionSources,
  executor = createSchedReadExecutor() }) {
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
    if (!['snapshot', 'tickets', 'tickets.csv'].includes(action) && !action.startsWith('ticket/')) return false;
    const share = resolveShare();
    void handleRead(action, req, res, query, share);
    return true;
  }
  async function handleRead(action, req, res, query, share) {
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    const connected = () => !controller.signal.aborted && !res.destroyed && !res.writableEnded;
    req.once('aborted', disconnect);
    res.once('close', disconnect);
    if (req.aborted || res.destroyed || res.writableEnded) disconnect();
    try {
      const result = await executor.run({ action, share, query,
        ...(action === 'snapshot' ? { nowMs: sources.now() } : {}) }, { signal: controller.signal });
      if (!connected()) return;
      if (action === 'snapshot') {
        sendJson(res, result.readable ? 200 : 503, result);
      } else if (action === 'tickets.csv') {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="sched-ledger.csv"', 'cache-control': 'no-store' });
        res.end(result);
      } else sendJson(res, 200, result);
    } catch (error) {
      if (connected()) sendJson(res, error.status || 503, error.status ? { ok: false, error: error.message } : read.readFailure(error));
    } finally {
      req.removeListener('aborted', disconnect);
      res.removeListener('close', disconnect);
    }
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
  return { route, poll, sweep: () => executor.sweep(resolveShare()), close: () => executor.close() };
}

module.exports = { createSchedApi };
