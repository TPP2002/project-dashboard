'use strict';
/**
 * 账号与额度接口的隔离测试：只用工厂 + 假 spawn + 临时 http 服务。
 * 不起真派单器、不起真看板 server、不碰真 registry 与账号登记、不碰网络。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  createResourcesApi, buildAction, validateAction, validateId, validateProvider,
  validateLabel, validateKeyFile, validateModel, DISPATCHER_ENTRY, ACTIONS, PROVIDERS,
} = require('../server/resourcesApi.cjs');

// 夹具路径一律占位写法，不写真实本机目录（noLocalIdentifiers 闸会扫）。
const FAKE_REPO = 'C:/path/to/dispatcher';
const KEY_FILE = 'C:/path/to/key.txt';
const SENTINEL = 'SENTINEL-DO-NOT-LEAK';
const READ_ARGS = [...DISPATCHER_ENTRY, 'list', '--json'];

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.unrefCalled = false;
  // 真 kill 之后 close 是异步来的；假子进程只记标记，避免同步 close 抢在 504 之前。
  child.kill = () => { child.killed = true; };
  child.unref = () => { child.unrefCalled = true; };
  return child;
}

/** 写完输出再发 close —— 监听器在 spawn 返回后才挂，所以统一走 setImmediate。 */
function emit(child, code, outText = '', errText = '') {
  if (outText) child.stdout.write(outText);
  child.stdout.end();
  if (errText) child.stderr.write(errText);
  child.stderr.end();
  child.emit('close', code);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function snapshotPayload() {
  return {
    formatVersion: 1,
    generatedAt: '2026-11-10T02:00:00.000Z',
    accounts: [{
      id: 'qoder-1', provider: 'qoder', providerName: 'Qoder', label: '主号', enabled: true,
      home: 'C:/path/to/' + SENTINEL, keyFile: 'C:/path/to/' + SENTINEL + '.txt',
      login: { status: 'ok', checkedAt: null, reason: null },
      quota: null, limits: [], lastUsedAt: null, running: 0,
    }],
    providers: [{ provider: 'qoder', providerName: 'Qoder', accountCount: 1, enabledCount: 1, gate: { open: true, reason: null } }],
    ladders: { light: [], standard: [], hard: [] },
  };
}

async function fixture(t, options = {}) {
  const calls = [];
  let handler = options.handler || ((child) => emit(child, 0, '', ''));
  const spawn = (command, args, spawnOptions) => {
    const child = makeChild();
    calls.push({ command, args, options: spawnOptions, child });
    const run = handler;
    setImmediate(() => run(child, args));
    return child;
  };
  const api = createResourcesApi({
    sendJson(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    },
    readBody(req, max, callback) {
      const chunks = []; let size = 0;
      req.on('data', (chunk) => { chunks.push(chunk); size += chunk.length; });
      req.on('end', () => callback(size > max ? new Error('请求过大') : null, Buffer.concat(chunks).toString('utf8')));
    },
    bodyMax: 4096,
    resolveDispatcherRepo: () => (Object.prototype.hasOwnProperty.call(options, 'repo') ? options.repo : FAKE_REPO),
    isCollaboration: Boolean(options.collaboration),
    isLocalRequest: options.isLocalRequest || (() => true),
    spawn: options.spawn || spawn,
    fileExists: options.fileExists || (() => true),
    readTimeoutMs: options.readTimeoutMs,
    actionTimeoutMs: options.actionTimeoutMs,
    loginWaitMs: options.loginWaitMs,
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const sub = url.pathname.replace(/^\/api\/resources\/?/, '');
    if (!api.route(sub, req, res)) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  });
  const base = `http://127.0.0.1:${server.address().port}/api/resources`;

  async function request(sub, body, raw) {
    const init = body === undefined && raw === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw === undefined ? JSON.stringify(body) : raw,
    };
    const res = await fetch(`${base}${sub}`, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 由用例断言 */ }
    return { status: res.status, body: json, text };
  }
  return {
    api, calls, request,
    read: () => request(''),
    act: (body) => request('/action', body),
    setHandler(next) { handler = next; },
  };
}

