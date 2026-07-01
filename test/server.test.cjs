'use strict';
/**
 * server.test.cjs —— server/server.cjs 端到端（spawn 真实进程 + fetch/SSE 断言）。
 *
 * 全程临时 registry（DASHBOARD_REGISTRY）+ 随机高位端口（DASHBOARD_PORT）+ 不开浏览器
 * （DASHBOARD_NO_OPEN=1），绝不碰真实 registry / A 股主仓。共享一个 server 实例，各测试
 * 在同一临时 registry 里注册各自独立项目（server 每次请求都重读 registry，天然隔离）。
 *
 * 覆盖：
 *   · GET  /api/health                     探活字段（端口/pid/projects/hooksInstalled）
 *   · GET  /api/projects                   读时派生 summary（不落盘 R9a）
 *   · GET  /api/board/:id                  board 全量；未注册 → 404
 *   · GET  /api/doc                        合法读 200；../ 与 junction 逃逸 → 403（R4）
 *   · POST /api/decide                     落库 + 参数按字面 argv 传递（防注入 R6）；非法答案 400
 *   · GET  /api/stream                     SSE 收 board:changed（mtime 轮询驱动 R7）
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { readBoard } = require('../cli/store.cjs');

const DASH_ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(DASH_ROOT, 'server', 'server.cjs');
const POLL_MS = 500; // server 内部 clamp 下限即 500，与之对齐

let SRV = null; // 共享 server 句柄：{ child, base, port, dir, reg }

const realTmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const randomPort = () => 20000 + Math.floor(Math.random() * 40000);
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

/** spawn 真实 server 进程；从 stdout 抓「http://127.0.0.1:PORT/」拿实际端口（端口占用会自增，故不假设端口）。 */
function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: DASH_ROOT, windowsHide: true,
      env: { ...process.env, DASHBOARD_NO_OPEN: '1', DASHBOARD_POLL_MS: String(POLL_MS), ...env },
    });
    let out = '', err = '', settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => done(reject, new Error('server 启动超时\nSTDOUT:\n' + out + '\nSTDERR:\n' + err)), 15000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/127\.0\.0\.1:(\d+)\//);
      if (m) done(resolve, { child, port: Number(m[1]), base: `http://127.0.0.1:${m[1]}` });
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done(reject, e));
    child.on('exit', (code) => done(reject, new Error('server 提前退出 code=' + code + '\nSTDOUT:\n' + out + '\nSTDERR:\n' + err)));
  });
}

/** kill server，等其真正退出（Windows kill 即终止；3s 兜底 SIGKILL）。 */
function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    try { child.kill(); } catch { resolve(); return; }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已死 */ } resolve(); }, 3000);
  });
}

/** 在共享 registry 里注册一个独立项目（各测试隔离），返回其句柄。 */
function newProject(id, name) {
  const root = path.join(SRV.dir, id);
  fs.mkdirSync(root, { recursive: true });
  cmds.register({ id, name: name || id, root, registry: SRV.reg });
  return { id, root, board: path.join(root, '.dashboard', 'board.json'), P: { project: id, registry: SRV.reg } };
}

async function getJson(pathname) {
  const res = await fetch(SRV.base + pathname);
  let body = null; try { body = await res.json(); } catch { /* 非 JSON 保持 null */ }
  return { status: res.status, body };
}
const doc = (proj, p) => fetch(SRV.base + '/api/doc?projectId=' + encodeURIComponent(proj) + '&path=' + encodeURIComponent(p));

// ---- SSE 客户端：http.get 保持长连，累积并按空行切分 event/data 块 ----
function parseSse(block) {
  let event = 'message', data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  let parsed = null; try { parsed = data ? JSON.parse(data) : null; } catch { /* 保持 null */ }
  return { event, data: parsed };
}
function openSse() {
  return new Promise((resolve, reject) => {
    const req = http.get(SRV.base + '/api/stream', (res) => {
      const client = { req, res, buf: '', events: [], waiters: [] };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        client.buf += chunk;
        let i;
        while ((i = client.buf.indexOf('\n\n')) >= 0) {
          const block = client.buf.slice(0, i); client.buf = client.buf.slice(i + 2);
          const ev = parseSse(block);
          client.events.push(ev);
          client.waiters = client.waiters.filter((w) => {
            if (w.name === ev.event) { clearTimeout(w.timer); w.resolve(ev); return false; }
            return true;
          });
        }
      });
      resolve(client);
    });
    req.on('error', reject);
  });
}
function waitEvent(client, name, timeoutMs) {
  const hit = client.events.find((e) => e.event === name);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const w = {
      name, resolve,
      timer: setTimeout(() => { client.waiters = client.waiters.filter((x) => x !== w); reject(new Error(`等 SSE 事件「${name}」超时`)); }, timeoutMs),
    };
    client.waiters.push(w);
  });
}
const closeSse = (client) => { try { client.req.destroy(); } catch { /* 已断 */ } };

// ============ 生命周期 ============

before(async () => {
  const dir = realTmp('srv-');
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const s = await startServer({ DASHBOARD_REGISTRY: reg, DASHBOARD_PORT: String(randomPort()) });
  SRV = { ...s, dir, reg };
});

after(async () => {
  if (SRV) { await stopServer(SRV.child); clean(SRV.dir); }
});

// ============ 用例 ============

