'use strict';
/**
 * server/server.cjs —— 多项目看板 · 零依赖本地 HTTP + SSE 服务
 *
 * 职责（只读展示 + 唯一写通道转发，绝不自写 board）：
 *   1) 静态托管 web/dist/（生产构建产物；SPA 路由回退 index.html；dist 未构建时给占位页）
 *   2) GET  /api/health                         → 探活：{ok,port,pid,projects:[id],hooksInstalled,...}
 *   3) GET  /api/projects                       → 读 registry + 每个 board 派生摘要（读时算，不落盘 R9a）
 *   4) GET  /api/board/:projectId               → 按需返回任务/活动，活动含月度归档；支持 ETag
 *      GET  /api/activity/:projectId            → 合并活动的倒序游标分页
 *   5) GET  /api/doc?projectId=&path=           → 读文档文本；path 必过 safePath，逃逸/非法 403（R4）
 *   6) POST /api/decide/:projectId/:taskId      → 转发 execFile 调 cli decide（board 仍只被 CLI 写 R6）
 *      POST /api/task/:projectId/:taskId/:action → 留言、暂缓、复工、作废、重开、要求补齐信息
 *   7) GET  /api/stream                         → SSE：mtime 轮询驱动的 board:changed 广播（R7，禁 fs.watch）
 *
 * 铁律（对齐实施方案第七节风险登记册）：
 *   - 零依赖：只用 Node 内置（http/fs/path/url/child_process/crypto）+ 本仓 core/*（同为零依赖）。
 *   - 写 board 唯一通道 = CLI：server 只经 execFile + 数组传参调语义命令（防注入），绝不自写 board（R6）。
 *   - 路径安全：/api/doc 按用户输入拼路径一律走 core/safePath.resolveInsideRoot（realpath + path.relative，非 startsWith）（R4）。
 *   - 实时：mtime 轮询（1–2s）驱动 SSE，禁 fs.watch；SSE 断开必清 subscriber + 15s 心跳保活（R7）。
 *   - 单实例：启动先探 /api/health；在跑的和这份是同一份代码则复用 + 开浏览器，
 *     不是同一份则关掉旧的接管同一端口（SERVER-RUNS-ON-LIVE-CHECKOUT d2=A）；绑 127.0.0.1（R9d）。
 *   - 同源校验：非 GET/HEAD 一律先查 Host∈{127.0.0.1,localhost}:实际端口 且 Origin 为空或同源，
 *     否则 403，防任意网页拿简单 POST 悄悄打写接口（AUD-SEC-ORIGIN-CHECK）。
 *
 * 【这份代码从哪来】(SERVER-RUNS-ON-LIVE-CHECKOUT，负责人 0906 拍板)
 *   负责人日常用的服务由 启动看板.bat / dashboard.sh 从【发布副本】起（mode=release，端口 6060 段）；
 *   从 git 检出直接起的是开发实例（mode=dev，端口 6070 段，health 里明写），两者互不干扰。
 *   服务是常驻进程：合进主干 + `cli release` 之后，得等下次启动才换新——所以启动时要比对版本、该换就换。
 *
 * 用法：node server/server.cjs
 *   环境变量：DASHBOARD_PORT=<起始端口>（默认 release 6060 / dev 6070）| DASHBOARD_NO_OPEN=1 不开浏览器 |
 *             DASHBOARD_NO_RESTART=1 版本不对也不换新（复用旧实例并提醒）|
 *             DASHBOARD_POLL_MS=1500 轮询间隔 | DASHBOARD_REGISTRY=<path> 覆盖 registry（测试隔离用）
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { createHash } = require('node:crypto');
const { execFile } = require('child_process');

const { resolveProject, readRegistry, REGISTRY_PATH, DASHBOARD_HOME } = require('../core/resolveProject.cjs');
const { readStamp, runtimeMode, displayCliCommand } = require('../core/runtimeRoot.cjs');
const { resolveInsideRoot } = require('../core/safePath.cjs');
const { VOID_STATUSES } = require('../core/boardSchema.cjs');
const { isUnlanded } = require('../core/decisionLanding.cjs');
const { buildTaskDispatchPrompt, shortTrigger } = require('../cli/dispatchPrompt.cjs');
const cpuBudget = require('../core/cpuBudget.cjs');
const costUsage = require('../core/costUsage.cjs');
const { createCodexApi } = require('./codexApi.cjs');
const { createReaderApi } = require('./readerApi.cjs');
const { buildParallelPlan } = require('./parallelPlan.cjs');
const { hookInstalledFor } = require('../core/hookProbe.cjs');
const { readSettings, writeSettings, normalizeWebhookEvents, MODULE_IDS, normalizeModules, resolveModules } = require('../core/settings.cjs');

// ============ 常量 ============

const SERVICE = 'claude-dashboard';           // 单实例探测的服务签名
const VERSION = '1.0';

const DASH_ROOT = path.resolve(__dirname, '..');            // 这份代码的家（发布副本 / 主工位检出 / 安装目录）
const DIST_DIR = path.join(DASH_ROOT, 'web', 'dist');        // 前端生产产物（批次7产出，未必已存在）
const CLI_INDEX = path.join(DASH_ROOT, 'cli', 'index.cjs');  // CLI 入口（唯一写者）
// registry 可被环境变量覆盖，方便测试隔离（不碰真实 registry / 示例项目·模拟器主仓）
const REGISTRY = process.env.DASHBOARD_REGISTRY ? path.resolve(process.env.DASHBOARD_REGISTRY) : REGISTRY_PATH;
const WEBHOOK_URL = (process.env.DASHBOARD_EVENT_WEBHOOK || '').trim();
const WEBHOOK_CONFIGURED = /^https?:\/\//.test(WEBHOOK_URL);

// —— 我是哪份代码（SERVER-RUNS-ON-LIVE-CHECKOUT）——
// 负责人日常用的服务必须从【发布副本】起（mode=release）；从 git 检出起的一律算开发实例（mode=dev），
// 换个端口段、health 里明写，绝不和负责人在用的那份抢同一个位置。
const MODE = runtimeMode(DASH_ROOT);
const STAMP = readStamp(DASH_ROOT);
const RELEASE_COMMIT = (STAMP && STAMP.commit) || null;
const RELEASED_AT = (STAMP && STAMP.releasedAt) || null;

// 端口段按身份分开且【不重叠】：release 6060~6068、dev 6070~6078。
// 重叠会出事——起 release 时扫到 6070 上的开发实例，会把人家当"版本不对的旧实例"杀掉。
const DEFAULT_PORT_BASE = MODE === 'dev' ? 6070 : 6060;
const PORT_BASE = parseInt(process.env.DASHBOARD_PORT || String(DEFAULT_PORT_BASE), 10);
const PORT_RANGE = 8;
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
  webhookCursor: new Map(), // projectId → 已处理活动的最大 ISO ts（含失败与未勾选的活动）
  webhookSending: new Map(), // 同项目串行发送；只合并期间的变更标记，不保存重试队列
};

// 路径只保留最新版本；摘要/合并缓存限制项目数，避免长驻服务积攒旧板。
const summaryCache = new Map();
const archiveCache = new Map();
const mergedBoardCache = new Map();
const BOARD_CACHE_LIMIT = 50;

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

/**
 * 同源校验（AUD-SEC-ORIGIN-CHECK）：GET/HEAD 之外一律先过这道闸。
 * 治的病：各写接口 handler 原先直接 `JSON.parse(raw)`，不看 Origin/Host——任意网页用
 * text/plain 简单 POST（不触发预检）就能悄悄打 /api/decide（替用户拍板）、
 * /api/dispatch-task（本机弹终端跑 claude）、/api/cpu，本机等价于被跨站 CSRF。
 * Host 头必须命中本进程实际监听的 127.0.0.1:<port> 或 localhost:<port>；
 * Origin 头缺失（非浏览器直连，如本机脚本/curl/CLI 自身）视为同源放行，
 * 一旦存在就必须与 Host 完全同源，否则一律拒绝——不对任何一侧法外开恩。
 */
