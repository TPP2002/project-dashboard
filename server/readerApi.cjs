'use strict';
/**
 * readerApi.cjs —— 看板「审阅台」后端(READER-INTO-BOARD)。
 *
 * 干什么:把仓库里的审计/外脑报告(markdown)连同「上一版」「按日期分层的边注」端给前端;
 *        接住负责人写在段落旁的批注;把批注按需导出成仓库 docs 下的 JSON 供回流对话随 PR 入库。
 *
 * 事实源:
 *   · 报告清单 = <项目 docsRoot>/docs/design/审计回流/reader.json(仓库正本,每批回运往里加)
 *   · 报告正文/上一版/边注 = 清单里写的相对路径,一律经 resolveInsideRoot 白名单根校验(与 /api/doc 同规矩)
 *   · 批注主存 = <看板根>/data/reader/<project>/<key>.json(与 board.json 同级的本机账本:加锁 + 原子写)
 *   · 批注镜像 = 对应看板卡的 note(经 CLI,和 decide 一样只经 execFile 数组传参,不拼 shell)
 *
 * 明确不做:不 commit / 不 push。进仓库那一步只提供「导出」,由回流对话随 PR 提交(负责人 2026-09-05 质疑后定)。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { resolveInsideRoot } = require('../core/safePath.cjs');
const { withLock } = require('../core/lock.cjs');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');

const MANIFEST_REL = 'docs/design/审计回流/reader.json';
const EXPORT_DIR_REL = 'docs/design/审计回流/批注';
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
const NOTE_TIMEOUT_MS = 15000;

function createReaderApi(deps) {
  const { resolveProjectSafe, sendJson, readBody, bodyMax, dashRoot, cliIndex, registry, registryPath, pollBoards } = deps;
  const DATA_DIR = path.join(dashRoot, 'data', 'reader');

  // ---------- 读仓库文件(全部走白名单根) ----------
  function readRepoText(proj, rel) {
    const full = resolveInsideRoot(proj.docsRoot, rel);
    if (!full) return { error: 403, message: `路径越界或非法:${rel}` };
    try { return { text: fs.readFileSync(full, 'utf8') }; }
    catch (e) {
      if (e.code === 'ENOENT') return { error: 404, message: `文件不存在:${rel}` };
      return { error: 500, message: e.message };
    }
  }
  function readManifest(proj) {
    const r = readRepoText(proj, MANIFEST_REL);
    if (r.error) return r;
    try { return { manifest: JSON.parse(r.text) }; }
    catch (e) { return { error: 500, message: '报告清单不是合法 JSON:' + e.message }; }
  }
  function findReport(manifest, key) {
    for (const batch of manifest.batches || []) {
      for (const rep of batch.reports || []) if (rep.key === key) return { batch, report: rep };
    }
    return null;
  }

  // ---------- 批注账本 ----------
  function annoPath(projectId, key) { return path.join(DATA_DIR, projectId, key + '.json'); }
  function readAnnos(projectId, key) {
    try { return JSON.parse(fs.readFileSync(annoPath(projectId, key), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return { schemaVersion: 1, project: projectId, key, annos: [] }; throw e; }
  }
  function writeAnnos(projectId, key, mutate) {
    const file = annoPath(projectId, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withLock(file + '.lock', () => {
      const doc = readAnnos(projectId, key);       // 锁内重读 → 改 → 原子写(与 board 同纪律)
      mutate(doc);
      atomicWriteJsonSync(file, doc);
      return doc;
    });
  }
  function annoCounts(projectId, manifest) {
    const out = {};
    for (const batch of manifest.batches || []) for (const rep of batch.reports || []) {
      try { out[rep.key] = readAnnos(projectId, rep.key).annos.length; } catch (_) { out[rep.key] = 0; }
    }
    return out;
  }

  // ---------- 边注层 ----------
  function loadNoteLayers(proj, batch, key) {
    const layers = [];
    for (const layer of batch.noteLayers || []) {
      const r = readRepoText(proj, layer.file);
      if (r.error) { layers.push({ id: layer.id, name: layer.name, notes: [], error: r.message }); continue; }
      let data;
      try { data = JSON.parse(r.text); } catch (e) { layers.push({ id: layer.id, name: layer.name, notes: [], error: '边注文件不是合法 JSON' }); continue; }
      const bucket = data.layers && data.layers[layer.key || layer.id];
      const notes = bucket && bucket.notes && Array.isArray(bucket.notes[key]) ? bucket.notes[key] : [];
      layers.push({ id: layer.id, name: (bucket && bucket.name) || layer.name, notes });
    }
    return layers;
  }

  // ---------- handlers ----------
  function handleManifest(res, query) {
    const projectId = String(query.project || '');
    const proj = projectId && resolveProjectSafe(projectId);
    if (!proj) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
    const m = readManifest(proj);
    if (m.error) return sendJson(res, m.error, { ok: false, error: m.message, manifestPath: MANIFEST_REL });
    return sendJson(res, 200, { ok: true, project: projectId, manifest: m.manifest, annoCounts: annoCounts(projectId, m.manifest) });
  }

  function handleReport(res, query) {
    const projectId = String(query.project || ''); const key = String(query.key || '');
    if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: '非法报告 key' });
    const proj = projectId && resolveProjectSafe(projectId);
    if (!proj) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
    const m = readManifest(proj);
    if (m.error) return sendJson(res, m.error, { ok: false, error: m.message });
    const hit = findReport(m.manifest, key);
    if (!hit) return sendJson(res, 404, { ok: false, error: `清单里没有报告「${key}」` });
    const md = readRepoText(proj, hit.report.md);
    if (md.error) return sendJson(res, md.error, { ok: false, error: md.message });
    let prevMd = null;
    if (hit.report.prevMd) { const p = readRepoText(proj, hit.report.prevMd); prevMd = p.error ? null : p.text; }
    return sendJson(res, 200, {
      ok: true, project: projectId, batch: { id: hit.batch.id, name: hit.batch.name, baseline: hit.batch.baseline },
      report: hit.report, md: md.text, prevMd, notes: loadNoteLayers(proj, hit.batch, key),
      annos: readAnnos(projectId, key).annos,
    });
  }

  function handleAnnosGet(res, query) {
    const projectId = String(query.project || ''); const key = String(query.key || '');
    if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: '非法报告 key' });
    if (!resolveProjectSafe(projectId)) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
    return sendJson(res, 200, { ok: true, annos: readAnnos(projectId, key).annos });
  }

  /** 镜像一条批注到看板卡 note(失败不阻塞主存,回包里如实标 mirror:false) */
  function mirrorNote(projectId, taskId, text, cb) {
    if (!taskId) return cb(false, '报告未绑定看板卡');
    const args = [cliIndex, 'note', '--project', projectId, '--task', taskId, '--text', text, '--author', '负责人·审阅台'];
    if (registry && registryPath && registry !== registryPath) args.push('--registry', registry);
    execFile(process.execPath, args, { cwd: dashRoot, timeout: NOTE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (e, _out, err) => {
      if (e) return cb(false, String(err || e.message).slice(0, 300));
      try { pollBoards && pollBoards(); } catch (_) {}
      cb(true, null);
    });
  }

  function handleAnnosPost(req, res) {
    readBody(req, bodyMax, (err, raw) => {
      if (err) return sendJson(res, 413, { ok: false, error: err.message });
      let body; try { body = raw ? JSON.parse(raw) : {}; } catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
      const projectId = String(body.project || ''); const key = String(body.key || ''); const op = body.op || 'add';
      if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: '非法报告 key' });
      const proj = resolveProjectSafe(projectId);
      if (!proj) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
      const m = readManifest(proj);
      const hit = m.manifest ? findReport(m.manifest, key) : null;
      const taskId = hit ? hit.report.task : null;

      if (op === 'delete') {
        const id = String(body.id || '');
        if (!id) return sendJson(res, 400, { ok: false, error: '缺 id' });
        let removed = false;
        const doc = writeAnnos(projectId, key, (d) => { const n = d.annos.length; d.annos = d.annos.filter((a) => a.id !== id); removed = d.annos.length !== n; });
        return sendJson(res, removed ? 200 : 404, { ok: removed, annos: doc.annos, error: removed ? undefined : '没有这条批注' });
      }
      if (op !== 'add') return sendJson(res, 400, { ok: false, error: `未知 op:${op}` });

      const a = body.anno || {};
      const text = typeof a.text === 'string' ? a.text.trim() : '';
      if (!text) return sendJson(res, 400, { ok: false, error: '批注内容为空' });
      if (text.length > 4000) return sendJson(res, 400, { ok: false, error: '批注太长(>4000 字)' });
      const anno = {
        id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        blockId: typeof a.blockId === 'string' ? a.blockId.slice(0, 40) : '',
        anchor: typeof a.anchor === 'string' ? a.anchor.slice(0, 120) : '',
        quote: typeof a.quote === 'string' ? a.quote.slice(0, 160) : '',
        text,
        author: (typeof a.author === 'string' && a.author.trim()) ? a.author.trim().slice(0, 40) : '负责人',
        at: new Date().toISOString(),
      };
      const doc = writeAnnos(projectId, key, (d) => { d.annos.push(anno); });
      const noteText = `【审阅台批注·${key}${anno.anchor ? ' §' + anno.anchor : ''}】${text}${anno.quote ? `(段:「${anno.quote.slice(0, 60)}…」)` : ''}`;
      mirrorNote(projectId, taskId, noteText, (mirrored, mirrorError) => {
        sendJson(res, 200, { ok: true, anno, annos: doc.annos, mirror: mirrored, mirrorError: mirrorError || undefined, task: taskId });
      });
    });
  }

  /** 导出:把本机批注账本写成仓库 docs 下的 JSON(不 commit;由回流对话随 PR 提交) */
  function handleExport(req, res) {
    readBody(req, bodyMax, (err, raw) => {
      if (err) return sendJson(res, 413, { ok: false, error: err.message });
      let body; try { body = raw ? JSON.parse(raw) : {}; } catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
      const projectId = String(body.project || ''); const key = String(body.key || '');
      if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: '非法报告 key' });
      const proj = resolveProjectSafe(projectId);
      if (!proj) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
      const dir = resolveInsideRoot(proj.docsRoot, EXPORT_DIR_REL);
      if (!dir) return sendJson(res, 403, { ok: false, error: '导出目录越界' });
      const doc = readAnnos(projectId, key);
      const dest = path.join(dir, key + '.json');
      try {
        fs.mkdirSync(dir, { recursive: true });
        atomicWriteJsonSync(dest, { ...doc, exportedAt: new Date().toISOString(), _说明: '审阅台导出的负责人段落批注;由回流对话随 PR 入库,看板不自动 commit' });
      } catch (e) { return sendJson(res, 500, { ok: false, error: '写导出文件失败:' + e.message }); }
      return sendJson(res, 200, { ok: true, path: path.posix.join(EXPORT_DIR_REL, key + '.json'), count: doc.annos.length });
    });
  }

  function route(action, req, res, query) {
    if (action === 'manifest' && req.method === 'GET') { handleManifest(res, query); return true; }
    if (action === 'report' && req.method === 'GET') { handleReport(res, query); return true; }
    if (action === 'annos' && req.method === 'GET') { handleAnnosGet(res, query); return true; }
    if (action === 'annos' && req.method === 'POST') { handleAnnosPost(req, res); return true; }
    if (action === 'export' && req.method === 'POST') { handleExport(req, res); return true; }
    return false;
  }

  return { route, MANIFEST_REL, EXPORT_DIR_REL, DATA_DIR };
}

module.exports = { createReaderApi, MANIFEST_REL, EXPORT_DIR_REL };