test('GET /api/health → ok + 端口/pid/projects/hooksInstalled', async () => {
  newProject('health');
  const { status, body } = await getJson('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, 'claude-dashboard');
  assert.equal(body.port, SRV.port, 'health.port 应为实际监听端口');
  assert.ok(Number.isInteger(body.pid), 'pid 为整数');
  assert.ok(Array.isArray(body.projects) && body.projects.includes('health'), 'projects 含刚注册的项目');
  assert.equal(typeof body.hooksInstalled, 'object', 'hooksInstalled 为对象');
});

test('GET /api/projects → 含读时派生 summary（total/byStatus）', async () => {
  const p = newProject('projlist');
  cmds.add({ _: ['P01'], title: 'a', ...p.P });
  cmds.add({ _: ['P02'], title: 'b', status: '已完工', ...p.P });
  const { status, body } = await getJson('/api/projects');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const entry = body.projects.find((x) => x.id === 'projlist');
  assert.ok(entry, '项目在列表中');
  assert.equal(entry.summary.total, 2);
  assert.equal(entry.summary.byStatus['已完工'], 1);
  assert.equal(entry.summary.progress, 50);
});

test('GET /api/board/:id → 返回 board 全量；未注册 → 404', async () => {
  const p = newProject('boardone');
  cmds.add({ _: ['P01'], title: '看板任务', ...p.P });
  const { status, body } = await getJson('/api/board/boardone');
  assert.equal(status, 200);
  assert.equal(body.project.id, 'boardone');
  assert.ok(Array.isArray(body.tasks) && body.tasks.find((t) => t.id === 'P01'), 'tasks 含 P01');

  const miss = await getJson('/api/board/no-such-proj');
  assert.equal(miss.status, 404);
  assert.equal(miss.body.ok, false);
});

test('GET /api/doc → 合法读 200；../ 与 junction 逃逸 → 403（R4）', async () => {
  const p = newProject('docproj');
  fs.writeFileSync(path.join(p.root, 'NOTE.md'), '# 文档标题\nhello-doc-body');

  // 合法：docsRoot（=主仓）内的文件可读
  const okRes = await doc('docproj', 'NOTE.md');
  assert.equal(okRes.status, 200);
  assert.match(await okRes.text(), /hello-doc-body/);

  // ../ 逃逸：把机密放在 docsRoot 外，尝试穿越 → 403
  fs.writeFileSync(path.join(SRV.dir, 'SECRET.txt'), 'top-secret');
  const esc = await doc('docproj', '../SECRET.txt');
  assert.equal(esc.status, 403, '../ 穿越必须 403');

  // junction 逃逸：root 内建 junction 指向 root 外（startsWith 会被骗过，realpath 不会）→ 403
  const outside = path.join(SRV.dir, 'doc-outside'); fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'junction-secret');
  let made = false;
  try { fs.symlinkSync(outside, path.join(p.root, 'link'), 'junction'); made = true; } catch { /* 无权限造 junction 则跳过该断言 */ }
  if (made) {
    const jesc = await doc('docproj', 'link/secret.txt');
    assert.equal(jesc.status, 403, 'junction 逃逸必须 403');
  }
});

test('POST /api/decide → 落库 + 参数按字面 argv 传递（防注入 R6）', async () => {
  const p = newProject('decideok');
  cmds.add({ _: ['P01'], title: '拍板', ...p.P });
  // 一个“含 shell 元字符的合法选项”：若 server 拿去拼 shell，会被解释/截断；execFile 数组传参则原样到 CLI。
  const INJECT = '甲 & echo pwned > pwned.txt';
  cmds.pending({ _: ['P01'], q: '选哪个', opt: ['甲', INJECT], rec: '甲', ...p.P });

  const res = await fetch(SRV.base + '/api/decide/decideok/P01', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ did: 'd1', answer: INJECT }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  // 落库：answer 逐字节 === 我发送的注入串（证明未经 shell）
  const d = readBoard(p.board).tasks.find((t) => t.id === 'P01').decisions.find((x) => x.id === 'd1');
  assert.strictEqual(d.answer, INJECT, 'answer 原样落库');
  // 无副作用：注入串未被 shell 执行（server cwd 与项目目录都不该冒出 pwned.txt）
  assert.equal(fs.existsSync(path.join(DASH_ROOT, 'pwned.txt')), false, 'DASH_ROOT 无副作用文件');
  assert.equal(fs.existsSync(path.join(p.root, 'pwned.txt')), false, '项目目录无副作用文件');
});

test('POST /api/decide → 非法答案（不在 options）400 且不落库', async () => {
  const p = newProject('decidebad');
  cmds.add({ _: ['P01'], title: '拍板2', ...p.P });
  cmds.pending({ _: ['P01'], q: '选哪个', opt: ['甲', '乙'], rec: '甲', ...p.P });

  const res = await fetch(SRV.base + '/api/decide/decidebad/P01', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ did: 'd1', answer: '"; DROP TABLE tasks; --' }),
  });
  assert.equal(res.status, 400, 'CLI 拒绝非法答案 → 400');
  const d = readBoard(p.board).tasks.find((t) => t.id === 'P01').decisions.find((x) => x.id === 'd1');
  assert.equal(d.answer, null, '非法答案不落库');
});

test('GET /api/stream → 收到 board:changed 广播（mtime 轮询 R7）', async () => {
  const p = newProject('sseproj');
  cmds.add({ _: ['P01'], title: 'sse', ...p.P });
  const sse = await openSse();
  try {
    await waitEvent(sse, 'hello', 5000); // 首个 hello（带项目列表）
    const changed = waitEvent(sse, 'board:changed', 8000);
    // 周期性戳 board 改 mtime：server 首次见到项目只记基线不广播，二次改动必广播 → 对时序 race 鲁棒。
    let n = 0;
    const poke = setInterval(() => { try { cmds.note({ ...p.P, text: 'poke-' + (++n) }); } catch { /* 忽略偶发锁竞争 */ } }, 600);
    try {
      const ev = await changed;
      assert.equal(ev.data.projectId, 'sseproj', 'board:changed 带正确 projectId');
    } finally { clearInterval(poke); }
  } finally { closeSse(sse); }
});
