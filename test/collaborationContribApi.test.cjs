'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const SERVER = path.resolve(__dirname, '../server/server.cjs');
const ORIGIN = 'http://127.0.0.1:47123';
const PASSWORD = 'Contribution-test-secret-123';

// Same isolated home, ephemeral port and ready IPC protocol as collaborationServer.
function start(home) {
  const child = fork(SERVER, [], { silent: true, windowsHide: true, env: { ...process.env,
    DASHBOARD_HOME: home, DASHBOARD_REGISTRY: path.join(home, 'registry.json'), DASHBOARD_MODE: 'collaboration',
    DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1',
    DASHBOARD_POLL_MS: '500', DASHBOARD_EVENT_WEBHOOK: '',
  } });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out: ' + output)); }, 15000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output)); });
    child.on('message', msg => { if (msg.type === 'dashboard-ready') { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${msg.port}` }); } });
  });
}
async function stop(srv) {
  if (!srv || srv.child.exitCode !== null) return;
  await new Promise(resolve => { srv.child.once('exit', resolve); srv.child.kill(); });
}

test('contributions HTTP roles, confidentiality, authorization and read-only directory', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collaboration-contrib-'));
  let srv;
  t.after(async () => { await stop(srv); fs.rmSync(home, { recursive: true, force: true }); });
  const registryPath = path.join(home, 'registry.json');
  const registry = { projects: {} };
  for (const id of ['alpha', 'beta']) {
    const mainRepo = path.join(home, id);
    fs.mkdirSync(mainRepo);
    const board = path.join(mainRepo, 'board.json');
    registry.projects[id] = { mainRepo, board, name: id };
    fs.writeFileSync(board, JSON.stringify(emptyBoard({ id, name: id, mainRepo })));
  }
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  const auth = createAuth({ home, registryPath });
  await auth.bootstrap('secret-owner-login', PASSWORD);
  const ledgerPath = path.join(home, 'private', 'collaboration-auth.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.users[0].displayName = '项目负责人';
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const owner = await auth.login('secret-owner-login', PASSWORD);
  async function register(role, projectIds, username, displayName) {
    const invite = auth.createInvite(owner.token, { role, projectIds, expiresInHours: 1, maxUses: 1 });
    return auth.register({ inviteToken: invite.token, username, displayName, password: PASSWORD });
  }
  const member = await register('member', ['alpha'], 'secret-member-login', '推进成员');
  const viewer = await register('viewer', ['alpha'], 'secret-viewer-login', '只读用户');
  const outsider = await register('member', ['beta'], 'secret-outside-login', '其他项目成员');
  const disabled = await register('member', ['alpha'], 'secret-disabled-login', '历史成员');
  auth.access(owner.token, disabled.user.id, { projectIds: ['alpha'], disabled: true });
  const board = emptyBoard({ id: 'alpha', name: 'alpha', mainRepo: home });
  board.tasks = [{ id: 'ONE', title: 'A shared task', status: '已完工', assigneeUserId: member.user.id,
    createdByUserId: member.user.id, collaborators: [{ userId: owner.user.id, name: owner.user.displayName }],
    gitBranch: 'SECRET BRANCH', prNumbers: [123], cost: { tokens: 999 } }];
  board.activity = [{ ts: new Date().toISOString(), type: 'done', userId: member.user.id, author: member.user.displayName,
    taskId: 'ONE', via: 'ai', text: 'SECRET ACTIVITY', reason: 'SECRET REASON', tokenLabel: 'SECRET TOKEN LABEL' }];
  fs.writeFileSync(registry.projects.alpha.board, JSON.stringify(board));
  srv = await start(home);
  async function request(session, suffix = '', projectId = 'alpha', method = 'GET') {
    const res = await fetch(`${srv.base}/api/collaboration/projects/${projectId}/contributions${suffix}`, {
      method, headers: session ? { Cookie: `dashboard_session=${session.token}` } : {},
    });
    const body = await res.json();
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /passwordHash|tokenHash|"salt"|"username"|SECRET|secret-.*-login/);
    for (const secret of [PASSWORD, owner.token, member.token, viewer.token]) assert.ok(!serialized.includes(secret));
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('vary'), /Cookie/i);
    return { status: res.status, body };
  }
  await t.test('owner and member receive full before legacy route fallback', async () => {
    for (const session of [owner, member]) {
      const result = await request(session);
      assert.equal(result.status, 200);
      assert.equal(result.body.scope, 'full');
      assert.equal(result.body.range.weeks, 8);
      assert.equal(result.body.totals.completed, 1);
      assert.equal(result.body.recent[0].viaAi, true);
      assert.equal(result.body.recent[0].action, 'done');
      assert.ok(result.body.members.some(m => m.userId === owner.user.id));
      assert.ok(!result.body.members.some(m => m.userId === outsider.user.id));
    }
  });
  await t.test('viewer gets only summary with no identities anywhere', async () => {
    const result = await request(viewer);
    assert.equal(result.status, 200); assert.equal(result.body.scope, 'summary');
    assert.deepEqual(Object.keys(result.body).sort(), ['range', 'scope', 'totals', 'weekly']);
    const json = JSON.stringify(result.body);
    for (const session of [owner, member, viewer, outsider, disabled]) {
      assert.ok(!json.includes(session.user.id)); assert.ok(!json.includes(session.user.displayName));
    }
    assert.doesNotMatch(json, /members|unattributed|recent|userId/);
  });
  await t.test('unauthenticated, disabled, cross-project and missing projects are rejected', async () => {
    assert.equal((await request(null)).status, 401);
    assert.equal((await request(disabled)).status, 401);
    for (const session of [member, viewer]) assert.equal((await request(session, '', 'beta')).status, 404);
    assert.equal((await request(outsider)).status, 404);
    assert.equal((await request(owner, '', 'missing')).status, 404);
  });
  await t.test('only exact 4/8/12 weeks accepted and non-GET never mutates', async () => {
    for (const weeks of ['4', '8', '12']) {
      const result = await request(member, '?weeks=' + weeks);
      assert.equal(result.status, 200); assert.equal(result.body.weekly.length, Number(weeks));
    }
    for (const suffix of ['?weeks=5', '?weeks=', '?weeks=04', '?weeks=8.0', '?weeks=4&weeks=8']) {
      assert.equal((await request(member, suffix)).status, 400);
    }
    const before = fs.readFileSync(registry.projects.alpha.board, 'utf8');
    for (const session of [owner, member, viewer]) assert.equal((await request(session, '', 'alpha', 'POST')).status, 405);
    assert.equal(fs.readFileSync(registry.projects.alpha.board, 'utf8'), before);
  });
  await t.test('projectDirectory is a read-only whitelist, includes owner and disabled history, excludes other projects', () => {
    const before = fs.readFileSync(ledgerPath, 'utf8');
    const directory = auth.projectDirectory('alpha');
    assert.deepEqual(directory.map(u => u.id), [owner.user.id, member.user.id, viewer.user.id, disabled.user.id]);
    assert.equal(directory.find(u => u.id === disabled.user.id).disabled, true);
    for (const entry of directory) assert.deepEqual(Object.keys(entry).sort(), ['disabled', 'displayName', 'id', 'role']);
    directory[0].displayName = 'changed only returned data';
    assert.equal(auth.projectDirectory('alpha')[0].displayName, owner.user.displayName);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before);
  });
  await t.test('contributions include real monthly archives, deduplicate and refresh them like the board route', async () => {
    // archive-activity stores a JSON array next to board.json, named by local month.
    const old = new Date(Date.now() - 8 * 86400000);
    const stamp = `${old.getFullYear()}${String(old.getMonth() + 1).padStart(2, '0')}`;
    const file = path.join(path.dirname(registry.projects.alpha.board), `activity-${stamp}.json`);
    const archived = [
      { ts: old.toISOString(), type: 'note', kind: 'message', userId: member.user.id,
        author: member.user.displayName, taskId: 'ONE', via: 'ai', text: 'Archived message' },
      { ts: new Date(old.getTime() + 1000).toISOString(), type: 'note', kind: 'message', taskId: 'ONE', text: 'Unsigned archived message' },
      board.activity[0], // A board/archive overlap must count only once.
    ];
    const boardBefore = fs.readFileSync(registry.projects.alpha.board, 'utf8');
    fs.writeFileSync(file, JSON.stringify(archived));
    for (const session of [owner, member, viewer]) {
      const { status, body } = await request(session, '?weeks=4');
      assert.equal(status, 200);
      assert.equal(body.totals.messages, 2);
      assert.equal(body.totals.attributedOps, 2);
      assert.equal(body.totals.aiOps, 2);
      assert.equal(body.weekly.reduce((n, w) => n + w.messages, 0), 2);
      assert.equal(body.weekly.reduce((n, w) => n + w.ops, 0), 3);
      assert.equal(body.weekly.reduce((n, w) => n + w.completed, 0), 1);
      const bucket = body.weekly.find(w => Date.parse(w.weekStart) <= old.getTime()
        && old.getTime() < Date.parse(w.weekStart) + 7 * 86400000);
      assert.equal(bucket.messages, 2);
      if (body.scope === 'full') {
        assert.equal(body.members.find(m => m.userId === member.user.id).messages, 1);
        assert.equal(body.unattributed.messages, 1);
        assert.equal(body.recent.length, 2);
        assert.equal(body.recent[1].action, 'message');
        assert.equal(body.recent[1].viaAi, true);
      }
    }
    const merged = await fetch(srv.base + '/api/board/alpha?fields=activity', { headers: { Cookie: `dashboard_session=${owner.token}` } });
    assert.equal(merged.status, 200);
    assert.equal((await merged.json()).activity.length, 3);
    assert.equal((await request(owner, '', 'beta')).body.totals.messages, 0, 'archives stay in their project directory');
    archived.push({ ...archived[0], text: 'Another archived message' });
    fs.writeFileSync(file, JSON.stringify(archived));
    const refreshed = (await request(member)).body;
    assert.equal(refreshed.totals.messages, 3);
    assert.equal(refreshed.totals.attributedOps, 3);
    assert.equal(refreshed.weekly.reduce((n, w) => n + w.messages, 0), 3);
    assert.equal(fs.readFileSync(registry.projects.alpha.board, 'utf8'), boardBefore);
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(archived), 'contributions do not mutate archives');
  });
  await t.test('corrupt authentication ledger fails closed for directory and HTTP', async () => {
    fs.writeFileSync(ledgerPath, '{broken');
    assert.throws(() => auth.projectDirectory('alpha'), { status: 503 });
    assert.equal((await request(owner)).status, 503);
  });
});
