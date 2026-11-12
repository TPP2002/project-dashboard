'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const { boardView } = require('../server/collaborationApi.cjs');
const { taskView, text, publicJson } = require('../core/collaborationPublic.cjs');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');

function oldView(board, user) {
  return { schemaVersion: board.schemaVersion,
    project: { id: text(board.project.id), name: text(board.project.name), createdAt: text(board.project.createdAt), updatedAt: text(board.project.updatedAt) },
    tasks: board.tasks.map(t => taskView(t, user, board.activity || [])),
    activity: (board.activity || []).filter(a => ['collaboration:claim', 'collaboration:progress'].includes(a.type) && typeof a.userId === 'string')
      .map(a => ({ ts: text(a.ts), type: a.type, taskId: text(a.taskId), userId: text(a.userId), author: text(a.author) })) };
}
const serialize = value => JSON.stringify(value, publicJson);
test('grouped board view matches the original algorithm', () => {
  let seed = 1234567;
  const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 30; i++) {
    const count = i === 0 ? 0 : i === 1 ? 60 : i === 2 ? 2 : rand(61);
    const board = { schemaVersion: '1', project: { id: 'demo', name: 'Demo' }, tasks: Array.from({ length: count }, (_, n) => ({ id: 'T' + n, title: 'Task', status: '待开工', wave: 1 })), activity: [] };
    const length = i === 1 ? 600 : rand(601);
    for (let n = 0; n < length; n++) board.activity.push({ taskId: n < 100 ? 'T0' : 'T' + rand(80), kind: n % 5 ? 'message' : 'other', type: n % 7 ? 'note' : 'collaboration:claim', userId: 'u', text: n === 99 ? '文'.repeat(30000) : 'text' + n });
    if (i === 1) board.activity[board.activity.length - 1] = { taskId: 'T0', kind: 'message', text: '文'.repeat(30000) };
    if (i === 2) board.activity = Array.from({ length: 100 }, (_, n) => ({ taskId: 'T0', kind: 'message', text: 'text' + n }));
    for (const user of [{ id: 'u', role: 'owner' }, { id: 'u', role: 'member' }, { id: 'v', role: 'viewer' }, { id: 'u', role: 'member', disabled: true }]) assert.equal(serialize(boardView(board, user)), serialize(oldView(board, user)));
  }
});

test('board and view caches respect fingerprints, limits and immutable boards', () => {
  const { createMemberBoardCache } = require('../core/memberBoardCache.cjs');
  let reads = 0, revision = 1, views = 0, summaries = 0;
  const cache = createMemberBoardCache({ stat: () => ({ size: revision, mtimeMs: revision, ctimeMs: revision }), read: () => { reads++; return JSON.stringify({ project: {}, tasks: [], activity: [] }); }, summarize: () => { summaries++; return { total: 0 }; }, view: (b, u) => { views++; return { user: u.id, board: b }; } });
  const user = { id: 'u', role: 'member', disabled: false };
  for (let n = 0; n < 20; n++) { const b = cache.board('a'); assert.ok(Object.isFrozen(b)); cache.summary('a'); cache.view('a', user); }
  assert.equal(reads, 1); assert.equal(summaries, 1); assert.equal(views, 1);
  assert.ok(Object.isFrozen(cache.board('a').tasks));
  assert.throws(() => cache.board('a').tasks.push({}));
  assert.deepEqual(cache.board('a').tasks, []);
  cache.view('a', { ...user, id: 'other' }); assert.equal(reads, 1); assert.equal(views, 2);
  cache.view('a', { ...user, role: 'viewer' }); assert.equal(views, 3);
  revision++; cache.board('a'); cache.view('a', user); cache.summary('a'); assert.equal(reads, 2); assert.equal(views, 4); assert.equal(summaries, 2);
  for (let n = 0; n < 8; n++) cache.board('b' + n);
  cache.board('a'); assert.equal(reads, 11);
  for (let n = 0; n < 65; n++) cache.view('a', { ...user, id: 'x' + n });
  const before = views; cache.view('a', { ...user, id: 'x0' }); assert.equal(views, before + 1);
});

