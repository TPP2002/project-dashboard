'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const cmds = require('../cli/commands.cjs');
const freePort = require('../scripts/free-port.cjs');

const DASH_ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(DASH_ROOT, 'server/server.cjs');
const POLL_MS = 500;
const TMP_ROOT = fs.realpathSync.native(os.tmpdir());

function fixture() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'dashboard-webhook-')));
  const registry = path.join(dir, 'registry.json');
  return { dir, registry };
}

function clean(dir) {
  assert.equal(path.dirname(dir), TMP_ROOT, '只清理由本测试创建的临时目录');
  assert.ok(path.basename(dir).startsWith('dashboard-webhook-'));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** 从 stdout 取实际监听端口；所有设置、注册表与子进程都隔离。 */
function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: DASH_ROOT, windowsHide: true,
      env: { ...process.env, DASHBOARD_NO_OPEN: '1', DASHBOARD_NO_RESTART: '1',
        DASHBOARD_EVENT_WEBHOOK: '', DASHBOARD_POLL_MS: String(POLL_MS), ...env },
    });
    let out = '', err = '', settled = false;
    const finish = (error, server) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) void stopServer(child).then(() => reject(error), reject);
      else resolve(server);
    };
    const timer = setTimeout(() => finish(new Error('server 启动超时\n' + out + '\n' + err)), 15000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      out += data;
      const match = out.match(/127\.0\.0\.1:(\d+)\//);
      if (match) finish(null, { child, base: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', (data) => { err += data; });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`server 提前退出 ${code}\n${out}\n${err}`)));
  });
}

function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (error) { reject(error); }
    }, 3000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    try { child.kill(); } catch (error) { clearTimeout(timeout); reject(error); }
  });
}

async function receiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    // 只收看板发来的 POST /events：全量并行跑测试时别的测试起的 server 会按 DASHBOARD_PORT 起往上探 9 个端口的
    // GET /api/health，撞上这个接收器就会被记成一条「推送」，让「初始基线不补发」偶红（0908 两次实踩，AD-20260908-WEBHOOK-TEST-FLAKE）。
    if (req.method !== 'POST' || req.url !== '/events') { req.resume(); res.writeHead(404); res.end(); return; }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { received.push({ method: req.method, headers: req.headers, body: JSON.parse(raw) }); }
      catch (_) { received.push({ invalidJson: raw }); }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, received, url: `http://127.0.0.1:${server.address().port}/events` };
}

async function waitFor(check, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(50);
  }
  assert.fail('等待超时：' + description);
}

async function json(server, pathname, body, headers = {}) {
  const response = await fetch(server.base + pathname, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...headers } }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}

