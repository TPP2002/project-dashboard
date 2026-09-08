'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { readBoard } = require('../cli/store.cjs');
const freePort = require('../scripts/free-port.cjs');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server/server.cjs');
let server, dir, registry, base;

function startServer(port) {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [SERVER], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, DASHBOARD_REGISTRY: registry, DASHBOARD_HOME: dir,
        DASHBOARD_PORT: String(port), DASHBOARD_NO_OPEN: '1', DASHBOARD_NO_RESTART: '1',
        DASHBOARD_EVENT_WEBHOOK: '', DASHBOARD_POLL_MS: '500' },
    });
    let out = '', err = '', settled = false;
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(url);
    };
    const timer = setTimeout(() => finish(new Error(`server 启动超时\n${out}\n${err}`)), 15000);
    server.stdout.setEncoding('utf8');
    server.stderr.setEncoding('utf8');
    server.stdout.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) finish(null, `http://127.0.0.1:${match[1]}`);
    });
    server.stderr.on('data', (chunk) => { err += chunk; });
    server.on('error', (error) => finish(error));
    server.on('exit', (code) => finish(new Error(`server 提前退出 ${code}\n${out}\n${err}`)));
  });
}

function stopServer() {
  if (!server || !server.pid || server.exitCode !== null || server.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
    server.kill();
  });
}

