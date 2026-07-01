'use strict';
/**
 * server/server.cjs —— 多项目看板 · 零依赖本地 HTTP + SSE 服务
 *
 * 职责（只读展示 + 唯一写通道转发，绝不自写 board）：
 *   1) 静态托管 web/dist/（生产构建产物；SPA 路由回退 index.html；dist 未构建时给占位页）
 *   2) GET  /api/health                         → 探活：{ok,port,pid,projects:[id],hooksInstalled,...}
 *   3) GET  /api/projects                       → 读 registry + 每个 board 派生摘要（读时算，不落盘 R9a）
 *   4) GET  /api/board/:projectId               → 返回该项目 board.json 全量
 *   5) GET  /api/doc?projectId=&path=           → 读文档文本；path 必过 safePath，逃逸/非法 403（R4）
 *   6) POST /api/decide/:projectId/:taskId      → 转发 execFile 调 cli decide（board 仍只被 CLI 写 R6）
 *   7) GET  /api/stream                         → SSE：mtime 轮询驱动的 board:changed 广播（R7，禁 fs.watch）
 *
 * 铁律（对齐实施方案第七节风险登记册）：
 *   - 零依赖：只用 Node 内置（http/fs/path/url/child_process/crypto）+ 本仓 core/*（同为零依赖）。
 *   - 写 board 唯一通道 = CLI：server 只经 execFile + 数组传参调 cli decide（防注入），绝不自写 board（R6）。
 *   - 路径安全：/api/doc 按用户输入拼路径一律走 core/safePath.resolveInsideRoot（realpath + path.relative，非 startsWith）（R4）。
 *   - 实时：mtime 轮询（1–2s）驱动 SSE，禁 fs.watch；SSE 断开必清 subscriber + 15s 心跳保活（R7）。
 *   - 单实例：启动先探 /api/health，已在跑则复用 + 开浏览器；端口 6060 起自增；绑 127.0.0.1（R9d）。
 *
 * 用法：node server/server.cjs
 *   环境变量：DASHBOARD_PORT=6060 起始端口 | DASHBOARD_NO_OPEN=1 不开浏览器 |
 *             DASHBOARD_POLL_MS=1500 轮询间隔 | DASHBOARD_REGISTRY=<path> 覆盖 registry（测试隔离用）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { execFile } = require('child_process');

const { resolveProject, readRegistry, REGISTRY_PATH } = require('../core/resolveProject.cjs');
const { resolveInsideRoot } = require('../core/safePath.cjs');

// ============ 常量 ============

const SERVICE = 'claude-dashboard';           // 单实例探测的服务签名
const VERSION = '1.0';

const DASH_ROOT = path.resolve(__dirname, '..');            // ~/.claude/dashboard
const DIST_DIR = path.join(DASH_ROOT, 'web', 'dist');        // 前端生产产物（批次7产出，未必已存在）
const CLI_INDEX = path.join(DASH_ROOT, 'cli', 'index.cjs');  // CLI 入口（唯一写者）
// registry 可被环境变量覆盖，方便测试隔离（不碰真实 registry / A 股主仓）
const REGISTRY = process.env.DASHBOARD_REGISTRY ? path.resolve(process.env.DASHBOARD_REGISTRY) : REGISTRY_PATH;

const PORT_BASE = parseInt(process.env.DASHBOARD_PORT || '6060', 10);
const PORT_RANGE = 20;                          // 6060 ~ 6079 依次尝试
const POLL_MS = Math.max(500, parseInt(process.env.DASHBOARD_POLL_MS || '1500', 10)); // mtime 轮询间隔
const HEARTBEAT_MS = 15000;                     // SSE 心跳
const BODY_MAX = 256 * 1024;                    // POST 体上限，防滥用
const DECIDE_TIMEOUT_MS = 15000;                // execFile 调 CLI 超时

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
};

// ============ 运行时状态 ============

const state = {
  actualPort: null,
  startedAt: Date.now(),
  subscribers: new Set(),   // SSE clients（res 对象）
  mtimes: new Map(),        // projectId → board.json 上次 mtimeMs（null=文件缺失）
};

// ============ 通用工具 ============

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(body);
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, { 'content-type': contentType || 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(text);
}

/** decodeURIComponent 遇畸形 % 序列会抛，包一层返回 null */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_) { return null; }
}

