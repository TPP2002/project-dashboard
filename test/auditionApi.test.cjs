'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createAuditionApi, INDEX_REL, EXPORT_DIR_REL } = require('../server/auditionApi.cjs');

const BATCH_REL = 'docs/design/audio/试听台/第一轮/batch.json';
const AUDIO_REL = 'docs/design/audio/试听台/第一轮/clips/buy.mp3';
const HTML_REL = 'docs/design/audio/试听台/screens/main.html';
const FIXED_AT = '2026-09-12T08:00:00.000Z';
const AUDIO_BYTES = Buffer.from([0x49, 0x44, 0x33, 0, 0xff, 0x80, 0xfe, 1, 2, 3]);

function batchFixture() {
  return {
    schemaVersion: 1, key: 'dir-r1', title: '声音方向试听', summary: '对比买入的声音', task: 'AUDIO-DESIGN', groupNoun: '方向',
    screens: [{ id: 'main', title: '主交易屏', path: HTML_REL, width: 1920, height: 1080 }], defaultScreen: 'main',
    groups: [{ id: 'A', name: '像素原声', pitch: '清爽', refs: '游戏声音', risk: '可能听腻' }],
    scenes: [{ id: 'buy', name: '买入成交', level: 2, when: '买入成交时', screen: 'main' }],
    clips: [{ scene: 'buy', group: 'A', files: ['clips/buy.mp3'], desc: '简短的买入声', sources: [
      { platform: '素材站', author: '作者', title: '买入声', license: 'CC BY 4.0', licenseUrl: 'https://example.org/license', url: 'https://example.org/buy', attribution: '买入声 — 作者 — CC BY 4.0', mods: '调节音量' },
    ] }],
    decisions: [{ task: 'AUDIO-DESIGN', did: 'd5', optionGroups: { '选像素原声': 'A' } }], notes: ['先听，再决定'],
  };
}