function isSameOriginRequest(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const port = state.actualPort;
  const host = String(req.headers.host || '').toLowerCase();
  const validHosts = port ? [`127.0.0.1:${port}`, `localhost:${port}`] : [];
  if (!validHosts.includes(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return String(origin).toLowerCase() === `http://${host}`;
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

/**
 * 派单开出来的新对话应该站在哪个文件夹里 =「代码的家」codeRepo。
 *
 * 治的病：原先三个派单入口各写一遍 `proj.mainRepo`，而 mainRepo 是「板的家」。
 * 板可自成一家（cluster：板在 F:\board-repo，卡改的代码全在 F:\code-repo），
 * 此时派出去的对话落在一个非 git 仓、没有 CLAUDE.md 的空壳目录里——协议锚、
 * git 认领闸门、开工三查全部失效，对话等于站在空地上开工
 * （SERVER-GIT-CWD-USES-MAINREPO，2026-09-06）。
 *
 * 回落规则（没写 codeRepo 就用 mainRepo）只认 resolveProject 那一处：三个 handler
 * 各写一遍 `|| mainRepo`，正是拆 codeRepo 字段要消灭的漂移。
 * @returns {string|null} 落脚目录；项目解析不出时返回 null（调用方须据此拒绝派单，
 *   绝不能把 undefined 交给 spawn —— 那会静默落到 server 自己的 cwd 上）。
 */
function dispatchCwd(pid) {
  const proj = resolveProjectSafe(pid);
  return proj ? proj.codeRepo : null;
}

/**
 * Codex 面板落脚的仓（工单 cwd + `.codex/jobs` 台账根）——同样是「代码的家」codeRepo。
 *
 * 按显式项目参数解析，不按服务 cwd 或固定项目猜测；与普通派单共用同一处回落规则。
 * @returns {string|null} 代码仓绝对路径；缺参或项目未注册时 null，不许拿去 spawn。
 */
function codexRepo(projectId) {
  return dispatchCwd(projectId);
}

/** 读 board.json：ENOENT → null；解析失败 → 抛（调用方决定 404 还是 500） */
function readBoardFile(boardPath) {
  let raw;
  try { raw = fs.readFileSync(boardPath, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(raw);
}

function rememberBoard(cache, boardPath, entry) {
  cache.delete(boardPath);
  cache.set(boardPath, entry);
  if (cache.size > BOARD_CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return entry;
}

/** 摘要只由板内数据派生，归档不改变项目清单现有口径。 */
function readSummaryCached(boardPath) {
  let stat;
  try { stat = fs.statSync(boardPath); }
  catch (e) { if (e.code === 'ENOENT') { summaryCache.delete(boardPath); return null; } throw e; }
  const cached = summaryCache.get(boardPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.summary;
  const board = readBoardFile(boardPath);
  if (!board) return null;
  const summary = deriveSummary(board);
  rememberBoard(summaryCache, boardPath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
  return summary;
}

/** 仅枚举文件和 stat；条件请求命中时不读取 board/归档内容。文件名也参与版本，覆盖新增/删除。 */
function activitySnapshot(boardPath) {
  let boardStat;
  try { boardStat = fs.statSync(boardPath); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const dir = path.dirname(boardPath);
  const archives = fs.readdirSync(dir).filter((name) => /^activity-\d{6}\.json$/.test(name)).sort()
    .map((name) => {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      return { file, mtimeMs: stat.mtimeMs, size: stat.size };
    });
  const version = JSON.stringify([
    [boardPath, boardStat.mtimeMs, boardStat.size],
    ...archives.map((a) => [a.file, a.mtimeMs, a.size]),
  ]);
  return { archives, version };
}

function readArchiveCached(info) {
  const cached = archiveCache.get(info.file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.items;
  const items = JSON.parse(fs.readFileSync(info.file, 'utf8'));
  if (!Array.isArray(items)) throw new Error(`归档应为 JSON 数组：${info.file}`);
  archiveCache.set(info.file, { mtimeMs: info.mtimeMs, size: info.size, items });
  return items;
}

function compareActivity(a, b) {
  return (Date.parse(a.ts) - Date.parse(b.ts)) || String(a.ts || '').localeCompare(String(b.ts || ''));
}

/** 先合并去重再排序；两条读接口共享结果，不能在响应裁剪时改动缓存数组。 */
function readMergedBoard(boardPath, snapshot) {
  const cached = mergedBoardCache.get(boardPath);
  if (cached && cached.version === snapshot.version) return cached.board;
  const board = readBoardFile(boardPath);
  if (!board) return null;
  const seen = new Set();
  const activity = [];
  for (const items of [board.activity || [], ...snapshot.archives.map(readArchiveCached)]) {
    for (const item of items) {
      const key = JSON.stringify([item.ts, item.taskId, item.text]);
      if (!seen.has(key)) { seen.add(key); activity.push(item); }
    }
  }
  activity.sort(compareActivity);
  const merged = { ...board, activity };
  rememberBoard(mergedBoardCache, boardPath, { version: snapshot.version, board: merged });
  return merged;
}

function replyNotModified(req, res, snapshot, endpoint, query) {
  const params = JSON.stringify(Object.keys(query).sort().map((key) => [key, query[key]]));
  const hash = createHash('sha1').update(snapshot.version + '|' + endpoint + '|' + params).digest('hex').slice(0, 16);
  const etag = `W/"${hash}"`;
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] !== etag) return false;
  res.writeHead(304, { 'cache-control': 'no-cache' });
  res.end();
  return true;
}

function positiveInteger(value, fallback) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n > 0 ? Math.min(n, Number.MAX_SAFE_INTEGER) : fallback;
}

/** 从 board 派生摘要（读时算、不落盘 R9a）；口径对齐 CLI deriveStats：只数"已完工"，分母剔掉作废卡 */
function deriveSummary(board) {
  const tasks = (board && board.tasks) || [];
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  const total = tasks.filter((t) => !VOID_STATUSES.includes(t.status)).length;
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
 * 判据：**codeRepo（代码的家）** 的 post-commit 存在且包含转发本项目 id 的同步块。
 * 认 codeRepo 不认 mainRepo：hook 挂在「提交发生的那个仓」上，板可自成一家
 * （cluster：板在 F:\board-repo、代码在 F:\code-repo）；去板那边找必然扑空、
 * 体检恒报「hook 未安装」（SERVER-GIT-CWD-USES-MAINREPO，与 cli/gitSync.cjs doctor 同口径）。
 * 多项目可共用代码仓，仅认 "dashboard" 字样会把其它项目的 hook 误判成本项目已装。
 * 任何异常都当 false，绝不抛。
 */
function hooksInstalledMap(projects) {
  const out = {};
  for (const id of projects) {
    let installed = false;
    try {
      const proj = resolveProjectSafe(id);
      if (proj) {
        installed = hookInstalledFor(proj.codeRepo, id);
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

/** 等待单次请求结束，不重试；超时、连接或响应失败只记一行，不暴露地址。 */
function postWebhook(payload) {
  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reason) console.warn(`[webhook] ${payload.project}/${payload.task} 推送失败：${reason}`);
      resolve();
    };
    try {
      const target = new URL(WEBHOOK_URL);
      const body = JSON.stringify(payload);
      const transport = target.protocol === 'https:' ? https : http;
      const request = transport.request(target, {
        method: 'POST', timeout: 3000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (response) => {
        response.once('error', () => finish('响应中断'));
        response.once('end', () => finish(response.statusCode >= 200 && response.statusCode < 300
          ? null : `接收方返回 ${response.statusCode}`));
        response.resume();
      });
      const timedOut = () => { finish('超过三秒'); request.destroy(); };
      request.once('timeout', timedOut);
      request.once('error', () => finish('连接不可用'));
      // 总时限也覆盖尚未连接的阶段，不能让 DNS 或握手拖住未完成的请求。
      timer = setTimeout(timedOut, 3000);
      timer.unref();
      request.end(body);
    } catch (_) { finish('地址或请求不可用'); }
  });
}

/** 初见项目只记基线；按活动时间发本轮新增消息，最多 20 条，失败和溢出都不补发。 */
async function notifyWebhook(id) {
  if (!WEBHOOK_CONFIGURED) return;
  const sending = state.webhookSending.get(id);
  if (sending) { sending.changed = true; return; }
  const batch = { changed: false };
  state.webhookSending.set(id, batch);
  let latest;
  try {
    const project = resolveProjectSafe(id);
    if (!project) return;
    const board = readBoardFile(project.board);
    if (!board) return;
    const activity = (Array.isArray(board.activity) ? board.activity : [])
      .filter((entry) => entry && typeof entry.ts === 'string');
    latest = activity.reduce((max, entry) => entry.ts > max ? entry.ts : max, '');
    if (!state.webhookCursor.has(id)) return;
    const cursor = state.webhookCursor.get(id);
    const events = normalizeWebhookEvents(readSettings().webhookEvents);
    const fresh = activity.filter((entry) => entry.ts > cursor
      && ['done', 'pending', 'block'].includes(entry.type) && events[entry.type])
      .sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
    if (fresh.length > 20) console.warn(`[webhook] 项目 ${id} 本轮超过 20 条，丢弃 ${fresh.length - 20} 条`);
    const tasks = Array.isArray(board.tasks) ? board.tasks : [];
    for (const entry of fresh.slice(0, 20)) {
      const task = tasks.find((candidate) => candidate.id === entry.taskId);
      await postWebhook({
        event: entry.type, project: id, projectName: board.project?.name || project.name,
        task: entry.taskId, title: task?.plainTitle || task?.title || '', status: task?.status || '', ts: entry.ts,
      });
    }
  } catch (_) { console.warn(`[webhook] 项目 ${id} 的活动读取或推送失败`); }
  finally {
    // 无论请求成败都推进游标；发送期间有新变更时只读一次最新板，不补发本批消息。
    if (latest !== undefined) state.webhookCursor.set(id, latest);
    state.webhookSending.delete(id);
    if (batch.changed) void notifyWebhook(id);
  }
}

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
    if (!state.mtimes.has(id)) {
      state.mtimes.set(id, mtime);
      void notifyWebhook(id); // 同时建立活动基线，下一次变动才会推送。
      continue;
    }
    if (state.mtimes.get(id) !== mtime) {
      state.mtimes.set(id, mtime);
      broadcast('board:changed', { projectId: id, mtime });
      void notifyWebhook(id);
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
    webhook: { configured: WEBHOOK_CONFIGURED, events: normalizeWebhookEvents(readSettings().webhookEvents) },
    modules: resolveModules(),
    // 报家门（SERVER-RUNS-ON-LIVE-CHECKOUT）：谁都能一眼看出"在跑的是哪份代码、哪个提交"，
    // 启动器据此判断要不要换新，体检据此提醒"合了主干还没生效"。
    mode: MODE,
    codeRoot: DASH_ROOT,
    releaseCommit: RELEASE_COMMIT,
    releasedAt: RELEASED_AT,
  });
}

function handleProjects(req, res) {
  const reg = readRegistrySafe();
  const entries = reg.projects || {};
  const list = [];
  for (const id of Object.keys(entries)) {
    const proj = resolveProjectSafe(id);
    const entry = entries[id] || {};
    const name = entry.name || (proj && proj.name) || id;
    const item = { id, name };
    if (typeof entry.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(entry.color)) item.color = entry.color;
    if (typeof entry.icon === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(entry.icon)) item.icon = entry.icon;
    if (!proj) { list.push({ ...item, summary: emptySummary(), error: '项目解析失败' }); continue; }
    let summary;
    try { summary = readSummaryCached(proj.board); }
    catch (_) { list.push({ ...item, summary: emptySummary(), error: 'board.json 解析失败' }); continue; }
    if (!summary) { list.push({ ...item, summary: emptySummary(), error: 'board.json 不存在' }); continue; }
    list.push({ ...item, summary });
  }
  sendJson(res, 200, { ok: true, projects: list });
}

function emptySummary() {
  return { total: 0, byStatus: {}, progress: 0, pendingCount: 0, lastActivityTs: null };
}

function handleBoard(req, res, projectId, query = {}) {
  if (!projectId) return sendJson(res, 400, { ok: false, error: '缺 projectId' });
  const proj = resolveProjectSafe(projectId);
  if (!proj) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
  try {
    const snapshot = activitySnapshot(proj.board);
    if (!snapshot) return sendJson(res, 404, { ok: false, error: 'board.json 尚不存在（该项目还未建 board）' });
    if (replyNotModified(req, res, snapshot, 'board', query)) return;
    const fields = ['tasks', 'activity', 'all'].includes(query.fields) ? query.fields : 'all';
    const board = fields === 'tasks' ? readBoardFile(proj.board) : readMergedBoard(proj.board, snapshot);
    if (!board) return sendJson(res, 404, { ok: false, error: 'board.json 尚不存在（该项目还未建 board）' });
    const limit = positiveInteger(query.activityLimit, 0);
    const activity = fields === 'tasks' ? [] : limit ? board.activity.slice(-limit) : board.activity;
    sendJson(res, 200, { ...board, tasks: fields === 'activity' ? [] : board.tasks, activity });
  } catch (e) {
    res.removeHeader('ETag');
    sendJson(res, 500, { ok: false, error: `board.json 或活动归档读取失败：${e.message}` });
  }
}

function handleActivity(req, res, projectId, query = {}) {
  if (!projectId) return sendJson(res, 400, { ok: false, error: '缺 projectId' });
  const proj = resolveProjectSafe(projectId);
  if (!proj) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
  const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;
  const before = query.before === undefined ? Infinity : Date.parse(query.before);
  if ((query.before !== undefined && (typeof query.before !== 'string' || !isoTime.test(query.before))) || Number.isNaN(before)) {
    return sendJson(res, 400, { ok: false, error: 'before 必须是 ISO 时间戳' });
  }
  const limit = Math.min(1000, positiveInteger(query.limit, 100));
  try {
    const snapshot = activitySnapshot(proj.board);
    if (!snapshot) return sendJson(res, 404, { ok: false, error: 'board.json 尚不存在（该项目还未建 board）' });
    if (replyNotModified(req, res, snapshot, 'activity', query)) return;
    const board = readMergedBoard(proj.board, snapshot);
    if (!board) return sendJson(res, 404, { ok: false, error: 'board.json 尚不存在（该项目还未建 board）' });
    const items = [];
    for (let i = board.activity.length - 1; i >= 0 && items.length < limit; i--) {
      const item = board.activity[i];
      if (before === Infinity || Date.parse(item.ts) < before) items.push(item);
    }
    sendJson(res, 200, { ok: true, items, nextBefore: items.length ? items[items.length - 1].ts : null });
  } catch (e) {
    res.removeHeader('ETag');
    sendJson(res, 500, { ok: false, error: `board.json 或活动归档读取失败：${e.message}` });
  }
}

/**
 * 可并行清单 —— 现在哪几张卡能同时派给不同对话去做。
 * 纯规则计算(依赖 / 施工占用 / 文件范围 / 卡号前缀),不调任何模型,零额度。
 */
function handleParallel(req, res, query) {
  const projectId = query.project;
  if (!projectId || typeof projectId !== 'string') return sendJson(res, 400, { ok: false, error: '缺 project' });
  const proj = resolveProjectSafe(projectId);
  if (!proj) return sendJson(res, 404, { ok: false, error: `未注册的项目「${projectId}」` });
  let board;
  try { board = readBoardFile(proj.board); }
  catch (e) { return sendJson(res, 500, { ok: false, error: `board.json 解析失败：${e.message}` }); }
  if (!board) return sendJson(res, 404, { ok: false, error: 'board.json 尚不存在' });
  try {
    sendJson(res, 200, Object.assign({ ok: true }, buildParallelPlan(board.tasks)));
  } catch (e) {
    sendJson(res, 500, { ok: false, error: '并行清单计算失败：' + e.message });
  }
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

/** 只允许保存推送事件和模块开关；推送地址始终来自环境变量。 */
function handleSettings(req, res) {
  readBody(req, BODY_MAX, (err, raw) => {
    if (err) return sendJson(res, 413, { ok: false, error: err.message });
    let body;
    try { body = JSON.parse(raw); }
    catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
    const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
    if (!isRecord(body) || !Object.keys(body).length
      || Object.keys(body).some((key) => !['webhookEvents', 'modules'].includes(key))) {
      return sendJson(res, 400, { ok: false, error: '只能保存 webhookEvents 或 modules，至少提供一项' });
    }
    if (Object.hasOwn(body, 'webhookEvents') && (!isRecord(body.webhookEvents) || Object.entries(body.webhookEvents)
        .some(([key, value]) => !['done', 'pending', 'block'].includes(key) || typeof value !== 'boolean'))) {
      return sendJson(res, 400, { ok: false, error: '只能保存完工、待拍板、阻塞三项开关，值必须是布尔值' });
    }
    if (Object.hasOwn(body, 'modules') && (!isRecord(body.modules) || Object.entries(body.modules)
      .some(([key, value]) => !MODULE_IDS.includes(key) || typeof value !== 'boolean'))) {
      return sendJson(res, 400, { ok: false, error: 'modules 只允许 codex、cost、cpu、reader 四项开关，值必须是布尔值' });
    }
    try {
      const patch = {};
      if (Object.hasOwn(body, 'webhookEvents')) patch.webhookEvents = normalizeWebhookEvents(body.webhookEvents);
      if (Object.hasOwn(body, 'modules')) patch.modules = { ...normalizeModules(readSettings().modules), ...body.modules };
      const settings = writeSettings(patch);
      return sendJson(res, 200, { ok: true, settings: {
        webhookEvents: normalizeWebhookEvents(settings.webhookEvents), modules: normalizeModules(settings.modules),
      } });
    } catch (_) { return sendJson(res, 500, { ok: false, error: '设置保存失败，请稍后再试' }); }
  });
}

const codexApi = createCodexApi({
  resolveRepo: codexRepo,
  readRegistry: readRegistrySafe,
  dashboardRoot: DASH_ROOT,
  sessionsRoot: process.env.DASHBOARD_CODEX_SESSIONS
    ? path.resolve(process.env.DASHBOARD_CODEX_SESSIONS) : undefined,
  readBody,
  sendJson,
  sendText,
  bodyMax: BODY_MAX,
});

// 审阅台(READER-INTO-BOARD):报告清单/正文/边注只读仓库文件,批注写数据根下的 data/reader 账本并镜像到卡 note。
const readerApi = createReaderApi({
  resolveProjectSafe,
  sendJson,
  readBody,
  bodyMax: BODY_MAX,
  dashRoot: DASH_ROOT,
  dataRoot: DASHBOARD_HOME,
  cliIndex: CLI_INDEX,
  registry: REGISTRY,
  registryPath: REGISTRY_PATH,
  pollBoards: () => pollBoards(),
});

/**
 * 本机算力账本快照(GET /api/cpu)。
 * 只读账本文件,不动任何进程;看板据此显示"当前谁占了多少核、还剩多少"。
 */
function handleCpuStatus(req, res) {
  try { return sendJson(res, 200, { ok: true, cpu: cpuBudget.cpuStatus() }); }
  catch (e) { return sendJson(res, 500, { ok: false, error: '读算力账本失败：' + (e && e.message) }); }
}

/**
 * 费用只认登记的对话目录；跨项目保留同址前缀，供聚合层暴露并列归属。
 * 只读解析，路径异常的其他项目逐个跳过，不能拖垮本项目的费用查询。
 * @returns {{prefixes:string[],otherPrefixes:string[]}|null} 未注册或本项目解析失败时 null。
 */
function costPrefixes(pid) {
  const proj = resolveProjectSafe(pid);
  if (!proj) return null;
  const prefixes = [...new Set(proj.costRoots.map(costUsage.mapRepoToPrefix))];
  const otherPrefixes = new Set();
  for (const otherPid of Object.keys(readRegistrySafe().projects || {})) {
    if (otherPid === pid) continue;
    const other = resolveProjectSafe(otherPid);
    if (!other) continue;
    for (const root of other.costRoots) otherPrefixes.add(costUsage.mapRepoToPrefix(root));
  }
  return { prefixes, otherPrefixes: [...otherPrefixes] };
}

/**
 * token 成本聚合(GET /api/cost?project=<id>&days=<n>)。
 * 读 ~/.claude/projects 下该项目(含其 worktree 目录)的对话流水,按天/按模型/主·子agent聚合;
 * 订阅套餐看不到美元,这里给的是本机流水里的真实 token 数(BOARD-COST-MONITOR,0901)。
 */
function handleCostUsage(req, res, query) {
  const pid = String(query.project || '');
  const proj = resolveProjectSafe(pid);
  const selected = costPrefixes(pid);
  if (!proj || !selected) return sendJson(res, 404, { ok: false, error: `未注册项目：${pid}` });
  const days = Math.max(1, Math.min(365, parseInt(query.days, 10) || 30));
  return Promise.all([
    costUsage.getUsage({ ...selected, days }),
    codexApi.getCostUsage(days, proj.name || pid),
  ])
    .then(([usage, codex]) => {
      const quota = codexApi.getQuota();
      const claudeTokens = costUsage.totalClaudeTokens(usage);
      const codexTokens = codex.selected.tokens;
      sendJson(res, 200, {
        ok: true,
        costRoots: proj.costRoots,
        sharedDirs: usage.sharedDirs,
        usage,
        codex,
        quota,
        combined: {
          claudeTokens,
          codexTokens,
          totalTokens: claudeTokens + codexTokens,
          savingsEstimateUsd: costUsage.estimateCodexSavings(codexTokens, usage),
        },
      });
    })
    .catch((e) => sendJson(res, 500, { ok: false, error: '聚合成本失败：' + (e && e.message) }));
}

/**
 * 设置/释放负责人预留(POST /api/cpu,body: { cores, minutes? })。
 *
 * 写的就是账本里一条普通占用记录,所有跑测试的进程下次启动读到它就自动让路——
 * 不需要通知谁、也不会打断正在跑的活(不抢已发出去的活,只影响之后启动的)。
 * cores<=0 = 释放;minutes 给了就设到期时间,防"设了忘了释放"长期空占。
 */
function handleCpuReserve(req, res) {
  readBody(req, BODY_MAX, (err, raw) => {
    if (err) return sendJson(res, 413, { ok: false, error: err.message });
    let body;
    try { body = raw ? JSON.parse(raw) : {}; }
    catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }

    const cores = Number(body.cores);
    if (!Number.isFinite(cores)) return sendJson(res, 400, { ok: false, error: '缺 cores（要预留的核数，0=释放）' });
    const minutes = Number(body.minutes);
    const opts = Number.isFinite(minutes) && minutes > 0
      ? { expiresAtMs: Date.now() + minutes * 60 * 1000 }
      : {};
    try { return sendJson(res, 200, { ok: true, cpu: cpuBudget.setReserve(cores, opts) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: '写算力账本失败：' + (e && e.message) }); }
  });
}

const TASK_ACTIONS = ['note', 'park', 'unpark', 'cancel', 'reopen', 'request-info'];

/** 网页治理操作只转发 CLI；正文按字面参数传递，拒绝文案沿用 decide 的约定。 */
function handleTaskAction(req, res, pid, tid, action) {
  if (!pid || !tid) return sendJson(res, 400, { ok: false, error: '缺 projectId 或 taskId' });
  readBody(req, BODY_MAX, (err, raw) => {
    if (err) return sendJson(res, 413, { ok: false, error: err.message });
    let body;
    try { body = raw ? JSON.parse(raw) : {}; }
    catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { ok: false, error: '请求体应为 JSON 对象' });
    }
    const hasText = (field) => typeof body[field] === 'string' && body[field].trim().length > 0;
    const args = [CLI_INDEX, action, tid];
    if (action === 'note') {
      if (!hasText('text')) return sendJson(res, 400, { ok: false, error: '缺 text（留言正文）' });
      args.push('--text', body.text, '--from', 'human');
    } else if (action === 'request-info') {
      if (!hasText('did')) return sendJson(res, 400, { ok: false, error: '缺 did（要补齐的 decision id）' });
      if (!Array.isArray(body.missing) || !body.missing.length
        || body.missing.some((field) => typeof field !== 'string' || !field.trim())) {
        return sendJson(res, 400, { ok: false, error: '缺 missing（要补齐的字段数组）' });
      }
      args.push('--did', body.did, '--missing', body.missing.join(','));
    } else {
      if (!hasText('reason')) return sendJson(res, 400, { ok: false, error: '缺 reason（操作理由）' });
      args.push('--reason', body.reason);
      if (action === 'park' && body.note !== undefined) {
        if (typeof body.note !== 'string') return sendJson(res, 400, { ok: false, error: 'note（遗留说明）应为文本' });
        if (body.note) args.push('--note', body.note);
      }
    }
    args.push('--project', pid, '--author', '负责人', '--json');
    if (REGISTRY !== REGISTRY_PATH) args.push('--registry', REGISTRY);
    execFile(process.execPath, args, {
      cwd: DASH_ROOT, timeout: DECIDE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    }, (e, stdout, stderr) => {
      if (e) {
        const msg = String(stderr || '').trim() || e.message || `${action} 失败`;
        return sendJson(res, typeof e.code === 'number' ? 400 : 500, { ok: false, error: msg });
      }
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch (_) { return sendJson(res, 500, { ok: false, error: 'CLI 输出非 JSON', raw: String(stdout).slice(0, 500) }); }
      try { pollBoards(); } catch (_) {}
      sendJson(res, 200, parsed);
    });
  });
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

/**
 * handleDispatch —— 一键派单启动 Claude Code 对话（治用户"拍板了没人做"痛点）。
 * body:{ pid, tid, did } → 找到该 decision + task + project 元数据 → 生成"启动指令"文本
 *   → spawn 新 Windows 终端窗口跑 `claude "启动指令"`（cwd=项目根，让新对话进对的项目）
 * 前一版"复制粘贴"根本不算派单;这才是真正让新对话被启动。
 */
function handleDispatch(req, res) {
  readBody(req, BODY_MAX, (err, raw) => {
    if (err) return sendJson(res, 413, { ok: false, error: err.message });
    let body;
    try { body = raw ? JSON.parse(raw) : {}; }
    catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
    const pid = String(body.pid || '').trim();
    const tid = String(body.tid || '').trim();
    const did = String(body.did || '').trim();
    if (!pid || !tid || !did) return sendJson(res, 400, { ok: false, error: '缺 pid/tid/did' });

    // 从 registry 拿项目根、从 board 拿 task+decision
    let projects;
    try { projects = readRegistrySafe(); }
    catch (e) { return sendJson(res, 500, { ok: false, error: 'registry 读不出:' + e.message }); }
    const proj = projects.projects && projects.projects[pid];
    if (!proj) return sendJson(res, 404, { ok: false, error: `项目 ${pid} 未注册` });
    let board;
    try { board = JSON.parse(fs.readFileSync(proj.board, 'utf8')); }
    catch (_) { return sendJson(res, 404, { ok: false, error: `${pid} 的 board.json 读不出` }); }
    const task = (board.tasks || []).find((t) => t.id === tid);
    if (!task) return sendJson(res, 404, { ok: false, error: `任务 ${tid} 不存在` });
    const decision = (task.decisions || []).find((d) => d.id === did);
    if (!decision) return sendJson(res, 404, { ok: false, error: `decision ${did} 不存在` });
    if (decision.answer === null || decision.answer === undefined) {
      return sendJson(res, 400, { ok: false, error: `decision ${did} 还没拍板,无法派单` });
    }

    // 生成启动指令(含"看板派单 header"让新对话认得出自己是被派来的)
    const prompt = buildDispatchPrompt(pid, proj, task, decision);

    // 在 Windows 打开新 cmd 窗口跑 claude,cwd=项目【代码的家】,让 CLAUDE.md 协议锚生效
    const cwd = dispatchCwd(pid);
    if (!cwd) return sendJson(res, 500, { ok: false, error: `派单失败:算不出项目 ${pid} 的代码目录(registry 里 codeRepo/mainRepo 都读不出)` });
    const cmdArgs = ['/c', 'start', '"看板派单·' + tid + '·' + did + '"', 'cmd', '/k',
      'chcp 65001 >nul && claude ' + JSON.stringify(prompt)];
    let child;
    try {
      child = require('node:child_process').spawn('cmd.exe', cmdArgs, {
        cwd, detached: true, stdio: 'ignore', windowsHide: false, shell: false,
      });
      child.unref();
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: '派单失败:' + e.message });
    }
    sendJson(res, 200, {
      ok: true, dispatched: { pid, tid, did },
      msg: '已开新 Claude Code 对话窗口,该对话已收到派单指令、正在启动',
    });
  });
}

/**
 * handleDispatchProject —— 整项目派单:把该项目所有 unlanded decisions 打包成一份任务书。
 * 用户实操中最需要这个:"一个项目一个启动指令"——不是一条一次派对话。
 */
function handleDispatchProject(req, res) {
  readBody(req, BODY_MAX, (err, raw) => {
    if (err) return sendJson(res, 413, { ok: false, error: err.message });
    let body;
    try { body = raw ? JSON.parse(raw) : {}; }
    catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
    const pid = String(body.pid || '').trim();
    if (!pid) return sendJson(res, 400, { ok: false, error: '缺 pid' });

    let projects;
    try { projects = readRegistrySafe(); }
    catch (e) { return sendJson(res, 500, { ok: false, error: 'registry 读不出:' + e.message }); }
    const proj = projects.projects && projects.projects[pid];
    if (!proj) return sendJson(res, 404, { ok: false, error: `项目 ${pid} 未注册` });

    let board;
    try { board = JSON.parse(fs.readFileSync(proj.board, 'utf8')); }
    catch (_) { return sendJson(res, 404, { ok: false, error: `${pid} 的 board.json 读不出` }); }

    // 待落地口径与前端、接单命令一致；终态卡的未标记决策视为随卡落地。
    const items = [];
    for (const t of (board.tasks || [])) {
      for (const d of (t.decisions || [])) {
        if (isUnlanded(t, d)) {
          items.push({ task: t, decision: d });
        }
      }
    }
    if (!items.length) return sendJson(res, 400, { ok: false, error: '本项目没有待落地决策' });

    const prompt = buildProjectDispatchPrompt(pid, proj, items);
    const preview = body.preview === true; // 前端可只要文本(不实际派单)
    if (preview) return sendJson(res, 200, { ok: true, prompt, count: items.length });

    const cwd = dispatchCwd(pid);
    if (!cwd) return sendJson(res, 500, { ok: false, error: `派单失败:算不出项目 ${pid} 的代码目录(registry 里 codeRepo/mainRepo 都读不出)` });
    const cmdArgs = ['/c', 'start', '"看板整项目派单·' + pid + '·' + items.length + '条"', 'cmd', '/k',
      'chcp 65001 >nul && claude ' + JSON.stringify(prompt)];
    try {
      const child = require('node:child_process').spawn('cmd.exe', cmdArgs, {
        cwd, detached: true, stdio: 'ignore', windowsHide: false, shell: false,
      });
      child.unref();
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: '派单失败:' + e.message });
    }
    sendJson(res, 200, { ok: true, dispatched: { pid, count: items.length },
      msg: `已开新对话窗口,${items.length} 条待落地决策打包发出` });
  });
}

/**
 * handleDispatchTask —— 任务级派单(用户要的正确粒度):
 * 一个任务的所有 unlanded decisions 打包给一个对话,那对话 claim 一次该任务、
 * 带着所有答案一起施工。治"一个决策一个对话各自 claim 同一任务打架"。
 */
function handleDispatchTask(req, res) {
  readBody(req, BODY_MAX, (err, raw) => {
    if (err) return sendJson(res, 413, { ok: false, error: err.message });
    let body;
    try { body = raw ? JSON.parse(raw) : {}; }
    catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
    const pid = String(body.pid || '').trim();
    const tid = String(body.tid || '').trim();
    if (!pid || !tid) return sendJson(res, 400, { ok: false, error: '缺 pid/tid' });

    let projects;
    try { projects = readRegistrySafe(); }
    catch (e) { return sendJson(res, 500, { ok: false, error: 'registry 读不出:' + e.message }); }
    const proj = projects.projects && projects.projects[pid];
    if (!proj) return sendJson(res, 404, { ok: false, error: `项目 ${pid} 未注册` });

    let board;
    try { board = JSON.parse(fs.readFileSync(proj.board, 'utf8')); }
    catch (_) { return sendJson(res, 404, { ok: false, error: `${pid} 的 board.json 读不出` }); }
    const task = (board.tasks || []).find((t) => t.id === tid);
    if (!task) return sendJson(res, 404, { ok: false, error: `任务 ${tid} 不存在` });

    const decisions = (task.decisions || []).filter(
      (d) => isUnlanded(task, d),
    );
    if (!decisions.length) return sendJson(res, 400, { ok: false, error: `任务 ${tid} 没有待落地决策` });

    const prompt = buildTaskDispatchPrompt(pid, proj.name || pid, task, decisions, board);
    const trigger = shortTrigger(pid, tid);
    // preview:同时给【完整任务书】和【短触发指令】,前端用短触发做"复制接单"(可靠兜底)
    if (body.preview === true) return sendJson(res, 200, { ok: true, prompt, trigger, count: decisions.length });

    // 自动开终端:只传【短触发指令】(避开命令行长度/转义炸裂),funnel through cli inbox。
    // 注意:开的是"终端里的 Claude Code",不是桌面 App——前端会同时提供"复制接单指令"兜底。
    const cwd = dispatchCwd(pid);
    if (!cwd) return sendJson(res, 500, { ok: false, error: `派单失败:算不出项目 ${pid} 的代码目录(registry 里 codeRepo/mainRepo 都读不出)` });
    const cmdArgs = ['/c', 'start', '看板派单-' + tid, 'cmd', '/k', 'claude', trigger];
    try {
      const child = require('node:child_process').spawn('cmd.exe', cmdArgs, {
        cwd, detached: true, stdio: 'ignore', windowsHide: false, shell: false,
      });
      child.unref();
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: '派单失败:' + e.message });
    }
    sendJson(res, 200, { ok: true, dispatched: { pid, tid, count: decisions.length }, trigger,
      msg: `已尝试开终端对话落地任务 ${tid}(${decisions.length} 条决策)` });
  });
}

