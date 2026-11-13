'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteHostsApi } = require('../server/remoteHostsApi.cjs');

test('只读接口校验路径、开关和范围', () => {
  let enabled = true, reply;
  const monitor = { list: () => ({ ok: true, hosts: [{ name: 'demo-1' }] }),
    perf: name => name === 'demo-1' ? { ok: true } : null,
    processes: name => name === 'demo-1' ? { ok: true } : null };
  const api = createRemoteHostsApi({ monitor, enabled: () => enabled, now: () => 1,
    sendJson: (res, status, body) => { reply = { status, body }; } });
  const get = (action, query = {}) => api.route(action, { method: 'GET' }, {}, query);
  assert.equal(get('remote-hosts'), true); assert.equal(reply.status, 200); assert.equal(reply.body.hosts.length, 1);
  enabled = false; get('remote-hosts'); assert.deepEqual(reply.body, { ok: true, disabled: true, configError: null, hosts: [] }); enabled = true;
  get('remote-hosts/demo-1/perf', { range: '10m' }); assert.equal(reply.status, 200);
  get('remote-hosts/demo-1/perf', { range: 'bad' }); assert.deepEqual(reply, { status: 400, body: { ok: false, error: 'range 只能是 60s、10m、24h' } });
  for (const name of ['missing', 'Demo', 'demo%2F1']) { get(`remote-hosts/${name}/processes`); assert.equal(reply.status, 404); assert.equal(reply.body.error, '没有这台远程机器'); }
  assert.equal(api.route('remote-hosts', { method: 'POST' }, {}, {}), false);
  assert.equal(get('snapshot'), false);
});
