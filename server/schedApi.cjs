'use strict';
/** 调度 API：读盘快照、发指令、迁移期预留双写；所有业务写入只走已公开的契约。 */
const c = require('../core/schedContract.cjs');
const read = require('../core/schedRead.cjs');

function createSchedApi({ sendJson, readBody, bodyMax, cpuBudget, resolveShare, sources = c.productionSources }) {
  let previousStamp;

  function syncLegacy(data, nowMs) {
    try {
      const status = data.requestedCores === 0 ? cpuBudget.clearReserve()
        : cpuBudget.setReserve(data.requestedCores, data.durationMinutes ? { expiresAtMs: nowMs + data.durationMinutes * 60000 } : {});
      // clearReserve 的旧实现会吞删除错误；回读仍有预留时必须向负责人报告失败。
      if (data.requestedCores === 0 && status.reservedCores !== 0) throw new Error('旧账本仍有负责人预留，清除失败');
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  }
  function validateInput(body) {
    c.fields(body, { kind: c.text, data: v => c.requireRecord(v, '指令 data') });
    if (['pause-one', 'resume-one'].includes(body.kind)) throw new Error('本期未开放');
    if (body.kind === 'reserve') c.validateReserve(body.data, false);
    else if (['owner-hold', 'owner-release'].includes(body.kind)) c.fields(body.data, {});
    else if (['jump-queue', 'cancel'].includes(body.kind)) c.fields(body.data, { ticketId: c.ticketId });
    else throw new Error('本期未开放');
  }
  function handlePost(req, res, legacyOnly) {
    readBody(req, bodyMax, (error, raw) => {
      if (error) return sendJson(res, 413, { ok: false, error: error.message });
      let body;
      try {
        body = JSON.parse(raw);
        if (legacyOnly) c.validateReserve(body, false); else validateInput(body);
      } catch (error) { return sendJson(res, 400, { ok: false, error: error.message }); }
      const nowMs = sources.now();
      if (legacyOnly) {
        const legacy = syncLegacy(body, nowMs);
        return sendJson(res, 200, { ok: legacy.ok, legacy });
      }
      const share = resolveShare();
      try {
        const data = ['reserve', 'owner-hold', 'owner-release'].includes(body.kind)
          ? { ...body.data, machine: read.readConfig(share).machine } : body.data;
        const createdAt = new Date(nowMs).toISOString();
        const commandId = c.segment(`dash-${createdAt.replace(/[-:.]/g, '')}-${sources.nonce()}`);
        const command = { commandId, kind: body.kind, data, submitter: 'dashboard', createdAt,
          expiresAt: new Date(nowMs + 10 * 60000).toISOString() };
        c.writeCommand(share, command, sources);
        const legacy = body.kind === 'reserve' ? syncLegacy(body.data, nowMs) : undefined;
        return sendJson(res, 200, { ok: true, commandId, ...(legacy ? { legacy } : {}) });
      } catch (error) {
        return sendJson(res, error.code === 'EEXIST' ? 409 : 503, { ok: false, error: `指令未提交:${error.message}` });
      }
    });
  }
  function route(action, req, res, query) {
    if (req.method === 'POST' && ['command', 'legacy-reserve'].includes(action)) {
      handlePost(req, res, action === 'legacy-reserve'); return true;
    }
    if (req.method !== 'GET') return false;
    const share = resolveShare();
    try {
      if (action === 'snapshot') {
        const result = read.snapshot(share, cpuBudget, sources.now());
        sendJson(res, result.readable ? 200 : 503, result);
      } else if (action === 'tickets') sendJson(res, 200, read.ticketPage(share, query));
      else if (action.startsWith('ticket/')) sendJson(res, 200, { ok: true, ticket: read.ticketDetail(share, action.slice(7)) });
      else return false;
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