test('member HTTP polling respects authorization and versions', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'member-poll-'));
  let child;
  t.after(async () => { if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); fs.rmSync(home, { recursive: true, force: true }); });
  const registryPath = path.join(home, 'registry.json');
  const boardPath = path.join(home, 'board.json');
  const board = emptyBoard({ id: 'demo', name: 'Demo', mainRepo: home });
  board.tasks = [{ id: 'T1', title: 'Task', status: '待开工', wave: 1 }];
  fs.writeFileSync(boardPath, JSON.stringify(board));
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { demo: { name: 'Demo', mainRepo: home, board: boardPath } } }));
  const auth = createAuth({ home, registryPath }); const password = 'Example-password-12345';
  await auth.bootstrap('owner', password);
  const owner = await auth.login('owner', password, 'owner');
  const invite = auth.createInvite(owner.token, { projectIds: ['demo'], expiresInHours: 1, maxUses: 2 });
  const member = await auth.register({ inviteToken: invite.token, username: 'member', password }, 'member');
  const other = await auth.register({ inviteToken: invite.token, username: 'other', password }, 'other');
  const viewerInvite = auth.createInvite(owner.token, { projectIds: ['demo'], expiresInHours: 1, maxUses: 1, role: 'viewer' });
  const viewer = await auth.register({ inviteToken: viewerInvite.token, username: 'viewer', password }, 'viewer');
  const origin = 'http://localhost:47123';
  child = fork(path.resolve(__dirname, '../server/server.cjs'), [], { silent: true, windowsHide: true, env: { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: registryPath, DASHBOARD_MODE: 'collaboration', DASHBOARD_PUBLIC_ORIGIN: origin, DASHBOARD_HOST: 'localhost', DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1', DASHBOARD_EVENT_WEBHOOK: '' } });
  const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server timeout')), 15000); child.once('error', reject); child.once('exit', code => reject(new Error('server exit ' + code))); child.on('message', message => { if (message.type === 'dashboard-ready') { clearTimeout(timer); resolve(message.port); } }); });
  const req = async (url, session, data) => { const res = await fetch('http://localhost:' + port + url, { method: data === undefined ? 'GET' : 'POST', headers: { ...(session ? { cookie: 'dashboard_session=' + session.token } : {}), ...(data === undefined ? {} : { origin, 'content-type': 'application/json', 'x-dashboard-request': '1', 'x-dashboard-csrf': session.csrfToken }) }, body: data === undefined ? undefined : JSON.stringify(data) }); const bodyText = await res.text(); return { res, text: bodyText, body: JSON.parse(bodyText) }; };
  const list1 = await req('/api/projects', member); const list2 = await req('/api/projects', member); assert.equal(list1.text, list2.text);
  const plain = await req('/api/board/demo', member); assert.equal(plain.text, serialize(oldView(board, member.user))); assert.equal(plain.res.headers.get('cache-control'), 'private, no-store'); assert.equal(plain.res.headers.get('vary'), 'Cookie'); assert.equal(plain.res.headers.has('etag'), false);
  const full = await req('/api/board/demo?since=x', member); assert.match(full.body.version, /^[a-f0-9]{16}$/);
  assert.equal(full.body.version, crypto.createHash('sha256').update(plain.text).digest('hex').slice(0, 16));
  const same = await req('/api/board/demo?since=' + full.body.version, member); assert.deepEqual(same.body, { ok: true, unchanged: true, version: full.body.version });
  assert.equal((await req('/api/collaboration/projects/demo/tasks/T1/claim', member, {})).res.status, 200);
  const changed = await req('/api/board/demo?since=' + full.body.version, member); assert.notEqual(changed.body.version, full.body.version); assert.ok(changed.body.tasks);
  assert.notEqual((await req('/api/projects', member)).text, list1.text);
  const otherView = await req('/api/board/demo?since=x', other); const viewerView = await req('/api/board/demo?since=x', viewer);
  assert.notEqual(otherView.body.version, changed.body.version); assert.notEqual(viewerView.body.version, changed.body.version);
  assert.notEqual(viewerView.body.version, otherView.body.version);
  auth.access(owner.token, member.user.id, { projectIds: [], disabled: false }); assert.equal((await req('/api/board/demo?since=' + changed.body.version, member)).res.status, 404);
  assert.equal((await req('/api/auth/logout', other, {})).res.status, 200); assert.equal((await req('/api/board/demo?since=' + otherView.body.version, other)).res.status, 401);
});
