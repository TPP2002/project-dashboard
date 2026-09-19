'use strict';
/**
 * readerImport.test.cjs —— 审阅台「本机导入」(READER-IMPORT-BUTTON T1)两段式测试:
 *   · 纯函数与存储层(server/readerImport.cjs):key 生成、入参校验、落盘/重复导入/列出/读取/删除、批次拼装
 *   · server 接线:spawn 真实 server + 临时 registry + 临时仓库与数据根,按接口契约逐条验
 *     POST /api/reader/import、manifest 并入「本机导入」批次、report 读本机 md、
 *     import-original 回原件、import-delete 删导入与批注账本
 *
 * 夹具只用 test/fixtures/reader-import 下的虚构样稿;临时目录一律 os.tmpdir() 造,不出现本机绝对路径。
 */
const { test, before, after } = require('node:test');
const freePort = require('../scripts/free-port.cjs');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const ri = require('../server/readerImport.cjs');

const DASH_ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(DASH_ROOT, 'server', 'server.cjs');
const FIXTURES = path.join(DASH_ROOT, 'test', 'fixtures', 'reader-import');
const MB = 1024 * 1024;
const realTmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

// ---------- 第一段:纯函数与存储层(不依赖 HTTP) ----------
test('makeImportKey:IMP-<YYYYMMDD>-<md 的 sha1 前 6 位>;同内容同天同 key,内容变了 key 就变', () => {
  const md = '# 示例\n\n正文。\n';
  const key = ri.makeImportKey(md, new Date(2026, 8, 19, 10, 30, 0));
  const want = 'IMP-20260919-' + crypto.createHash('sha1').update(md, 'utf8').digest('hex').slice(0, 6);
  assert.equal(key, want);
  assert.equal(ri.makeImportKey(md, new Date(2026, 8, 19, 23, 0, 0)), key);
  assert.notEqual(ri.makeImportKey(md + '改一个字', new Date(2026, 8, 19, 23, 0, 0)), key);
});

test('validateImportBody:校验顺序与状态码按契约(md 空 400 → md 超 3MB 413 → 原件超 30MB 413 → 格式 400)', () => {
  assert.equal(ri.validateImportBody({ md: '  \n ', format: 'md' }).status, 400, 'md 去空白后为空');
  assert.equal(ri.validateImportBody({ format: 'md' }).status, 400, 'md 缺失');
  assert.equal(ri.validateImportBody({ md: 'x'.repeat(3 * MB + 1), format: 'md' }).status, 413, 'md 超 3MB');
  assert.equal(ri.validateImportBody({ md: 'x', format: 'exe' }).status, 400, '格式不在名单');
  // 原件/格式检查的先后:恰好 30MB 的原件放行,才轮到格式检查报 400;解码再多 3 字节就 413
  const exact = 'A'.repeat((30 * MB / 3) * 4);
  const over = exact + 'AAAA';
  assert.equal(ri.validateImportBody({ md: 'x', format: 'exe', original: { name: 'a.bin', base64: over } }).status, 413);
  assert.equal(ri.validateImportBody({ md: 'x', format: 'exe', original: { name: 'a.bin', base64: exact } }).status, 400);
  assert.equal(ri.validateImportBody({ md: 'x', format: 'md', original: '不对' }).status, 400, 'original 不是对象');
  assert.equal(ri.validateImportBody({ md: 'x', format: 'md', original: { name: 'a.pdf' } }).status, 400, 'original 缺 base64');
  assert.equal(ri.validateImportBody({ md: 'x', format: 'md', original: { name: 'a.pdf', base64: '!!不是base64!!' } }).status, 400, 'base64 字符集不对');
});

