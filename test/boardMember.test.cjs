'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { fork, execFile } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const CLI = path.resolve(__dirname, '../cli/boardMember.cjs');
const PASSWORD = 'Member-cli-fixture-password-12345';
function start(home, origin, local = false) {
  const child = fork(path.resolve(__dirname, '../server/server.cjs'), [], { windowsHide: true, silent: true,
    env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json'),
      DASHBOARD_MODE: local ? '' : 'collaboration', DASHBOARD_PUBLIC_ORIGIN: local ? '' : origin,
      DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1', DASHBOARD_EVENT_WEBHOOK: '', DASHBOARD_POLL_MS: '500' } });
  let logs = ''; child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out')); }, 15000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited')); });
    child.on('message', m => { if (m.type === 'dashboard-ready') { clearTimeout(timer); resolve({ child, port: m.port, logs: () => logs }); } });
  });
}
async function stop(s) {
  if (!s || s.child.exitCode !== null || s.child.signalCode !== null) return;
  await new Promise(resolve => { s.child.once('exit', resolve); s.child.kill(); });
}
test('downloaded standalone member CLI authenticates and operates the real collaboration server', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-member-'));
  const home = path.join(root, 'server'), memberHome = path.join(root, 'member'); fs.mkdirSync(home);
  let srv, local; let upstreamPort, forcedStatus = 0, inject401 = false;
  const traffic = [], secrets = [PASSWORD], outputs = [], credentialSnapshots = [];
  // Count actual wire requests and inspect protective headers without replacing
  // the real server or task operation children. No forwarded headers are added.
  const proxy = http.createServer((req, res) => {
    const chunks = []; req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      traffic.push({ route: req.url, method: req.method, headers: req.headers });
      if (req.headers.cookie) {
        secrets.push(req.headers.cookie);
        const v = req.headers.cookie.match(/dashboard_session=([^;]+)/)?.[1]; if (v) secrets.push(v);
      }
      if (forcedStatus || (inject401 && req.url === '/api/projects')) {
        const status = forcedStatus || 401; inject401 = false;
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Synthetic response' })); return;
      }
      const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: req.headers, agent: false }, response => {
        const returned = []; response.on('data', d => returned.push(d));
        response.on('end', () => {
          const bytes = Buffer.concat(returned);
          try { const b = JSON.parse(bytes); if (b.token) secrets.push(b.token); if (b.csrfToken) secrets.push(b.csrfToken); } catch {}
          for (const c of response.headers['set-cookie'] || []) {
            const v = c.match(/^dashboard_session=([^;]+)/)?.[1]; if (v) secrets.push(v);
          }
          res.writeHead(response.statusCode, response.headers); res.end(bytes);
        });
      });
      upstream.on('error', () => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"Offline"}'); });
      upstream.end(body);
    });
  });
  const proxySockets = new Set();
  proxy.on('connection', socket => {
    proxySockets.add(socket); socket.once('close', () => proxySockets.delete(socket));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${proxy.address().port}`;
  t.after(async () => {
    await stop(srv); await stop(local);
    // Assertions and requests have finished. The parent fetch client can retain
    // pooled sockets; close our fixture's connections before awaiting close.
    await new Promise(resolve => {
      proxy.close(resolve);
      for (const socket of proxySockets) socket.destroy();
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const registryPath = path.join(home, 'registry.json'); const boardFile = path.join(home, 'alpha.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { mainRepo: home, board: boardFile, name: 'Alpha' },
    beta: { mainRepo: home, board: path.join(home, 'beta.json'), name: 'Beta' } } }));
  for (const id of ['alpha', 'beta']) fs.writeFileSync(path.join(home, id + '.json'), JSON.stringify(emptyBoard({ id, name: id })));
  const auth = createAuth({ home, registryPath }); await auth.bootstrap('owner', PASSWORD); const owner = await auth.login('owner', PASSWORD);
  const inv = auth.createInvite(owner.token, { projectIds: ['alpha'], expiresInHours: 1, maxUses: 2 });
  const member = await auth.register({ inviteToken: inv.token, username: 'member', displayName: '组员甲', password: PASSWORD });
  const other = await auth.register({ inviteToken: inv.token, username: 'other', password: PASSWORD });
  auth.logout(member.token); auth.logout(other.token);
  const read = () => JSON.parse(fs.readFileSync(boardFile));
  const seed = (id, fields = {}) => {
    const board = read(); board.tasks.push({ id, title: id + ' title', status: '待开工', percent: 0, wave: 0, ...fields });
    fs.writeFileSync(boardFile, JSON.stringify(board));
  };
  seed('OPEN', { plainTitle: '可领的卡', description: '详细说明' });
  seed('DONE', { status: '已完工' }); seed('VOID', { status: '已作废' }); seed('COLLECT', { status: '收官' });
  seed('OTHER', { status: '施工中', assigneeUserId: other.user.id, assigneeName: '别人' });
  seed('MINE', { status: '施工中', assigneeUserId: member.user.id, assigneeName: member.user.displayName });
  seed('SHARED', { status: '施工中', assigneeUserId: other.user.id, collaborators: [{ userId: member.user.id, name: member.user.displayName, joinedAt: new Date().toISOString() }] });
  seed('AI', { builder: '派单器', status: '施工中' });
  srv = await start(home, server); upstreamPort = srv.port;
  function cli(args, input = '', options = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [options.file || CLI, ...args], { windowsHide: true, timeout: 60000,
        env: { ...process.env, BOARD_MEMBER_HOME: options.home || memberHome }, cwd: options.cwd || root, maxBuffer: 2 * 1048576 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') return reject(new Error('CLI could not run'));
        outputs.push(stdout, stderr);
        if (fs.existsSync(memberHome)) for (const name of fs.readdirSync(memberHome)) {
          const file = path.join(memberHome, name); if (fs.statSync(file).isFile()) credentialSnapshots.push(fs.readFileSync(file, 'utf8'));
        }
        resolve({ code: error ? error.code : 0, stdout, stderr });
      });
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
  }
  async function ok(args, input, options) { const r = await cli(args, input, options); assert.equal(r.code, 0, r.stderr || r.stdout); return r; }
  const device = () => JSON.parse(fs.readFileSync(path.join(memberHome, 'device.cred')));
  const db = () => JSON.parse(fs.readFileSync(path.join(home, 'private', 'collaboration-auth.json')));
  await t.test('usage validation rejects password arguments, insecure origins and missing required fields before any request', async () => {
    for (const args of [
      ['login', '--server', server, '--username', 'member', '--password', PASSWORD],
      ['login', '--server', 'http://example.com/path', '--username', 'member'],
      ...['unclaim', 'park', 'unpark', 'cancel', 'reopen'].map(c => [c, 'OPEN']),
      ['progress', 'OPEN', '--percent', '1.5'], ['priority', 'OPEN', '--level', 'nonsense'],
      ['note', 'OPEN'], ['add'],
    ]) {
      const before = traffic.length; const r = await cli(args); assert.equal(r.code, 2); assert.equal(traffic.length, before);
    }
    const help = await ok([]); for (const command of ['login', 'logout', 'whoami', 'use', 'projects', 'list', 'show', 'add', 'claim', 'done', 'join', 'leave', 'progress', 'note', 'unclaim', 'park', 'unpark', 'cancel', 'reopen', 'priority', 'guide']) assert.ok(help.stdout.includes(command));
    assert.match(help.stdout, /给 AI 看的说明:node board-member.cjs guide/);
    assert.equal((await cli(['list'])).code, 3);
    const guide = await ok(['guide']); assert.match(guide.stdout, /你在替 未登录 操作云端看板 未登录/);
  });
  await t.test('stdin password login normalizes URL, protects a real device and logs out the password session', async () => {
    const r = await ok(['login', '--server', server + '/some/path?query=1#/kanban', '--username', 'member', '--label', '测试电脑'], PASSWORD + '\nignored second line\n');
    assert.match(r.stdout, /已登录:组员甲\(member\),本机设备:测试电脑,有效期到/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(memberHome, 'config.json'))).server, server);
    assert.equal(device().scheme, process.platform === 'win32' ? 'dpapi-user' : 'file-0600');
    assert.equal(db().sessions.filter(s => s.userId === member.user.id && s.deviceId === null).length, 0);
    const userDevices = db().devices.filter(d => d.userId === member.user.id); assert.equal(userDevices.length, 1);
    assert.equal(userDevices[0].id, device().deviceId);
    assert.equal(traffic.at(-1).route, '/api/auth/logout');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(memberHome).mode & 0o777, 0o700);
      for (const f of ['device.cred', 'config.json']) assert.equal(fs.statSync(path.join(memberHome, f)).mode & 0o777, 0o600);
    }
    // whoami in the next subtest really decrypts the DPAPI blob on Windows;
    // there is no injected protector or platform skip.
  });
  await t.test('identity, projects, default selection, list filters, messages and available commands', async () => {
    const who = await ok(['whoami']); for (const value of ['组员甲', 'member', 'alpha', server, device().expiresAt]) assert.ok(who.stdout.includes(value));
    assert.match((await ok(['projects'])).stdout, /alpha\s+Alpha/);
    await ok(['use', 'alpha']); assert.equal(JSON.parse(fs.readFileSync(path.join(memberHome, 'config.json'))).defaultProject, 'alpha');
    assert.equal((await cli(['use', 'beta'])).code, 1);
    const list = (await ok(['list'])).stdout;
    for (const id of ['DONE', 'VOID', 'COLLECT']) assert.ok(!list.includes(id));
    assert.match(list, /OPEN\s+待开工\s+0%\s+中\s+可领的卡\s+无人认领\s+协作0人/); assert.match(list, /AI 施工/);
    assert.match((await ok(['list', '--all'])).stdout, /DONE/);
    assert.match((await ok(['list', '--status', '施工中'])).stdout, /MINE/);
    assert.doesNotMatch((await ok(['list', '--status', '施工中'])).stdout, /OPEN/);
    const mine = (await ok(['list', '--mine'])).stdout; assert.match(mine, /MINE/); assert.match(mine, /SHARED/); assert.doesNotMatch(mine, /OTHER|OPEN/);
    const board = read();
    for (let i = 0; i < 12; i++) board.activity.push({ ts: new Date(Date.UTC(2026, 9, 27, 0, 0, i)).toISOString(), type: 'note', kind: 'message', taskId: 'OPEN', author: '留言人', userId: other.user.id, text: '留言编号' + i + '结束' });
    fs.writeFileSync(boardFile, JSON.stringify(board));
    const show = (await ok(['show', 'OPEN'])).stdout;
    for (const value of ['标题:OPEN title', '人话标题:可领的卡', '描述:详细说明', '状态:待开工', '进度:0%', '优先级:中', '主负责人:无人认领', '协作人:无', '你现在能做:', 'claim OPEN', '留言编号11结束', '留言人']) assert.ok(show.includes(value), value);
    assert.ok(!show.includes('留言编号1结束')); assert.equal((show.match(/留言编号/g) || []).length, 10);
    assert.equal((await cli(['show', 'MISSING'])).code, 1);
    inject401 = true; const before = traffic.filter(r => r.route === '/api/auth/device-login').length;
    await ok(['projects']); assert.equal(traffic.filter(r => r.route === '/api/auth/device-login').length - before, 2);
    const r = await ok(['projects', '--json']); assert.ok(Array.isArray(JSON.parse(r.stdout).projects)); assert.ok(!r.stdout.includes('csrfToken'));
  });
  let createdId;
  await t.test('add, claim, progress with note, message and done persist member identity and real activity', async () => {
    const desc = path.join(root, 'description.txt'); fs.writeFileSync(desc, '从文件读的描述');
    const added = await ok(['add', '--title', '新卡标题', '--plain-title', '新卡人话标题', '--desc-file', desc, '--json']);
    const result = JSON.parse(added.stdout); createdId = result.task.id; assert.ok(!added.stdout.includes('csrfToken'));
    await ok(['claim', createdId]); await ok(['progress', createdId, '--percent', '67', '--note', '节点完成']);
    assert.equal(read().tasks.find(x => x.id === createdId).nextMilestone, '节点完成');
    const text = path.join(root, 'message.txt'); fs.writeFileSync(text, '从文件读的留言');
    await ok(['note', createdId, '--text-file', text]); await ok(['note', createdId, '--text', '直接留言']);
    await ok(['progress', createdId, '--percent', '100']); assert.equal(read().tasks.find(x => x.id === createdId).status, '施工中');
    await ok(['done', createdId]);
    const stored = read(); const card = stored.tasks.find(x => x.id === createdId);
    assert.equal(card.status, '已完工'); assert.equal(card.percent, 100); assert.equal(card.assigneeUserId, member.user.id); assert.equal(card.description, '从文件读的描述');
    for (const type of ['collaboration:claim', 'collaboration:progress']) assert.ok(stored.activity.some(a => a.taskId === createdId && a.type === type && a.userId === member.user.id));
    for (const text of ['从文件读的留言', '直接留言']) assert.ok(stored.activity.some(a => a.taskId === createdId && a.text === text && a.userId === member.user.id));
  });
  await t.test('rejected takeover is byte-preserving; joining and leaving use server permissions', async () => {
    const bytes = fs.readFileSync(boardFile); const denied = await cli(['claim', 'OTHER']);
    assert.equal(denied.code, 1); assert.match(denied.stderr, /卡片当前状态不允许这样做.*服务器原话/); assert.deepEqual(fs.readFileSync(boardFile), bytes);
    const json = JSON.parse((await cli(['claim', 'OTHER', '--json'])).stdout);
    assert.equal(json.ok, false); assert.equal(json.status, 409); assert.equal(json.exitCode, 1);
    await ok(['join', 'OTHER']); assert.ok(read().tasks.find(x => x.id === 'OTHER').collaborators.some(c => c.userId === member.user.id));
    await ok(['leave', 'OTHER']); assert.equal(read().tasks.find(x => x.id === 'OTHER').collaborators.length, 0);
    const before = fs.readFileSync(boardFile); const cross = await cli(['claim', 'OPEN', '--project', 'beta']); assert.equal(cross.code, 1); assert.deepEqual(fs.readFileSync(boardFile), before);
  });
  await t.test('park, unpark, unclaim, cancel, reopen, both priority spellings and guide', async () => {
    await ok(['claim', 'OPEN']); await ok(['park', 'OPEN', '--reason', '等资料']); assert.equal(read().tasks.find(x => x.id === 'OPEN').status, '暂缓');
    await ok(['unpark', 'OPEN', '--reason', '资料齐了']); assert.equal(read().tasks.find(x => x.id === 'OPEN').status, '可复工');
    await ok(['claim', 'OPEN']); await ok(['unclaim', 'OPEN', '--reason', '先放手']); assert.equal(read().tasks.find(x => x.id === 'OPEN').assigneeUserId, undefined);
    await ok(['reopen', createdId, '--reason', '补充']); await ok(['cancel', createdId, '--reason', '不做了']); assert.equal(read().tasks.find(x => x.id === createdId).status, '已作废');
    assert.match((await ok(['show', createdId])).stdout, /作废原因:不做了/);
    await ok(['priority', 'OPEN', '--level', '高']); assert.equal(read().tasks.find(x => x.id === 'OPEN').priority, 'high');
    await ok(['priority', 'OPEN', '--level', 'urgent']); assert.equal(read().tasks.find(x => x.id === 'OPEN').priority, 'urgent');
    const guide = (await ok(['guide'])).stdout;
    for (const value of ['云端看板 · AI 使用说明', '开工前', '干活中', '收尾', '规矩', server, '组员甲', `node "${CLI}"`, '不要替组员登录', '退出码:0 成功']) assert.ok(guide.includes(value), value);
    assert.doesNotMatch(guide, /<命令>|<网址>|<显示名>/);
  });
  await t.test('server revocation, expiry and disable produce exit three and a personal login instruction', async () => {
    const saved = fs.readFileSync(path.join(home, 'private', 'collaboration-auth.json'));
    for (const scenario of ['revoke', 'disable', 'expire']) {
      if (scenario === 'revoke') auth.revokeDevice(owner.token, device().deviceId);
      if (scenario === 'disable') auth.access(owner.token, member.user.id, { projectIds: ['alpha'], disabled: true });
      if (scenario === 'expire') {
        const ledger = db(); ledger.devices.find(d => d.id === device().deviceId).expiresAt = '2000-01-01T00:00:00.000Z';
        fs.writeFileSync(path.join(home, 'private', 'collaboration-auth.json'), JSON.stringify(ledger));
      }
      for (const command of ['whoami', 'list', 'show']) {
        const r = await cli(command === 'show' ? [command, 'OPEN'] : [command]); assert.equal(r.code, 3); assert.match(r.stderr, /请让组员本人在终端运行:node board-member.cjs login/);
      }
      fs.writeFileSync(path.join(home, 'private', 'collaboration-auth.json'), saved);
    }
    for (const [status, message] of [[400, '参数不对'], [403, '没有权限'], [404, '找不到这个项目或卡'],
      [409, '卡片当前状态不允许这样做'], [429, '操作太频繁请稍后'], [503, '服务器暂时不可用']]) {
      forcedStatus = status; const r = await cli(['projects']); assert.equal(r.code, status === 503 ? 4 : 1); assert.ok(r.stderr.includes(message));
    }
    forcedStatus = 0;
  });
  await t.test('public download in both modes has exact bytes and runs outside repository', async () => {
    local = await start(home, '', true);
    for (const base of [server, `http://127.0.0.1:${local.port}`]) {
      const r = await fetch(base + '/board-member.cjs'); assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal(r.headers.get('content-disposition'), 'attachment; filename="board-member.cjs"'); assert.equal(r.headers.get('cache-control'), 'no-cache');
      const bytes = Buffer.from(await r.arrayBuffer()); assert.deepEqual(bytes, fs.readFileSync(CLI));
      const head = await fetch(base + '/board-member.cjs', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
      assert.equal(head.headers.get('content-length'), String(bytes.length));
      assert.equal((await fetch(base + '/board-member.cjs', { method: 'POST' })).status, 405);
      const downloaded = path.join(root, 'board-member.cjs'); fs.writeFileSync(downloaded, bytes);
      assert.match((await ok(['help'], '', { file: downloaded, cwd: root })).stdout, /login --server/);
    }
  });
  await t.test('project ambiguity is explicit, logout revokes and offline commands fail without leaking secrets', async () => {
    // Remove default and grant two projects: no guess may cause a write.
    const cfgFile = path.join(memberHome, 'config.json'); const cfg = JSON.parse(fs.readFileSync(cfgFile)); delete cfg.defaultProject; fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    auth.access(owner.token, member.user.id, { projectIds: ['alpha', 'beta'], disabled: false });
    const ambiguous = await cli(['list']); assert.equal(ambiguous.code, 2); assert.match(ambiguous.stderr, /alpha.*beta/);
    auth.access(owner.token, member.user.id, { projectIds: ['alpha'], disabled: false });
    const id = device().deviceId; await ok(['logout']); assert.equal(db().devices.find(d => d.id === id).revoked, true);
    assert.equal(fs.existsSync(path.join(memberHome, 'device.cred')), false); assert.equal((await cli(['list'])).code, 3);
    await ok(['login', '--server', server, '--username', 'member'], PASSWORD + '\n');
    await stop(srv); assert.equal((await cli(['list'])).code, 4);
    const failedLogout = await cli(['logout']); assert.equal(failedLogout.code, 4); assert.match(failedLogout.stderr, /本机凭据已删,服务器上的设备没撤成,请在网页上撤销/);
    assert.equal(fs.existsSync(path.join(memberHome, 'device.cred')), false);
  });
  await t.test('all child output, credential files and server logs remain free of password, device, session and CSRF plaintext', () => {
    function files(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]) : []; }
    const contents = [...outputs, ...credentialSnapshots, srv.logs(), local.logs(), ...files(memberHome).map(f => fs.readFileSync(f, 'utf8'))];
    for (const secret of secrets) if (secret) assert.equal(contents.some(s => s.includes(secret)), false, 'secret leaked');
    for (const r of traffic.filter(r => r.method === 'POST' && r.route.startsWith('/api/'))) {
      assert.equal(r.headers.origin, server); assert.equal(r.headers['x-dashboard-request'], '1'); assert.equal(r.headers['content-type'], 'application/json');
      assert.ok(Object.keys(r.headers).every(k => k !== 'forwarded' && !k.startsWith('x-forwarded-')));
      if (!['/api/auth/login', '/api/auth/device-login'].includes(r.route)) assert.ok(r.headers['x-dashboard-csrf']);
    }
  });
});
