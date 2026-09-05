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

test('annos:框选批注带上选区偏移;非法区间当整段批注不落脏数据', async () => {
  const ok = await api('POST', '/api/reader/annos', { project: 'trepo', key: 'R1', op: 'add', anno: { blockId: 'b3', text: '这句不对', start: 3, end: 9 } });
  assert.equal(ok.json.anno.start, 3);
  assert.equal(ok.json.anno.end, 9);
  const bad = await api('POST', '/api/reader/annos', { project: 'trepo', key: 'R1', op: 'add', anno: { blockId: 'b3', text: '整段', start: 9, end: 9 } });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.anno.start, undefined, '空区间不该写进账本');
  clean(path.join(DASH_ROOT, 'data', 'reader', 'trepo'));
});

test('marks:荧光笔 add/delete;重叠的旧笔被顶掉;缺区间 400;不镜像看板卡', async () => {
  const boardBefore = JSON.parse(fs.readFileSync(path.join(SRV.repo, '.dashboard', 'board.json'), 'utf8')).activity.length;
  const a = await api('POST', '/api/reader/marks', { project: 'trepo', key: 'R1', op: 'add', mark: { blockId: 'b3', anchor: '1.1 第一节', quote: '这段改过了', start: 0, end: 5, color: 'green' } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.highlights.length, 1);
  assert.equal(a.json.mark.color, 'green');
  // 与已有笔重叠 → 顶掉旧的,不叠色
  const b = await api('POST', '/api/reader/marks', { project: 'trepo', key: 'R1', op: 'add', mark: { blockId: 'b3', start: 3, end: 12, color: 'pink' } });
  assert.equal(b.json.highlights.length, 1, '重叠的旧笔应被顶掉');
  assert.equal(b.json.highlights[0].color, 'pink');
  // 不重叠 → 并存
  const c = await api('POST', '/api/reader/marks', { project: 'trepo', key: 'R1', op: 'add', mark: { blockId: 'b3', start: 20, end: 24 } });
  assert.equal(c.json.highlights.length, 2);
  assert.equal(c.json.highlights[1].color, 'yellow', '没给颜色时默认黄');
  assert.equal((await api('POST', '/api/reader/marks', { project: 'trepo', key: 'R1', op: 'add', mark: { blockId: 'b3' } })).status, 400);
  assert.equal((await api('POST', '/api/reader/marks', { project: 'trepo', key: 'R1', op: 'add', mark: { start: 1, end: 2 } })).status, 400);
  const boardAfter = JSON.parse(fs.readFileSync(path.join(SRV.repo, '.dashboard', 'board.json'), 'utf8')).activity.length;
  assert.equal(boardAfter, boardBefore, '荧光笔是阅读痕迹,不该镜像成看板卡 note');
  const del = await api('POST', '/api/reader/marks', { project: 'trepo', key: 'R1', op: 'delete', id: c.json.mark.id });
  assert.equal(del.json.highlights.length, 1);
  assert.equal((await api('POST', '/api/reader/marks', { project: 'trepo', key: 'R1', op: 'delete', id: 'nope' })).status, 404);
  const rep = await api('GET', '/api/reader/report?project=trepo&key=R1');
  assert.equal(rep.json.highlights.length, 1, '报告回包里应带上荧光笔');
  clean(path.join(DASH_ROOT, 'data', 'reader', 'trepo'));
});

test('review:标记/撤销「已审阅」落本机账本并进清单回包;未知状态 400;不回写仓库 reader.json', async () => {
  const manifestPath = path.join(SRV.repo, 'docs', 'design', '审计回流', 'reader.json');
  const before = fs.readFileSync(manifestPath, 'utf8');
  const on = await api('POST', '/api/reader/review', { project: 'trepo', key: 'R1', state: '已审阅' });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(on.json.review.state, '已审阅');
  assert.ok(on.json.review.at);
  const m = await api('GET', '/api/reader/manifest?project=trepo');
  assert.equal(m.json.reviews.R1.state, '已审阅', '清单回包应带上已审阅标记(报告架靠它分组)');
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), before, '仓库 reader.json 是回流对话的正本,看板不许改');
  assert.equal((await api('POST', '/api/reader/review', { project: 'trepo', key: 'R1', state: '读完了' })).status, 400);
  const off = await api('POST', '/api/reader/review', { project: 'trepo', key: 'R1', state: '未审阅' });
  assert.equal(off.json.review, null);
  assert.equal((await api('GET', '/api/reader/manifest?project=trepo')).json.reviews.R1, undefined);
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
