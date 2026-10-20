'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { fork, execFile, spawnSync } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const { opDigest, pruneReceipts, MAX_RECEIPTS } = require('../core/syncLedger.cjs');
const { entryGateRefusal } = require('../core/syncReplay.cjs');
const CLI = path.resolve(__dirname, '../cli/collaboration.cjs');
const INDEX = path.resolve(__dirname, '../cli/index.cjs');
const SERVER = path.resolve(__dirname, '../server/server.cjs');
const ORIGIN = 'http://127.0.0.1:47123';
const PASSWORD = 'Sync-test-password';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function start(home, mode = 'collaboration') {
  const child = fork(SERVER, [], { silent: true, windowsHide: true, env: { ...process.env,
    DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json'), DASHBOARD_MODE: mode,
    DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1',
    DASHBOARD_POLL_MS: '100', DASHBOARD_EVENT_WEBHOOK: '',
  } });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out: ' + output)); }, 15000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output)); });
    child.on('message', msg => { if (msg.type === 'dashboard-ready') { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${msg.port}`, output: () => output }); } });
  });
}
async function stop(srv) {
  if (srv && srv.child.exitCode === null) await new Promise(resolve => { srv.child.once('exit', resolve); srv.child.kill(); });
}
function cli(home, command, payload, args = []) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, command, ...args], { windowsHide: true, timeout: 60000,
      env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json') },
    }, (err, stdout, stderr) => {
      try { resolve({ ...JSON.parse(stdout), stderr, code: err?.code || 0 }); } catch { reject(new Error('Invalid CLI output')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(payload ? JSON.stringify(payload) : '');
  });
}
const timeFields = new Set(['ts', 'updatedAt', 'lastProgressAt', 'decidedAt', 'landedAt', 'since']);
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !timeFields.has(k)).map(([k, v]) => [k, comparable(v)]));
}
test('receipt digest and acknowledged retention preserve pending results', () => {
  const op = { seq: 1, flags: { z: 2, a: [1, 2] }, kind: 'op', author: 'AI' };
  assert.equal(opDigest(op), opDigest({ author: 'AI', flags: { a: [1, 2], z: 2 }, kind: 'op', seq: 99 }));
  for (const changed of [{ ...op, author: 'owner' }, { ...op, flags: { z: 2, a: [2, 1] } }]) assert.notEqual(opDigest(op), opDigest(changed));
  const now = Date.UTC(2026, 9, 20);
  const row = (seq, days, deviceId = 'd') => ({ deviceId, seq, digest: 'a'.repeat(64), status: 'applied', at: new Date(now - days * 86400000).toISOString() });
  const ledger = { v: 1, acks: { d: 5 }, receipts: {
    expired: row(1, 8), boundary: row(2, 7), recent: row(3, 1), pending: row(6, 30), other: row(1, 30, 'other'),
  } };
  pruneReceipts(ledger, now);
  assert.deepEqual(Object.keys(ledger.receipts).sort(), ['boundary', 'other', 'pending', 'recent']);
  const large = { v: 1, acks: { d: MAX_RECEIPTS + 3 }, receipts: {} };
  for (let i = 0; i < MAX_RECEIPTS + 3; i++) large.receipts['r' + i] = { ...row(i + 1, 0), at: new Date(now + i).toISOString() };
  large.receipts.pending = row(MAX_RECEIPTS + 4, 30);
  pruneReceipts(large, now);
  assert.equal(Object.keys(large.receipts).length, MAX_RECEIPTS);
  for (let i = 0; i < 4; i++) assert.equal(Object.hasOwn(large.receipts, 'r' + i), false);
  assert.ok(large.receipts.r4); assert.ok(large.receipts.pending);
});

test('real cloud sync service: replay, guards, snapshots, upload, concurrency and receipts', { timeout: 120000 }, async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-sync-ops-')));
  let srv, local;
  t.after(async () => { await stop(srv); await stop(local); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const registryPath = path.join(home, 'registry.json'), boardFile = path.join(home, 'alpha.json');
  const board = emptyBoard({ id: 'alpha', name: 'Alpha' });
  fs.writeFileSync(boardFile, JSON.stringify(board));
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { name: 'Alpha', mainRepo: home, board: boardFile } } }));
  const auth = createAuth({ home, registryPath });
  await auth.bootstrap('owner', PASSWORD);
  const owner = await auth.login('owner', PASSWORD, 'sync-owner');
  const sessions = {};
  for (const role of ['member', 'viewer']) {
    const invite = auth.createInvite(owner.token, { role, projectIds: ['alpha'], maxUses: 1, expiresInHours: 1 });
    sessions[role] = await auth.register({ inviteToken: invite.token, username: role, password: PASSWORD });
  }
  const tokenFile = path.join(home, 'device-token');
  const created = await cli(home, 'create-device', null, ['--username', 'owner', '--label', 'test-device', '--token-file', tokenFile]);
  assert.equal(created.ok, true); assert.equal(created.stderr, '');
  const deviceToken = fs.readFileSync(tokenFile, 'utf8').trim();
  srv = await start(home);
  const secrets = [PASSWORD, owner.token, deviceToken, hash(owner.token), hash(deviceToken)];
  async function request(route, { session, data, headers = {}, base = srv.base } = {}) {
    const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: {
      ...(session ? { Cookie: 'dashboard_session=' + session.token } : {}),
      ...(data === undefined ? {} : { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Dashboard-Request': '1',
        ...(session ? { 'X-Dashboard-CSRF': session.csrfToken } : {}) }), ...headers,
    }, body: data === undefined ? undefined : JSON.stringify(data) });
    const raw = await response.text();
    for (const secret of secrets) assert.equal(raw.includes(secret), false, 'No credential in response');
    return { status: response.status, body: raw ? JSON.parse(raw) : null, raw, headers: response.headers };
  }
  const login = await request('/api/auth/device-login', { data: { token: deviceToken } });
  assert.equal(login.status, 200);
  const device = { token: login.headers.get('set-cookie').match(/^dashboard_session=([^;]+)/)[1], csrfToken: login.body.csrfToken };
  secrets.push(device.token, hash(device.token));
  const current = await request('/api/auth/session', { session: device }); assert.equal(current.body.csrfToken, device.csrfToken);
  const deviceId = auth.session(device.token).deviceId;
  let seq = 0;
  const op = (command, flags, extras = {}) => ({ v: 1, kind: 'op', opId: crypto.randomUUID(), seq: ++seq, project: 'local', remoteProjectId: 'alpha',
    command, flags, files: {}, author: 'test-ai', clientTs: '2026-10-19T12:00:00.000Z', device: '电脑甲', ...extras });
  const add = id => op('add', { _: [id], title: 'Technical task', 'plain-title': '新任务', model: 'test' });
  const send = (ops, ackSeq = 0, projectId = 'alpha') => request(`/api/sync/projects/${projectId}/ops`, { session: device, data: { ackSeq, ops } });
  const read = () => JSON.parse(fs.readFileSync(boardFile));
  const ledgerFile = path.join(home, 'sync-ledger', 'alpha.json');
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile));
  let chain, firstResults;
  await t.test('add through done matches local CLI and stamps every activity', async () => {
    chain = [add('T1'), op('claim', { _: ['T1'], builder: '派单器', branch: 'sync-test' }),
      op('progress', { _: ['T1'], percent: '50', next: '继续核对' }), op('note', { _: ['T1'], text: '负责人留言' }, { author: 'owner' }),
      op('pending', { _: ['T1'], q: '选哪条路', opt: ['甲', '乙'], rec: '甲', background: '需要保存并比较原始数据以便核对操作是否保持一致。'.repeat(4),
        'pros-甲': '使用现有规则减少差异但需要保留输入。'.repeat(3), 'pros-乙': '重新编写规则较自由但需要额外维护。'.repeat(3), reason: '使用现有规则可以减少重复实现造成的差异并有利于核对。'.repeat(3) }),
      op('decide', { _: ['T1'], did: 'd1', answer: '甲' }), op('cost', { _: ['T1'], agents: 'test:1', tokens: '123' }),
      op('done', { _: ['T1'], commit: 'abcdef123456', pr: '42' })];
    const localDir = path.join(home, 'direct'); fs.mkdirSync(localDir);
    const localReg = path.join(localDir, 'registry.json'), localBoard = path.join(localDir, 'board.json');
    fs.writeFileSync(localBoard, JSON.stringify(board));
    fs.writeFileSync(localReg, JSON.stringify({ projects: { alpha: { mainRepo: localDir, board: localBoard } } }));
    for (const item of chain) {
      const args = [item.command, ...(item.flags._ || [])];
      for (const [key, value] of Object.entries(item.flags)) if (key !== '_') {
        for (const v of Array.isArray(value) ? value : [value]) args.push('--' + key, String(v));
      }
      // pending --json selects stdin input rather than merely JSON output.
      // This comparison intentionally exercises its explicit flag form.
      args.push('--author', item.author, '--registry', localReg, '--project', 'alpha');
      const result = spawnSync(process.execPath, [INDEX, ...args], { windowsHide: true, encoding: 'utf8', timeout: 30000,
        cwd: localDir, env: { ...process.env, DASHBOARD_HOME: localDir, CLAUDE_CODE_SESSION_ID: '' } });
      assert.equal(result.status, 0, result.stderr);
    }
    const response = await send(chain);
    assert.equal(response.status, 200, response.raw);
    assert.deepEqual(response.body.results.map(r => r.status), chain.map(() => 'applied'));
    firstResults = response.body.results;
    const cloud = read(), direct = JSON.parse(fs.readFileSync(localBoard));
    assert.deepEqual(comparable(cloud.tasks), comparable(direct.tasks));
    assert.equal(cloud.tasks[0].status, '已完工');
    const audit = ['userId', 'via', 'clientTs', 'device', 'opId'];
    assert.deepEqual(comparable(cloud.activity.map(a => Object.fromEntries(Object.entries(a).filter(([k]) => !audit.includes(k))))), comparable(direct.activity));
    assert.equal(cloud.activity.length, chain.length);
    cloud.activity.forEach((a, i) => {
      assert.equal(a.userId, owner.user.id); assert.equal(a.via, i === 3 ? 'owner-device' : 'ai');
      for (const key of ['clientTs', 'device', 'opId']) assert.equal(a[key], chain[i][key]);
    });
    assert.equal(response.body.etag, hash(fs.readFileSync(boardFile)));
  });
  await t.test('same batch and normalized content replay identical receipts without another write', async () => {
    const before = fs.readFileSync(boardFile, 'utf8');
    assert.deepEqual((await send(chain)).body.results, firstResults);
    const resequenced = { ...chain[0], seq: 999, flags: Object.fromEntries(Object.entries(chain[0].flags).reverse()) };
    assert.deepEqual((await send([resequenced])).body.results[0], firstResults[0]);
    const conflict = (await send([{ ...chain[0], author: 'different' }])).body.results[0];
    assert.equal(conflict.status, 'rejected'); assert.equal(conflict.httpStatus, 409);
    assert.equal(fs.readFileSync(boardFile, 'utf8'), before);
  });
  await t.test('original gates, remote id, kind and set refusal are per operation', async () => {
    const missingModel = add('MISSING'); delete missingModel.flags.model;
    const fresh = add('NOCOST'); assert.equal((await send([fresh])).body.results[0].status, 'applied');
    const noCost = op('done', { _: ['NOCOST'] });
    const items = [op('set', { _: ['T1', 'status', '未开工'] }), missingModel, noCost,
      { ...add('WRONG'), remoteProjectId: 'other' }, { ...add('WRONGKIND'), kind: 'untracked' }];
    const r = (await send(items)).body.results;
    assert.deepEqual(r.map(x => x.status), items.map(() => 'rejected'));
    assert.deepEqual(r.map(x => x.httpStatus), [403, 400, 400, 400, 400]);
    assert.equal(r[0].error, '云端项目不接受 set,请改用专门命令');
    assert.equal(r[1].error, entryGateRefusal('add', missingModel.flags));
    assert.equal(r[2].error, entryGateRefusal('done', { ...noCost.flags, project: 'alpha', registry: registryPath }));
    assert.deepEqual((await send(items)).body.results, r);
    const partial = (await send([add('FIRST'), op('set', {}), add('LAST')])).body.results;
    assert.deepEqual(partial.map(x => x.status), ['applied', 'rejected', 'applied']);
    assert.ok(read().tasks.find(x => x.id === 'FIRST')); assert.ok(read().tasks.find(x => x.id === 'LAST'));
  });
  await t.test('all four routes require owner device and writes require every existing guard', async () => {
    const routes = [['/api/sync/projects', undefined], ['/api/sync/projects/alpha/snapshot', undefined],
      ['/api/sync/projects/alpha/ops', { ackSeq: 0, ops: [add('DENIED')] }], ['/api/sync/projects/new/upload', { board }]];
    const before = fs.readFileSync(boardFile, 'utf8');
    for (const [route, data] of routes) {
      assert.equal((await request(route, { data })).status, 401);
      for (const session of [sessions.member, sessions.viewer, owner]) assert.equal((await request(route, { session, data })).status, 403);
      assert.equal((await request(route, { session: device, data, headers: { 'X-Forwarded-For': '127.0.0.1' } })).status, 403);
      if (data) for (const headers of [{ 'X-Dashboard-CSRF': '' }, { Origin: 'https://evil.example' }, { 'X-Dashboard-Request': '' }, { 'Content-Type': 'text/plain' }]) {
        assert.equal((await request(route, { session: device, data, headers })).status, 403);
      }
    }
    const internal = { sessionToken: device.token, projectId: 'alpha', ackSeq: 0, ops: [add('INTERNAL')] };
    assert.equal((await cli(home, 'sync-ops', internal, ['--project', 'alpha'])).status, 400);
    for (const session of [owner, sessions.member, sessions.viewer]) assert.equal((await cli(home, 'sync-ops', { ...internal, sessionToken: session.token })).status, 403);
    assert.equal((await cli(home, 'sync-ops', { ...internal, sessionToken: 'invalid' })).status, 401);
    assert.equal(fs.readFileSync(boardFile, 'utf8'), before);
    for (const ops of [[], Array.from({ length: 21 }, () => add('EXCESS'))]) assert.equal((await send(ops)).status, 400);
    assert.equal((await send([add('NEGATIVE')], -1)).status, 400);
    const large = op('note', { _: ['T1'], text: 'x'.repeat(2 * 1024 * 1024) });
    assert.equal((await send([large])).status, 413);
  });
  await t.test('snapshot returns exact board and hash; conditional read checks auth before 304', async () => {
    const a = await request('/api/sync/projects/alpha/snapshot', { session: device });
    assert.deepEqual(a.body.board, read()); assert.equal(a.body.etag, hash(fs.readFileSync(boardFile)));
    const unchanged = await request('/api/sync/projects/alpha/snapshot', { session: device, headers: { 'If-None-Match': a.body.etag } });
    assert.equal(unchanged.status, 304); assert.equal(unchanged.raw, '');
    assert.equal((await request('/api/sync/projects/alpha/snapshot', { session: sessions.member, headers: { 'If-None-Match': a.body.etag } })).status, 403);
    await send([op('note', { _: ['T1'], text: 'changed' })]);
    const b = await request('/api/sync/projects/alpha/snapshot', { session: device, headers: { 'If-None-Match': a.body.etag } });
    assert.equal(b.status, 200); assert.notEqual(b.body.etag, a.body.etag);
  });
  await t.test('upload registers a new project, supports replay and is picked up by SSE polling', async () => {
    const incoming = emptyBoard({ id: 'local-id', name: '上传项目' });
    incoming._commandReceipts = { historical: 'must remain in exact snapshot' };
    const upload = () => request('/api/sync/projects/uploaded/upload', { session: device, data: { board: incoming, name: 'Uploaded' } });
    assert.equal((await upload()).status, 200);
    const snapshot = await request('/api/sync/projects/uploaded/snapshot', { session: device });
    assert.deepEqual(snapshot.body.board, { ...incoming, project: { ...incoming.project, id: 'uploaded' } });
    const list = (await request('/api/sync/projects', { session: device })).body.projects;
    assert.deepEqual(list.find(p => p.id === 'uploaded'), { id: 'uploaded', name: 'Uploaded', etag: snapshot.body.etag });
    assert.equal((await upload()).status, 409);
    assert.equal((await request('/api/sync/projects/bad/upload', { session: device, data: { board: { project: {} } } })).status, 400);
    for (const id of ['..%5Cescape', '%2Fescape', 'bad%00id']) assert.equal((await request(`/api/sync/projects/${id}/upload`, { session: device, data: { board: incoming } })).status, 400);
    let req;
    const event = new Promise((resolve, reject) => {
      req = http.get(srv.base + '/api/stream', { headers: { Cookie: 'dashboard_session=' + device.token } }, res => {
        let buffer = '';
        res.on('data', b => {
          buffer += b;
          if (buffer.includes('event: board:changed') && buffer.includes('"projectId":"uploaded"')) resolve();
        });
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('Uploaded project missing SSE event')), 5000);
    try {
      // The first mtime observation establishes a baseline, per existing contract.
      await new Promise(resolve => setTimeout(resolve, 650));
      assert.equal((await send([{ ...add('UPLOADED'), remoteProjectId: 'uploaded' }], 0, 'uploaded')).body.results[0].status, 'applied');
      await event;
    } finally { clearTimeout(timer); req.destroy(); }
    assert.ok((await request('/api/sync/projects/uploaded/snapshot', { session: device })).body.board.tasks.find(x => x.id === 'UPLOADED'));
  });
  await t.test('member operation and sync operation retain both concurrent updates', async () => {
    const root = '/api/collaboration/projects/alpha/tasks';
    const created = await request(root, { session: sessions.member, data: { title: 'Member work' } });
    const id = created.body.task.id;
    assert.equal((await request(`${root}/${id}/claim`, { session: sessions.member, data: {} })).status, 200);
    const note = op('note', { _: [id], text: 'parallel owner note' });
    const results = await Promise.all([request(`${root}/${id}/progress`, { session: sessions.member, data: { percent: 37 } }), send([note])]);
    assert.deepEqual(results.map(r => r.status), [200, 200]); assert.equal(results[1].body.results[0].status, 'applied');
    const current = read(); assert.equal(current.tasks.find(x => x.id === id).percent, 37);
    assert.ok(current.activity.find(a => a.opId === note.opId && a.userId === owner.user.id));
    assert.ok(current.activity.find(a => a.taskId === id && a.type === 'collaboration:progress' && a.userId === sessions.member.user.id));
    assert.equal(current.activity.find(a => a.taskId === id && a.type === 'collaboration:progress').opId, undefined);
  });
  await t.test('actual board lock timeout mapped to 409 by replay remains retry and is not receipted', async () => {
    const item = op('note', { _: ['T1'], text: 'after contention' });
    const before = fs.readFileSync(boardFile, 'utf8');
    fs.writeFileSync(boardFile + '.lock', JSON.stringify({ pid: process.pid, ts: Date.now() }));
    let result;
    try { result = await send([item]); } finally { fs.unlinkSync(boardFile + '.lock'); }
    assert.equal(result.status, 200, result.raw); assert.equal(result.body.results[0].status, 'retry');
    assert.equal(Object.hasOwn(ledger().receipts, item.opId), false); assert.equal(fs.readFileSync(boardFile, 'utf8'), before);
    assert.equal((await send([item])).body.results[0].status, 'applied');
    assert.equal(read().activity.filter(a => a.opId === item.opId).length, 1);
  });
  await t.test('ack advances monotonically, cleanup runs on write and corruption fails closed', async () => {
    const original = ledger();
    original.receipts.expired = { deviceId, seq: 1, digest: 'a'.repeat(64), status: 'applied', at: '2020-01-01T00:00:00.000Z' };
    original.receipts.pending = { deviceId: 'different-device', seq: 1, digest: 'b'.repeat(64), status: 'applied', at: '2020-01-01T00:00:00.000Z' };
    fs.writeFileSync(ledgerFile, JSON.stringify(original));
    await send([chain[0]], 8); assert.equal(ledger().acks[deviceId], 8);
    assert.equal(Object.hasOwn(ledger().receipts, 'expired'), false); assert.ok(ledger().receipts.pending);
    await send([chain[0]], 0); assert.equal(ledger().acks[deviceId], 8);
    const before = fs.readFileSync(boardFile, 'utf8');
    for (const corrupt of ['{broken', JSON.stringify({ v: 1, receipts: {}, acks: [] }), JSON.stringify({ v: 1, receipts: { x: {} }, acks: {} })]) {
      fs.writeFileSync(ledgerFile, corrupt);
      const response = await send([add('CORRUPT')]);
      assert.equal(response.status, 503); assert.equal(response.body.ok, false);
      assert.equal(fs.readFileSync(ledgerFile, 'utf8'), corrupt); assert.equal(fs.readFileSync(boardFile, 'utf8'), before);
    }
  });
  await t.test('revoked device loses every sync route immediately and cannot login again', async () => {
    auth.revokeDevice(owner.token, deviceId);
    for (const [route, data] of [['/api/sync/projects', undefined], ['/api/sync/projects/alpha/snapshot', undefined],
      ['/api/sync/projects/alpha/ops', { ackSeq: 0, ops: [add('REVOKED')] }], ['/api/sync/projects/new/upload', { board }]]) {
      assert.equal((await request(route, { session: device, data })).status, 401);
    }
    assert.equal((await request('/api/auth/device-login', { data: { token: deviceToken } })).status, 401);
    const result = await cli(home, 'sync-ops', { sessionToken: device.token, projectId: 'alpha', ackSeq: 0, ops: [add('REVOKED')] });
    assert.equal(result.status, 401);
    for (const secret of secrets) assert.equal(srv.output().includes(secret), false);
  });
  await t.test('local mode has none of the four sync routes', async () => {
    local = await start(home, '');
    for (const [route, data] of [['/api/sync/projects', undefined], ['/api/sync/projects/alpha/snapshot', undefined],
      ['/api/sync/projects/alpha/ops', { ackSeq: 0, ops: [add('LOCAL')] }], ['/api/sync/projects/new/upload', { board }]]) {
      assert.equal((await request(route, { data, base: local.base, headers: { Origin: local.base } })).status, 404);
    }
  });
});
