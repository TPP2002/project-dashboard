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
 *   · 荧光笔与「已审阅」标记(READER-USABILITY-ROUND2)同住这份账本、同一把锁:
 *     荧光笔是纯阅读痕迹不镜像看板;「已审阅」只记在本机,不回写仓库 reader.json 的 status。
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
/** 荧光笔可选颜色(存色名不存色值,好让深浅两套主题各自配色) */
const HL_COLORS = new Set(['yellow', 'green', 'blue', 'pink']);
/** 「已审阅」只有两态;未标记 = review 为 null */
const REVIEW_STATES = new Set(['已审阅', '未审阅']);

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
  function emptyDoc(projectId, key) { return { schemaVersion: 2, project: projectId, key, annos: [], highlights: [], review: null }; }
  function readAnnos(projectId, key) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(annoPath(projectId, key), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return emptyDoc(projectId, key); throw e; }
    // v1 账本没有荧光笔与审阅状态:读时补默认,盘上文件等下一次写入时自然升到 v2
    if (!Array.isArray(doc.annos)) doc.annos = [];
    if (!Array.isArray(doc.highlights)) doc.highlights = [];
    if (!doc.review || typeof doc.review !== 'object') doc.review = null;
    return doc;
  }
  function writeAnnos(projectId, key, mutate) {
    const file = annoPath(projectId, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withLock(file + '.lock', () => {
      const doc = readAnnos(projectId, key);       // 锁内重读 → 改 → 原子写(与 board 同纪律)
      mutate(doc);
      doc.schemaVersion = 2;
      atomicWriteJsonSync(file, doc);
      return doc;
    });
  }
  /** 报告架要的两份汇总:每份报告的批注数、荧光笔数与「已审阅」标记 */
  function shelfSummary(projectId, manifest) {
    const counts = {}; const marks = {}; const reviews = {};
    for (const batch of manifest.batches || []) for (const rep of batch.reports || []) {
      try {
        const doc = readAnnos(projectId, rep.key);
        counts[rep.key] = doc.annos.length;
        marks[rep.key] = doc.highlights.length;
        if (doc.review) reviews[rep.key] = doc.review;
      } catch (_) { counts[rep.key] = 0; marks[rep.key] = 0; }
    }
    return { annoCounts: counts, markCounts: marks, reviews };
  }

  /** 选区偏移:必须是一段合法的非空区间,否则当「整段」处理(返回 null),不让脏数据进账本 */
  function readSpan(o) {
    const s = Number(o && o.start); const e = Number(o && o.end);
    if (!Number.isInteger(s) || !Number.isInteger(e)) return null;
    if (s < 0 || e <= s) return null;
    return { start: s, end: e };
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
    return sendJson(res, 200, { ok: true, project: projectId, manifest: m.manifest, ...shelfSummary(projectId, m.manifest) });
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
    const doc = readAnnos(projectId, key);
    return sendJson(res, 200, {
      ok: true, project: projectId, batch: { id: hit.batch.id, name: hit.batch.name, baseline: hit.batch.baseline },
      report: hit.report, md: md.text, prevMd, notes: loadNoteLayers(proj, hit.batch, key),
      annos: doc.annos, highlights: doc.highlights, review: doc.review,
    });
  }

  function handleAnnosGet(res, query) {
    const projectId = String(query.project || ''); const key = String(query.key || '');
    if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: '非法报告 key' });
    if (!resolveProjectSafe(projectId)) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
    const doc = readAnnos(projectId, key);
    return sendJson(res, 200, { ok: true, annos: doc.annos, highlights: doc.highlights, review: doc.review });
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
      const span = readSpan(a);
      const anno = {
        id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        blockId: typeof a.blockId === 'string' ? a.blockId.slice(0, 40) : '',
        anchor: typeof a.anchor === 'string' ? a.anchor.slice(0, 120) : '',
        quote: typeof a.quote === 'string' ? a.quote.slice(0, 160) : '',
        text,
        author: (typeof a.author === 'string' && a.author.trim()) ? a.author.trim().slice(0, 40) : '负责人',
        at: new Date().toISOString(),
        // 框选批注带上选区在本段纯文本里的偏移,正文才能把被批的那句标出来(整段批注则没有这两个字段)
        ...(span ? { start: span.start, end: span.end } : {}),
      };
      const doc = writeAnnos(projectId, key, (d) => { d.annos.push(anno); });
      const noteText = `【审阅台批注·${key}${anno.anchor ? ' §' + anno.anchor : ''}】${text}${anno.quote ? `(段:「${anno.quote.slice(0, 60)}…」)` : ''}`;
      mirrorNote(projectId, taskId, noteText, (mirrored, mirrorError) => {
        sendJson(res, 200, { ok: true, anno, annos: doc.annos, mirror: mirrored, mirrorError: mirrorError || undefined, task: taskId });
      });
    });
  }

  /** 荧光笔:纯阅读痕迹,只落本机账本,不镜像看板卡(不是「意见」,镜像过去只会刷屏) */
  function handleMarks(req, res) {
    readBody(req, bodyMax, (err, raw) => {
      if (err) return sendJson(res, 413, { ok: false, error: err.message });
      let body; try { body = raw ? JSON.parse(raw) : {}; } catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
      const projectId = String(body.project || ''); const key = String(body.key || ''); const op = body.op || 'add';
      if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: '非法报告 key' });
      if (!resolveProjectSafe(projectId)) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });

      if (op === 'delete') {
        const id = String(body.id || '');
        if (!id) return sendJson(res, 400, { ok: false, error: '缺 id' });
        let removed = false;
        const doc = writeAnnos(projectId, key, (d) => { const n = d.highlights.length; d.highlights = d.highlights.filter((h) => h.id !== id); removed = d.highlights.length !== n; });
        return sendJson(res, removed ? 200 : 404, { ok: removed, highlights: doc.highlights, error: removed ? undefined : '没有这条荧光笔' });
      }
      if (op !== 'add') return sendJson(res, 400, { ok: false, error: `未知 op:${op}` });

      const m = body.mark || {};
      const span = readSpan(m);
      if (!span) return sendJson(res, 400, { ok: false, error: '荧光笔缺合法的选区范围' });
      const blockId = typeof m.blockId === 'string' ? m.blockId.slice(0, 40) : '';
      if (!blockId) return sendJson(res, 400, { ok: false, error: '荧光笔缺所在段落' });
      const color = HL_COLORS.has(m.color) ? m.color : 'yellow';
      const mark = {
        id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        blockId, start: span.start, end: span.end, color,
        quote: typeof m.quote === 'string' ? m.quote.slice(0, 160) : '',
        anchor: typeof m.anchor === 'string' ? m.anchor.slice(0, 120) : '',
        at: new Date().toISOString(),
      };
      const doc = writeAnnos(projectId, key, (d) => {
        // 同段落里与新选区重叠的旧笔先撤掉:重复涂色只会叠成一团看不出颜色
        d.highlights = d.highlights.filter((h) => !(h.blockId === blockId && h.start < mark.end && mark.start < h.end));
        d.highlights.push(mark);
      });
      return sendJson(res, 200, { ok: true, mark, highlights: doc.highlights });
    });
  }

  /** 「已审阅」标记:只记本机(仓库 reader.json 是回流对话维护的正本,看板不回写它) */
  function handleReview(req, res) {
    readBody(req, bodyMax, (err, raw) => {
      if (err) return sendJson(res, 413, { ok: false, error: err.message });
      let body; try { body = raw ? JSON.parse(raw) : {}; } catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
      const projectId = String(body.project || ''); const key = String(body.key || '');
      if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: '非法报告 key' });
      if (!resolveProjectSafe(projectId)) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
      const state = String(body.state || '');
      if (!REVIEW_STATES.has(state)) return sendJson(res, 400, { ok: false, error: `未知状态「${state}」(只认 已审阅 / 未审阅)` });
      const review = state === '已审阅'
        ? { state, at: new Date().toISOString(), by: (typeof body.by === 'string' && body.by.trim()) ? body.by.trim().slice(0, 40) : '负责人' }
        : null;
      const doc = writeAnnos(projectId, key, (d) => { d.review = review; });
      return sendJson(res, 200, { ok: true, review: doc.review });
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
    if (action === 'marks' && req.method === 'POST') { handleMarks(req, res); return true; }
    if (action === 'review' && req.method === 'POST') { handleReview(req, res); return true; }
    if (action === 'export' && req.method === 'POST') { handleExport(req, res); return true; }
    return false;
  }

  return { route, MANIFEST_REL, EXPORT_DIR_REL, DATA_DIR };
}

module.exports = { createReaderApi, MANIFEST_REL, EXPORT_DIR_REL };
