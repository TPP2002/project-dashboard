'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createPerksApi } = require('../server/perksApi.cjs');
const TOKEN = 'abcdef0123456789abcdef0123456789';
const REPO = 'C:/path/to/perks';

async function fixture(t, opts = {}) {
  const children = [], calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; }; child.unref = () => { child.unrefed = true; };
    children.push({ child, command, args, options });
    setImmediate(() => { if (opts.start) opts.start(child); else child.stdout.write(JSON.stringify({ port: 12345, token: TOKEN }) + '\n'); });
    return child;
  };
  const api = createPerksApi({
    sendJson(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); },
    readBody(req, max, cb) { let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => cb(raw.length > max ? Error() : null, raw)); },
    bodyMax: 4096, resolvePerksRepo: () => opts.repo === undefined ? REPO : opts.repo,
    isCollaboration: !!opts.collaboration, isLocalRequest: () => !opts.remote,
    fileExists: () => opts.exists !== false, spawn,
    fetch: async (url, init) => { calls.push({ url, init }); return opts.fetch ? opts.fetch(url, init, calls.length) : { status: 200, json: async () => ({ value: 1 }) }; },
    startTimeoutMs: 40, heartbeatEveryMs: 10000, now: opts.now || (() => 100000),
  });
  const server = http.createServer((req, res) => { if (!api.route(new URL(req.url, 'http://localhost').pathname.slice(1), req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  async function request(path = '', body) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    const text = await res.text(); assert.equal(text.includes(TOKEN), false);
    return { status: res.status, body: JSON.parse(text) };
  }
  return { request, children, calls, port: server.address().port };
}

test('闸门、可用性和缺少仓库', async t => {
  for (const [opts, status, error] of [[{ collaboration: true }, 404, '每日福利只在本机看板里使用'], [{ remote: true }, 403, '请求来源不是本机']]) {
    const f = await fixture(t, opts); assert.deepEqual(await f.request('available'), { status, body: { ok: false, error } }); assert.equal(f.children.length, 0); assert.equal(f.calls.length, 0);
  }
  for (const [opts, available, error] of [[{ repo: null }, false, '这台电脑没接每日福利'], [{ exists: false }, false, '每日福利还没更新到能接看板的版本'], [{}, true, null]]) {
    const f = await fixture(t, opts); assert.deepEqual((await f.request('available')).body, { ok: true, available });
    if (error) assert.deepEqual(await f.request(), { status: 503, body: { ok: false, error } });
    assert.equal(f.children.length, 0);
  }
});

test('单飞启动、状态与续命', async t => {
  const f = await fixture(t); const [a, b] = await Promise.all([f.request(), f.request()]);
  assert.deepEqual(a, { status: 200, body: { ok: true, data: { value: 1 } } }); assert.deepEqual(a, b);
  assert.equal(f.children.length, 1); const c = f.children[0];
  assert.equal(c.command, process.execPath); assert.deepEqual(c.args, ['--import', 'tsx', 'src/cli.ts', 'panel', '--serve']);
  assert.deepEqual(c.options, { cwd: REPO, windowsHide: true, shell: false, detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
  assert.equal(c.child.unrefed, true); assert.equal(f.calls[0].url, 'http://127.0.0.1:12345/api/state');
  assert.equal(f.calls[0].init.headers['x-perks-token'], TOKEN); await f.request();
  assert.equal(f.calls[0].init.headers.host, '127.0.0.1:12345');
  assert.equal(f.children.length, 1); assert.equal(f.calls.filter(c => c.url.endsWith('/heartbeat')).length, 1);
});

test('启动失败和超时结束子进程', async t => {
  for (const start of [c => c.stdout.write('bad\n'), c => c.stdout.write(JSON.stringify({port: 65536, token: TOKEN}) + '\n'), c => c.stdout.write(JSON.stringify({port: 1234, token: 'BAD'}) + '\n'), c => c.emit('close', 1)]) {
    const f = await fixture(t, { start }); assert.equal((await f.request()).status, 502); assert.equal(f.children[0].child.killed, true);
  }
  const f = await fixture(t, { start: () => {} }); assert.deepEqual(await f.request(), { status: 504, body: { ok: false, error: '每日福利服务起得太慢' } }); assert.equal(f.children[0].child.killed, true);
});

test('转发故障和 403 重启一次', async t => {
  for (const fail of ['throw', 403]) {
    const f = await fixture(t, { fetch: async (url, init, n) => { if (n === 1) { if (fail === 'throw') throw Error(); return { status: 403 }; } return { status: 200, json: async () => ({value: 1}) }; } });
    assert.equal((await f.request()).status, 200); assert.equal(f.children.length, 2);
  }
  const f = await fixture(t, { fetch: async () => { throw Error(); } }); assert.deepEqual(await f.request(), { status: 502, body: { ok: false, error: '连不上每日福利服务' } }); assert.equal(f.children.length, 2);
});

test('动作白名单、字段校验及面板错误', async t => {
  const f = await fixture(t);
  const cases = [
    [{action:'run'}, '/api/run', {}], [{action:'stop'}, '/api/stop', {}],
    [{action:'login', account:'main', ids:['abc']}, '/api/login', {account:'main', ids:['abc']}],
    [{action:'schedule', on:true}, '/api/schedule', {on:true}],
    [{action:'account-add', name:'x', platformIds:['abc']}, '/api/accounts/add', {name:'x', platformIds:['abc']}],
    [{action:'account-update', id:'acct-1', enabled:false, platformIds:[]}, '/api/accounts/update', {id:'acct-1', enabled:false, platformIds:[]}],
  ];
  for (const [body, path, payload] of cases) { assert.equal((await f.request('action', body)).status, 200); const call = f.calls.at(-1); assert.ok(call.url.endsWith(path)); assert.deepEqual(JSON.parse(call.init.body), payload); assert.equal(call.init.headers['content-type'], 'application/json'); }
  for (const [body, error] of [[{action:'bad'}, '不认识的操作'], [{action:'login', account:'bad'}, '账号编号格式不对'], [{action:'login', ids:[]}, '平台编号格式不对'], [{action:'login', ids:['Bad']}, '平台编号格式不对'], [{action:'schedule'}, '缺少开关状态'], [{action:'account-add', name:'\n', platformIds:['abc']}, '名字不合规'], [{action:'account-add', name:'x', platformIds:[]}, '平台编号格式不对'], [{action:'account-update', id:'bad'}, '账号编号格式不对'], [{action:'account-update', id:'main', name:''}, '名字不合规'], [{action:'account-update', id:'main', platformIds:['Bad']}, '平台编号格式不对'], [{action:'account-update', id:'main', enabled:1}, '参数不对']]) {
    const count = f.calls.length; assert.deepEqual(await f.request('action', body), {status:400, body:{ok:false,error}}); assert.equal(f.calls.length, count);
  }
  for (const status of [400, 409, 500]) { const g = await fixture(t, { fetch: async () => ({status, json: async () => ({error:'错误'})}) }); const result = await g.request('action', {action:'run'}); assert.deepEqual(result, status === 500 ? {status:502, body:{ok:false,error:'每日福利服务没按预期回应'}} : {status, body:{ok:false,error:'错误'}}); }
});

test('非法请求体和超长请求体不启动服务', async t => {
  const f = await fixture(t);
  for (const [body, status, error] of [['{', 400, '请求内容格式有误'], ['[]', 400, '请求内容格式有误'], ['x'.repeat(4097), 413, '请求内容太长']]) {
    const res = await fetch(`http://127.0.0.1:${f.port}/action`, {method:'POST', body});
    assert.equal(res.status, status); assert.deepEqual(await res.json(), {ok:false,error});
  }
  assert.equal(f.children.length, 0); assert.equal(f.calls.length, 0);
});

test('面板异常内容和敏感信息不会返回页面', async t => {
  for (const value of [[], null, { secret: TOKEN }]) {
    const f = await fixture(t, { fetch: async () => ({status:200, json:async () => value}) });
    assert.deepEqual(await f.request(), {status:502, body:{ok:false,error:'每日福利服务没按预期回应'}});
  }
  const g = await fixture(t, { fetch: async () => ({status:200, json:async () => ({port: 12345})}) });
  assert.deepEqual(await g.request(), {status:200, body:{ok:true,data:{port: 12345}}});
  const h = await fixture(t, { fetch: async () => ({status:200, json:async () => ({startedAt: 1794412345000})}) });
  assert.deepEqual(await h.request(), {status:200, body:{ok:true,data:{startedAt: 1794412345000}}});
  const f = await fixture(t, { fetch: async () => ({status:409, json:async () => ({error:'x'.repeat(250)})}) });
  assert.deepEqual(await f.request('action', {action:'run'}), {status:409, body:{ok:false,error:'x'.repeat(200)}});
});

test('续命间隔到期后再次续命', async t => {
  let clock = 100000;
  const f = await fixture(t, { now: () => clock });
  await f.request(); clock += 10000; await f.request();
  assert.equal(f.calls.filter(c => c.url.endsWith('/heartbeat')).length, 1);
  clock++; await f.request();
  assert.equal(f.calls.filter(c => c.url.endsWith('/heartbeat')).length, 2);
});