/** 读 registry，出错返回空表（server 只读，绝不因坏 registry 崩） */
function readRegistrySafe() {
  try { return readRegistry(REGISTRY); }
  catch (_) { return { schemaVersion: '1.0', projects: {} }; }
}

/** 解析 project，出错返回 null（未注册 / 路径异常都当"无此项目"处理） */
function resolveProjectSafe(id) {
  try { return resolveProject(id, { registryPath: REGISTRY }); }
  catch (_) { return null; }
}

/** 读 board.json：ENOENT → null；解析失败 → 抛（调用方决定 404 还是 500） */
function readBoardFile(boardPath) {
  let raw;
  try { raw = fs.readFileSync(boardPath, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(raw);
}

/** 从 board 派生摘要（读时算、不落盘 R9a）；done 口径对齐 CLI deriveStats（只数"已完工"） */
function deriveSummary(board) {
  const tasks = (board && board.tasks) || [];
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  const total = tasks.length;
  const done = byStatus['已完工'] || 0;
  const progress = total ? Math.round((done / total) * 100) : 0;
  let pendingCount = 0;
  for (const t of tasks) for (const d of (t.decisions || [])) {
    if (d && (d.answer === null || d.answer === undefined)) pendingCount++;
  }
  let lastActivityTs = null;
  for (const a of ((board && board.activity) || [])) {
    if (a && a.ts && (lastActivityTs === null || a.ts > lastActivityTs)) lastActivityTs = a.ts;
  }
  return { total, byStatus, progress, pendingCount, lastActivityTs };
}

/**
 * 尽力探测各项目的同步 git hook 是否已安装（health 的可选字段 hooksInstalled）。
 * 判据：主仓 .git/hooks/post-commit 存在且内容含 "dashboard" 标记。任何异常都当 false，绝不抛。
 */
function hooksInstalledMap(projects) {
  const out = {};
  for (const id of projects) {
    let installed = false;
    try {
      const proj = resolveProjectSafe(id);
      if (proj) {
        const hook = path.join(proj.mainRepo, '.git', 'hooks', 'post-commit');
        const txt = fs.readFileSync(hook, 'utf8');
        installed = /dashboard/i.test(txt);
      }
    } catch (_) { installed = false; }
    out[id] = installed;
  }
  return out;
}

// ============ SSE ============

function sseWrite(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); return true; }
  catch (_) { return false; }
}

/** 向所有 SSE 订阅者广播；写失败的连接顺手清理 */
function broadcast(event, data) {
  for (const res of state.subscribers) {
    if (!sseWrite(res, event, data)) state.subscribers.delete(res);
  }
}

function handleStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // 首个事件：hello（带当前项目列表，前端可据此立即拉一遍）
  sseWrite(res, 'hello', { ts: Date.now(), pid: process.pid, projects: Object.keys(readRegistrySafe().projects || {}) });
  state.subscribers.add(res);

  // 断开清理：close / error / aborted 都归位，Set.delete 幂等（重复删无副作用）
  const cleanup = () => { state.subscribers.delete(res); };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// ============ mtime 轮询（驱动 SSE，禁 fs.watch —— R7） ============

/**
 * 扫各项目 board.json 的 mtime，与上次比对，变了就广播 board:changed{projectId,mtime}。
 * 首次见到某项目只记基线不广播（避免启动瞬间刷一波）。全程 try/catch，绝不让定时器崩。
 */
function pollBoards() {
  let reg;
  try { reg = readRegistrySafe(); } catch (_) { return; }
  const ids = Object.keys(reg.projects || {});
  for (const id of ids) {
    const proj = resolveProjectSafe(id);
    if (!proj) continue;
    let mtime = null;
    try { mtime = fs.statSync(proj.board).mtimeMs; }
    catch (e) { mtime = null; } // ENOENT 等 → 视为"无文件"
    if (!state.mtimes.has(id)) { state.mtimes.set(id, mtime); continue; } // 基线，不广播
    if (state.mtimes.get(id) !== mtime) {
      state.mtimes.set(id, mtime);
      broadcast('board:changed', { projectId: id, mtime });
    }
  }
}

// ============ API 处理 ============