test('validateImportBody:标题取 fileName 去扩展名并截 120 字;名字只留最后一段并清「..」;扩展名只认小写字母数字 ≤5 位', () => {
  const v = ri.validateImportBody({ md: 'x', format: 'docx', title: '', fileName: '上传目录/子目录\\最终 报告.DOCX' });
  assert.equal(v.ok, true);
  assert.equal(v.value.fileName, '最终 报告.DOCX', '只取最后一段(正反斜杠都算)');
  assert.equal(v.value.title, '最终 报告', '空标题取 fileName 去扩展名');
  assert.equal(ri.validateImportBody({ md: 'x', format: 'md', title: '甲'.repeat(150) }).value.title.length, 120, '标题截 120 字');
  const dotdot = ri.validateImportBody({ md: 'x', format: 'md', fileName: '..\\..\\escape.md' });
  assert.equal(dotdot.value.fileName, 'escape.md', '路径穿越段被清掉');
  const withOriginal = ri.validateImportBody({ md: 'x', format: 'pdf', title: 'x', original: { name: '上传目录/样稿.PDF', base64: Buffer.from('abc').toString('base64') } });
  assert.equal(withOriginal.value.original.name, '样稿.PDF');
  assert.equal(withOriginal.value.original.ext, 'pdf', '大写扩展名落盘前转小写');
  assert.equal(ri.extFromName(ri.sanitizeName('README')), 'bin', '没有扩展名 → bin');
  assert.equal(ri.extFromName(ri.sanitizeName('a.b123456')), 'bin', '扩展名超 5 位 → bin');
  assert.equal(ri.validateImportBody({ md: 'x', format: 'md', title: 'x' }).value.original, null, '不带 original 时归一成 null');
  const w = ri.validateImportBody({ md: 'x', format: 'md', title: 'x', warnings: ['第 2 页是扫描件', 42, null] });
  assert.deepEqual(w.value.warnings, ['第 2 页是扫描件'], 'warnings 只收字符串项');
  assert.equal(ri.validateImportBody({ md: 'x', format: 'md', fileName: '   ' }).status, 400, '标题和 fileName 都推不出 → 400');
});