async function fixture(t, options = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'audition-api-')));
  const dataRoot = path.join(dir, 'home'), docsRoot = path.join(dir, 'docs-root');
  fs.mkdirSync(dataRoot); fs.mkdirSync(docsRoot);
  const previousHome = process.env.DASHBOARD_HOME;
  process.env.DASHBOARD_HOME = dataRoot;
  const previousSettings = process.env.DASHBOARD_GLOBAL_SETTINGS;
  process.env.DASHBOARD_GLOBAL_SETTINGS = path.join(dataRoot, 'global-settings.json');
  let server;
  t.after(async () => {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (previousHome === undefined) delete process.env.DASHBOARD_HOME; else process.env.DASHBOARD_HOME = previousHome;
    if (previousSettings === undefined) delete process.env.DASHBOARD_GLOBAL_SETTINGS; else process.env.DASHBOARD_GLOBAL_SETTINGS = previousSettings;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const write = (rel, value) => {
    const full = path.join(docsRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
  };
  const index = { schemaVersion: 1, batches: [{ key: 'dir-r1', title: '声音方向试听', path: BATCH_REL, task: 'AUDIO-DESIGN', addedAt: '2026-09-12', status: '待试听' }] };
  if (!options.noIndex) write(INDEX_REL, index);
  write(BATCH_REL, batchFixture()); write(AUDIO_REL, AUDIO_BYTES);
  write(HTML_REL, '<!doctype html><html lang="zh"><body><button>买入</button><script>window.parent.postMessage({source:"audition-screen",type:"ready",scenes:["buy"]},location.origin)</script></body></html>');
  const calls = [], env = { enabled: options.enabled !== false, mirrorFailure: false };
  let id = 0, polls = 0;
  const cliIndex = path.join(dir, 'cli', 'index.cjs'), registry = path.join(dir, 'registry.json');
  const api = createAuditionApi({
    resolveProjectSafe: project => project === 'sample' ? { docsRoot } : null,
    dataRoot: process.env.DASHBOARD_HOME, dashRoot: dir, cliIndex, registry, registryPath: path.join(dir, 'default-registry.json'), bodyMax: options.bodyMax ?? 4096,
    isEnabled: () => env.enabled, now: options.now || (() => FIXED_AT), createId: () => `note-${++id}`,
    pollBoards: () => { polls++; },
    execFile(executable, args, config, callback) {
      calls.push({ executable, args, config });
      setImmediate(() => callback(env.mirrorFailure ? new Error('镜像失败') : null, '', env.mirrorFailure ? '临时卡不可用' : ''));
    },
    sendJson(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); },
    readBody(req, max, callback) {
      const chunks = []; let size = 0;
      req.on('data', chunk => { chunks.push(chunk); size += chunk.length; });
      req.on('end', () => callback(size > max ? new Error('请求过大') : null, Buffer.concat(chunks).toString('utf8')));
    },
  });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!api.route(url.pathname.slice('/api/audition/'.length), req, res, Object.fromEntries(url.searchParams))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/audition/`;
  async function request(action, { query = {}, body, headers = {} } = {}) {
    return fetch(`${base}${action}?${new URLSearchParams({ project: 'sample', key: 'dir-r1', ...query })}`, body === undefined ? { headers } : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ project: 'sample', key: 'dir-r1', ...body }),
    });
  }
  async function json(action, opts) { const res = await request(action, opts); return { status: res.status, body: await res.json() }; }
  return { dir, docsRoot, dataRoot, write, request, json, calls, env, cliIndex, registry, polls: () => polls, api };
}

test('索引缺失返回中文空状态；无写盘副作用', async t => {
  const f = await fixture(t, { noIndex: true });
  const result = await f.json('index');
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { ok: false, error: '本项目还没有试听清单' });
  assert.equal(fs.existsSync(path.join(f.dataRoot, 'data')), false);
});

test('正常批次、相对目录及索引汇总保持数据约定', async t => {
  const f = await fixture(t);
  const result = await f.json('batch');
  assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.batch, batchFixture()); assert.deepEqual(result.body.problems, []);
  assert.equal(result.body.baseDir, 'docs/design/audio/试听台/第一轮');
  const index = (await f.json('index')).body;
  assert.equal(index.project, 'sample');
  assert.deepEqual(index.summaries['dir-r1'], { notes: 0, up: 0, down: 0, review: null });
});

test('批次逐条报告缺文件、未定义组、缺署名、非法扩展名及重复片段，不丢掉整批', async t => {
  const f = await fixture(t), batch = batchFixture();
  batch.clips[0].files = ['clips/missing.mp3', 'clips/sound.exe'];
  batch.clips[0].group = 'unknown';
  batch.clips[0].sources[0].attribution = '';
  batch.clips.push(structuredClone(batch.clips[0]));
  f.write(BATCH_REL, batch);
  const result = await f.json('batch');
  assert.equal(result.status, 200); assert.equal(result.body.batch.clips.length, 2);
  for (const pattern of [/缺少文件/, /未定义的组/, /署名/, /扩展名/, /重复/]) assert.ok(result.body.problems.some(p => pattern.test(p)), String(pattern));
});

test('校验版本、唯一编号、引用、文件数量及完整来源，坏条目不会使整批崩溃', async t => {
  const f = await fixture(t), batch = batchFixture();
  batch.schemaVersion = 2;
  batch.groups.push({ ...batch.groups[0] }); batch.scenes.push({ ...batch.scenes[0], screen: 'unknown', level: 6 });
  batch.clips[0].scene = 'unknown'; batch.clips[0].files = [];
  batch.clips[0].sources = [{ license: '', url: '' }, { license: 'CC-BY', url: 'https://example.org' }, { license: 'Attribution', url: 'https://example.org' }];
  batch.clips.push(null, { group: 'A', scene: 'buy', files: Array(5).fill('clips/buy.mp3'), sources: [] });
  f.write(BATCH_REL, batch);
  const result = await f.json('batch');
  assert.equal(result.status, 200);
  for (const pattern of [/版本/, /组编号重复/, /场景编号重复/, /未定义的场景/, /未定义的画面/, /1 到 4/, /至少需要一条来源/, /缺少授权或原链接/, /强度/]) assert.ok(result.body.problems.some(p => pattern.test(p)), String(pattern));
  assert.equal(result.body.problems.filter(p => p.includes('没有署名内容')).length, 2);
});

test('非法批次编号、未注册项目和索引中的越界路径被拒绝', async t => {
  const f = await fixture(t);
  for (const key of ['../outside', '', 'a'.repeat(41), '含空 格']) assert.equal((await f.json('batch', { query: { key } })).status, 400);
  assert.equal((await f.json('batch', { query: { project: 'unknown' } })).status, 404);
  f.write(INDEX_REL, { schemaVersion: 1, batches: [{ key: 'dir-r1', title: '越界', path: '../outside.json' }] });
  assert.equal((await f.json('batch')).status, 403);
});

test('索引中的缺失或非字符串编号不被正则隐式转换为合法编号', async t => {
  const f = await fixture(t);
  for (const key of [undefined, null, 123, [], {}]) {
    f.write(INDEX_REL, { schemaVersion: 1, batches: [{ key, title: '坏编号', path: BATCH_REL }] });
    const result = await f.json('index');
    assert.equal(result.status, 422); assert.equal(result.body.ok, false);
  }
});

test('文件路径穿越、白名单外类型、目录和超大文件被拒绝', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.dir, 'outside.mp3'), AUDIO_BYTES);
  f.write('private.txt', '不能作为素材读取');
  for (const rel of ['../outside.mp3', '..\\outside.mp3', 'private.txt']) assert.equal((await f.request('file', { query: { path: rel } })).status, 403);
  assert.equal((await f.request('file', { query: { path: 'missing.mp3' } })).status, 404);
  fs.mkdirSync(path.join(f.docsRoot, 'folder.mp3'));
  assert.equal((await f.request('file', { query: { path: 'folder.mp3' } })).status, 403);
  const large = path.join(f.docsRoot, 'large.wav'), fd = fs.openSync(large, 'w');
  try { fs.ftruncateSync(fd, 30 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
  assert.equal((await f.request('file', { query: { path: 'large.wav' } })).status, 413);
});

test('音频二进制原样返回；网页 MIME 与限制接口访问的策略齐全', async t => {
  const f = await fixture(t);
  const audio = await f.request('file', { query: { path: AUDIO_REL } });
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.equal(audio.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), AUDIO_BYTES);
  const html = await f.request('file', { query: { path: HTML_REL } });
  assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
  const csp = html.headers.get('content-security-policy');
  for (const text of ["connect-src 'none'", "frame-ancestors 'self'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "form-action 'none'"]) assert.ok(csp.includes(text), text);
  for (const kind of ['img', 'media', 'font']) assert.match(csp, new RegExp(`${kind}-src[^;]*data:[^;]*blob:`));
  assert.equal(await html.text(), fs.readFileSync(path.join(f.docsRoot, HTML_REL), 'utf8'));
  for (const [ext, mime] of Object.entries({ ogg: 'audio/ogg', wav: 'audio/wav', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', htm: 'text/html; charset=utf-8' })) {
    f.write(`asset.${ext}`, AUDIO_BYTES);
    assert.equal((await f.request('file', { query: { path: `asset.${ext}` } })).headers.get('content-type'), mime);
  }
});

test('音频单区间、后缀和开放区间返回 206 与准确字节，非法区间返回 416', async t => {
  const f = await fixture(t);
  for (const [range, start, end] of [['bytes=2-5', 2, 5], ['bytes=7-', 7, 9], ['bytes=-3', 7, 9], ['bytes=7-99', 7, 9], ['bytes=-99', 0, 9]]) {
    const res = await f.request('file', { query: { path: AUDIO_REL }, headers: { Range: range } });
    assert.equal(res.status, 206); assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/10`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), AUDIO_BYTES.subarray(start, end + 1));
  }
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'words=1-3', 'bytes=99999999999999999999-']) {
    const res = await f.request('file', { query: { path: AUDIO_REL }, headers: { Range: range } });
    assert.equal(res.status, 416, range); assert.equal(res.headers.get('content-range'), 'bytes */10'); assert.equal((await res.arrayBuffer()).byteLength, 0);
  }
});

