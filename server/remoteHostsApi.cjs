'use strict';
function createRemoteHostsApi({ sendJson, monitor, enabled, now = Date.now }) {
  return { route(action, req, res, query = {}) {
    if (req.method !== 'GET') return false;
    if (action === 'remote-hosts') { sendJson(res, 200, enabled() ? monitor.list(now()) : { ok: true, disabled: true, configError: null, hosts: [] }); return true; }
    const match = /^remote-hosts\/([^/]+)\/(perf|processes)$/.exec(action);
    if (!match) return false;
    let name; try { name = decodeURIComponent(match[1]); } catch { name = ''; }
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) { sendJson(res, 404, { ok: false, error: '没有这台远程机器' }); return true; }
    const range = query.range === undefined ? '60s' : query.range;
    if (match[2] === 'perf' && !['60s', '10m', '24h'].includes(range)) { sendJson(res, 400, { ok: false, error: 'range 只能是 60s、10m、24h' }); return true; }
    const result = match[2] === 'perf' ? monitor.perf(name, range, now()) : monitor.processes(name, now());
    if (!result) sendJson(res, 404, { ok: false, error: '没有这台远程机器' }); else sendJson(res, 200, result);
    return true;
  } };
}
module.exports = { createRemoteHostsApi };
