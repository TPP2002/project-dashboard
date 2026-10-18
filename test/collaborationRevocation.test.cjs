'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork, execFile } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const { publicJson } = require('../core/collaborationPublic.cjs');
const c = require('../core/schedContract.cjs');
const CLI = path.resolve(__dirname, '../cli/collaboration.cjs');
const PASSWORD = 'Streaming-real-password-123';
const ORIGIN = 'http://127.0.0.1:47123';

if (process.argv.includes('--server-fixture')) {
  // Real server, no altered authorization functions. The diagnostics message is
  // emitted only after initial authorization and receipt of the first chunk.
  require('node:diagnostics_channel').channel('dashboard.owner-body').subscribe(data => {
    process.send({ type: 'body-received', ...data });
  });
  require('../server/server.cjs').main();
} else if (process.argv.includes('--owner-fixture')) {
  require('node:diagnostics_channel').channel('dashboard.collaboration-input').subscribe(data => {
    process.send({ type: 'input-received', ...data });
  });
  require('../cli/collaboration.cjs').main(['owner-command']).then(() => process.disconnect()).catch(error => {
    console.log(JSON.stringify({ ok: false, status: error.status || 500 }));
    process.exitCode = 1; process.disconnect();
  });
} else {
  const { test } = require('node:test');
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  function message(child, type, route) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); };
      const onMessage = value => {
        if (value.type === type && (!route || value.path === route.split('?')[0])) { cleanup(); resolve(value); }
      };
      const onExit = code => { cleanup(); reject(new Error('Fixture exited: ' + code)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Missing synchronization: ' + type + ' ' + (route || ''))); }, 15000);
      child.on('message', onMessage); child.once('exit', onExit);
    });
  }
  async function start(home, mode = 'collaboration') {
    const child = fork(__filename, ['--server-fixture'], { silent: true, windowsHide: true,
      env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json'),
        DASHBOARD_MODE: mode, DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1', DASHBOARD_NO_RESTART: '1', DASHBOARD_EVENT_WEBHOOK: '',
        DASHBOARD_MODULES: 'all', DASHBOARD_POLL_MS: '500',
        DASHBOARD_SCHED_SHARE: path.join(home, 'share'), SCHED_SHARE: path.join(home, 'share'),
        DASHBOARD_GLOBAL_SETTINGS: path.join(home, 'global-settings.json'), DASHBOARD_CODEX_SESSIONS: path.join(home, 'sessions'),
      } });
    let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    try { const ready = await message(child, 'dashboard-ready'); return { child, base: 'http://127.0.0.1:' + ready.port }; }
    catch (e) { child.kill(); throw new Error(e.message + '\n' + output); }
  }
  async function stop(srv) {
    if (!srv || srv.child.exitCode !== null || srv.child.signalCode !== null) return;
    await new Promise(resolve => { srv.child.once('exit', resolve); srv.child.kill(); });
  }
  function headers(session, origin = ORIGIN) {
    return { Origin: origin, 'Content-Type': 'application/json', 'X-Dashboard-Request': '1',
      ...(session ? { Cookie: 'dashboard_session=' + session.token, 'X-Dashboard-CSRF': session.csrfToken } : {}) };
  }
  async function request(srv, route, session, body) {
    const res = await fetch(srv.base + route, { method: body === undefined ? 'GET' : 'POST', headers: headers(session, srv.local ? srv.base : ORIGIN),
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  async function heldBody(srv, route, session, body) {
    const bytes = Buffer.from(JSON.stringify(body)), cut = Math.max(1, Math.floor(bytes.length / 2));
    const entered = message(srv.child, 'body-received', route);
    let req;
    const response = new Promise((resolve, reject) => {
      req = http.request(srv.base + route, { method: 'POST', headers: { ...headers(session), 'Content-Length': bytes.length } }, res => {
        let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { reject(e); } });
      });
      req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('HTTP fixture timeout')));
      req.write(bytes.subarray(0, cut));
    });
    response.catch(() => {});
    try { assert.ok((await entered).bytes > 0); }
    catch (e) { req.destroy(); throw e; }
    return { finish: () => { req.end(bytes.subarray(cut)); return response; }, abort: () => req.destroy() };
  }
  function cli(home, args, input) {
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [CLI, ...args], { windowsHide: true, timeout: 20000,
        env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json') } }, (error, stdout, stderr) => {
        try { resolve({ ...JSON.parse(stdout), exit: error?.code || 0, stderr }); } catch { reject(new Error(stderr || stdout || String(error))); }
      });
      child.stdin.on('error', () => {}); child.stdin.end(input ? JSON.stringify(input) : '');
    });
  }
  // Snapshot only synthetic non-auth files; revocation is expected to change auth.
  function snapshot(root) {
    const files = {};
    function visit(dir, prefix = '') {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!prefix && entry.name === 'private') continue;
        const relative = prefix + entry.name, full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full, relative + '/'); else files[relative] = fs.readFileSync(full).toString('base64');
      }
    }
    visit(root); return files;
  }

  test('streaming owner requests revalidate at body completion and CLI commit', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-revocation-'));
    let srv, local;
    t.after(async () => { await stop(srv); await stop(local); fs.rmSync(home, { recursive: true, force: true }); });
    const registryPath = path.join(home, 'registry.json'), boardFile = path.join(home, 'board.json');
    write(registryPath, { projects: { alpha: { mainRepo: home, codeRepo: home, board: boardFile } } });
    const board = emptyBoard({ id: 'alpha', name: 'Alpha' });
    board.tasks = [{ id: 'ONE', title: 'One', wave: 1, status: '待拍板', percent: 0,
      decisions: [{ id: 'd1', question: 'Proceed?', options: ['yes', 'no'], recommended: 'yes', answer: null }] }];
    board.revision = 1;
    const receiptKey = 'a'.repeat(64);
    const receiptCreatedAt = Date.now();
    board._commandRetention = { version: 2, rejectBefore: receiptCreatedAt, lastNow: receiptCreatedAt };
    board._commandReceipts = { [receiptKey]: { inputHash: 'b'.repeat(64), revision: 1, createdAt: receiptCreatedAt,
      result: { private: 'INTERNAL-RECEIPT-SECRET' } } };
    write(boardFile, board); write(path.join(home, 'settings.json'), { webhookEvents: { done: true, pending: true, block: true } });
    const manifest = path.join(home, 'docs/design/审计回流/reader.json');
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    write(manifest, { batches: [{ reports: [{ key: 'fixture', task: 'ONE' }] }] });
    const paths = c.schedPaths(path.join(home, 'share'));
    for (const dir of [paths.control, paths.staging, paths.commands, paths.commandReceipts, paths.tickets]) fs.mkdirSync(dir, { recursive: true });
    write(paths.format, { formatVersion: 1, capabilities: ['canonical-json-sha256', 'reservation-expiry'], createdAt: new Date().toISOString() });
    write(paths.dispatcher, { machine: 'fixture-host', createdAt: new Date().toISOString(), createdBy: 'fixture' });
    const auth = createAuth({ home, registryPath });
    await auth.bootstrap('owner', PASSWORD);
    let owner = await auth.login('owner', PASSWORD);
    const passFile = path.join(home, 'password'); fs.writeFileSync(passFile, PASSWORD, { mode: 0o600 });
    srv = await start(home);

    for (const revoke of ['logout', 'reset-owner-password', 'revoke-all-credentials']) {
      await t.test('partial settings body cannot commit after ' + revoke, async () => {
        const before = snapshot(home);
        const held = await heldBody(srv, '/api/settings', owner, { webhookEvents: { done: false } });
        try {
          if (revoke === 'logout') assert.equal((await request(srv, '/api/auth/logout', owner, {})).status, 200);
          else assert.equal((await cli(home, revoke === 'reset-owner-password'
            ? [revoke, '--username', 'owner', '--password-file', passFile] : [revoke, '--confirm-revoke'])).ok, true);
          assert.equal((await held.finish()).status, 401);
          assert.deepEqual(snapshot(home), before);
        } finally { held.abort(); }
        owner = await auth.login('owner', PASSWORD);
      });
    }

    const device = auth.createDevice(owner.token, 'fixture-issued sessions');
    const routes = [
      ['/api/task/alpha/ONE/note', { text: 'must not write' }],
      ['/api/task/alpha/ONE/request-info', { did: 'd1', missing: ['background'] }],
      ['/api/decide/alpha/ONE', { did: 'd1', answer: 'yes' }],
      ['/api/undecide/alpha/ONE', { did: 'd1' }],
      ['/api/mark-landed/alpha/ONE', { did: 'd1' }],
      ['/api/sched/command', { kind: 'owner-hold', data: {} }],
      ['/api/codex/dispatch?project=alpha', { slug: 'missing-fixture' }],
      ['/api/codex/say?project=alpha', {}],
      ['/api/codex/collect?project=alpha', {}],
      ['/api/codex/say-session?project=alpha', {}],
      ['/api/dispatch', {}], ['/api/dispatch-project', {}], ['/api/dispatch-task', {}],
      ['/api/reader/annos', { project: 'alpha', key: 'fixture', anno: { text: 'must not write' } }],
      ['/api/audition/note', {}],
    ];
    for (const [route, body] of routes) await t.test('shared body boundary rejects revoked owner: ' + route, async () => {
      const session = auth.deviceLogin(device.token);
      const before = snapshot(home);
      const held = await heldBody(srv, route, session, body);
      try {
        assert.equal((await request(srv, '/api/auth/logout', session, {})).status, 200);
        assert.equal((await held.finish()).status, 401);
        assert.deepEqual(snapshot(home), before, 'no settings, board, annotation, dispatch or scheduler writes');
      } finally { held.abort(); }
    });

    await t.test('current owner identity is re-read, not copied from admission', async () => {
      const session = owner; // Password session; device sessions also require owner at session lookup.
      const held = await heldBody(srv, '/api/settings', session, { webhookEvents: { done: false } });
      const file = path.join(home, 'private', 'collaboration-auth.json');
      const db = JSON.parse(fs.readFileSync(file));
      // Synthetic fixture retains another enabled owner so the ledger is valid.
      const original = db.users.find(u => u.id === session.user.id);
      db.users.push({ ...original, id: 'fixture-second-owner', username: 'second-owner' });
      original.role = 'member'; write(file, db);
      try { assert.equal((await held.finish()).status, 403); }
      finally { held.abort(); original.role = 'owner'; write(file, db); }
    });

    await t.test('CLI internal command rejects revoked credentials and member credentials before board writes', async () => {
      const session = auth.deviceLogin(device.token);
      auth.logout(session.token);
      const args = ['note', 'ONE', '--project', 'alpha', '--text', 'must not write', '--json'];
      const before = fs.readFileSync(boardFile, 'utf8');
      const result = await cli(home, ['owner-command'], { sessionToken: session.token, args });
      assert.equal(result.status, 401); assert.equal(fs.readFileSync(boardFile, 'utf8'), before);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(session.token));
      const invitation = auth.createInvite(owner.token, { projectIds: ['alpha'], maxUses: 1, expiresInHours: 1 });
      const member = await auth.register({ inviteToken: invitation.token, username: 'fixture-member', password: PASSWORD });
      assert.equal((await cli(home, ['owner-command'], { sessionToken: member.token, args })).status, 403);
      assert.equal(fs.readFileSync(boardFile, 'utf8'), before);
    });

    await t.test('one actual HTTP proxy socket address cannot lock another correct account', async () => {
      for (let i = 0; i < 10; i++) assert.equal((await request(srv, '/api/auth/login', null,
        { username: 'fixture-member', password: 'x' })).status, 400);
      assert.equal((await request(srv, '/api/auth/login', null, { username: 'fixture-member', password: PASSWORD })).status, 429);
      assert.equal((await request(srv, '/api/auth/login', null, { username: 'owner', password: PASSWORD })).status, 200);
    });

    await t.test('CLI reads credentials from stdin and checks revocation after delayed input completes', async () => {
      const session = auth.deviceLogin(device.token);
      const child = fork(__filename, ['--owner-fixture'], { silent: true, windowsHide: true,
        env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: registryPath } });
      let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.resume();
      const timer = setTimeout(() => child.kill(), 20000);
      const exited = new Promise(resolve => child.once('exit', code => { clearTimeout(timer); resolve(code); }));
      const entered = message(child, 'input-received');
      const input = JSON.stringify({ sessionToken: session.token,
        args: ['note', 'ONE', '--project', 'alpha', '--text', 'must not write', '--json'] });
      const before = fs.readFileSync(boardFile, 'utf8');
      assert.equal(child.spawnargs.some(arg => arg.includes(session.token)), false);
      child.stdin.write(input.slice(0, -1));
      try {
        assert.ok((await entered).bytes > 0);
        auth.logout(session.token);
        child.stdin.end(input.slice(-1));
        assert.equal(await exited, 1); assert.equal(JSON.parse(output).status, 401);
        assert.equal(fs.readFileSync(boardFile, 'utf8'), before);
        assert.equal(output.includes(session.token), false);
      } finally { if (child.exitCode === null) { child.kill(); await exited; } }
    });

    await t.test('normal owner writes settings, CLI note and scheduler command with unchanged semantics', async () => {
      assert.equal((await request(srv, '/api/settings', owner, { webhookEvents: { done: false } })).status, 200);
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'))).webhookEvents.done, false);
      const result = await request(srv, '/api/task/alpha/ONE/note', owner, { text: 'authorized note' });
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true);
      assert.equal(JSON.parse(fs.readFileSync(boardFile)).activity.at(-1).text, 'authorized note');
      assert.equal((await request(srv, '/api/sched/command', owner, { kind: 'owner-hold', data: {} })).status, 200);
      assert.equal(fs.readdirSync(paths.commands).filter(name => name.endsWith('.json')).length, 1);
    });

    await t.test('authorized reader annotation still mirrors through the protected CLI executor', async () => {
      const result = await request(srv, '/api/reader/annos', owner,
        { project: 'alpha', key: 'fixture', anno: { text: 'authorized annotation' } });
      assert.equal(result.status, 200); assert.equal(result.body.mirror, true, JSON.stringify(result.body));
      assert.match(JSON.parse(fs.readFileSync(boardFile)).activity.at(-1).text, /authorized annotation/);
    });

    await t.test('all board projections hide internal receipts without changing persisted metadata', async () => {
      for (const suffix of ['', '?fields=tasks', '?fields=activity']) {
        const response = await request(srv, '/api/board/alpha' + suffix, owner);
        assert.equal(response.status, 200); assert.doesNotMatch(JSON.stringify(response.body), /_commandReceipts|_commandRetention|INTERNAL-RECEIPT-SECRET/);
      }
      assert.equal(JSON.parse(fs.readFileSync(boardFile))._commandReceipts[receiptKey].result.private, 'INTERNAL-RECEIPT-SECRET');
      assert.deepEqual(JSON.parse(fs.readFileSync(boardFile))._commandRetention, board._commandRetention);
      assert.equal(JSON.stringify({ result: { _commandReceipts: ['private'], _commandRetention: { rejectBefore: 1 }, ok: true } }, publicJson), '{"result":{"ok":true}}');
    });

    await t.test('local mode still permits settings and CLI board writes without credentials', async () => {
      local = await start(home, 'local'); local.local = true;
      assert.equal((await request(local, '/api/settings', null, { webhookEvents: { pending: false } })).status, 200);
      assert.equal((await request(local, '/api/task/alpha/ONE/note', null, { text: 'local note' })).status, 200);
      assert.equal(JSON.parse(fs.readFileSync(boardFile)).activity.at(-1).text, 'local note');
      const response = await request(local, '/api/board/alpha');
      assert.doesNotMatch(JSON.stringify(response.body), /_commandReceipts|INTERNAL-RECEIPT-SECRET/);
    });
  });
}