test('批注增删、标记、整组倾向、审阅、汇总与原子写相互保留', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.json('state')).body.state, { schemaVersion: 1, project: 'sample', key: 'dir-r1', notes: [], marks: {}, verdicts: {}, verdictReasons: {}, review: null });
  const note = await f.json('note', { body: { scene: 'buy', group: 'A', text: '清楚，但稍微尖了一点' } });
  assert.equal(note.body.state.notes[0].at, FIXED_AT); assert.equal(note.body.state.notes[0].by, '负责人');
  await Promise.all([
    f.json('mark', { body: { scene: 'buy', group: 'A', value: 'up' } }),
    f.json('verdict', { body: { group: 'A', value: 'like' } }),
    f.json('review', { body: { state: '已审阅' } }),
  ]);
  const pair = JSON.stringify(['A', 'buy']);
  let state = (await f.json('state')).body.state;
  assert.equal(state.notes.length, 1); assert.deepEqual(state.marks, { [pair]: 'up' }); assert.deepEqual(state.verdicts, { A: 'like' });
  assert.deepEqual(state.review, { state: '已审阅', at: FIXED_AT, by: '负责人' });
  let summary = (await f.json('index')).body.summaries['dir-r1'];
  assert.deepEqual(summary, { notes: 1, up: 1, down: 0, review: state.review });
  await f.json('mark', { body: { scene: 'buy', group: 'A', value: 'down' } });
  summary = (await f.json('index')).body.summaries['dir-r1']; assert.equal(summary.up, 0); assert.equal(summary.down, 1);
  for (const value of ['meh', 'dislike']) assert.equal((await f.json('verdict', { body: { group: 'A', value } })).body.state.verdicts.A, value);
  await f.json('mark', { body: { scene: 'buy', group: 'A', value: null } });
  await f.json('verdict', { body: { group: 'A', value: null } });
  await f.json('review', { body: { state: '未审阅' } });
  assert.equal((await f.json('note/delete', { body: { id: 'note-1' } })).status, 200);
  assert.equal((await f.json('note/delete', { body: { id: 'note-1' } })).status, 404);
  state = (await f.json('state')).body.state;
  assert.deepEqual(state.notes, []); assert.deepEqual(state.marks, {}); assert.deepEqual(state.verdicts, {}); assert.equal(state.review, null);
  const ledgerDir = path.join(f.dataRoot, 'data/audition/sample');
  assert.deepEqual(fs.readdirSync(ledgerDir), ['dir-r1.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ledgerDir, 'dir-r1.json'), 'utf8')), state);
});