test('存储层:落盘/同内容重复导入不覆盖/批次拼装倒序/读取/原件/删除', () => {
  const dir = realTmp('reader-import-store-');
  try {
    const at12 = new Date(2026, 8, 19, 12, 0, 0);
    const a = ri.saveImport(dir, 'demo-a', { title: '样稿甲', fileName: 'a.md', format: 'md', md: '# 甲\n', warnings: [], original: null }, at12);
    assert.equal(a.duplicate, false);
    assert.match(a.key, /^IMP-\d{8}-[0-9a-f]{6}$/);
    const dirA = ri.importDir(dir, 'demo-a', a.key);
    assert.equal(fs.readFileSync(path.join(dirA, 'report.md'), 'utf8'), '# 甲\n');
    const meta = JSON.parse(fs.readFileSync(path.join(dirA, 'meta.json'), 'utf8'));
    assert.deepEqual(Object.keys(meta), ['key', 'title', 'fileName', 'format', 'importedAt', 'warnings', 'originalName', 'originalBytes'], 'meta 形状与契约一致');
    assert.equal(meta.importedAt, at12.toISOString());
    assert.equal(meta.originalName, '');
    assert.equal(meta.originalBytes, 0);
    assert.equal(ri.hasOriginal(dir, 'demo-a', a.key), false);
    assert.equal(ri.readImportOriginal(dir, 'demo-a', a.key), null);
    // 同内容同天再导入:同 key、不覆盖、meta 原样保留
    const again = ri.saveImport(dir, 'demo-a', { title: '换了标题', fileName: 'b.md', format: 'md', md: '# 甲\n', warnings: [], original: null }, new Date(2026, 8, 19, 18, 0, 0));
    assert.equal(again.key, a.key);
    assert.equal(again.duplicate, true);
    assert.equal(again.meta.title, '样稿甲', '重复导入沿用既有 meta');
    assert.equal(again.meta.importedAt, at12.toISOString(), '重复导入不刷新导入时间');
    assert.equal(fs.readFileSync(path.join(dirA, 'report.md'), 'utf8'), '# 甲\n');
    // 带原件的第二份(时间更晚,供倒序断言)
    const bytes = Buffer.from('PDF-虚构字节');
    const b = ri.saveImport(dir, 'demo-a', { title: '样稿乙', fileName: 'b.pdf', format: 'pdf', md: '# 乙\n', warnings: [], original: { name: '样稿.PDF', ext: 'pdf', buffer: bytes, mime: 'application/pdf' } }, new Date(2026, 8, 19, 15, 0, 0));
    const orig = ri.readImportOriginal(dir, 'demo-a', b.key);
    assert.equal(orig.ext, 'pdf');
    assert.deepEqual(fs.readFileSync(orig.file), bytes);
    assert.equal(ri.hasOriginal(dir, 'demo-a', b.key), true);
    // 批次拼装:按导入时间倒序,报告元数据逐字段对齐契约
    const batch = ri.buildLocalImportBatch('demo-a', ri.listImports(dir, 'demo-a'), dir);
    assert.equal(batch.id, 'local-import');
    assert.equal(batch.name, '本机导入');
    assert.equal(batch.baseline, '本机导入,未经回流对账');
    assert.deepEqual(batch.noteLayers, []);
    assert.deepEqual(batch.reports.map((r) => r.key), [b.key, a.key], '按导入时间倒序');
    const r = batch.reports[0];
    assert.deepEqual(Object.keys(r), ['key', 'title', 'version', 'md', 'project', 'status', 'why', 'imported', 'importedAt', 'format', 'fileName', 'warnings', 'hasOriginal']);
    assert.match(r.version, /^PDF · \d{4}-\d{2}-\d{2}$/);
    assert.equal(r.md, null);
    assert.equal(r.project, 'demo-a');
    assert.equal(r.status, '未对账');
    assert.equal(r.imported, true);
    assert.equal(r.why, '本机导入的文件:b.pdf。没有经过回流对账,没有边注,也没有登记拍板项。');
    assert.equal(r.hasOriginal, true);
    assert.equal(batch.reports[1].hasOriginal, false);
    // 读/删
    assert.equal(ri.readImport(dir, 'demo-a', a.key).md, '# 甲\n');
    assert.equal(ri.readImport(dir, 'demo-a', 'IMP-20990101-000000'), null, '没有这份导入 → null');
    assert.equal(ri.readImport(dir, 'demo-a', '../../逃逸'), null, '非法 key 一律 null');
    assert.deepEqual(ri.listImports(dir, 'demo-b'), [], '别的项目的导入互不可见');
    assert.equal(ri.deleteImport(dir, 'demo-a', a.key), true);
    assert.equal(fs.existsSync(dirA), false);
    assert.equal(ri.deleteImport(dir, 'demo-a', a.key), false, '再删一次 → false');
    assert.equal(ri.deleteImport(dir, 'demo-a', 'R1'), false, '非 IMP- key 拒删');
  } finally { clean(dir); }
});

