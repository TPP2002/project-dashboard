'use strict';
/**
 * readerApi.cjs —— 看板「审阅台」后端(READER-INTO-BOARD)。
 *
 * 干什么:把仓库里的审计/外脑报告(markdown)连同「上一版」「按日期分层的边注」端给前端;
 *        接住负责人写在段落旁的批注;把批注按需导出成仓库 docs 下的 JSON 供回流对话随 PR 入库;
 *        另有「导出给外脑」(READER-EXPORT-REVIEW):把批阅意见单拼成 md 只回给前端,不落盘。
 *
 * 事实源:
 *   · 报告清单 = <项目 docsRoot>/docs/design/审计回流/reader.json(仓库正本,每批回运往里加)
 *   · 报告正文/上一版/边注 = 清单里写的相对路径,一律经 resolveInsideRoot 白名单根校验(与 /api/doc 同规矩)
 *   · 批注主存 = <DASHBOARD_HOME>/data/reader/<project>/<key>.json(数据根中的本机账本:加锁 + 原子写)
 *   · 批注镜像 = 对应看板卡的 note(经 CLI,和 decide 一样只经 execFile 数组传参,不拼 shell)
 *   · 荧光笔与「已审阅」标记(READER-USABILITY-ROUND2)同住这份账本、同一把锁:
 *     荧光笔是纯阅读痕迹不镜像看板;「已审阅」只记在本机,不回写仓库 reader.json 的 status。
 *   · 本机导入(READER-IMPORT-BUTTON):浏览器端(T2)转好的 markdown 连同可选原件,落在
 *     <数据根>/data/reader/<项目>/imports/<key>/(纯函数与存储层见 readerImport.cjs);
 *     manifest 在 shelfSummary 之前动态并入「本机导入」虚拟批次;IMP- 开头的 key 读本机 md。
 *
 * 明确不做:不 commit / 不 push。进仓库那一步只提供「导出」,由回流对话随 PR 提交(负责人 2026-09-05 质疑后定)。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { resolveInsideRoot } = require('../core/safePath.cjs');
const { withLock } = require('../core/lock.cjs');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
const { buildReviewExport, exportFileName } = require('./readerReviewExport.cjs');
const readerImport = require('./readerImport.cjs');

const MANIFEST_REL = 'docs/design/审计回流/reader.json';
const EXPORT_DIR_REL = 'docs/design/审计回流/批注';
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
const NOTE_TIMEOUT_MS = 15000;
/** 荧光笔可选颜色(存色名不存色值,好让深浅两套主题各自配色) */
const HL_COLORS = new Set(['yellow', 'green', 'blue', 'pink']);
/** 「已审阅」只有两态;未标记 = review 为 null */
const REVIEW_STATES = new Set(['已审阅', '未审阅']);
/** 原件回包的 Content-Type:只认 pdf/docx 两种正经类型,其余(含 html)一律按二进制流回,防脚本执行 */
const ORIGINAL_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function createReaderApi(deps) {
  // dashRoot 是代码根,用于启动 CLI 的工作目录。
  // dataRoot 是 DASHBOARD_HOME 数据根,批注主存不随发布副本替换。
  const { resolveProjectSafe, sendJson, readBody, bodyMax, dashRoot, dataRoot, cliIndex, registry, registryPath, pollBoards, importBodyMax } = deps;
  const DATA_DIR = path.join(dataRoot, 'data', 'reader');
  // 本机导入的 POST 体上限(30MB 原件 base64 约 40MB,放宽到 45MB);只用于 /api/reader/import,其它动作仍用 bodyMax
  const IMPORT_BODY_MAX = importBodyMax || 45 * 1024 * 1024;

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
    // 本机导入:追加「本机导入」虚拟批次,且必须发生在 shelfSummary 之前,
    // 导入报告的批注数/荧光笔数/已审阅标记才进货架汇总;没有导入时不动 manifest,回包与从前逐字节一致。
    const imports = readerImport.listImports(DATA_DIR, projectId);
    if (!imports.length) {
      return sendJson(res, 200, { ok: true, project: projectId, manifest: m.manifest, ...shelfSummary(projectId, m.manifest) });
    }
    const batch = readerImport.buildLocalImportBatch(projectId, imports, DATA_DIR);
    const manifest = { ...m.manifest, batches: [...(m.manifest.batches || []), batch] };
    return sendJson(res, 200, { ok: true, project: projectId, manifest, ...shelfSummary(projectId, manifest) });
  }

  /**
   * 读一份报告的全部素材:清单定位 → 正文 → 上一版 → 边注 → 本机批注。
   * handleReport 与 export-review 两处共用;失败返回 { status, message }。
   * 这是纯读取,返回体怎么发由两个 handler 各自决定(handleReport 的返回体一个字节不许变)。
   */
  function loadReportBundle(projectId, key) {
    const proj = projectId && resolveProjectSafe(projectId);
    if (!proj) return { status: 404, message: `未注册的项目「${projectId}」` };
    // 本机导入的报告(IMP- 开头):正文取本机 imports 目录,无边注层、无上一版;IMP- 之外的 key 走原有路径。
    // 放在 loadReportBundle 里,report 与 export-review 两条路都认导入报告
    if (key.startsWith('IMP-')) {
      const hit = readerImport.readImport(DATA_DIR, projectId, key);
      if (!hit) return { status: 404, message: `没有这份本机导入「${key}」` };
      const doc = readAnnos(projectId, key);
      return {
        proj,
        batch: { id: readerImport.BATCH_ID, name: readerImport.BATCH_NAME, baseline: readerImport.BATCH_BASELINE },
        report: readerImport.buildImportReportMeta(projectId, hit.meta, readerImport.hasOriginal(DATA_DIR, projectId, key)),
        md: hit.md, prevMd: null, notes: [],
        annos: doc.annos, highlights: doc.highlights, review: doc.review,
      };
    }
    const m = readManifest(proj);
    if (m.error) return { status: m.error, message: m.message };
    const hit = findReport(m.manifest, key);
    if (!hit) return { status: 404, message: `清单里没有报告「${key}」` };
    const md = readRepoText(proj, hit.report.md);
    if (md.error) return { status: md.error, message: md.message };
    let prevMd = null;
    if (hit.report.prevMd) { const p = readRepoText(proj, hit.report.prevMd); prevMd = p.error ? null : p.text; }
    const doc = readAnnos(projectId, key);
    return {
      proj,
      batch: { id: hit.batch.id, name: hit.batch.name, baseline: hit.batch.baseline },
      report: hit.report, md: md.text, prevMd, notes: loadNoteLayers(proj, hit.batch, key),
      annos: doc.annos, highlights: doc.highlights, review: doc.review,
    };
  }

  function handleReport(res, query) {
    const projectId = String(query.project || ''); const key = String(query.key || '');
    if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: '非法报告 key' });
    const b = loadReportBundle(projectId, key);
    if (b.status) return sendJson(res, b.status, { ok: false, error: b.message });
    return sendJson(res, 200, {
      ok: true, project: projectId, batch: b.batch,
      report: b.report, md: b.md, prevMd: b.prevMd, notes: b.notes,
      annos: b.annos, highlights: b.highlights, review: b.review,
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

  /** 本机日历的今天,YYYY-MM-DD(导出单上的「批阅日期」;测试经纯函数注入固定值) */
  function localToday() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** 导出给外脑(READER-EXPORT-REVIEW):拼「批阅意见单 + 回流对账 + 带批注的报告原文」md,只回给前端不落盘 */
  function handleExportReview(res, query) {
    const projectId = String(query.project || ''); const key = String(query.key || '');
    if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: '非法报告 key' });
    const b = loadReportBundle(projectId, key);
    if (b.status) return sendJson(res, b.status, { ok: false, error: b.message });
    const today = localToday();
    return sendJson(res, 200, {
      ok: true,
      fileName: exportFileName(b.report.title, today),
      md: buildReviewExport({ meta: b.report, batch: b.batch, md: b.md, annos: b.annos, notes: b.notes, today }),
      annoCount: b.annos.length,
    });
  }

  // ---------- 本机导入(READER-IMPORT-BUTTON T1:纯函数与存储层在 readerImport.cjs) ----------
  /** 导入:接住浏览器端转好的 markdown(可选带原件),校验后落本机数据目录;同内容同天 = 同 key,不重复存 */
  function handleImport(req, res) {
    readBody(req, IMPORT_BODY_MAX, (err, raw) => {
      if (err) return sendJson(res, 413, { ok: false, error: err.message });
      let body; try { body = raw ? JSON.parse(raw) : {}; } catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
      const projectId = String(body.project || '');
      const proj = resolveProjectSafe(projectId);
      if (!proj) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
      const v = readerImport.validateImportBody(body);
      if (!v.ok) return sendJson(res, v.status, { ok: false, error: v.message });
      let saved;
      try { saved = readerImport.saveImport(DATA_DIR, projectId, v.value); }
      catch (e) { return sendJson(res, 500, { ok: false, error: '落盘导入失败:' + e.message }); }
      return sendJson(res, 200, {
        ok: true, key: saved.key, duplicate: saved.duplicate,
        report: readerImport.buildImportReportMeta(projectId, saved.meta, readerImport.hasOriginal(DATA_DIR, projectId, saved.key)),
      });
    });
  }

  /** 回原件:附件下载;Content-Type 只认 pdf/docx,其余(含 html)一律二进制流,防把上传内容当网页执行 */
  function handleImportOriginal(res, query) {
    const projectId = String(query.project || ''); const key = String(query.key || '');
    if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: '非法报告 key' });
    if (!resolveProjectSafe(projectId)) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
    const hit = readerImport.readImportOriginal(DATA_DIR, projectId, key);
    if (!hit) return sendJson(res, 404, { ok: false, error: '这份导入没有原件' });
    let data;
    try { data = fs.readFileSync(hit.file); } catch (e) { return sendJson(res, 500, { ok: false, error: '读原件失败:' + e.message }); }
    res.writeHead(200, {
      'Content-Type': ORIGINAL_MIME[hit.ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Content-Disposition': 'attachment; filename="' + path.basename(hit.file) + '"',
    });
    res.end(data);
  }

  /** 删导入:只许删 IMP- 开头的本机导入(仓库里的报告绝不能从这里被删);连同该 key 的批注账本一起清 */
  function handleImportDelete(req, res) {
    readBody(req, bodyMax, (err, raw) => {
      if (err) return sendJson(res, 413, { ok: false, error: err.message });
      let body; try { body = raw ? JSON.parse(raw) : {}; } catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
      const projectId = String(body.project || ''); const key = String(body.key || '');
      if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: '非法报告 key' });
      if (!key.startsWith('IMP-')) return sendJson(res, 400, { ok: false, error: '只允许删除本机导入(IMP- 开头)的报告' });
      if (!resolveProjectSafe(projectId)) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
      let removed;
      try { removed = readerImport.deleteImport(DATA_DIR, projectId, key); }
      catch (e) { return sendJson(res, 500, { ok: false, error: '删除导入失败:' + e.message }); }
      if (!removed) return sendJson(res, 404, { ok: false, error: `没有这份本机导入「${key}」` });
      // 批注账本(及锁)一并清:删账本也走锁,杜绝「删到一半又被并发写回」
      const ledger = annoPath(projectId, key);
      let removedAnnos = 0;
      try { removedAnnos = readAnnos(projectId, key).annos.length; } catch (_) { /* 账本读不出就按 0 条回 */ }
      try { withLock(ledger + '.lock', () => { fs.rmSync(ledger, { force: true }); }); } catch (_) { /* 删锁失败不阻塞回包 */ }
      try { fs.rmSync(ledger + '.lock', { force: true }); } catch (_) { /* ignore */ }
      return sendJson(res, 200, { ok: true, removedAnnos });
    });
  }

  function route(action, req, res, query) {
    if (action === 'manifest' && req.method === 'GET') { handleManifest(res, query); return true; }
    if (action === 'report' && req.method === 'GET') { handleReport(res, query); return true; }
    if (action === 'export-review' && req.method === 'GET') { handleExportReview(res, query); return true; }
    if (action === 'annos' && req.method === 'GET') { handleAnnosGet(res, query); return true; }
    if (action === 'annos' && req.method === 'POST') { handleAnnosPost(req, res); return true; }
    if (action === 'marks' && req.method === 'POST') { handleMarks(req, res); return true; }
    if (action === 'review' && req.method === 'POST') { handleReview(req, res); return true; }
    if (action === 'export' && req.method === 'POST') { handleExport(req, res); return true; }
    if (action === 'import' && req.method === 'POST') { handleImport(req, res); return true; }
    if (action === 'import-original' && req.method === 'GET') { handleImportOriginal(res, query); return true; }
    if (action === 'import-delete' && req.method === 'POST') { handleImportDelete(req, res); return true; }
    return false;
  }

  return { route, MANIFEST_REL, EXPORT_DIR_REL, DATA_DIR };
}

module.exports = { createReaderApi, MANIFEST_REL, EXPORT_DIR_REL };