function handleHealth(req, res) {
  const projects = Object.keys(readRegistrySafe().projects || {});
  sendJson(res, 200, {
    ok: true,
    service: SERVICE,
    version: VERSION,
    port: state.actualPort,
    pid: process.pid,
    uptimeMs: Date.now() - state.startedAt,
    projects,
    hooksInstalled: hooksInstalledMap(projects),
    sseSubscribers: state.subscribers.size,
    distBuilt: fs.existsSync(path.join(DIST_DIR, 'index.html')),
  });
}

function handleProjects(req, res) {
  const reg = readRegistrySafe();
  const entries = reg.projects || {};
  const list = [];
  for (const id of Object.keys(entries)) {
    const proj = resolveProjectSafe(id);
    const name = (entries[id] && entries[id].name) || (proj && proj.name) || id;
    if (!proj) { list.push({ id, name, summary: emptySummary(), error: '项目解析失败' }); continue; }
    let board;
    try { board = readBoardFile(proj.board); }
    catch (_) { list.push({ id, name, summary: emptySummary(), error: 'board.json 解析失败' }); continue; }
    if (!board) { list.push({ id, name, summary: emptySummary(), error: 'board.json 不存在' }); continue; }
    list.push({ id, name, summary: deriveSummary(board) });
  }
  sendJson(res, 200, { ok: true, projects: list });
}

function emptySummary() {
  return { total: 0, byStatus: {}, progress: 0, pendingCount: 0, lastActivityTs: null };
}

function handleBoard(req, res, projectId) {
  if (!projectId) return sendJson(res, 400, { ok: false, error: '缺 projectId' });
  const proj = resolveProjectSafe(projectId);
  if (!proj) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
  let board;
  try { board = readBoardFile(proj.board); }
  catch (e) { return sendJson(res, 500, { ok: false, error: `board.json 解析失败：${e.message}` }); }
  if (!board) return sendJson(res, 404, { ok: false, error: 'board.json 尚不存在（该项目还未建 board）' });
  sendJson(res, 200, board);
}

function handleDoc(req, res, query) {
  const projectId = query.projectId;
  const relPath = query.path;
  if (!projectId || typeof projectId !== 'string') return sendJson(res, 400, { ok: false, error: '缺 projectId' });
  if (!relPath || typeof relPath !== 'string') return sendJson(res, 400, { ok: false, error: '缺 path' });
  const proj = resolveProjectSafe(projectId);
  if (!proj) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
  // 白名单根 = 项目 docsRoot（未配则回落主仓）；resolveInsideRoot 用 realpath+path.relative 判逃逸，
  // 能挡住 ../x 穿越，也能识破 junction 指向根外（R4）。逃逸/非法一律 403。
  const full = resolveInsideRoot(proj.docsRoot, relPath);
  if (!full) return sendJson(res, 403, { ok: false, error: '非法路径（越界或含非法字符）' });
  fs.readFile(full, 'utf8', (err, text) => {
    if (err) {
      if (err.code === 'ENOENT') return sendJson(res, 404, { ok: false, error: '文档不存在' });
      if (err.code === 'EISDIR') return sendJson(res, 400, { ok: false, error: '路径是目录不是文件' });
      return sendJson(res, 500, { ok: false, error: err.message });
    }
    sendText(res, 200, text, 'text/plain; charset=utf-8');
  });
}

