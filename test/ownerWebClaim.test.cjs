'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createAuth } = require('../core/collaborationAuth.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const rules = require('../core/collaborationRules.cjs');
const ORIGIN = 'http://127.0.0.1:47123';

test('collaboration rules export importable ESM with identical results', async () => {
  assert.equal(typeof rules.toEsmSource, 'function');
  const esm = await import('data:text/javascript;base64,' + Buffer.from(rules.toEsmSource()).toString('base64'));
  for (const status of ['待开工', '施工中', '暂缓', '收官', '已完工', '已作废']) {
    for (const fields of [{}, { builder: 'AI' }, { collaborators: [{ userId: 'owner' }], assigneeUserId: 'member' }, { decisions: [{ answer: null }] }]) {
      const task = { status, ...fields };
      for (const user of [{ id: 'owner', role: 'owner' }, { id: 'member', role: 'member' }, null]) {
        assert.deepEqual(esm.memberActions(task, user), rules.memberActions(task, user));
        assert.equal(esm.aiWork(task), rules.aiWork(task));
      }
    }
  }
});

test('owner HTTP claim and progress persist and remain visible to members', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-web-claim-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const registryPath = path.join(home, 'registry.json');
  const boardPath = path.join(home, 'alpha.json');
  const board = emptyBoard({ id: 'alpha', name: '协作', mainRepo: home });
  board.tasks = [{ id: 'ONE', title: '负责人领取', status: '待开工', wave: 1 }];
  fs.writeFileSync(boardPath, JSON.stringify(board));
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { alpha: { mainRepo: home, board: boardPath, name: '协作' } } }));
  const auth = createAuth({ home, registryPath });
  const password = 'Owner-test-password-123';
  await auth.bootstrap('owner', password);
  const owner = await auth.login('owner', password, 'owner-web-test');
  const invite = auth.createInvite(owner.token, { projectIds: ['alpha'], expiresInHours: 1, maxUses: 1 });
  const member = await auth.register({ inviteToken: invite.token, username: 'member', password }, 'member-web-test');
  child = fork(path.resolve(__dirname, '../server/server.cjs'), [], { silent: true, windowsHide: true, env: {
    ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: registryPath, DASHBOARD_MODE: 'collaboration',
    DASHBOARD_PUBLIC_ORIGIN: ORIGIN, DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_NO_OPEN: '1',
    DASHBOARD_POLL_MS: '500', DASHBOARD_EVENT_WEBHOOK: '',
  } });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + output)), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output)); });
    child.on('message', msg => { if (msg.type === 'dashboard-ready') { clearTimeout(timer); resolve(`http://127.0.0.1:${msg.port}`); } });
  });
  async function request(route, session, data) {
    const res = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: {
      Cookie: 'dashboard_session=' + session.token,
      ...(data === undefined ? {} : { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Dashboard-Request': '1', 'X-Dashboard-CSRF': session.csrfToken }),
    }, body: data === undefined ? undefined : JSON.stringify(data) });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    return body;
  }
  const root = '/api/collaboration/projects/alpha/tasks/ONE/';
  assert.equal((await request(root + 'claim', owner, {})).ok, true);
  const claimed = JSON.parse(fs.readFileSync(boardPath, 'utf8')).tasks.find(task => task.id === 'ONE');
  assert.equal(claimed.assigneeUserId, owner.user.id);
  assert.equal(claimed.status, '施工中');
  assert.equal((await request(root + 'progress', owner, { percent: 40 })).ok, true);
  const updated = JSON.parse(fs.readFileSync(boardPath, 'utf8')).tasks.find(task => task.id === 'ONE');
  assert.equal(updated.percent, 40);
  const visible = (await request('/api/board/alpha', member)).tasks.find(task => task.id === 'ONE');
  assert.equal(visible.assigneeUserId, owner.user.id);
  assert.equal(visible.status, '施工中');
  assert.equal(visible.percent, 40);
});
