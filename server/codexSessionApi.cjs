'use strict';

const fs = require('node:fs');
const { isValidSessionId } = require('./codexSessionData.cjs');
const {
  getCodexReport,
  getCodexUsage,
  getLatestQuota,
  getSessionDetail,
  listSessions,
} = require('./codexSessions.cjs');
const { findCodexExecutable, spawnSessionResume, waitForChild } = require('./codexProcess.cjs');

const MESSAGE_MAX = 8000;

function createCodexSessionApi(options) {
  const { readBody, sendJson, sendText, bodyMax, dashboardRoot, sessionsRoot, readRegistry, getJobs, commandError } = options;

  function queryOptions(extra = {}) {
    const registry = readRegistry();
    return {
      sessionsRoot,
      dashboardRoot,
      projects: registry.projects || {},
      jobs: getJobs(),
      ...extra,
    };
  }

  function jsonBody(req, res, callback) {
    readBody(req, bodyMax, (error, raw) => {
      if (error) return sendJson(res, 413, { ok: false, error: error.message });
      let body;
      try { body = raw ? JSON.parse(raw) : {}; }
      catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
      callback(body);
    });
  }

  function validId(value, res) {
    if (isValidSessionId(value)) return value;
    sendJson(res, 400, { ok: false, error: 'sessionId 必须是 UUID' });
    return null;
  }

  function handleSessions(res, query) {
    try {
      const limit = Math.max(1, Math.min(500, parseInt(query.limit, 10) || 50));
      const days = Math.max(1, Math.min(365, parseInt(query.days, 10) || 30));
      sendJson(res, 200, listSessions(queryOptions({ limit, days })));
    } catch (error) {
      sendJson(res, 500, { ok: false, error: '读取 Codex 会话失败：' + error.message });
    }
  }

  function handleSession(res, query) {
    const sessionId = validId(query.id, res);
    if (!sessionId) return;
    try {
      const tail = Math.max(1, Math.min(1000, parseInt(query.tail, 10) || 200));
      const detail = getSessionDetail(sessionId, queryOptions({ tail }));
      if (!detail) return sendJson(res, 404, { ok: false, error: `会话 ${sessionId} 不存在` });
      sendJson(res, 200, detail);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: '读取 Codex 会话详情失败：' + error.message });
    }
  }

  function handleQuota(res) {
    try { sendJson(res, 200, getLatestQuota(queryOptions())); }
    catch (error) { sendJson(res, 500, { ok: false, error: '读取 Codex 额度失败：' + error.message }); }
  }

  function handleReport(res, query) {
    try {
      const days = Number(query.days) === 7 ? 7 : 1;
      sendJson(res, 200, getCodexReport(queryOptions({ days })));
    } catch (error) {
      sendJson(res, 500, { ok: false, error: '生成昨夜战报失败：' + error.message });
    }
  }

  function handleSaySession(req, res) {
    jsonBody(req, res, (body) => {
      const sessionId = validId(body.sessionId, res);
      if (!sessionId) return;
      if (typeof body.message !== 'string' || !body.message.trim()) {
        return sendJson(res, 400, { ok: false, error: 'message 不能为空' });
      }
      if (body.message.length > MESSAGE_MAX) {
        return sendJson(res, 400, { ok: false, error: `message 不能超过 ${MESSAGE_MAX} 字符` });
      }
      if (body.sandboxMode !== undefined && !['read-only', 'workspace-write'].includes(body.sandboxMode)) {
        return sendJson(res, 400, { ok: false, error: 'sandboxMode 只允许 read-only 或 workspace-write' });
      }
      let detail;
      try { detail = getSessionDetail(sessionId, queryOptions({ tail: 1 })); }
      catch (error) { return sendJson(res, 500, { ok: false, error: '读取会话失败：' + error.message }); }
      if (!detail) return sendJson(res, 404, { ok: false, error: `会话 ${sessionId} 不存在` });
      const executable = findCodexExecutable();
      if (!executable) return sendJson(res, 500, { ok: false, error: '找不到可用的 Codex 可执行文件' });
      const cwd = detail.cwd && fs.existsSync(detail.cwd) ? detail.cwd : dashboardRoot;
      let child;
      try {
        child = spawnSessionResume({
          executable, sessionId, message: body.message,
          sandboxMode: body.sandboxMode || 'read-only', cwd,
        });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: '启动 Codex 续聊失败：' + error.message });
      }
      waitForChild(child, (result) => {
        if (result.kind !== 'exit' || result.code !== 0) return commandError(res, result);
        sendText(res, 200, result.stdout, 'text/plain; charset=utf-8');
      });
    });
  }

  function route(action, req, res, query) {
    if (action === 'sessions' && req.method === 'GET') { handleSessions(res, query); return true; }
    if (action === 'session' && req.method === 'GET') { handleSession(res, query); return true; }
    if (action === 'quota' && req.method === 'GET') { handleQuota(res); return true; }
    if (action === 'report' && req.method === 'GET') { handleReport(res, query); return true; }
    if (action === 'say-session' && req.method === 'POST') { handleSaySession(req, res); return true; }
    return false;
  }

  return {
    getCostUsage: (days, projectName) => getCodexUsage(queryOptions({ days, projectName })),
    getQuota: () => getLatestQuota(queryOptions()),
    route,
  };
}

module.exports = { createCodexSessionApi };