test('真实事件推送、初始基线、服务端事件选择与同源设置校验', { timeout: 30000 }, async () => {
  const f = fixture();
  let sink, server;
  try {
    sink = await receiver();
    const root = path.join(f.dir, 'project');
    fs.mkdirSync(root);
    cmds.register({ id: 'wire', name: '桌面灯测试', root, registry: f.registry });
    const flags = { project: 'wire', registry: f.registry };
    cmds.add({ ...flags, _: ['OLD'], title: '启动前的旧卡' });
    cmds.done({ ...flags, _: ['OLD'] });
    cmds.add({ ...flags, _: ['T1'], title: '技术说明', 'plain-title': '给桌上的灯一个完工提示' });
    server = await startServer({ DASHBOARD_PORT: String(await freePort()),
      DASHBOARD_REGISTRY: f.registry, DASHBOARD_HOME: f.dir, DASHBOARD_EVENT_WEBHOOK: sink.url });
    const initial = await json(server, '/api/health');
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.webhook, { configured: true, events: { done: true, pending: true, block: true } });
    assert.ok(!JSON.stringify(initial.body).includes(sink.url), '健康信息不能回显推送地址');
    await delay(POLL_MS + 100);
    assert.equal(sink.received.length, 0, '初始基线不补发历史完工');

    cmds.done({ ...flags, _: ['T1'] });
    await waitFor(() => sink.received.length === 1, '第一张卡完工推送');
    const message = sink.received[0];
    const board = JSON.parse(fs.readFileSync(path.join(root, '.dashboard/board.json'), 'utf8'));
    const activity = board.activity.find((entry) => entry.type === 'done' && entry.taskId === 'T1');
    assert.equal(message.method, 'POST');
    assert.match(message.headers['content-type'], /^application\/json/);
    assert.deepEqual(message.body, { event: 'done', project: 'wire', projectName: '桌面灯测试', task: 'T1',
      title: '给桌上的灯一个完工提示', status: '已完工', ts: activity.ts });
    assert.ok(Number.isFinite(Date.parse(message.body.ts)));

    const saved = await json(server, '/api/settings', { webhookEvents: { done: false } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { ok: true, settings: { webhookEvents: { done: false, pending: true, block: true }, modules: { codex: false, cost: false, cpu: false, reader: false, audition: false } } });
    const stored = JSON.parse(fs.readFileSync(path.join(f.dir, 'settings.json'), 'utf8'));
    assert.deepEqual(stored.webhookEvents, saved.body.settings.webhookEvents);
    cmds.add({ ...flags, _: ['T2'], title: '不该推送的完工' });
    cmds.done({ ...flags, _: ['T2'] });
    await delay(POLL_MS * 3 + 100);
    assert.equal(sink.received.length, 1, '关闭完工后不发送，也不重复之前的事件');
    const health = await json(server, '/api/health');
    assert.equal(health.body.webhook.configured, true);
    assert.equal(health.body.webhook.events.done, false);

    for (const invalid of [null, [], {}, { webhookEvents: [] }, { webhookEvents: { done: 'false' } },
      { webhookEvents: { pending: null } }, { webhookEvents: { extra: true } },
      { webhookEvents: {}, address: 'http://example.invalid' }]) {
      assert.equal((await json(server, '/api/settings', invalid)).status, 400);
    }
    assert.equal((await json(server, '/api/settings', { webhookEvents: { done: true } },
      { Origin: 'https://example.invalid' })).status, 403);
    assert.deepEqual((await json(server, '/api/health')).body.webhook.events, stored.webhookEvents);

    cmds.add({ ...flags, _: ['BLOCK'], title: '没有人话标题时使用技术标题' });
    cmds.block({ ...flags, _: ['BLOCK'], by: 'T2', reason: '等待上游' });
    await waitFor(() => sink.received.length === 2, '仍开启的阻塞推送');
    assert.deepEqual(sink.received[1].body, { event: 'block', project: 'wire', projectName: '桌面灯测试',
      task: 'BLOCK', title: '没有人话标题时使用技术标题', status: '未开工', ts: sink.received[1].body.ts });
    assert.ok(Number.isFinite(Date.parse(sink.received[1].body.ts)));

    cmds.add({ ...flags, _: ['PENDING'], title: '待拍板接线测试', 'plain-title': '有一个新的问题等你决定' });
    cmds.pending({ ...flags, _: ['PENDING'], q: '测试接收器先观察哪一类提醒？', opt: ['甲', '乙'], rec: '甲',
      background: '【场景】本地接收器已验证完工和阻塞消息，现在需要确认待拍板也经过同一个推送出口。'
        + '【问题】遗漏此类事件会让桌上灯带无法提醒负责人回来处理。'
        + '【要做的事】在临时项目登记完整问题，检查接收器收到事件并保留卡号与状态。',
      'pros-甲': '【好处】先观察待拍板，可验证橙色提醒接线。【代价】需要多登记一个临时问题。',
      'pros-乙': '【好处】只看完工事件，检查步骤更少。【代价】不能证明待拍板事件已经接通。',
      reason: '推荐先验证待拍板，因为完工和阻塞已经覆盖，补上此项才能证明三个独立事件选择都能实际发出消息。' });
    await waitFor(() => sink.received.length === 3, '仍开启的待拍板推送');
    assert.deepEqual(sink.received[2].body, { event: 'pending', project: 'wire', projectName: '桌面灯测试',
      task: 'PENDING', title: '有一个新的问题等你决定', status: '待拍板', ts: sink.received[2].body.ts });
    assert.ok(Number.isFinite(Date.parse(sink.received[2].body.ts)));

    await stopServer(server.child);
    server = await startServer({ DASHBOARD_PORT: String(await freePort()), DASHBOARD_HOME: f.dir,
      DASHBOARD_REGISTRY: f.registry, DASHBOARD_EVENT_WEBHOOK: sink.url });
    assert.deepEqual((await json(server, '/api/health')).body.webhook.events, stored.webhookEvents);
    await delay(POLL_MS + 100);
    assert.equal(sink.received.length, 3, '重启只重新建基线，设置保留且旧活动不重发');
  } finally {
    try { await stopServer(server?.child); }
    finally {
      if (sink) await new Promise((resolve) => sink.server.close(resolve));
      clean(f.dir);
    }
  }
});

test('没有推送地址或协议不符时显示未配置，坏设置回落默认', { timeout: 30000 }, async () => {
  for (const address of ['', 'file:///not-a-webhook']) {
    const f = fixture();
    let server;
    try {
      fs.writeFileSync(path.join(f.dir, 'settings.json'), '{broken');
      server = await startServer({ DASHBOARD_PORT: String(await freePort()), DASHBOARD_HOME: f.dir,
        DASHBOARD_REGISTRY: f.registry, DASHBOARD_EVENT_WEBHOOK: address });
      const health = await json(server, '/api/health');
      assert.equal(health.status, 200);
      assert.deepEqual(health.body.webhook, { configured: false, events: { done: true, pending: true, block: true } });
    } finally {
      await stopServer(server?.child);
      clean(f.dir);
    }
  }
});