before(async () => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'human-channel-server-')));
  registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  base = await startServer(await freePort());
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.pid, server.pid, '只向本测试拥有的进程发请求');
});
after(async () => {
  await stopServer();
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function project(id, status = '施工中') {
  const root = path.join(dir, id);
  fs.mkdirSync(root);
  cmds.register({ id, name: id, root, registry });
  const P = { project: id, registry };
  cmds.add({ ...P, _: ['P01'], title: '负责人操作测试', 'plain-title': '网页可以直接留下说明', status });
  // 用语义 CLI 构造历史缺三件套的决策，服务和测试都不手编 board。
  cmds.set({ ...P, _: ['P01'], field: 'decisions', value: JSON.stringify([
    { id: 'd1', question: '选哪个方案？', options: ['A', 'B'], recommended: 'A', answer: null, decidedAt: null },
  ]) });
  return { id, P, board: path.join(root, '.dashboard/board.json') };
}
async function post(p, action, body, origin = base) {
  const res = await fetch(`${base}/api/task/${p.id}/P01/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin === null ? {} : { origin }) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
function success(result, p) {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  const board = readBoard(p.board);
  assert.equal(board.activity.at(-1).author, '负责人');
  assert.equal(board.activity.at(-1).taskId, 'P01');
  return { task: board.tasks[0], activity: board.activity.at(-1) };
}

test('POST note：正文按字面落库，强制负责人署名，无 Origin 本机调用也可用', async () => {
  const p = project('note-ok');
  const text = '请保留引号 "原文"、分号 ;、& | 和 $(echo literal)\n第二行说明';
  const result = await post(p, 'note', { text, author: '冒充别人', from: '施工方' }, null);
  const { task, activity } = success(result, p);
  assert.equal(task.status, '施工中');
  assert.equal(activity.kind, 'message');
  assert.equal(activity.text, text);
});

test('POST park：暂缓理由与可选遗留说明写进卡', async () => {
  const p = project('park-ok');
  const reason = '先等上游完成确认';
  const note = '保留当前工作内容';
  const { task, activity } = success(await post(p, 'park', { reason, note }), p);
  assert.equal(task.status, '暂缓');
  assert.equal(task.blockReason, reason);
  assert.equal(task.parkedNote, note);
  assert.equal(activity.type, 'park');
});

test('POST unpark：从暂缓转可复工并保存解除理由', async () => {
  const p = project('unpark-ok');
  cmds.park({ ...p.P, _: ['P01'], reason: '上游还没有完成', note: '保持现场' });
  const reason = '上游已交付可以继续';
  const { task, activity } = success(await post(p, 'unpark', { reason }), p);
  assert.equal(task.status, '可复工');
  assert.equal(task.unparkReason, reason);
  assert.equal(task.blockReason, undefined);
  assert.equal(task.parkedNote, undefined);
  assert.equal(activity.type, 'unpark');
});

test('POST cancel：作废理由和活动真实写入', async () => {
  const p = project('cancel-ok');
  const reason = '重复事项统一作废';
  const { task, activity } = success(await post(p, 'cancel', { reason }), p);
  assert.equal(task.status, '已作废');
  assert.equal(task.cancelReason, reason);
  assert.equal(activity.type, 'cancel');
});

test('POST reopen：已完工卡重开，进度与完工日期按 CLI 归零', async () => {
  const p = project('reopen-ok');
  cmds.done({ ...p.P, _: ['P01'] });
  const reason = '验收发现缺项需要补做';
  const { task, activity } = success(await post(p, 'reopen', { reason }), p);
  assert.equal(task.status, '待开工');
  assert.equal(task.percent, 0);
  assert.equal(task.dates.done, null);
  assert.equal(task.reopenReason, reason);
  assert.equal(activity.type, 'reopen');
});

test('POST request-info：活动、缺字段列表与要求时间真实写入', async () => {
  const p = project('request-ok');
  const missing = ['background', 'optionPros', 'recommendReason'];
  const result = await post(p, 'request-info', { did: 'd1', missing });
  const { task, activity } = success(result, p);
  assert.equal(task.status, '施工中');
  assert.equal(task.decisions[0].answer, null);
  assert.match(task.decisions[0].infoRequestedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(activity.ts, task.decisions[0].infoRequestedAt);
  assert.equal(activity.kind, 'request-info');
  assert.equal(activity.did, 'd1');
  assert.deepEqual(activity.missing, missing);
  assert.equal(activity.text, '负责人要求补齐 d1 的三件套：background、optionPros、recommendReason');
  assert.deepEqual(result.body.changed, ['decisions']);
});

test('六个接口缺必填或类型不正确均 400，板的原始字节不变', async () => {
  const p = project('missing-fields');
  const before = fs.readFileSync(p.board, 'utf8');
  const cases = [
    ['note', {}], ['note', { text: '   ' }], ['note', { text: 1 }],
    ['park', {}], ['unpark', {}], ['cancel', {}], ['reopen', {}],
    ['park', { reason: '正常理由', note: {} }], ['cancel', { reason: [] }],
    ['request-info', {}], ['request-info', { missing: ['background'] }],
    ['request-info', { did: 'd1' }], ['request-info', { did: 'd1', missing: [] }],
    ['request-info', { did: 'd1', missing: 'background' }],
    ['request-info', { did: 'd1', missing: [null] }], ['note', null], ['park', []],
  ];
  for (const [action, body] of cases) {
    const result = await post(p, action, body);
    assert.equal(result.status, 400, action + ' ' + JSON.stringify(body));
    assert.equal(result.body.ok, false);
    assert.ok(result.body.error);
    assert.equal(fs.readFileSync(p.board, 'utf8'), before);
  }
});

test('六个接口伪造 Origin 均 403 且不落库', async () => {
  const requests = [
    ['note', { text: '跨站留言不能写入' }, '施工中'],
    ['park', { reason: '跨站暂缓不能写入' }, '施工中'],
    ['unpark', { reason: '跨站复工不能写入' }, '暂缓'],
    ['cancel', { reason: '跨站作废不能写入' }, '施工中'],
    ['reopen', { reason: '跨站重开不能写入' }, '已作废'],
    ['request-info', { did: 'd1', missing: ['background'] }, '施工中'],
  ];
  for (const [action, body, status] of requests) {
    const p = project('forged-' + action, status);
    const before = fs.readFileSync(p.board, 'utf8');
    const result = await post(p, action, body, 'https://evil.example.com');
    assert.equal(result.status, 403, action);
    assert.match(result.body.error, /跨站请求被拒/);
    assert.equal(fs.readFileSync(p.board, 'utf8'), before, action);
  }
});

test('施工中卡 reopen 返回 400，CLI 的 stderr 原样透出且不落库', async () => {
  const p = project('reopen-rejected');
  const before = fs.readFileSync(p.board, 'utf8');
  const reason = '正在施工不能重开';
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'cli/index.cjs'), 'reopen', 'P01',
    '--project', p.id, '--registry', registry, '--reason', reason, '--author', '负责人', '--json'],
  { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(cli.status, 1, cli.stderr);
  const result = await post(p, 'reopen', { reason });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, cli.stderr.trim());
  assert.match(result.body.error, /reopen 非法迁移：施工中 → 待开工/);
  assert.equal(fs.readFileSync(p.board, 'utf8'), before);
});

test('request-info 非法 missing 和已答决策由 CLI 拒绝，400 且不落库', async () => {
  const p = project('request-rejected');
  let before = fs.readFileSync(p.board, 'utf8');
  const bad = await post(p, 'request-info', { did: 'd1', missing: ['answer'] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /--missing/);
  assert.equal(fs.readFileSync(p.board, 'utf8'), before);
  cmds.decide({ ...p.P, _: ['P01'], did: 'd1', answer: 'A' });
  before = fs.readFileSync(p.board, 'utf8');
  const answered = await post(p, 'request-info', { did: 'd1', missing: ['background'] });
  assert.equal(answered.status, 400);
  assert.match(answered.body.error, /已答/);
  assert.equal(fs.readFileSync(p.board, 'utf8'), before);
});