test('镜像使用注入的命令参数数组；失败不影响批注主存', async t => {
  const f = await fixture(t), text = '更轻一点；" & $(echo 不执行)';
  const result = await f.json('note', { body: { scene: 'buy', group: 'A', text } });
  assert.equal(result.body.mirrored, true); assert.equal(f.polls(), 1);
  assert.deepEqual(f.calls[0].args, [f.cliIndex, 'note', '--project', 'sample', '--task', 'AUDIO-DESIGN', '--text', `试听台批注〔声音方向试听·买入成交·像素原声〕${text}`, '--author', '负责人·试听台', '--registry', f.registry]);
  assert.equal(f.calls[0].executable, process.execPath); assert.equal(f.calls[0].config.windowsHide, true); assert.equal(f.calls[0].config.shell, undefined);
  f.env.mirrorFailure = true;
  const failed = await f.json('note', { body: { text: '整批再听一遍' } });
  assert.equal(failed.status, 200); assert.equal(failed.body.mirrored, false); assert.equal(failed.body.mirrorError, '临时卡不可用');
  assert.equal(failed.body.state.notes.length, 2); assert.equal((await f.json('state')).body.state.notes.length, 2);
  assert.ok(f.calls[1].args.includes('试听台批注〔声音方向试听·整批·全部〕整批再听一遍'));
});

test('非法写入不落盘；正文大小限制沿用依赖参数', async t => {
  const f = await fixture(t);
  for (const [action, body] of [
    ['note', { text: '' }], ['note', { text: '意见', scene: 'unknown' }], ['note', { text: '意见', group: 'unknown' }],
    ['mark', { scene: 'buy', group: 'A', value: 'like' }], ['verdict', { group: 'A', value: 'up' }],
    ['review', { state: 'done' }], ['note/delete', {}], ['mark', { scene: 'buy', group: 'A' }],
  ]) assert.equal((await f.json(action, { body })).status, 400, action);
  assert.equal((await f.json('note', { body: { text: 'a'.repeat(5000) } })).status, 413);
  assert.equal(fs.existsSync(path.join(f.dataRoot, 'data')), false);
});