// —— (a) 读成功 ——
test('读成功：删掉 home 与 keyFile，参数与 cwd 都对', async (t) => {
  const f = await fixture(t, { handler: (child) => emit(child, 0, JSON.stringify(snapshotPayload()) + '\n') });
  const result = await f.read();
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  const account = result.body.data.accounts[0];
  assert.equal(account.id, 'qoder-1');
  assert.equal(Object.prototype.hasOwnProperty.call(account, 'home'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(account, 'keyFile'), false);
  assert.equal(result.text.includes(SENTINEL), false);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, READ_ARGS);
  assert.equal(f.calls[0].options.cwd, FAKE_REPO);
  assert.equal(f.calls[0].command, process.execPath);
});

// —— (b) 读失败各分支 ——
test('读失败：退出码非 0 回 502 且取最后一行输出', async (t) => {
  const f = await fixture(t, { handler: (child) => emit(child, 1, '', 'tsx 吵了一句\n派单器说读不出来\n') });
  const result = await f.read();
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { ok: false, error: '派单器说读不出来' });
});

test('读失败：stdout 不是 JSON', async (t) => {
  const f = await fixture(t, { handler: (child) => emit(child, 0, '这不是 JSON\n') });
  const result = await f.read();
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { ok: false, error: '派单器返回的内容读不懂' });
});

test('读失败：formatVersion 不是 1', async (t) => {
  const f = await fixture(t, { handler: (child) => emit(child, 0, JSON.stringify({ formatVersion: 2, accounts: [] })) });
  const result = await f.read();
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { ok: false, error: '账号数据的格式版本看板不认识' });
});

test('读失败：超时回 504 并 kill 子进程', async (t) => {
  const f = await fixture(t, { readTimeoutMs: 20, handler: () => { /* 一直不退出 */ } });
  const result = await f.read();
  assert.equal(result.status, 504);
  assert.deepEqual(result.body, { ok: false, error: '派单器命令超时' });
  assert.equal(f.calls[0].child.killed, true);
});

test('读失败：spawn 抛错回 500', async (t) => {
  const f = await fixture(t, { spawn: () => { throw new Error('没有权限'); } });
  const result = await f.read();
  assert.equal(result.status, 500);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error, '启动派单器命令失败:没有权限');
});

// —— (c) 仓定位失败 ——
test('找不到派单器仓回 503', async (t) => {
  const f = await fixture(t, { repo: null });
  const result = await f.read();
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { ok: false, error: '找不到派单器仓,读不了账号' });
  assert.equal(f.calls.length, 0);
});

test('仓里没有账号管理命令回 503', async (t) => {
  const f = await fixture(t, { fileExists: () => false });
  const result = await f.read();
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { ok: false, error: '派单器仓里没有账号管理命令,先把派单器更新到最新' });
  assert.equal(f.calls.length, 0);
});

// —— (d) 协作模式 / 非本机 ——
test('协作模式：GET 与 POST 都 404，且不起子进程', async (t) => {
  const f = await fixture(t, { collaboration: true });
  const read = await f.read();
  assert.equal(read.status, 404);
  assert.deepEqual(read.body, { ok: false, error: '账号与额度只在本机看板里使用' });
  const write = await f.act({ action: 'refresh' });
  assert.equal(write.status, 404);
  assert.deepEqual(write.body, { ok: false, error: '账号与额度只在本机看板里使用' });
  assert.equal(f.calls.length, 0);
});

test('非本机 Host：GET 与 POST 都 403，且不起子进程', async (t) => {
  const f = await fixture(t, { isLocalRequest: () => false });
  const read = await f.read();
  assert.equal(read.status, 403);
  assert.deepEqual(read.body, { ok: false, error: '请求来源不是本机' });
  const write = await f.act({ action: 'refresh' });
  assert.equal(write.status, 403);
  assert.deepEqual(write.body, { ok: false, error: '请求来源不是本机' });
  assert.equal(f.calls.length, 0);
});

