'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const freePort = require('../scripts/free-port.cjs');

const ROOT = path.resolve(__dirname, '..');
const OFF = { codex: false, cost: false, cpu: false, reader: false, audition: false };
const ON = { codex: true, cost: true, cpu: true, reader: true, audition: true };

async function startServer(t, { modules, settings } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-modules-')));
  let child;
  t.after(async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {
    sample: { name: '临时项目', mainRepo: repo },
  } }));
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  const env = {
    ...process.env, DASHBOARD_HOME: dir, DASHBOARD_REGISTRY: registry,
    DASHBOARD_GLOBAL_SETTINGS: path.join(dir, 'global-settings.json'),
    DASHBOARD_CODEX_SESSIONS: path.join(dir, 'sessions'),
    DASHBOARD_EVENT_WEBHOOK: '', DASHBOARD_NO_OPEN: '1', DASHBOARD_POLL_MS: '500',
    DASHBOARD_PORT: String(await freePort()),
  };
  // 显式删除宿主开关，默认关闭用例不能依赖开发者的个人设置。
  delete env.DASHBOARD_MODULES;
  if (modules !== undefined) env.DASHBOARD_MODULES = modules;
  child = spawn(process.execPath, [path.join(ROOT, 'server/server.cjs')], { cwd: ROOT, env, windowsHide: true });
  const base = await new Promise((resolve, reject) => {
    let out = '', err = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`server 启动超时\n${out}\n${err}`)), 15000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      out += data;
      const match = out.match(/127\.0\.0\.1:(\d+)\//);
      if (match) finish(null, `http://127.0.0.1:${match[1]}`);
    });
    child.stderr.on('data', (data) => { err += data; });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`server 提前退出 ${code}\n${out}\n${err}`)));
  });
  async function json(endpoint, body) {
    const response = await fetch(base + endpoint, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { dir, json };
}

test('默认模块全关，菜单保存后立即放行；关闭后立即拦截', async (t) => {
  const srv = await startServer(t);
  assert.deepEqual((await srv.json('/api/health')).body.modules, OFF);
  for (const endpoint of ['/api/codex/jobs', '/api/cost', '/api/cpu', '/api/reader/xxx', '/api/audition/index']) {
    const result = await srv.json(endpoint);
    assert.equal(result.status, 404, endpoint);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /模块未启用/);
  }
  assert.equal((await srv.json('/api/cpu', { cores: 0 })).status, 404);
  const saved = await srv.json('/api/settings', { modules: { codex: true } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.settings.modules, { ...OFF, codex: true });
  assert.deepEqual(saved.body.settings.webhookEvents, { done: true, pending: true, block: true });
  const jobs = await srv.json('/api/codex/jobs?project=sample');
  assert.equal(jobs.status, 200);
  assert.deepEqual(jobs.body, []);
  assert.deepEqual((await srv.json('/api/health')).body.modules, { ...OFF, codex: true });
  const combined = await srv.json('/api/settings', { modules: { cost: true }, webhookEvents: { done: false } });
  assert.equal(combined.status, 200);
  assert.deepEqual(combined.body.settings.modules, { ...OFF, codex: true, cost: true });
  assert.equal(combined.body.settings.webhookEvents.done, false);
  await srv.json('/api/settings', { modules: { codex: false } });
  assert.equal((await srv.json('/api/codex/jobs?project=sample')).status, 404);
  const stored = JSON.parse(fs.readFileSync(path.join(srv.dir, 'settings.json'), 'utf8'));
  assert.deepEqual(stored.modules, { ...OFF, cost: true });
  assert.equal(stored.webhookEvents.done, false);
  fs.writeFileSync(path.join(srv.dir, 'settings.json'), JSON.stringify({ ...stored, modules: { reader: true } }));
  assert.deepEqual((await srv.json('/api/health')).body.modules, { ...OFF, reader: true });
});

test('非法模块名、非布尔值和非法设置结构返回 400，原设置不变', async (t) => {
  const srv = await startServer(t, { settings: { modules: { codex: true } } });
  const settingsPath = path.join(srv.dir, 'settings.json');
  const before = fs.readFileSync(settingsPath, 'utf8');
  for (const body of [
    { modules: { extra: true } }, { modules: { codex: 'true' } }, { modules: { cpu: 1 } },
    { modules: { reader: null } }, { modules: { audition: 'true' } }, { modules: null }, { modules: [] }, { modules: true },
    { modules: {}, extra: false }, {}, [], null,
  ]) {
    assert.equal((await srv.json('/api/settings', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), before);
});

test('DASHBOARD_MODULES=all 全开且优先于设置文件和菜单保存', async (t) => {
  const srv = await startServer(t, { modules: 'all', settings: { modules: OFF } });
  assert.deepEqual((await srv.json('/api/health')).body.modules, ON);
  assert.equal((await srv.json('/api/codex/jobs?project=sample')).status, 200);
  assert.equal((await srv.json('/api/settings', { modules: { codex: false } })).status, 200);
  assert.deepEqual((await srv.json('/api/health')).body.modules, ON);
});

test('逗号名单覆盖文件；未知名称不会开启模块', async (t) => {
  const srv = await startServer(t, { modules: ' codex, cost,unknown ', settings: { modules: ON } });
  assert.deepEqual((await srv.json('/api/health')).body.modules, { ...OFF, codex: true, cost: true });
});

test('脏模块字段回落关闭，合法布尔字段保留', async (t) => {
  const srv = await startServer(t, { settings: { modules: { codex: 'true', cpu: 1, reader: true, audition: 1, extra: true } } });
  assert.deepEqual((await srv.json('/api/health')).body.modules, { ...OFF, reader: true });
});

test('试听台模块保存后立即生效，关闭后读写都被拦截', async (t) => {
  const srv = await startServer(t);
  assert.equal((await srv.json('/api/settings', { modules: { audition: true } })).status, 200);
  assert.deepEqual((await srv.json('/api/health')).body.modules, { ...OFF, audition: true });
  const missing = await srv.json('/api/audition/index?project=sample');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, '本项目还没有试听清单');
  await srv.json('/api/settings', { modules: { audition: false } });
  for (const endpoint of ['index', 'batch', 'file', 'state']) {
    const result = await srv.json(`/api/audition/${endpoint}?project=sample`);
    assert.equal(result.status, 404); assert.match(result.body.error, /模块未启用/);
  }
  for (const endpoint of ['note', 'note/delete', 'mark', 'verdict', 'review', 'export']) {
    const result = await srv.json(`/api/audition/${endpoint}`, { project: 'sample', key: 'dir-r1' });
    assert.equal(result.status, 404); assert.match(result.body.error, /模块未启用/);
  }
});
