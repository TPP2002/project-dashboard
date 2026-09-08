'use strict';
// 真 server 子进程 + 临时 registry；派单只取 preview，所有 board 写入经现有 CLI 命令层。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { readBoard } = require('../cli/store.cjs');
const freePort = require('../scripts/free-port.cjs');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server/server.cjs');
let srv;

function stopServer(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, DASHBOARD_NO_OPEN: '1', DASHBOARD_POLL_MS: '500', ...env },
    });
    let out = '', err = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) stopServer(child).then(() => reject(error), reject);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('server 启动超时\n' + out + '\n' + err)), 15000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/127\.0\.0\.1:(\d+)\//);
      if (match) finish(null, { child, base: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => finish(new Error(`server 提前退出 code=${code}\n${out}\n${err}`)));
  });
}

before(async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unlanded-server-')));
  const reg = path.join(dir, 'registry.json');
  srv = { dir, reg };
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  Object.assign(srv, await startServer({
    DASHBOARD_REGISTRY: reg, DASHBOARD_HOME: path.join(dir, 'home'), DASHBOARD_PORT: String(await freePort()),
  }));
});

after(async () => {
  if (!srv) return;
  await stopServer(srv.child);
  fs.rmSync(srv.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function newProject(id) {
  const root = path.join(srv.dir, id);
  fs.mkdirSync(root);
  const { board } = cmds.register({ id, name: id, root, registry: srv.reg });
  const P = { project: id, registry: srv.reg };
  return {
    id, board,
    add(tid, status, decisions) {
      cmds.add({ _: [tid], title: `任务 ${tid}`, status, ...P });
      // 模拟 done 自动落地上线前的存量，仍走 CLI 写者，不自行写 board。
      cmds.set({ _: [tid], field: 'decisions', value: JSON.stringify(decisions), ...P });
    },
  };
}

const decision = (id, extra = {}) => ({
  id, question: `问题 ${id}`, options: ['A', 'B'], recommended: 'A',
  answer: 'A', decidedAt: '2026-01-01', ...extra,
});

async function post(route, body) {
  const res = await fetch(srv.base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  return { status: res.status, body: await res.json() };
}

test('dispatch-project preview 只打包非终态卡的已答未标决策，count 不含完工/作废卡', async () => {
  const p = newProject('project-preview');
  p.add('ACTIVE-1', '施工中', [decision('d1', { question: '仍须落实甲' }),
    decision('d2', { question: '仍须落实乙', landed: false }),
    decision('d3', { question: '已经显式落地', landed: true }), decision('d4', { answer: null })]);
  p.add('DONE-1', '已完工', [decision('d1', { question: '完工存量不要派' })]);
  p.add('VOID-1', '已作废', [decision('d1', { question: '作废存量不要派' })]);
  const before = fs.readFileSync(p.board, 'utf8');
  const result = await post('/api/dispatch-project', { pid: p.id, preview: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.count, 2);
  assert.match(result.body.prompt, /ACTIVE-1/);
  assert.match(result.body.prompt, /仍须落实甲/);
  assert.match(result.body.prompt, /仍须落实乙/);
  assert.doesNotMatch(result.body.prompt, /DONE-1|VOID-1|完工存量不要派|作废存量不要派|已经显式落地/);
  assert.equal(fs.readFileSync(p.board, 'utf8'), before, '预览不得改历史数据');
});

test('dispatch-task preview 对终态卡无待落地可派，非终态卡仍按任务打包', async () => {
  const p = newProject('task-preview');
  p.add('ACTIVE-1', '施工中', [decision('d1'), decision('d2', { landed: true })]);
  p.add('DONE-1', '已完工', [decision('d1')]);
  p.add('VOID-1', '已作废', [decision('d1')]);
  for (const tid of ['DONE-1', 'VOID-1']) {
    const result = await post('/api/dispatch-task', { pid: p.id, tid, preview: true });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /没有待落地决策/);
  }
  const active = await post('/api/dispatch-task', { pid: p.id, tid: 'ACTIVE-1', preview: true });
  assert.equal(active.status, 200);
  assert.equal(active.body.count, 1);
  assert.match(active.body.prompt, /mark-landed ACTIVE-1 --did d1/);
  assert.doesNotMatch(active.body.prompt, /mark-landed ACTIVE-1 --did d2/);
});

test('mark-landed all:true 经 CLI 确认终态存量，保留未答项与既有落地证据', async () => {
  const p = newProject('mark-all');
  for (const [tid, status] of [['DONE-1', '已完工'], ['VOID-1', '已作废']]) {
    const existing = decision('d3', { landed: true, landedAt: '2026-01-02', landedCommit: 'abc1234' });
    const unanswered = decision('d4', { answer: null, decidedAt: null });
    const missing = decision('d5', { answer: undefined, decidedAt: null });
    p.add(tid, status, [decision('d1'), decision('d2', { landed: false }), existing, unanswered, missing]);
    const result = await post(`/api/mark-landed/${p.id}/${tid}`, { all: true, author: '看板' });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.id, tid);
    const board = readBoard(p.board);
    const task = board.tasks.find((t) => t.id === tid);
    assert.equal(task.status, status);
    assert.deepEqual(task.decisions.map((d) => d.landed), [true, true, true, undefined, undefined]);
    assert.match(task.decisions[0].landedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(task.decisions[2], existing);
    assert.deepEqual(task.decisions[3], unanswered);
    assert.equal(task.decisions[4].answer, undefined);
    assert.equal(board.activity.at(-1).author, '看板');
    assert.match(board.activity.at(-1).text, /已代码落地（全部未落地项）/);
  }
});

test('mark-landed 必须给 did 或严格布尔 all:true；非法请求不写盘', async () => {
  const p = newProject('mark-invalid');
  p.add('ACTIVE-1', '施工中', [decision('d1')]);
  const before = fs.readFileSync(p.board, 'utf8');
  for (const body of [{}, { did: ' ' }, { all: false }, { all: 'true' }, { all: 1 }]) {
    const result = await post(`/api/mark-landed/${p.id}/ACTIVE-1`, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /did/);
  }
  assert.equal(fs.readFileSync(p.board, 'utf8'), before);
});

test('mark-landed 逐条写法仍只标指定决策，all:true 优先于 did', async () => {
  const p = newProject('mark-single');
  p.add('ACTIVE-1', '施工中', [decision('d1'), decision('d2'), decision('d3')]);
  const route = `/api/mark-landed/${p.id}/ACTIVE-1`;
  const single = await post(route, { did: 'd1' });
  assert.equal(single.status, 200);
  assert.deepEqual(readBoard(p.board).tasks[0].decisions.map((d) => !!d.landed), [true, false, false]);
  const all = await post(route, { all: true, did: 'ignored' });
  assert.equal(all.status, 200);
  assert.deepEqual(readBoard(p.board).tasks[0].decisions.map((d) => d.landed), [true, true, true]);
});