test('导出写到约定的仓库位置；账本和索引不被导出改写', async t => {
  const f = await fixture(t);
  await f.json('note', { body: { group: 'A', text: '整组不错' } });
  const state = (await f.json('state')).body.state, before = fs.readFileSync(path.join(f.docsRoot, INDEX_REL));
  const result = await f.json('export', { body: {} });
  assert.equal(result.status, 200); assert.equal(result.body.path, `${EXPORT_DIR_REL}/dir-r1.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.docsRoot, result.body.path), 'utf8')), state);
  assert.deepEqual(fs.readFileSync(path.join(f.docsRoot, INDEX_REL)), before);
  assert.deepEqual((await f.json('state')).body.state, state);
});

test('模块关闭时全部读写返回 404，不读取清单、不写账本、不调用镜像', async t => {
  const f = await fixture(t, { enabled: false });
  for (const action of ['index', 'batch', 'state', 'file']) {
    const result = await f.json(action); assert.equal(result.status, 404); assert.match(result.body.error, /模块未启用/);
  }
  for (const action of ['note', 'note/update', 'note/delete', 'mark', 'verdict', 'review', 'export']) assert.equal((await f.json(action, { body: {} })).status, 404);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(path.join(f.dataRoot, 'data')), false);
});

test('批注可反复修改：锁内保留编号、创建信息与其它账本内容，修改时间随注入时钟变化', async t => {
  let at = FIXED_AT;
  const f = await fixture(t, { now: () => at });
  const original = (await f.json('note', { body: { scene: 'buy', group: 'A', text: '有点尖' } })).body.note;
  await f.json('mark', { body: { scene: 'buy', group: 'A', value: 'down' } });
  await f.json('verdict', { body: { group: 'A', value: 'meh', reason: '需要再听' } });
  const before = (await f.json('state')).body.state;
  for (const [timestamp, text] of [['2026-09-12T08:01:00.000Z', '改得柔和一点'], ['2026-09-12T08:02:00.000Z', '再短一点就好']]) {
    at = timestamp;
    const result = await f.json('note/update', { body: { id: original.id, text: `  ${text}\n` } });
    assert.equal(result.status, 200); assert.equal(result.body.ok, true);
    const expected = { ...original, text, editedAt: at };
    assert.deepEqual(result.body.note, expected);
    assert.deepEqual(result.body.state, { ...before, notes: [expected] });
    assert.deepEqual((await f.json('state')).body.state, result.body.state);
  }
  const ledgerDir = path.join(f.dataRoot, 'data/audition/sample');
  assert.deepEqual(fs.readdirSync(ledgerDir), ['dir-r1.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ledgerDir, 'dir-r1.json'), 'utf8')), (await f.json('state')).body.state);
});

test('批注修改：找不到返回 404，空白、非字符串和超长返回 400，拒绝时不改主存或调用镜像', async t => {
  const f = await fixture(t, { bodyMax: 20000 });
  await f.json('note', { body: { text: '保留这条批注' } });
  const before = (await f.json('state')).body.state, count = f.calls.length;
  const missing = await f.json('note/update', { body: { id: 'missing', text: '不能新增' } });
  assert.equal(missing.status, 404); assert.equal(missing.body.error, '没有这条批注');
  for (const text of ['', ' \n ', 123, null, [], {}, '字'.repeat(4001)]) {
    const result = await f.json('note/update', { body: { id: 'note-1', text } });
    assert.equal(result.status, 400); assert.equal(result.body.error, '批注须为 1 到 4000 字');
  }
  assert.equal((await f.json('note/update', { body: { text: '缺少编号' } })).status, 400);
  assert.deepEqual((await f.json('state')).body.state, before); assert.equal(f.calls.length, count);
  const maximum = await f.json('note/update', { body: { id: 'note-1', text: ` ${'字'.repeat(4000)} ` } });
  assert.equal(maximum.status, 200); assert.equal(maximum.body.note.text.length, 4000);
});

test('批注修改镜像采用参数数组与原批注归属；镜像失败保留修改内容及时间', async t => {
  const f = await fixture(t), text = '更柔和；" & $(echo 不执行)';
  await f.json('note', { body: { scene: 'buy', group: 'A', text: '原批注' } });
  const result = await f.json('note/update', { body: { id: 'note-1', text } });
  assert.equal(result.body.mirrored, true); assert.equal(f.polls(), 2);
  assert.deepEqual(f.calls[1].args, [f.cliIndex, 'note', '--project', 'sample', '--task', 'AUDIO-DESIGN', '--text', `试听台批注(修改)〔声音方向试听·买入成交·像素原声〕${text}`, '--author', '负责人·试听台', '--registry', f.registry]);
  assert.equal(f.calls[1].executable, process.execPath); assert.equal(f.calls[1].config.windowsHide, true); assert.equal(f.calls[1].config.shell, undefined);
  await f.json('note', { body: { text: '整批意见' } });
  f.env.mirrorFailure = true;
  const failed = await f.json('note/update', { body: { id: 'note-2', text: '整批都需要重听' } });
  assert.equal(failed.status, 200); assert.equal(failed.body.mirrored, false); assert.equal(failed.body.mirrorError, '临时卡不可用');
  assert.ok(f.calls[3].args.includes('试听台批注(修改)〔声音方向试听·整批·全部〕整批都需要重听'));
  assert.deepEqual((await f.json('state')).body.state.notes[1], { ...failed.body.note, text: '整批都需要重听', editedAt: FIXED_AT });
});

test('整组原因保存与修改；省略原因保留原值，空串和 null 清除，取消倾向一并清除', async t => {
  let at = FIXED_AT;
  const f = await fixture(t, { now: () => at });
  const saved = await f.json('verdict', { body: { group: 'A', value: 'like', reason: '  清楚又耐听\n' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.state.verdictReasons, { A: { text: '清楚又耐听', at: FIXED_AT } });
  at = '2026-09-12T08:03:00.000Z';
  const retained = await f.json('verdict', { body: { group: 'A', value: 'meh' } });
  assert.deepEqual(retained.body.state.verdictReasons, saved.body.state.verdictReasons);
  const changed = await f.json('verdict', { body: { group: 'A', value: 'meh', reason: '再柔和一点' } });
  assert.deepEqual(changed.body.state.verdictReasons, { A: { text: '再柔和一点', at } });
  for (const reason of ['', ' \n ', null]) {
    const cleared = await f.json('verdict', { body: { group: 'A', value: 'meh', reason } });
    assert.equal(cleared.status, 200); assert.deepEqual(cleared.body.state.verdictReasons, {});
    assert.deepEqual(cleared.body.state.verdicts, { A: 'meh' });
    await f.json('verdict', { body: { group: 'A', value: 'like', reason: '保留这句' } });
  }
  const cancelled = await f.json('verdict', { body: { group: 'A', value: null, reason: '取消时不留这句' } });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.body.state.verdicts, {}); assert.deepEqual(cancelled.body.state.verdictReasons, {});
  assert.deepEqual((await f.json('state')).body.state, cancelled.body.state);
});

test('整组原因限制 2000 字并校验类型，拒绝时不写盘或镜像', async t => {
  const f = await fixture(t, { bodyMax: 10000 });
  const saved = await f.json('verdict', { body: { group: 'A', value: 'like', reason: ` ${'字'.repeat(2000)} ` } });
  assert.equal(saved.status, 200); assert.equal(saved.body.state.verdictReasons.A.text.length, 2000);
  const before = (await f.json('state')).body.state, count = f.calls.length;
  for (const reason of ['字'.repeat(2001), false, 12, [], {}]) {
    const result = await f.json('verdict', { body: { group: 'A', value: 'dislike', reason } });
    assert.equal(result.status, 400); assert.equal(result.body.error, '整组原因须为 0 到 2000 字');
  }
  assert.deepEqual((await f.json('state')).body.state, before); assert.equal(f.calls.length, count);
});

test('保存倾向或原因都会镜像参数数组；原因清空显示未写原因，镜像失败不回滚', async t => {
  const f = await fixture(t), reason = '耐听；" & $(echo 不执行)';
  for (const [value, label] of [['like', '喜欢'], ['meh', '一般'], ['dislike', '不喜欢']]) {
    const result = await f.json('verdict', { body: { group: 'A', value, reason } });
    assert.equal(result.body.mirrored, true);
    const call = f.calls.at(-1);
    assert.deepEqual(call.args, [f.cliIndex, 'note', '--project', 'sample', '--task', 'AUDIO-DESIGN', '--text', `试听台整组倾向〔声音方向试听·像素原声〕${label}——${reason}`, '--author', '负责人·试听台', '--registry', f.registry]);
    assert.equal(call.executable, process.execPath); assert.equal(call.config.windowsHide, true); assert.equal(call.config.shell, undefined);
  }
  const changed = await f.json('verdict', { body: { group: 'A', value: 'dislike', reason: '只改原因' } });
  assert.equal(changed.body.mirrored, true);
  assert.ok(f.calls.at(-1).args.includes('试听台整组倾向〔声音方向试听·像素原声〕不喜欢——只改原因'));
  f.env.mirrorFailure = true;
  const failed = await f.json('verdict', { body: { group: 'A', value: 'meh', reason: null } });
  assert.equal(failed.status, 200); assert.equal(failed.body.mirrored, false); assert.equal(failed.body.mirrorError, '临时卡不可用');
  assert.ok(f.calls.at(-1).args.includes('试听台整组倾向〔声音方向试听·像素原声〕一般——(未写原因)'));
  assert.deepEqual((await f.json('state')).body.state, failed.body.state); assert.deepEqual(failed.body.state.verdicts, { A: 'meh' });
  assert.deepEqual(failed.body.state.verdictReasons, {});
});

test('旧账本读取补空原因且不迁移；写入新原因保留原有批注与倾向，导出包含新字段', async t => {
  const f = await fixture(t);
  const original = { schemaVersion: 1, project: 'sample', key: 'dir-r1', notes: [{ id: 'old-note', scene: null, group: null, text: '旧批注', at: FIXED_AT, by: '负责人' }], marks: {}, verdicts: { A: 'like' }, review: null };
  const file = path.join(f.dataRoot, 'data/audition/sample/dir-r1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(original));
  const bytes = fs.readFileSync(file), index = fs.readFileSync(path.join(f.docsRoot, INDEX_REL));
  assert.deepEqual((await f.json('state')).body.state, { ...original, verdictReasons: {} });
  assert.deepEqual(fs.readFileSync(file), bytes);
  const saved = await f.json('verdict', { body: { group: 'A', value: 'like', reason: '旧的一样能写原因' } });
  const expected = { ...original, verdictReasons: { A: { text: '旧的一样能写原因', at: FIXED_AT } } };
  assert.deepEqual(saved.body.state, expected); assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), expected);
  const exported = await f.json('export', { body: {} });
  assert.equal(exported.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.docsRoot, exported.body.path), 'utf8')), expected);
  assert.deepEqual((await f.json('state')).body.state, expected); assert.deepEqual(fs.readFileSync(path.join(f.docsRoot, INDEX_REL)), index);
  assert.deepEqual((await f.json('index')).body.summaries['dir-r1'], { notes: 1, up: 0, down: 0, review: null });
});

test('盲听种子精确重放、标签与本地设置逐字段校验', async () => {
  const { blindOrder, blindLabel, seededRandom } = await import('../web/src/utils/audition/random.ts');
  const { normalizePreferences } = await import('../web/src/utils/audition/preferences.ts');
  const groups = ['A', 'B', 'C', 'D'];
  assert.deepEqual(blindOrder(groups, 7), ['C', 'B', 'D', 'A']);
  assert.deepEqual(blindOrder(groups, 7), blindOrder(groups, 7));
  assert.notDeepEqual(blindOrder(groups, 7), blindOrder(groups, 8));
  assert.deepEqual(groups, ['A', 'B', 'C', 'D']);
  const random = seededRandom(7);
  assert.deepEqual([random(), random(), random()], [0.011704753153026104, 0.06195825757458806, 0.97690763277933]);
  assert.deepEqual([0, 1, 2].map(i => blindLabel(i, '方向')), ['X', 'Y', 'Z']);
  assert.deepEqual([0, 1, 2].map(i => blindLabel(i, '候选')), ['1', '2', '3']);
  assert.deepEqual(normalizePreferences({ volume: 0, seed: -2147483648, blind: true }), { volume: 0, seed: -2147483648, blind: true, shelfCollapsed: false, railCollapsed: false });
  assert.deepEqual(normalizePreferences({ volume: 100, seed: 2147483647, blind: false }), { volume: 100, seed: 2147483647, blind: false, shelfCollapsed: false, railCollapsed: false });
  assert.deepEqual(normalizePreferences({ volume: 101, seed: 7, blind: 'true' }), { volume: 70, seed: 7, blind: false, shelfCollapsed: false, railCollapsed: false });
  for (const seed of [Infinity, NaN, 1.5, '2', 2147483648]) assert.equal(normalizePreferences({ seed }).seed, 1);
  assert.deepEqual(normalizePreferences(null), { volume: 70, seed: 1, blind: false, shelfCollapsed: false, railCollapsed: false });
});

test('批次架与侧栏折叠状态逐字段校验并可重新读取；旧设置和脏数据默认展开', async t => {
  const { normalizePreferences, loadPreferences, savePreferences } = await import('../web/src/utils/audition/preferences.ts');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored = null;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem(key) { assert.equal(key, 'board-audition-preferences'); return stored; },
    setItem(key, value) { assert.equal(key, 'board-audition-preferences'); stored = value; },
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; });
  const valid = { volume: 25, seed: 6, blind: true, shelfCollapsed: true, railCollapsed: true };
  assert.equal(savePreferences(valid), true); assert.deepEqual(loadPreferences(), valid);
  for (const shelfCollapsed of ['true', 1, null, [], {}]) {
    stored = JSON.stringify({ ...valid, shelfCollapsed });
    assert.deepEqual(loadPreferences(), { ...valid, shelfCollapsed: false });
  }
  for (const railCollapsed of ['true', 1, null, [], {}]) {
    stored = JSON.stringify({ ...valid, railCollapsed });
    assert.deepEqual(loadPreferences(), { ...valid, railCollapsed: false });
  }
  stored = JSON.stringify({ volume: 25, seed: 6, blind: true, shelfCollapsed: true });
  assert.deepEqual(loadPreferences(), { ...valid, railCollapsed: false });
  stored = JSON.stringify({ volume: 25, seed: 6, blind: true });
  assert.deepEqual(loadPreferences(), { ...valid, shelfCollapsed: false, railCollapsed: false });
  for (const bad of ['{', '[]', 'null']) { stored = bad; assert.deepEqual(loadPreferences(), normalizePreferences(null)); }
  assert.equal(savePreferences({ ...valid, shelfCollapsed: false }), true); assert.equal(loadPreferences().shelfCollapsed, false);
  for (const shelfCollapsed of [false, true]) for (const railCollapsed of [false, true]) {
    const value = { ...valid, shelfCollapsed, railCollapsed };
    assert.equal(savePreferences(value), true); assert.deepEqual(loadPreferences(), value);
  }
});

test('画面消息校验来源窗口和同源，只有相同场景在 80 毫秒内去重', async () => {
  const { createScreenReceiver } = await import('../web/src/utils/audition/messages.ts');
  const frame = {}, origin = 'https://example.org', played = [];
  let at = 100, ready = 0;
  const receiver = createScreenReceiver(scene => played.push(scene), () => { ready++; }, () => at);
  const event = { source: frame, origin, data: { source: 'audition-screen', type: 'trigger', scene: 'buy' } };
  receiver.receive({ ...event, source: {} }, frame, origin);
  receiver.receive({ ...event, origin: 'https://other.example.org' }, frame, origin);
  receiver.receive({ ...event, data: { ...event.data, source: 'unknown' } }, frame, origin);
  assert.deepEqual(played, []);
  receiver.receive(event, frame, origin); at = 179; receiver.receive(event, frame, origin);
  receiver.receive({ ...event, data: { ...event.data, scene: 'sell' } }, frame, origin);
  at = 180; receiver.receive(event, frame, origin);
  assert.deepEqual(played, ['buy', 'sell', 'buy']);
  receiver.receive({ ...event, data: { source: 'audition-screen', type: 'ready', scenes: [] } }, frame, origin);
  assert.equal(ready, 1);
  receiver.reset(); receiver.receive(event, frame, origin);
  assert.deepEqual(played, ['buy', 'sell', 'buy', 'buy']);
});

test('声音上下文必须由手势创建，停止解码后轮换不能跳过下一素材', async t => {
  const { AuditionPlayer } = await import('../web/src/utils/audition/player.ts');
  const previousContext = globalThis.AudioContext, played = [];
  let contexts = 0, finishSecond;
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, arrayBuffer: async () => Uint8Array.of(url === 'a.mp3' ? 1 : 2).buffer }));
  globalThis.AudioContext = class {
    constructor() { contexts++; this.state = 'running'; this.destination = {}; }
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    decodeAudioData(bytes) {
      const id = new Uint8Array(bytes)[0];
      return id === 2 ? new Promise(resolve => { finishSecond = () => resolve({ id }); }) : Promise.resolve({ id });
    }
    createBufferSource() {
      return { buffer: null, playbackRate: { value: 1 }, onended: null, connect() {}, disconnect() {},
        start() { played.push(this.buffer.id); queueMicrotask(() => this.onended?.()); }, stop() {} };
    }
    async close() { this.state = 'closed'; }
  };
  const player = new AuditionPlayer();
  try {
    await assert.rejects(player.unlock(), /开启声音/); assert.equal(contexts, 0);
    await player.unlock(true); assert.equal(contexts, 1);
    const files = ['a.mp3', 'b.mp3'];
    await player.play(files, new AbortController().signal);
    const controller = new AbortController(), waiting = player.play(files, controller.signal);
    const stopped = assert.rejects(waiting, error => error.name === 'AbortError');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof finishSecond, 'function');
    controller.abort(); await stopped; finishSecond();
    await player.play(files, new AbortController().signal);
    assert.deepEqual(played, [1, 2]);
  } finally {
    await player.dispose();
    if (previousContext === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = previousContext;
  }
});