// ---------- 第二段:server 接线(spawn 真实 server + 临时 registry / 仓库 / 数据根) ----------
let SRV = null;             // { child, base, dir, reg, repo, dataRoot }
let manifestSnapshot = '';  // 没有任何导入时的 manifest 回包原文(删完后逐字节比对用)
let key1 = null;            // 第一份导入:不带原件
let report1 = null;         // 第一份导入的回包元数据
let key2 = null;            // 第二份导入:带 pdf 原件

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
  const dir = realTmp('dash-reader-import-');
  const dataRoot = realTmp('dash-reader-import-data-');
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const batchDir = path.join(repo, 'docs', 'design', '审计回流', '导入测试批'); fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(path.join(batchDir, 'R1.md'), '# 仓库报告一\n\n仓库里的报告,导入功能不许碰它。\n', 'utf8');
  const manifest = { schemaVersion: 1, batches: [{ id: 'b1', name: '仓库批', baseline: 'main@abc', noteLayers: [], reports: [
    { key: 'R1', title: '仓库报告一', version: 'v1', md: 'docs/design/审计回流/导入测试批/R1.md', project: 'trepo' },
  ] }] };
  fs.writeFileSync(path.join(repo, 'docs', 'design', '审计回流', 'reader.json'), JSON.stringify(manifest), 'utf8');
  // 临时 registry + 一张看板卡:导入报告不绑卡,卡只是让 server 的镜像链路有真实目标可查
  const reg = path.join(dir, 'registry.json');
  const boardPath = path.join(repo, '.dashboard', 'board.json'); fs.mkdirSync(path.dirname(boardPath), { recursive: true });
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: { trepo: { name: '测试仓', mainRepo: repo, board: boardPath } } }), 'utf8');
  cmds.register({ id: 'trepo', name: '测试仓', root: repo, registry: reg });
  cmds.add({ _: ['T-1'], project: 'trepo', title: '测试卡', model: 'sonnet·低', registry: reg });
  const srv = await startServer({ DASHBOARD_REGISTRY: reg, DASHBOARD_HOME: dataRoot, DASHBOARD_MODULES: 'reader', DASHBOARD_PORT: String(await freePort()) });
  SRV = { ...srv, dir, reg, repo, dataRoot };
});
after(async () => { if (SRV) { await stopServer(SRV.child); clean(SRV.dir); clean(SRV.dataRoot); } });

test('导入前:manifest 没有本机导入批次;留一份逐字节快照供删完后比对', async () => {
  const res = await fetch(SRV.base + '/api/reader/manifest?project=trepo');
  manifestSnapshot = await res.text();
  const json = JSON.parse(manifestSnapshot);
  assert.equal(json.manifest.batches.some((b) => b.id === 'local-import'), false);
  assert.deepEqual(Object.keys(json.annoCounts), ['R1']);
});

test('import:md 与带 pdf 原件各落一份;manifest 在末尾追加本机导入批次,批注计数一并给出', async () => {
  const md1 = fs.readFileSync(path.join(FIXTURES, 'sample.md'), 'utf8');
  const r1 = await api('POST', '/api/reader/import', { project: 'trepo', title: '', fileName: '样稿/sample.md', format: 'md', md: md1 });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.match(r1.json.key, /^IMP-\d{8}-[0-9a-f]{6}$/);
  assert.equal(r1.json.duplicate, false);
  assert.equal(r1.json.report.title, 'sample', '空标题取 fileName 去扩展名');
  assert.equal(r1.json.report.fileName, 'sample.md', '只留最后一段');
  assert.equal(r1.json.report.hasOriginal, false);
  assert.equal(r1.json.report.status, '未对账');
  assert.equal(r1.json.report.imported, true);
  key1 = r1.json.key; report1 = r1.json.report;
  // 落盘:report.md + meta.json,都在数据根的 imports 下(不进仓库)
  const dir1 = path.join(SRV.dataRoot, 'data', 'reader', 'trepo', 'imports', key1);
  assert.equal(fs.readFileSync(path.join(dir1, 'report.md'), 'utf8'), md1);
  assert.ok(fs.existsSync(path.join(dir1, 'meta.json')));

  const pdf = fs.readFileSync(path.join(FIXTURES, 'sample.pdf'));
  const txt = fs.readFileSync(path.join(FIXTURES, 'sample.txt'), 'utf8');
  const r2 = await api('POST', '/api/reader/import', { project: 'trepo', title: '决策样稿', fileName: '样稿.pdf', format: 'pdf', md: txt, warnings: ['第 2 页是扫描件'], original: { name: '上传目录/样稿.PDF', mime: 'application/pdf', base64: pdf.toString('base64') } });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  assert.notEqual(r2.json.key, key1);
  assert.equal(r2.json.report.hasOriginal, true);
  assert.match(r2.json.report.version, /^PDF · \d{4}-\d{2}-\d{2}$/);
  const dir2 = path.join(SRV.dataRoot, 'data', 'reader', 'trepo', 'imports', r2.json.key);
  assert.equal(fs.existsSync(path.join(dir2, 'original.pdf')), true, '原件按 original.<扩展名> 落盘');
  const meta2 = JSON.parse(fs.readFileSync(path.join(dir2, 'meta.json'), 'utf8'));
  assert.equal(meta2.originalName, '样稿.PDF', 'original.name 清掉路径段');
  assert.equal(meta2.originalBytes, pdf.length);
  assert.deepEqual(meta2.warnings, ['第 2 页是扫描件']);
  key2 = r2.json.key;

  const m = await api('GET', '/api/reader/manifest?project=trepo');
  assert.equal(m.status, 200);
  const batches = m.json.manifest.batches;
  assert.equal(batches.length, 2);
  assert.equal(batches[0].id, 'b1', '仓库批次原样在前');
  const batch = batches[1];
  assert.equal(batch.id, 'local-import', '本机导入批次追加在最后(shelfSummary 之前并入)');
  assert.equal(batch.name, '本机导入');
  assert.equal(batch.baseline, '本机导入,未经回流对账');
  assert.deepEqual(batch.noteLayers, []);
  assert.deepEqual(batch.reports.map((r) => r.key), [key2, key1], '按导入时间倒序');
  assert.equal(m.json.annoCounts[key1], 0, '导入报告的批注数进货架汇总');
  assert.equal(m.json.annoCounts[key2], 0);
  assert.equal(m.json.annoCounts.R1, 0);
});