// —— (e) 写动作参数映射 ——
test('写动作参数映射：每条命令的 args 全量对齐', async (t) => {
  const f = await fixture(t, { handler: (child) => emit(child, 0, '好了\n') });
  const cases = [
    [{ action: 'add', provider: 'qoder', label: '副号' }, ['add', 'qoder', '--label', '副号']],
    [{ action: 'add', provider: 'qoder' }, ['add', 'qoder']],
    [{ action: 'add', provider: 'deepseek', label: '深度', keyFile: KEY_FILE }, ['add', 'deepseek', '--label', '深度', '--key-file', KEY_FILE]],
    [{ action: 'add', provider: 'claude', keyFile: KEY_FILE }, ['add', 'claude', '--key-file', KEY_FILE]],
    [{ action: 'login', id: 'qoder-1' }, ['login', 'qoder-1']],
    [{ action: 'enable', id: 'qoder-1' }, ['enable', 'qoder-1']],
    [{ action: 'disable', id: 'qoder-1' }, ['disable', 'qoder-1']],
    [{ action: 'remove', id: 'qoder-1' }, ['remove', 'qoder-1']],
    [{ action: 'refresh', id: 'qoder-1' }, ['refresh', 'qoder-1']],
    [{ action: 'refresh' }, ['refresh']],
    [{ action: 'clear-limit', id: 'qoder-1', model: '*' }, ['clear-limit', 'qoder-1', '--model', '*']],
    [{ action: 'clear-limit', id: 'qoder-1' }, ['clear-limit', 'qoder-1']],
  ];
  for (const [body, expected] of cases) {
    const before = f.calls.length;
    const result = await f.act(body);
    assert.equal(result.status, 200, JSON.stringify(body));
    assert.equal(f.calls.length, before + 1, JSON.stringify(body));
    assert.deepEqual(f.calls[before].args, [...DISPATCHER_ENTRY, ...expected], JSON.stringify(body));
  }
});

// —— (f) 白名单拒绝 ——
test('白名单拒绝：一律 400、文案对、零 spawn', async (t) => {
  const f = await fixture(t);
  const cases = [
    [{ action: 'login', id: 'Qoder-1' }, '账号编号格式不对'],
    [{ action: 'login', id: 'qoder-' }, '账号编号格式不对'],
    [{ action: 'login', id: 'qoder-1; rm -rf /' }, '账号编号格式不对'],
    [{ action: 'login', id: '../x' }, '账号编号格式不对'],
    [{ action: 'login', id: 'qoder-1\n' }, '账号编号格式不对'],
    [{ action: 'add', provider: 'unknown' }, '平台不认识'],
    [{ action: 'add', provider: 'Qoder' }, '平台不认识'],
    [{ action: 'add', provider: 'qoder', label: 'x'.repeat(21) }, '名字不合规'],
    [{ action: 'add', provider: 'qoder', label: 'a\nb' }, '名字不合规'],
    [{ action: 'add', provider: 'qoder', label: '-abc' }, '名字不合规'],
    [{ action: 'add', provider: 'qoder', label: 'a\tb' }, '名字不合规'],
    [{ action: 'add', provider: 'deepseek', keyFile: 'keys/x.txt' }, '密钥文件路径不合规'],
    [{ action: 'add', provider: 'deepseek', keyFile: 'C:/path/to/a\nb.txt' }, '密钥文件路径不合规'],
    [{ action: 'add', provider: 'deepseek', keyFile: "C:/path/to/o'brien.txt" }, '密钥文件路径不合规'],
    [{ action: 'add', provider: 'deepseek', keyFile: 'C:/path/to/a"b.txt' }, '密钥文件路径不合规'],
    [{ action: 'add', provider: 'deepseek', keyFile: 'C:/path/to/../secret.txt' }, '密钥文件路径不合规'],
    [{ action: 'add', provider: 'deepseek', keyFile: 'C:/path/to/' + 'a'.repeat(500) }, '密钥文件路径不合规'],
    [{ action: 'add', provider: 'deepseek' }, '缺少密钥文件路径'],
    [{ action: 'add', provider: 'qoder', keyFile: KEY_FILE }, '这个平台不用密钥文件'],
    [{ action: 'clear-limit', id: 'qoder-1', model: 'a b' }, '模型名不合规'],
    [{ action: 'clear-limit', id: 'qoder-1', model: 'a;b' }, '模型名不合规'],
    [{ action: 'delete', id: 'qoder-1' }, '不认识的操作'],
  ];
  for (const [body, error] of cases) {
    const result = await f.act(body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.deepEqual(result.body, { ok: false, error }, JSON.stringify(body));
  }
  assert.equal(f.calls.length, 0);

  const broken = await f.request('/action', undefined, '{不是 JSON');
  assert.equal(broken.status, 400);
  assert.deepEqual(broken.body, { ok: false, error: '请求内容格式有误' });
  assert.equal(f.calls.length, 0);
});

test('白名单校验函数可单独断言', () => {
  assert.equal(validateAction('refresh'), null);
  assert.equal(validateAction('delete'), '不认识的操作');
  assert.equal(validateId('qoder-1'), null);
  assert.equal(validateId('qoder-1 '), '账号编号格式不对');
  assert.equal(validateProvider('claude'), null);
  assert.equal(validateProvider('Claude'), '平台不认识');
  assert.equal(validateLabel(' 主号 '), null);
  assert.equal(validateLabel(' '), '名字不合规');
  assert.equal(validateLabel('x'.repeat(20)), null);
  assert.equal(validateKeyFile('C:/path/to/key.txt'), null);
  assert.equal(validateKeyFile('/home/demo/key.txt'), null);
  assert.equal(validateKeyFile('C:\\path\\to\\key.txt'), null);
  assert.equal(validateModel('claude-sonnet-4-5'), null);
  assert.equal(validateModel('*'), null);
  assert.deepEqual([...ACTIONS].sort(), ['add', 'clear-limit', 'disable', 'enable', 'login', 'refresh', 'remove']);
  assert.deepEqual([...PROVIDERS].sort(), ['claude', 'codex', 'deepseek', 'qoder', 'trae', 'workbuddy']);
  assert.deepEqual(buildAction({ action: 'refresh' }), { args: ['refresh'], isLogin: false, loginId: null });
});

// —— (g) 命令退出码 ——
test('退出码 2 或 1 → 400，带 code 与最后一行', async (t) => {
  for (const code of [2, 1]) {
    const f = await fixture(t, { handler: (child) => emit(child, code, '第一行\n账号不存在\n') });
    const result = await f.act({ action: 'login', id: 'qoder-1' });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { ok: false, code, error: '账号不存在' });
  }
});