/** 读 POST 体（带上限），回调 (err, string) */
function readBody(req, maxBytes, cb) {
  let size = 0; const chunks = []; let done = false;
  const finish = (err, data) => { if (done) return; done = true; cb(err, data); };
  req.on('data', (c) => {
    size += c.length;
    if (size > maxBytes) { finish(new Error('请求体过大')); try { req.destroy(); } catch (_) {} return; }
    chunks.push(c);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', (e) => finish(e));
}

function handleDecide(req, res, projectId, taskId) {
  if (!projectId || !taskId) return sendJson(res, 400, { ok: false, error: '缺 projectId 或 taskId' });
  readBody(req, BODY_MAX, (err, raw) => {
    if (err) return sendJson(res, 413, { ok: false, error: err.message });
    let body;
    try { body = raw ? JSON.parse(raw) : {}; }
    catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }

    const did = typeof body.did === 'string' ? body.did.trim() : '';
    const answer = typeof body.answer === 'string' ? body.answer : '';
    const author = (typeof body.author === 'string' && body.author.trim()) ? body.author.trim() : '看板';
    if (!did) return sendJson(res, 400, { ok: false, error: '缺 did（要拍板的 decision id）' });
    if (!answer) return sendJson(res, 400, { ok: false, error: '缺 answer（选中的答案）' });

    // board 仍只被 CLI 写：这里只经 execFile + 数组传参转发（无 shell、参数不拼串 → 防注入 R6）。
    const args = [CLI_INDEX, 'decide', '--project', projectId, taskId,
      '--did', did, '--answer', answer, '--author', author, '--json'];
    if (REGISTRY !== REGISTRY_PATH) { args.push('--registry', REGISTRY); } // 测试隔离时透传
    execFile(process.execPath, args, {
      cwd: DASH_ROOT, timeout: DECIDE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    }, (e, stdout, stderr) => {
      if (e) {
        // 退出码是数字 → CLI 跑了但拒绝（多为答案非法等用户错）→ 400；否则（spawn 失败/超时）→ 500
        const isCliReject = typeof e.code === 'number';
        const msg = (String(stderr || '').trim()) || e.message || 'decide 失败';
        return sendJson(res, isCliReject ? 400 : 500, { ok: false, error: msg });
      }
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch (_) { return sendJson(res, 500, { ok: false, error: 'CLI 输出非 JSON', raw: String(stdout).slice(0, 500) }); }
      // 写成功 → 立刻扫一遍 mtime 广播 board:changed，前端秒级刷新（不必等下一个轮询周期）
      try { pollBoards(); } catch (_) {}
      sendJson(res, 200, parsed);
    });
  });
}

// ============ 静态托管（web/dist + SPA 回退） ============

function streamFile(res, fullPath, status) {
  const ext = path.extname(fullPath).toLowerCase();
  res.writeHead(status || 200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  const stream = fs.createReadStream(fullPath);
  stream.on('error', () => { try { res.destroy(); } catch (_) {} });
  stream.pipe(res);
}

/** dist 未构建时的占位页：让 API 先可用、并提示怎么把前端 build 出来 */
function sendPlaceholder(res, status) {
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>项目管理看板</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:720px;margin:8vh auto;padding:0 24px;color:#222;line-height:1.7}
code{background:#f2f2f2;padding:2px 6px;border-radius:4px}a{color:#2563eb}h1{font-size:20px}</style>
<h1>项目管理看板 · 服务已就绪</h1>
<p>后端 API 正在运行，但前端界面（<code>web/dist</code>）还没构建。</p>
<p>构建前端：<code>cd ~/.claude/dashboard &amp;&amp; npm install &amp;&amp; npm run build</code>，然后刷新本页。</p>
<p>API 自测入口：
<a href="/api/health">/api/health</a> ·
<a href="/api/projects">/api/projects</a></p>`;
  sendText(res, status || 200, html, 'text/html; charset=utf-8');
}

function serveStatic(req, res, pathname) {
  const decoded = safeDecode(pathname);
  if (decoded === null) return sendJson(res, 400, { ok: false, error: '非法 URL 编码' });
  let rel = decoded;
  if (rel === '/' || rel === '') rel = '/index.html';

  const full = resolveInsideRoot(DIST_DIR, rel); // dist 是自家内容，仍做穿越防护（纵深防御）
  if (!full) return sendJson(res, 400, { ok: false, error: '非法路径' });

  fs.stat(full, (err, st) => {
    if (!err && st.isFile()) return streamFile(res, full);
    // 命中不到文件：带扩展名的当资源缺失 → 404；无扩展名的当前端路由 → 回退 index.html（SPA）
    const looksLikeAsset = path.extname(rel) !== '' && rel !== '/index.html';
    if (looksLikeAsset) return sendText(res, 404, `404 Not Found: ${rel}`);
    const indexPath = path.join(DIST_DIR, 'index.html');
    fs.stat(indexPath, (e2, s2) => {
      if (!e2 && s2.isFile()) return streamFile(res, indexPath, 200);
      return sendPlaceholder(res, 200); // dist 尚未构建
    });
  });
}

// ============ 主入口：路由 ============

const server = http.createServer((req, res) => {
  let parsed;
  try { parsed = url.parse(req.url, true); }
  catch (_) { return sendJson(res, 400, { ok: false, error: '非法 URL' }); }
  const pathname = parsed.pathname || '/';

  try {
    if (pathname.startsWith('/api/')) {
      // 拆分并逐段解码路径参数（project id / task id 可能含非 ASCII）
      const rawSegs = pathname.split('/').filter(Boolean); // ['api','board','game']
      const segs = rawSegs.map(safeDecode);
      if (segs.some((s) => s === null)) return sendJson(res, 400, { ok: false, error: '非法 URL 编码' });
      const sub = segs[1];

      if (sub === 'health' && req.method === 'GET') return handleHealth(req, res);
      if (sub === 'projects' && req.method === 'GET') return handleProjects(req, res);
      if (sub === 'stream' && req.method === 'GET') return handleStream(req, res);
      if (sub === 'doc' && req.method === 'GET') return handleDoc(req, res, parsed.query || {});
      if (sub === 'board' && req.method === 'GET') return handleBoard(req, res, segs[2]);
      if (sub === 'decide' && req.method === 'POST') return handleDecide(req, res, segs[2], segs[3]);

      return sendJson(res, 404, { ok: false, error: `未知 API 或方法不匹配：${req.method} ${pathname}` });
    }
    // 非 /api → 静态（仅 GET/HEAD）
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: '仅支持 GET' });
    return serveStatic(req, res, pathname);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: '服务器内部错误：' + (e && e.message) });
  }
});

// ============ 单实例 + 端口自增 + 开浏览器（R9d） ============

/** 探一个端口是否是"我们的"看板 server；是则返回 health 对象，否则 null */
function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 500 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
  });
}

/** 在端口区间里找已在跑的"我们的"实例，返回其端口；没有则 null */
async function findExistingInstance() {
  for (let p = PORT_BASE; p <= PORT_BASE + PORT_RANGE; p++) {
    const h = await probeHealth(p);
    if (h && h.service === SERVICE) return p;
  }
  return null;
}

function openBrowser(targetUrl) {
  if (process.env.DASHBOARD_NO_OPEN === '1') return;
  try {
    const { spawn } = require('child_process');
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', targetUrl], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [targetUrl], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [targetUrl], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (_) { /* 开不了浏览器不算错，用户手动访问即可 */ }
}

function startIntervals() {
  const poll = setInterval(() => { try { pollBoards(); } catch (_) {} }, POLL_MS);
  const beat = setInterval(() => broadcast('ping', { ts: Date.now() }), HEARTBEAT_MS);
  poll.unref(); beat.unref(); // 别因定时器卡住进程退出
}

function tryListen(port, attemptsLeft) {
  server.removeAllListeners('error');
  server.listen(port, '127.0.0.1');
  server.once('listening', () => {
    state.actualPort = port;
    const localUrl = `http://127.0.0.1:${port}/`;
    console.log('\n================================================');
    console.log('项目管理看板 · 已启动');
    console.log(`  本地地址：${localUrl}`);
    console.log(`  PID：${process.pid}`);
    console.log(`  看板根目录：${DASH_ROOT}`);
    console.log(`  registry：${REGISTRY}`);
    console.log('================================================');
    console.log('浏览器应已自动打开；未打开请手动访问上面地址。按 Ctrl+C 关闭。\n');
    pollBoards();       // 立即建立 mtime 基线
    startIntervals();   // 启动轮询 + 心跳
    openBrowser(localUrl);
  });
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`端口 ${port} 被占用，尝试 ${port + 1} ...`);
      setTimeout(() => tryListen(port + 1, attemptsLeft - 1), 50);
    } else {
      console.error(`\n[致命] 无法启动服务：${err && (err.message || err)}`);
      console.error(`已尝试端口 ${PORT_BASE} ~ ${PORT_BASE + PORT_RANGE}。可用 DASHBOARD_PORT 指定其它起始端口。\n`);
      process.exit(1);
    }
  });
}

function main() {
  findExistingInstance().then((existingPort) => {
    if (existingPort !== null) {
      const localUrl = `http://127.0.0.1:${existingPort}/`;
      console.log(`检测到看板已在运行（端口 ${existingPort}），复用该实例并打开浏览器。`);
      openBrowser(localUrl);
      process.exit(0);
    }
    tryListen(PORT_BASE, PORT_RANGE);
  });
}

// 局部请求出错不该拖垮整个本地服务（各请求/回调已各自兜底，这里是最后一道网）
process.on('uncaughtException', (e) => { console.error('[uncaught]', e && (e.stack || e.message || e)); });

main();