function buildProjectDispatchPrompt(pid, proj, items) {
  const CLI = displayCliCommand();
  const lines = [
    '# 【看板整项目派单】此对话由项目管理看板一键启动,负责落地本项目全部已拍板决策',
    '',
    `你是被【项目管理看板】自动派来的对话——用户在看板上一键选择了"打包派单本项目全部已拍板未落地的 ${items.length} 条决策",本对话被启动、cwd 已进项目代码仓、这条 prompt 就是完整任务书。你不需要问用户"要做什么"。`,
    '',
    `**项目**:${proj.name || pid} (项目 id: \`${pid}\`,已接入看板)`,
    `**共 ${items.length} 条待落地决策**,按下方顺序执行:`,
    '',
    '---',
    '',
  ];
  items.forEach((it, i) => {
    const t = it.task, d = it.decision;
    lines.push(`## ${i + 1}. ${t.id} · ${t.title} · 决策 #${d.id}(用户拍于 ${d.decidedAt})`);
    lines.push('');
    lines.push(`**问题**:${d.question}`);
    lines.push('');
    lines.push(`**用户拍的答案**:`);
    lines.push('');
    lines.push('```');
    lines.push(d.answer);
    lines.push('```');
    lines.push('');
    if (d.recommendReason) {
      lines.push(`**当时看板给的推荐理由**(参考,以用户答案为准):${d.recommendReason}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  });
  lines.push('## 你的施工职责(按顺序执行上面每条决策)');
  lines.push('');
  lines.push('**读了再动手**:');
  lines.push('1. 项目根 `CLAUDE.md`——本项目的看板同步纪律(pre-commit 硬闸门会拦你不 claim 就 commit)');
  lines.push('2. skill `project-build-workflow` §11.2 认领协议 + §11.9 看板同步 + §6.1/§6.2 拍板话术');
  lines.push('3. 各任务的设计文档(见 board.json 里对应 task.docs 字段)');
  lines.push('');
  lines.push('**每条决策的落地流程**:');
  lines.push('');
  lines.push('```');
  lines.push(`# 认领(不 claim git commit 会被 pre-commit 硬闸门拦下)`);
  lines.push(`${CLI} claim <任务id> --project ${pid} --branch <你的分支名>`);
  lines.push(``);
  lines.push(`# 按用户答案实施代码/设计`);
  lines.push(`# ...(施工过程)`);
  lines.push(``);
  lines.push(`# 施工完成`);
  lines.push(`${CLI} done <任务id> --project ${pid} --pr <PR号> --commit <sha>`);
  lines.push(`${CLI} mark-landed <任务id> --did <决策id> --project ${pid}`);
  lines.push('```');
  lines.push('');
  lines.push('**施工顺序建议**:');
  lines.push('- 有明确依赖顺序的按依赖跑;无强依赖的按 wave/编号跑');
  lines.push('- 每条决策独立分支、独立 PR、独立 auto-merge(见 skill §11.7)');
  lines.push('- 中途冒出新的待拍板点(超范围/新决策) → `cli pending --json` 登记(必须给背景/利弊/推荐理由三件套,见 skill §6.2)');
  lines.push('');
  lines.push('**关于"暂缓"类答案**(如 P15 "维持暂缓 + 编写职业晋升系统"这类不是"照代码改"而是"启动一个新方案"):');
  lines.push('- 不是让你现在动代码,而是让你**新起一份设计方案文档**(放 `docs/plans/` 下,沿用项目编号规则)');
  lines.push('- 按 skill §3 阶段①对账 + §4 阶段②建议 + §5 阶段③分解 走完,最后停下等用户拍板才能开工');
  lines.push('- 联网搜索/对抗审查/对齐现有代码这些用户提到的都要做完');
  lines.push('');
  lines.push('## 现在开始');
  lines.push('');
  lines.push('别问"要不要开始"、别问"具体做什么"——上面就是全部任务书。请从第 1 条开始,先做该条的阶段①对账。');
  return lines.join('\n');
}

function buildDispatchPrompt(pid, proj, task, decision) {
  const CLI = displayCliCommand();
  return [
    '# 【看板派单】此对话由项目管理看板一键启动',
    '',
    '你是被【项目管理看板】自动派来落地一条已拍板决策的。用户拍板后点了"一键开对话",看板启动了本对话并把完整任务上下文注入这条 prompt。你不需要问用户"要做什么"——下面就是完整任务书。',
    '',
    `**项目**:${proj.name || pid}(项目 id: \`${pid}\`,已接入看板)`,
    `**任务**:${task.id} · ${task.title}`,
    `**待落地决策**:#${decision.id}`,
    `**用户拍板于**:${decision.decidedAt}`,
    '',
    '## 决策详情',
    '',
    `**问题**:${decision.question}`,
    '',
    `**用户拍的答案**:${decision.answer}`,
    '',
    decision.recommendReason ? `**当时看板给的推荐理由**(仅参考,你要落地用户拍的答案):\n${decision.recommendReason}\n` : '',
    '',
    '## 你的施工职责',
    '',
    '1. 读项目根 `CLAUDE.md` 里"看板协议"锚段——本项目的看板同步纪律',
    '2. 阅读该任务的设计文档(见看板/`board.json` 里 task.docs 字段)',
    '3. 按 skill `project-build-workflow` §11.2 认领协议做:',
    '   - 先 `git fetch` 核对 worktree 新鲜度',
    '   - 建独立分支(顺延项目分支命名规则)',
    '   - **动代码前跑 cli claim**(pre-commit 硬闸门会拦你,不 claim 无法 commit):',
    '     ```',
    `     ${CLI} claim ${task.id} --project ${pid} --branch <你的分支名>`,
    '     ```',
    '4. 按用户拍的答案「' + decision.answer + '」落地实现',
    '5. 施工完成后:',
    '   ```',
    `   ${CLI} done ${task.id} --project ${pid} --pr <PR号> --commit <sha>`,
    `   ${CLI} mark-landed ${task.id} --did ${decision.id} --project ${pid}`,
    '   ```',
    '6. 达标自动 push + gh pr create + auto-merge to main(见 skill §11.7)',
    '',
    '## 现在开始',
    '',
    '别问我"要不要开始"、别问"具体做什么"——上面就是完整任务书。请开始阶段①对账。',
  ].filter((x) => x !== undefined).join('\n');
}

function handleMarkLanded(req, res, projectId, taskId) {
  if (!projectId || !taskId) return sendJson(res, 400, { ok: false, error: '缺 projectId 或 taskId' });
  readBody(req, BODY_MAX, (err, raw) => {
    if (err) return sendJson(res, 413, { ok: false, error: err.message });
    let body;
    try { body = raw ? JSON.parse(raw) : {}; }
    catch (_) { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
    const did = typeof body.did === 'string' ? body.did.trim() : '';
    const all = body.all === true;
    const author = (typeof body.author === 'string' && body.author.trim()) ? body.author.trim() : '看板';
    if (!did && !all) return sendJson(res, 400, { ok: false, error: '缺 did 或 all: true' });

    const args = [CLI_INDEX, 'mark-landed', taskId, ...(all ? ['--all'] : ['--did', did]), '--project', projectId, '--author', author, '--json'];
    if (REGISTRY !== REGISTRY_PATH) { args.push('--registry', REGISTRY); }
    execFile(process.execPath, args, {
      cwd: DASH_ROOT, timeout: DECIDE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    }, (e, stdout, stderr) => {
      if (e) {
        const isCliReject = typeof e.code === 'number';
        const msg = (String(stderr || '').trim()) || e.message || 'mark-landed 失败';
        return sendJson(res, isCliReject ? 400 : 500, { ok: false, error: msg });
      }
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch (_) { return sendJson(res, 500, { ok: false, error: 'CLI 输出非 JSON' }); }
      try { pollBoards(); } catch (_) {}
      sendJson(res, 200, parsed);
    });
  });
}

// ============ 静态托管（web/dist + SPA 回退） ============

function streamFile(res, fullPath, status) {
  const ext = path.extname(fullPath).toLowerCase();
  const isHtml = ext === '.html';
  // HTML 永不缓存(它引用哪个 hash chunk 变化频繁);带 hash 的 assets 也 no-cache,免得旧代码卡住用户。
  // 治用户实测的"浏览器一直显示旧界面"问题——之前只 no-cache 不够硬,加 no-store + must-revalidate 双保险。
  res.writeHead(status || 200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': isHtml ? 'no-store, no-cache, must-revalidate, max-age=0' : 'no-cache, must-revalidate',
    'pragma': 'no-cache',
    'expires': '0',
  });
  const stream = fs.createReadStream(fullPath);
  stream.on('error', () => { try { res.destroy(); } catch (_) {} });
  stream.pipe(res);
}

/** dist 未构建时的占位页：让 API 先可用、并提示怎么把前端 build 出来 */
function sendPlaceholder(res, status) {
  const buildRoot = DASH_ROOT.replace(/\\/g, '/')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>项目管理看板</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:720px;margin:8vh auto;padding:0 24px;color:#222;line-height:1.7}
code{background:#f2f2f2;padding:2px 6px;border-radius:4px}a{color:#2563eb}h1{font-size:20px}</style>
<h1>项目管理看板 · 服务已就绪</h1>
<p>后端 API 正在运行，但前端界面（<code>web/dist</code>）还没构建。</p>
<p>构建前端：<code>cd &quot;${buildRoot}&quot; &amp;&amp; npm install &amp;&amp; npm run build</code>，然后刷新本页。</p>
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
  if (!isSameOriginRequest(req)) return sendJson(res, 403, { ok: false, error: '跨站请求被拒' });
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
      const modules = resolveModules();

      if (sub === 'codex' && !modules.codex) return sendJson(res, 404, { ok: false, error: 'Codex 模块未启用（在菜单设置里打开，或 settings.json 的 modules.codex 设为 true）' });
      if (sub === 'cost' && !modules.cost) return sendJson(res, 404, { ok: false, error: '成本模块未启用（在菜单设置里打开，或 settings.json 的 modules.cost 设为 true）' });
      if (sub === 'cpu' && !modules.cpu) return sendJson(res, 404, { ok: false, error: '算力模块未启用（在菜单设置里打开，或 settings.json 的 modules.cpu 设为 true）' });
      if (sub === 'reader' && !modules.reader) return sendJson(res, 404, { ok: false, error: '审阅台模块未启用（在菜单设置里打开，或 settings.json 的 modules.reader 设为 true）' });

      if (sub === 'health' && req.method === 'GET') return handleHealth(req, res);
      if (sub === 'settings' && req.method === 'POST') return handleSettings(req, res);
      if (sub === 'projects' && req.method === 'GET') return handleProjects(req, res);
      if (sub === 'stream' && req.method === 'GET') return handleStream(req, res);
      if (sub === 'doc' && req.method === 'GET') return handleDoc(req, res, parsed.query || {});
      if (sub === 'board' && req.method === 'GET') return handleBoard(req, res, segs[2], parsed.query || {});
      if (sub === 'activity' && req.method === 'GET') return handleActivity(req, res, segs[2], parsed.query || {});
      if (sub === 'decide' && req.method === 'POST') return handleDecide(req, res, segs[2], segs[3]);
      if (sub === 'task' && req.method === 'POST' && segs.length === 5 && TASK_ACTIONS.includes(segs[4])) {
        return handleTaskAction(req, res, segs[2], segs[3], segs[4]);
      }
      if (sub === 'mark-landed' && req.method === 'POST') return handleMarkLanded(req, res, segs[2], segs[3]);
      if (sub === 'cpu' && req.method === 'GET') return handleCpuStatus(req, res);
      if (sub === 'cpu' && req.method === 'POST') return handleCpuReserve(req, res);
      if (sub === 'cost' && req.method === 'GET') return handleCostUsage(req, res, parsed.query || {});
      if (sub === 'dispatch' && req.method === 'POST') return handleDispatch(req, res);
      if (sub === 'dispatch-project' && req.method === 'POST') return handleDispatchProject(req, res);
      if (sub === 'dispatch-task' && req.method === 'POST') return handleDispatchTask(req, res);
      if (sub === 'parallel' && req.method === 'GET') return handleParallel(req, res, parsed.query || {});
      if (sub === 'codex' && codexApi.route(segs[2], req, res, parsed.query || {})) return;
      if (sub === 'reader' && readerApi.route(segs[2], req, res, parsed.query || {})) return;

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

/** 在端口区间里找已在跑的"我们的"实例，返回 {port, health}；没有则 null */
async function findExistingInstance() {
  for (let p = PORT_BASE; p <= PORT_BASE + PORT_RANGE; p++) {
    const h = await probeHealth(p);
    if (h && h.service === SERVICE) return { port: p, health: h };
  }
  return null;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 在跑的那个实例，和我这份代码是不是同一份（SERVER-RUNS-ON-LIVE-CHECKOUT，负责人 0906 拍板 d2=A）。
 * 老版本的 server 不报 codeRoot/releaseCommit → 一律判"不是同一份"，好让它被换掉：
 * 迁移当天在跑的恰恰就是那种老实例。
 * @param {object} h 对方 /api/health
 */
function isSameRuntime(h) {
  if (!h || h.codeRoot === undefined) return false;
  return path.resolve(h.codeRoot) === path.resolve(DASH_ROOT) && (h.releaseCommit || null) === RELEASE_COMMIT;
}

/**
 * 关掉旧实例并等它松开端口。关不掉返回 false（调用方降级成"复用旧的 + 大声提醒"，绝不硬抢）。
 * @param {{port:number, health:object}} inst
 */
async function stopInstance(inst) {
  try { process.kill(inst.health.pid); }
  catch (e) {
    if (e && e.code === 'ESRCH') return true; // 已经没了
    console.error(`  关不掉旧服务（pid ${inst.health.pid}）：${e && e.message}`);
    return false;
  }
  for (let i = 0; i < 40; i++) {              // 最多等 10 秒
    if (!(await probeHealth(inst.port))) return true;
    await delay(250);
  }
  return false;
}

/** 一句话说清"在跑的那份是什么版本"，给控制台用。 */
function describeRuntime(h) {
  if (!h || h.codeRoot === undefined) return '老版本（不报自己是哪份代码）';
  const who = h.releaseCommit ? `发布副本 @ ${String(h.releaseCommit).slice(0, 12)}` : `${h.mode || '?'} @ ${h.codeRoot}`;
  return who;
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
    console.log(`  代码来自：${DASH_ROOT}`);
    console.log(`  身份：${MODE}${RELEASE_COMMIT ? `（发布副本 @ ${RELEASE_COMMIT.slice(0, 12)}，发布于 ${RELEASED_AT}）` : ''}`);
    if (MODE === 'dev') console.log('  ⚠ 这是开发实例（代码根是 git 检出）——负责人日常用的那份应该从发布副本起（启动看板.bat）');
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

async function main() {
  const inst = await findExistingInstance();
  if (!inst) return tryListen(PORT_BASE, PORT_RANGE);

  const localUrl = `http://127.0.0.1:${inst.port}/`;
  if (isSameRuntime(inst.health)) {
    console.log(`检测到看板已在运行（端口 ${inst.port}，就是这份代码），复用该实例并打开浏览器。`);
    openBrowser(localUrl);
    process.exit(0);
  }

  // 版本不对 —— 这就是"合了主干却一直不生效"的现场（SERVER-RUNS-ON-LIVE-CHECKOUT）。
  console.log('\n检测到在跑的看板服务和这次要起的不是同一份代码：');
  console.log(`  在跑的：${describeRuntime(inst.health)}（pid ${inst.health.pid}，端口 ${inst.port}）`);
  console.log(`  这一份：${describeRuntime({ codeRoot: DASH_ROOT, releaseCommit: RELEASE_COMMIT, mode: MODE })}`);
  if (process.env.DASHBOARD_NO_RESTART === '1') {
    console.log('  DASHBOARD_NO_RESTART=1 → 不动它，复用旧实例。注意：你看到的仍是旧版本。\n');
    openBrowser(localUrl);
    process.exit(0);
  }
  console.log('  → 关掉旧的，用新的接管同一个端口（不想换新就设 DASHBOARD_NO_RESTART=1）');
  if (await stopInstance(inst)) return tryListen(inst.port, PORT_RANGE);

  console.log('  ✖ 旧服务关不掉（可能没权限或卡死了），只好复用它——你看到的仍是旧版本。');
  console.log(`     手动收拾：结束进程 ${inst.health.pid} 后重新启动。\n`);
  openBrowser(localUrl);
  process.exit(0);
}

// 局部请求出错不该拖垮整个本地服务（各请求/回调已各自兜底，这里是最后一道网）
process.on('uncaughtException', (e) => { console.error('[uncaught]', e && (e.stack || e.message || e)); });

// 直接 `node server/server.cjs` 才起服务;被 require 时只暴露纯函数供单测取用
// (派单要 spawn 真实终端窗口跑 claude,单测碰不得,只能验落脚点怎么算出来的)。
if (require.main === module) main();

/** 这份代码的身份与端口段（给测试与排错用；不起服务也能问出来）。 */
function runtimeInfo() {
  return { mode: MODE, codeRoot: DASH_ROOT, releaseCommit: RELEASE_COMMIT, portBase: PORT_BASE, portRange: PORT_RANGE };
}

module.exports = { dispatchCwd, codexRepo, costPrefixes, isSameRuntime, runtimeInfo };