// —— (h) 登录类后台继续 ——
test('登录类：窗内没退出回 pending，不 kill，锁释放；同账号未完成再登录 409', async (t) => {
  const f = await fixture(t, {
    loginWaitMs: 30,
    handler: (child) => { child.stdout.write('打开授权页: https://example.org/authorize\n'); },
  });
  const first = await f.act({ action: 'login', id: 'qoder-1' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, pending: true, lastLine: '打开授权页: https://example.org/authorize' });
  assert.equal(f.calls[0].child.killed, false);
  assert.equal(f.calls[0].child.unrefCalled, true);

  const again = await f.act({ action: 'login', id: 'qoder-1' });
  assert.equal(again.status, 409);
  assert.deepEqual(again.body, { ok: false, error: '该账号正在登录' });

  // 后台那个子进程自己退出后，同账号可以再登录。
  const child = f.calls[0].child;
  f.setHandler((c) => emit(c, 0, '登录完成\n'));
  emit(child, 0, '', '');
  await delay(10);
  const third = await f.act({ action: 'login', id: 'qoder-1' });
  assert.equal(third.status, 200);
  assert.deepEqual(third.body, { ok: true, code: 0, lastLine: '登录完成' });
});

// —— (i) 写锁 ——
test('写锁：一个写命令没退出时再发写请求 409，退出后恢复', async (t) => {
  const f = await fixture(t, { actionTimeoutMs: 5000, handler: () => { /* 不退出 */ } });
  const pending = f.act({ action: 'enable', id: 'qoder-1' });
  await delay(20);
  const blocked = await f.act({ action: 'disable', id: 'qoder-1' });
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body, { ok: false, error: '上一个操作还没做完,稍后再试' });

  f.setHandler((child) => emit(child, 0, '好了\n'));
  emit(f.calls[0].child, 0, '好了\n');
  const first = await pending;
  assert.equal(first.status, 200);

  const after = await f.act({ action: 'disable', id: 'qoder-1' });
  assert.equal(after.status, 200);
  assert.equal(after.body.ok, true);
});

// —— (j) 静默起子进程 ——
test('所有 spawn 调用都静默、数组传参、command 是当前 node', async (t) => {
  const f = await fixture(t, { handler: (child) => emit(child, 0, JSON.stringify(snapshotPayload())) });
  await f.read();
  await f.act({ action: 'refresh' });
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.options.windowsHide, true);
    assert.notEqual(call.options.shell, true);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.ok(Array.isArray(call.args));
    for (const arg of call.args) assert.equal(typeof arg, 'string');
  }
});

// —— (k) 响应只回最后一行 ——
test('写响应只含约定字段，非最后一行里的哨兵不外泄', async (t) => {
  const f = await fixture(t, { handler: (child) => emit(child, 0, `${SENTINEL}-line\n最后一行\n`) });
  const result = await f.act({ action: 'refresh' });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['code', 'lastLine', 'ok']);
  assert.equal(result.body.lastLine, '最后一行');
  assert.equal(result.text.includes(SENTINEL), false);
});
