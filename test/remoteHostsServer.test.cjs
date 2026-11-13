'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('./fixtures/sched/support.cjs');

test('真实服务无配置时返回空列表且原有调度接口可读', async t => {
  const previous = process.env.DASHBOARD_REMOTE_HOSTS_FILE;
  process.env.DASHBOARD_REMOTE_HOSTS_FILE = path.join(os.tmpdir(), `remote-hosts-absent-${process.pid}-${Date.now()}`, 'missing.json');
  let server;
  try { server = await startServer(t); } finally {
    if (previous === undefined) delete process.env.DASHBOARD_REMOTE_HOSTS_FILE;
    else process.env.DASHBOARD_REMOTE_HOSTS_FILE = previous;
  }
  const list = await server.json('/api/sched/remote-hosts');
  assert.equal(list.status, 200); assert.equal(list.body.ok, true); assert.deepEqual(list.body.hosts, []);
  assert.equal((await server.json('/api/sched/remote-hosts/nope/perf')).status, 404);
  assert.equal((await server.json('/api/sched/snapshot')).status, 200);
  await server.stop();
});
