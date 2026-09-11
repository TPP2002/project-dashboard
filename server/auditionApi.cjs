'use strict';
// 仓库清单只读；本机账本锁内重读后原子写，镜像失败不回滚已保存的批注。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { resolveInsideRoot } = require('../core/safePath.cjs');
const { withLock } = require('../core/lock.cjs');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');

const INDEX_REL = 'docs/design/audio/试听台/audition.json';
const EXPORT_DIR_REL = 'docs/design/audio/试听台/批注';
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_FILE = 30 * 1024 * 1024;
const AUDIO = new Set(['.mp3', '.ogg', '.wav']);
const MIME = {
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const HTML_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'none'; frame-ancestors 'self'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const list = (value) => Array.isArray(value) ? value : [];
function fail(status, message) { throw Object.assign(new Error(message), { status }); }

/** 仅单段字节范围；后缀范围和越过文件末尾的合法范围按 HTTP 语义截取。 */
function byteRange(raw, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const a = match[1] ? Number(match[1]) : null;
  const b = match[2] ? Number(match[2]) : null;
  if ([a, b].some((v) => v !== null && !Number.isSafeInteger(v))) return null;
  if (a === null) return b > 0 ? [Math.max(0, size - b), size - 1] : null;
  if (a >= size || (b !== null && b < a)) return null;
  return [a, b === null ? size - 1 : Math.min(b, size - 1)];
}

function createAuditionApi(deps) {
  const { resolveProjectSafe, sendJson, readBody, bodyMax, dataRoot, dashRoot, cliIndex, registry, registryPath, pollBoards } = deps;
  const runCli = deps.execFile || execFile;
  const now = deps.now || (() => new Date().toISOString());
  const createId = deps.createId || randomUUID;
  const DATA_DIR = path.join(dataRoot, 'data', 'audition');

  function projectOf(id) {
    if (!nonempty(id) || /[\\/\0]/.test(id) || id === '.' || id === '..') fail(400, '项目名称不合法');
    const proj = resolveProjectSafe(id);
    if (!proj) fail(404, '没有找到这个项目');
    return proj;
  }
  function checkKey(key) { if (typeof key !== 'string' || !KEY_RE.test(key)) fail(400, '批次编号不合法'); }
  function inside(root, rel) {
    const full = resolveInsideRoot(root, rel);
    if (!full) fail(403, '路径越界或不合法');
    return full;
  }
  function readJson(proj, rel) {
    const full = inside(proj.docsRoot, rel);
    let raw;
    try { raw = fs.readFileSync(full, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') fail(404, '文件不存在'); throw e; }
    try { return JSON.parse(raw); } catch { fail(422, '清单格式有误，无法读取'); }
  }
  function readIndex(proj) {
    let index;
    try { index = readJson(proj, INDEX_REL); }
    catch (e) { if (e.status === 404) fail(404, '本项目还没有试听清单'); throw e; }
    if (!object(index) || index.schemaVersion !== 1 || !Array.isArray(index.batches)) fail(422, '试听清单版本或批次列表有误');
    const seen = new Set();
    for (const entry of index.batches) {
      if (!object(entry) || typeof entry.key !== 'string' || !KEY_RE.test(entry.key) || !nonempty(entry.path) || !nonempty(entry.title)) fail(422, '试听清单中有不完整的批次');
      if (seen.has(entry.key)) fail(422, '试听清单有重复的批次编号');
      seen.add(entry.key);
    }
    return index;
  }
  function loadBatch(proj, key) {
    checkKey(key);
    const entry = readIndex(proj).batches.find((item) => item.key === key);
    if (!entry) fail(404, '清单里没有这个批次');
    const batch = readJson(proj, entry.path);
    if (!object(batch)) fail(422, '批次清单应为一份完整记录');
    const baseDir = path.posix.dirname(entry.path.replace(/\\/g, '/'));
    return { batch, baseDir, problems: validateBatch(proj, batch, baseDir) };
  }
  function validateBatch(proj, batch, baseDir) {
    const problems = [];
    if (batch.schemaVersion !== 1) problems.push('批次清单版本必须为 1');
    const ids = (items, label) => {
      const seen = new Set();
      if (!Array.isArray(items) || !items.length) problems.push(`${label}列表为空或格式有误`);
      for (const item of list(items)) {
        if (!object(item) || !nonempty(item.id)) { problems.push(`${label}缺少编号`); continue; }
        if (seen.has(item.id)) problems.push(`${label}编号重复：${item.id}`);
        seen.add(item.id);
      }
      return seen;
    };
    const groups = ids(batch.groups, '组');
    const scenes = ids(batch.scenes, '场景');
    const screens = ids(batch.screens, '画面');
    for (const screen of list(batch.screens).filter(object)) {
      if (!nonempty(screen.path) || !/\.html?$/i.test(screen.path)) problems.push(`画面「${screen.title || screen.id}」需要网页文件`);
      else checkFile(screen.path, `画面「${screen.title || screen.id}」`);
      for (const field of ['width', 'height']) if (screen[field] !== undefined && (!Number.isFinite(screen[field]) || screen[field] <= 0)) problems.push(`画面「${screen.title || screen.id}」的尺寸不合法`);
    }
    if (!screens.has(batch.defaultScreen)) problems.push('默认画面未定义');
    for (const scene of list(batch.scenes).filter(object)) {
      if (!screens.has(scene.screen || batch.defaultScreen)) problems.push(`场景「${scene.name || scene.id}」引用了未定义的画面`);
      if (!Number.isInteger(scene.level) || scene.level < 1 || scene.level > 5) problems.push(`场景「${scene.name || scene.id}」强度须在 1 到 5 之间`);
    }
    const pairs = new Set();
    if (!Array.isArray(batch.clips)) problems.push('声音片段列表格式有误');
    for (const [i, clip] of list(batch.clips).entries()) {
      const label = `第 ${i + 1} 个片段`;
      if (!object(clip)) { problems.push(`${label}格式有误`); continue; }
      if (!groups.has(clip.group)) problems.push(`${label}引用了未定义的组`);
      if (!scenes.has(clip.scene)) problems.push(`${label}引用了未定义的场景`);
      const pair = JSON.stringify([clip.group, clip.scene]);
      if (pairs.has(pair)) problems.push(`${label}与同组同场景的片段重复`);
      pairs.add(pair);
      if (!Array.isArray(clip.files) || clip.files.length < 1 || clip.files.length > 4) problems.push(`${label}须有 1 到 4 个声音文件`);
      for (const file of list(clip.files)) {
        if (!nonempty(file) || !AUDIO.has(path.extname(file).toLowerCase())) problems.push(`${label}的文件扩展名不在声音白名单内`);
        else checkFile(path.posix.join(baseDir, file.replace(/\\/g, '/')), label);
      }
      if (!Array.isArray(clip.sources) || !clip.sources.length) problems.push(`${label}至少需要一条来源`);
      for (const source of list(clip.sources)) {
        if (!object(source) || !nonempty(source.license) || !nonempty(source.url)) problems.push(`${label}的来源缺少授权或原链接`);
        if (object(source) && /CC[ -]BY|Attribution/i.test(source.license || '') && !nonempty(source.attribution)) problems.push(`${label}的授权要求署名，但没有署名内容`);
      }
    }
    return problems;
    function checkFile(rel, label) {
      try {
        const full = inside(proj.docsRoot, rel);
        const stat = fs.statSync(full);
        if (!stat.isFile()) problems.push(`${label}所指的不是文件`);
        else if (stat.size > MAX_FILE) problems.push(`${label}的文件超过 30MB`);
      } catch (e) {
        if (e.status === 403) problems.push(`${label}的文件路径越界`);
        else if (e.code === 'ENOENT') problems.push(`${label}缺少文件：${rel}`);
        else problems.push(`${label}的文件无法读取：${e.message}`);
      }
    }
  }

  function ledgerPath(project, key) { return inside(DATA_DIR, `${project}/${key}.json`); }
  function readState(project, key) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(ledgerPath(project, key), 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') return { schemaVersion: 1, project, key, notes: [], marks: {}, verdicts: {}, review: null };
      throw e;
    }
    if (!object(doc) || doc.schemaVersion !== 1 || doc.project !== project || doc.key !== key || !Array.isArray(doc.notes) || !object(doc.marks) || !object(doc.verdicts)) fail(500, '批注账本格式有误，请保留原文件检查');
    return doc;
  }
  function writeState(project, key, mutate) {
    const file = ledgerPath(project, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withLock(file + '.lock', () => {
      const doc = readState(project, key);
      mutate(doc);
      atomicWriteJsonSync(file, doc);
      return doc;
    });
  }
  function summaries(project, index) {
    return Object.fromEntries(index.batches.map(({ key }) => {
      const state = readState(project, key);
      const marks = Object.values(state.marks);
      return [key, { notes: state.notes.length, up: marks.filter((v) => v === 'up').length, down: marks.filter((v) => v === 'down').length, review: state.review }];
    }));
  }
  function serveFile(req, res, proj, rel) {
    const full = inside(proj.docsRoot, rel);
    const ext = path.extname(full).toLowerCase();
    if (!Object.hasOwn(MIME, ext)) fail(403, '不支持这种文件类型');
    let stat;
    try { stat = fs.statSync(full); } catch (e) { if (e.code === 'ENOENT') fail(404, '文件不存在'); throw e; }
    if (!stat.isFile()) fail(403, '所选路径不是文件');
    if (stat.size > MAX_FILE) fail(413, '单个文件不能超过 30MB');
    const headers = { 'Content-Type': MIME[ext], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
    if (ext === '.html' || ext === '.htm') headers['Content-Security-Policy'] = HTML_CSP;
    // SVG 也可能携带脚本；以图片读取不需要脚本权限。
    if (ext === '.svg') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    if (AUDIO.has(ext)) headers['Accept-Ranges'] = 'bytes';
    const data = fs.readFileSync(full);
    if (data.length > MAX_FILE) fail(413, '单个文件不能超过 30MB');
    if (AUDIO.has(ext) && req.headers.range !== undefined) {
      const range = byteRange(req.headers.range, data.length);
      if (!range) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${data.length}`, 'Content-Length': 0 }); return res.end(); }
      const [start, end] = range;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
      return res.end(data.subarray(start, end + 1));
    }
    res.writeHead(200, { ...headers, 'Content-Length': data.length });
    res.end(data);
  }
  function mirrorNote(project, task, text) {
    if (!nonempty(task)) return Promise.resolve({ mirrored: false, mirrorError: '批次没有绑定看板卡' });
    const args = [cliIndex, 'note', '--project', project, '--task', task, '--text', text, '--author', '负责人·试听台'];
    if (registry && registryPath && registry !== registryPath) args.push('--registry', registry);
    return new Promise((resolve) => {
      const finished = (e, _out, err) => {
        if (e) return resolve({ mirrored: false, mirrorError: String(err || e.message).slice(0, 300) });
        try { pollBoards?.(); } catch (refreshError) { return resolve({ mirrored: true, mirrorError: '批注已同步，看板刷新失败：' + refreshError.message }); }
        resolve({ mirrored: true });
      };
      try { runCli(process.execPath, args, { cwd: dashRoot, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }, finished); }
      catch (e) { finished(e); }
    });
  }
  function requireMember(items, id, label, optional = false) {
    if (optional && (id === undefined || id === null || id === '')) return null;
    const hit = list(items).find((item) => object(item) && item.id === id && nonempty(id));
    if (!hit) fail(400, `没有找到所选${label}`);
    return hit;
  }
  async function post(action, body) {
    if (!object(body)) fail(400, '请求内容须为一份记录');
    const { project, key } = body;
    const proj = projectOf(project);
    checkKey(key);
    const { batch } = loadBatch(proj, key);
    if (action === 'export') {
      const rel = path.posix.join(EXPORT_DIR_REL, key + '.json');
      const dest = inside(proj.docsRoot, rel);
      const source = ledgerPath(project, key);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      withLock(source + '.lock', () => withLock(dest + '.lock', () => atomicWriteJsonSync(dest, readState(project, key))));
      return { ok: true, path: rel };
    }
    let note, removed = false;
    const group = ['note', 'mark', 'verdict'].includes(action) ? requireMember(batch.groups, body.group, '组', action === 'note') : null;
    const scene = ['note', 'mark'].includes(action) ? requireMember(batch.scenes, body.scene, '场景', action === 'note') : null;
    if (action === 'note') {
      if (!nonempty(body.text) || body.text.trim().length > 4000) fail(400, '批注须为 1 到 4000 字');
      note = { id: createId(), scene: scene?.id || null, group: group?.id || null, text: body.text.trim(), at: now(), by: '负责人' };
    }
    if (action === 'note/delete' && !nonempty(body.id)) fail(400, '缺少批注编号');
    if (action === 'mark' && !['up', 'down', null].includes(body.value)) fail(400, '标记只接受好、不好或取消');
    if (action === 'verdict' && !['like', 'meh', 'dislike', null].includes(body.value)) fail(400, '整组倾向不合法');
    if (action === 'review' && !['已审阅', '未审阅'].includes(body.state)) fail(400, '审阅状态不合法');
    const state = writeState(project, key, (doc) => {
      if (action === 'note') doc.notes.push(note);
      if (action === 'note/delete') {
        removed = doc.notes.some((item) => item.id === body.id);
        if (!removed) fail(404, '没有这条批注');
        doc.notes = doc.notes.filter((item) => item.id !== body.id);
      }
      if (action === 'mark') {
        const pair = JSON.stringify([body.group, body.scene]);
        if (body.value === null) delete doc.marks[pair]; else doc.marks[pair] = body.value;
      }
      if (action === 'verdict') {
        if (body.value === null) delete doc.verdicts[body.group];
        else doc.verdicts = { ...doc.verdicts, [body.group]: body.value };
      }
      if (action === 'review') doc.review = body.state === '已审阅' ? { state: '已审阅', at: now(), by: '负责人' } : null;
    });
    if (!note) return { ok: true, state };
    const text = `试听台批注〔${batch.title}·${scene?.name || '整批'}·${group?.name || '全部'}〕${note.text}`;
    return { ok: true, state, note, ...await mirrorNote(project, batch.task, text) };
  }
  function errorReply(res, e) { sendJson(res, e.status || 500, { ok: false, error: e.status ? e.message : '试听台读写失败：' + e.message }); }
  function route(action, req, res, query = {}) {
    if (deps.isEnabled && !deps.isEnabled()) { sendJson(res, 404, { ok: false, error: '试听台模块未启用，请在菜单设置里打开' }); return true; }
    if (req.method === 'GET' && ['index', 'batch', 'file', 'state'].includes(action)) {
      try {
        const project = query.project;
        const proj = projectOf(project);
        if (action === 'file') serveFile(req, res, proj, query.path);
        else if (action === 'index') {
          const index = readIndex(proj);
          sendJson(res, 200, { ok: true, project, index, summaries: summaries(project, index) });
        } else {
          checkKey(query.key);
          if (action === 'batch') sendJson(res, 200, { ok: true, ...loadBatch(proj, query.key) });
          else sendJson(res, 200, { ok: true, state: readState(project, query.key) });
        }
      } catch (e) { errorReply(res, e); }
      return true;
    }
    if (req.method !== 'POST' || !['note', 'note/delete', 'mark', 'verdict', 'review', 'export'].includes(action)) return false;
    readBody(req, bodyMax, (error, raw) => {
      if (error) return sendJson(res, 413, { ok: false, error: '请求内容太长' });
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: '请求内容格式有误' }); }
      post(action, body).then((result) => sendJson(res, 200, result)).catch((e) => errorReply(res, e));
    });
    return true;
  }
  return { route, DATA_DIR };
}
module.exports = { createAuditionApi, INDEX_REL, EXPORT_DIR_REL };