test('import:同内容重复导入 → 同 key、duplicate:true、不重复存', async () => {
  const md1 = fs.readFileSync(path.join(FIXTURES, 'sample.md'), 'utf8');
  const r = await api('POST', '/api/reader/import', { project: 'trepo', title: '再导一次也一样', fileName: 'sample.md', format: 'md', md: md1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.key, key1);
  assert.equal(r.json.duplicate, true);
  assert.equal(r.json.report.importedAt, report1.importedAt, '导入时间不刷新');
  const dirs = fs.readdirSync(path.join(SRV.dataRoot, 'data', 'reader', 'trepo', 'imports')).filter((n) => n === key1);
  assert.equal(dirs.length, 1, '不重复存');
});

test('report:IMP- 开头读本机 md(无边注/无上一版);未知导入 404;仓库报告走原有路径不受影响', async () => {
  const r = await api('GET', '/api/reader/report?project=trepo&key=' + encodeURIComponent(key1));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.batch, { id: 'local-import', name: '本机导入', baseline: '本机导入,未经回流对账' });
  assert.equal(r.json.md, fs.readFileSync(path.join(FIXTURES, 'sample.md'), 'utf8'));
  assert.deepEqual(r.json.notes, []);
  assert.equal(r.json.prevMd, null);
  assert.equal(r.json.report.md, null);
  assert.deepEqual(r.json.annos, []);
  assert.equal((await api('GET', '/api/reader/report?project=trepo&key=IMP-20990101-abcdef')).status, 404);
  const repoRep = await api('GET', '/api/reader/report?project=trepo&key=R1');
  assert.equal(repoRep.status, 200);
  assert.equal(repoRep.json.batch.id, 'b1', 'IMP- 之外的 key 走原有路径');
  assert.match(repoRep.json.md, /仓库里的报告/);
});

