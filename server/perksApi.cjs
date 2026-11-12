'use strict';
/** 每日福利本机面板的隔离代理。 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');

const ENTRY = ['--import', 'tsx', 'src/cli.ts', 'panel', '--serve'];
const ACCOUNT_RE = /^(main|(?:acct|pool)-[0-9]{1,6})$/;
const PLATFORM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOKEN_RE = /^[0-9a-f]{16,64}$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validAccount = value => typeof value === 'string' && ACCOUNT_RE.test(value);
const validIds = (value, empty = false) => Array.isArray(value) && value.length >= (empty ? 0 : 1) && value.length <= 50 && value.every(id => typeof id === 'string' && PLATFORM_RE.test(id));
const validName = value => typeof value === 'string' && value.length >= 1 && value.length <= 40 && !/[\x00-\x1f\x7f]/.test(value);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function buildAction(body) {
  if (!isRecord(body)) return { error: '请求内容格式有误' };
  const data = {};
  switch (body.action) {
    case 'run': return { path: '/api/run', data };
    case 'stop': return { path: '/api/stop', data };
    case 'login':
      if (has(body, 'account')) { if (!validAccount(body.account)) return { error: '账号编号格式不对' }; data.account = body.account; }
      if (has(body, 'ids')) { if (!validIds(body.ids)) return { error: '平台编号格式不对' }; data.ids = body.ids; }
      return { path: '/api/login', data };
    case 'schedule':
      if (typeof body.on !== 'boolean') return { error: '缺少开关状态' };
      return { path: '/api/schedule', data: { on: body.on } };
    case 'account-add':
      if (!validName(body.name)) return { error: '名字不合规' };
      if (!validIds(body.platformIds)) return { error: '平台编号格式不对' };
      return { path: '/api/accounts/add', data: { name: body.name, platformIds: body.platformIds } };
    case 'account-update':
      if (!validAccount(body.id)) return { error: '账号编号格式不对' };
      data.id = body.id;
      if (has(body, 'name')) { if (!validName(body.name)) return { error: '名字不合规' }; data.name = body.name; }
      if (has(body, 'platformIds')) { if (!validIds(body.platformIds, true)) return { error: '平台编号格式不对' }; data.platformIds = body.platformIds; }
      if (has(body, 'enabled')) { if (typeof body.enabled !== 'boolean') return { error: '参数不对' }; data.enabled = body.enabled; }
      return { path: '/api/accounts/update', data };
    default: return { error: '不认识的操作' };
  }
}

function createPerksApi(deps) {
  const { sendJson, readBody, bodyMax, resolvePerksRepo, isCollaboration, isLocalRequest } = deps;
  const spawn = deps.spawn || defaultSpawn, fetch = deps.fetch || globalThis.fetch, exists = deps.fileExists || fs.existsSync;
  const now = deps.now || Date.now, startTimeoutMs = deps.startTimeoutMs ?? 20000, requestTimeoutMs = deps.requestTimeoutMs ?? 10000, heartbeatEveryMs = deps.heartbeatEveryMs ?? 10000;
  let service = null, starting = null, lastHeartbeat = null;
  function start(repo) {
    if (service) return Promise.resolve(service);
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      let child, timer, settled = false, output = '';
      function fail(timeout = false) {
        if (settled) return; settled = true; clearTimeout(timer);
        try { child?.kill(); } catch (_) { /* 已退出 */ }
        reject({ status: timeout ? 504 : 502, error: timeout ? '每日福利服务起得太慢' : '每日福利服务没起来' });
      }
      try { child = spawn(process.execPath, ENTRY, { cwd: repo, windowsHide: true, shell: false, detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: process.env }); }
      catch (_) { fail(); return; }
      timer = setTimeout(() => fail(true), startTimeoutMs);
      child.on('error', () => fail()); child.on('close', () => fail());
      if (!child.stdout) { fail(); return; }
      child.stdout.on('error', () => fail());
      child.stdout.on('data', chunk => {
        if (settled) return;
        output += chunk.toString('utf8'); const end = output.indexOf('\n');
        if (end < 0) return;
        let info; try { info = JSON.parse(output.slice(0, end)); } catch (_) { fail(); return; }
        if (!isRecord(info) || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || typeof info.token !== 'string' || !TOKEN_RE.test(info.token)) { fail(); return; }
        settled = true; clearTimeout(timer); service = { port: info.port, token: info.token };
        child.stdout.destroy(); child.unref(); resolve(service);
      });
    }).finally(() => { starting = null; });
    return starting;
  }
  async function forward(repo, endpoint, data) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await start(repo);
      try {
        const headers = { host: `127.0.0.1:${current.port}`, 'x-perks-token': current.token };
        const init = { method: data === undefined ? 'GET' : 'POST', headers, signal: AbortSignal.timeout(requestTimeoutMs) };
        if (data !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(data); }
        const response = await fetch(`http://127.0.0.1:${current.port}${endpoint}`, init);
        if (response.status !== 403) return { response, current };
      } catch (_) { /* 服务不可用，尝试重新启动 */ }
      if (service === current) service = null;
    }
    throw { status: 502, error: '连不上每日福利服务' };
  }
  // 回包安全检查只查口令：端口是几位数字，状态里的时间戳、计数可能碰巧含这串数字；口令是 32 位十六进制，不会碰巧出现。
  function safe(value, current) {
    const text = JSON.stringify(value);
    return typeof text === 'string' && !text.includes(current.token);
  }
  async function respond(repo, res, action) {
    try {
      const { response, current } = await forward(repo, action ? action.path : '/api/state', action ? action.data : undefined);
      let data; try { data = await response.json(); } catch (_) { data = null; }
      if (response.status === 200 && isRecord(data) && safe(data, current)) {
        sendJson(res, 200, { ok: true, data });
        if (!action && (lastHeartbeat === null || now() - lastHeartbeat > heartbeatEveryMs)) {
          lastHeartbeat = now(); void forward(repo, '/api/heartbeat', {}).catch(() => {});
        }
      } else if (action && (response.status === 400 || response.status === 409) && isRecord(data) && typeof data.error === 'string' && safe(data.error, current)) {
        sendJson(res, response.status, { ok: false, error: data.error.slice(0, 200) });
      } else sendJson(res, 502, { ok: false, error: '每日福利服务没按预期回应' });
    } catch (error) { sendJson(res, error.status || 502, { ok: false, error: error.error || '连不上每日福利服务' }); }
  }
  function route(subpath, req, res) {
    const available = subpath === 'available' && req.method === 'GET';
    const read = subpath === '' && req.method === 'GET';
    const action = subpath === 'action' && req.method === 'POST';
    if (!available && !read && !action) return false;
    if (isCollaboration) { sendJson(res, 404, { ok: false, error: '每日福利只在本机看板里使用' }); return true; }
    if (!isLocalRequest(req)) { sendJson(res, 403, { ok: false, error: '请求来源不是本机' }); return true; }
    const repo = resolvePerksRepo(), present = repo && exists(path.join(repo, 'src', 'control.ts'));
    if (available) { sendJson(res, 200, { ok: true, available: Boolean(present) }); return true; }
    if (!repo || !present) { sendJson(res, 503, { ok: false, error: repo ? '每日福利还没更新到能接看板的版本' : '这台电脑没接每日福利' }); return true; }
    if (read) { void respond(repo, res, null); return true; }
    readBody(req, bodyMax, (error, raw) => {
      if (error) { sendJson(res, 413, { ok: false, error: '请求内容太长' }); return; }
      let body; try { body = JSON.parse(raw); } catch (_) { sendJson(res, 400, { ok: false, error: '请求内容格式有误' }); return; }
      const built = buildAction(body);
      if (built.error) { sendJson(res, 400, { ok: false, error: built.error }); return; }
      void respond(repo, res, built);
    });
    return true;
  }
  return { route };
}
module.exports = { createPerksApi, buildAction, validAccount, validIds, validName, ENTRY, ACCOUNT_RE, PLATFORM_RE, TOKEN_RE };
