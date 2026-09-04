'use strict';
/**
 * readerApi.test.cjs —— 审阅台后端(READER-INTO-BOARD)端到端:spawn 真实 server + 临时 registry + 临时仓库。
 *
 * 覆盖:
 *   · GET  /api/reader/manifest   读仓库清单;没清单的项目 → 404 带 manifestPath 提示
 *   · GET  /api/reader/report     正文 + 上一版 + 两层边注按报告 key 取出;未知 key → 404;非法 key → 400
 *   · POST /api/reader/annos      add → 落 data/reader/<project>/<key>.json;GET 回读;delete 移除
 *   · POST /api/reader/export     写到仓库 docs/design/审计回流/批注/<key>.json(不 commit)
 *   · 清单里写 ../ 越界路径的报告 → 403(白名单根)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const cmds = require('../cli/commands.cjs');

const DASH_ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(DASH_ROOT, 'server', 'server.cjs');
const realTmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

let SRV = null; // { child, base, dir, reg, repo, dataDir }

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { cwd: DASH_ROOT, windowsHide: true, env: { ...process.env, DASHBOARD_NO_OPEN: '1', DASHBOARD_POLL_MS: '500', ...env } });
    let out = '', err = '', settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => done(reject, new Error('server 启动超时\n' + out + err)), 15000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; const m = out.match(/127\.0\.0\.1:(\d+)\//); if (m) done(resolve, { child, base: `http://127.0.0.1:${m[1]}` }); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done(reject, e));
    child.on('exit', (code) => done(reject, new Error('server 提前退出 code=' + code + '\n' + out + err)));
  });
}
function stopServer(child) {
  return new Promise((resolve) => { if (!child || child.exitCode !== null) return resolve(); const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000); child.once('exit', () => { clearTimeout(t); resolve(); }); try { child.kill(); } catch { resolve(); } });
}
async function api(method, p, body) {
  const res = await fetch(SRV.base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

before(async () => {
  const dir = realTmp('dash-reader-');
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const batchDir = path.join(repo, 'docs', 'design', '审计回流', '外脑回运-测试'); fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(path.join(batchDir, 'R1-v2.md'), '<!-- 来源注记 -->\n\n状态:评估件 · 事实基线 main@abc\n\n# 报告一\n\n## 1.1 第一节\n\n这段改过了,新写法。\n\n## 1.2 第二节\n\n没动的段。\n', 'utf8');
  fs.writeFileSync(path.join(batchDir, 'R1-v1.md'), '# 报告一\n\n## 1.1 第一节\n\n这段改过了,旧写法。\n\n## 1.2 第二节\n\n没动的段。\n', 'utf8');
  fs.writeFileSync(path.join(batchDir, 'reader_notes.json'), JSON.stringify({ schemaVersion: 1, layers: {
    'L1': { name: '第一层', notes: { R1: [{ anchor: '1.1', kind: '提示', text: '一层的注' }] } },
    'L2': { name: '第二层', notes: { R1: [{ anchor: '全篇', kind: '现状', text: '二层的注' }] } },
  } }), 'utf8');
  const manifest = { schemaVersion: 1, batches: [{ id: 'b1', name: '测试批', baseline: 'main@abc', noteLayers: [
    { id: 'L1', name: '第一层', file: 'docs/design/审计回流/外脑回运-测试/reader_notes.json', key: 'L1' },
    { id: 'L2', name: '第二层', file: 'docs/design/审计回流/外脑回运-测试/reader_notes.json', key: 'L2' },
  ], reports: [
    { key: 'R1', title: '报告一', version: 'v2', md: 'docs/design/审计回流/外脑回运-测试/R1-v2.md', prevMd: 'docs/design/审计回流/外脑回运-测试/R1-v1.md', prevLabel: 'v1', project: 'trepo', task: 'T-1', status: '待审阅', docAnswers: { d1: '文档已填:同意' } },
    { key: 'ESC', title: '越界', md: '../../outside.md', project: 'trepo' },
  ] }] };
  fs.writeFileSync(path.join(repo, 'docs', 'design', '审计回流', 'reader.json'), JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(dir, 'outside.md'), '不该读到', 'utf8');
  // 临时 registry + 有一张卡的看板(给批注镜像 note 用)
  const reg = path.join(dir, 'registry.json');
  const boardPath = path.join(repo, '.dashboard', 'board.json'); fs.mkdirSync(path.dirname(boardPath), { recursive: true });
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: { trepo: { name: '测试仓', mainRepo: repo, board: boardPath } } }), 'utf8');
  cmds.register({ id: 'trepo', name: '测试仓', root: repo, registry: reg });
  cmds.add({ _: ['T-1'], project: 'trepo', title: '测试卡', model: 'sonnet·低', registry: reg });
  const srv = await startServer({ DASHBOARD_REGISTRY: reg, DASHBOARD_PORT: String(20000 + Math.floor(Math.random() * 40000)) });
  SRV = { ...srv, dir, reg, repo };
});
after(async () => { if (SRV) { await stopServer(SRV.child); clean(SRV.dir); } });

test('manifest:读清单 + 批注计数;无清单项目 404', async () => {
  const r = await api('GET', '/api/reader/manifest?project=trepo');
  assert.equal(r.status, 200);
  assert.equal(r.json.manifest.batches[0].reports[0].key, 'R1');
  assert.deepEqual(r.json.annoCounts, { R1: 0, ESC: 0 });
  const miss = await api('GET', '/api/reader/manifest?project=nope');
  assert.equal(miss.status, 404);
});

test('report:正文/上一版/两层边注按 key 取出;非法 key 400;未知 key 404;越界路径 403', async () => {
  const r = await api('GET', '/api/reader/report?project=trepo&key=R1');
  assert.equal(r.status, 200);
  assert.match(r.json.md, /新写法/);
  assert.match(r.json.prevMd, /旧写法/);
  assert.equal(r.json.notes.length, 2);
  assert.equal(r.json.notes[0].notes[0].anchor, '1.1');
  assert.equal(r.json.notes[1].notes[0].kind, '现状');
  assert.equal(r.json.report.docAnswers.d1, '文档已填:同意');
  assert.equal((await api('GET', '/api/reader/report?project=trepo&key=bad%20key')).status, 400);
  assert.equal((await api('GET', '/api/reader/report?project=trepo&key=NOPE')).status, 404);
  assert.equal((await api('GET', '/api/reader/report?project=trepo&key=ESC')).status, 403);
});

test('annos:add 落本机账本并镜像到卡 note;GET 回读;delete 移除;空文本 400', async () => {
  const add = await api('POST', '/api/reader/annos', { project: 'trepo', key: 'R1', op: 'add', anno: { blockId: 'b3', anchor: '1.1 第一节', quote: '这段改过了', text: '这段前提变了,请重写' } });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  assert.equal(add.json.annos.length, 1);
  assert.equal(add.json.mirror, true, '批注应镜像成看板卡 note:' + add.json.mirrorError);
  const file = path.join(DASH_ROOT, 'data', 'reader', 'trepo', 'R1.json');
  assert.ok(fs.existsSync(file), '账本文件应落在 data/reader/<project>/<key>.json');
  const board = JSON.parse(fs.readFileSync(path.join(SRV.repo, '.dashboard', 'board.json'), 'utf8'));
  assert.ok(board.activity.some((a) => String(a.message || a.text || JSON.stringify(a)).includes('审阅台批注')), '卡 activity 里应有镜像 note');
  const get = await api('GET', '/api/reader/annos?project=trepo&key=R1');
  assert.equal(get.json.annos[0].text, '这段前提变了,请重写');
  const empty = await api('POST', '/api/reader/annos', { project: 'trepo', key: 'R1', op: 'add', anno: { text: '   ' } });
  assert.equal(empty.status, 400);
  const del = await api('POST', '/api/reader/annos', { project: 'trepo', key: 'R1', op: 'delete', id: add.json.anno.id });
  assert.equal(del.status, 200);
  assert.equal(del.json.annos.length, 0);
  clean(path.join(DASH_ROOT, 'data', 'reader', 'trepo'));
});

test('export:写到仓库 docs/design/审计回流/批注/<key>.json,不动 git', async () => {
  await api('POST', '/api/reader/annos', { project: 'trepo', key: 'R1', op: 'add', anno: { blockId: 'b3', text: '导出用' } });
  const r = await api('POST', '/api/reader/export', { project: 'trepo', key: 'R1' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.count, 1);
  const dest = path.join(SRV.repo, 'docs', 'design', '审计回流', '批注', 'R1.json');
  assert.ok(fs.existsSync(dest));
  const doc = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.equal(doc.annos[0].text, '导出用');
  assert.ok(doc.exportedAt);
  clean(path.join(DASH_ROOT, 'data', 'reader', 'trepo'));
});