test('annos/review:导入报告能批注、能标已审阅,货架汇总同步;没绑卡所以不镜像', async () => {
  const add = await api('POST', '/api/reader/annos', { project: 'trepo', key: key1, op: 'add', anno: { blockId: 'b1', text: '导入的也批一条' } });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  assert.equal(add.json.mirror, false, '导入报告没有绑卡,镜像如实标 false');
  const rev = await api('POST', '/api/reader/review', { project: 'trepo', key: key1, state: '已审阅' });
  assert.equal(rev.status, 200);
  const m = await api('GET', '/api/reader/manifest?project=trepo');
  assert.equal(m.json.annoCounts[key1], 1);
  assert.equal(m.json.reviews[key1].state, '已审阅');
  const rep = await api('GET', '/api/reader/report?project=trepo&key=' + encodeURIComponent(key1));
  assert.equal(rep.json.annos.length, 1);
  assert.equal(rep.json.review.state, '已审阅');
});

test('import-original:pdf 按附件回、类型正经;没有原件 404;非法 key 400', async () => {
  const res = await fetch(SRV.base + '/api/reader/import-original?project=trepo&key=' + encodeURIComponent(key2));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.ok(/^attachment/i.test(res.headers.get('content-disposition') || ''), '必须以附件回');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(path.join(FIXTURES, 'sample.pdf')));
  assert.equal((await api('GET', '/api/reader/import-original?project=trepo&key=' + encodeURIComponent(key1))).status, 404, '没带原件的导入');
  assert.equal((await api('GET', '/api/reader/import-original?project=trepo&key=R1')).status, 404, '仓库报告没有原件');
  assert.equal((await api('GET', '/api/reader/import-original?project=trepo&key=bad%20key')).status, 400);
});

test('import 校验:未注册项目 404;空 md 400;坏格式 400;md 超 3MB 413', async () => {
  assert.equal((await api('POST', '/api/reader/import', { project: 'nope', title: 'x', fileName: 'x.md', format: 'md', md: '# x' })).status, 404);
  assert.equal((await api('POST', '/api/reader/import', { project: 'trepo', title: 'x', fileName: 'x.md', format: 'md', md: '   ' })).status, 400);
  assert.equal((await api('POST', '/api/reader/import', { project: 'trepo', title: 'x', fileName: 'x.md', format: 'exe', md: '# x' })).status, 400);
  assert.equal((await api('POST', '/api/reader/import', { project: 'trepo', title: 'x', fileName: 'x.md', format: 'md', md: 'x'.repeat(3 * MB + 1) })).status, 413);
});

test('import-delete:删导入目录与批注账本;非 IMP- key 400;不存在 404;删完 manifest 与导入前逐字节一致', async () => {
  assert.equal((await api('POST', '/api/reader/import-delete', { project: 'trepo', key: 'R1' })).status, 400, '仓库报告绝不能从这里删');
  assert.equal((await api('POST', '/api/reader/import-delete', { project: 'trepo', key: 'IMP-20990101-abcdef' })).status, 404);
  const del2 = await api('POST', '/api/reader/import-delete', { project: 'trepo', key: key2 });
  assert.equal(del2.status, 200);
  assert.equal(del2.json.removedAnnos, 0);
  assert.equal(fs.existsSync(path.join(SRV.dataRoot, 'data', 'reader', 'trepo', 'imports', key2)), false);
  const del1 = await api('POST', '/api/reader/import-delete', { project: 'trepo', key: key1 });
  assert.equal(del1.status, 200);
  assert.equal(del1.json.removedAnnos, 1, '批注账本一并清,回条数');
  assert.equal(fs.existsSync(path.join(SRV.dataRoot, 'data', 'reader', 'trepo', key1 + '.json')), false, '批注账本删除');
  assert.equal(fs.existsSync(path.join(SRV.dataRoot, 'data', 'reader', 'trepo', key1 + '.json.lock')), false, '账本锁文件删除');
  const res = await fetch(SRV.base + '/api/reader/manifest?project=trepo');
  assert.equal(await res.text(), manifestSnapshot, '没有导入时,manifest 回包必须与改动前逐字节一致');
});
