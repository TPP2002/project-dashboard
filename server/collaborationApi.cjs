'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const bodyChannel = require('node:diagnostics_channel').channel('dashboard.owner-body');
const { publicJson, taskView, text } = require('../core/collaborationPublic.cjs');
const { createAuth, fail } = require('../core/collaborationAuth.cjs');
const { contributionView } = require('../core/collaborationContribView.cjs');
const { readRegistry, resolveProject } = require('../core/resolveProject.cjs');
const COOKIE = 'dashboard_session';
const DEVICE_COOKIE = 'dashboard_device';
const CLI = path.resolve(__dirname, '../cli/collaboration.cjs');

function configuration(env = process.env) {
  if (env.DASHBOARD_MODE !== 'collaboration') return null;
  let origin;
  try { origin = new URL(env.DASHBOARD_PUBLIC_ORIGIN); } catch { throw new Error('DASHBOARD_PUBLIC_ORIGIN is required'); }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      !((origin.protocol === 'https:') || (origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) {
    throw new Error('DASHBOARD_PUBLIC_ORIGIN must be HTTPS, or loopback HTTP for private tests');
  }
  return { origin: origin.origin, secure: origin.protocol === 'https:', host: env.DASHBOARD_HOST || '127.0.0.1' };
}
function rawCookie(req, name = COOKIE) {
  const values = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
function json(res, status, data, replacer = publicJson) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', vary: 'Cookie', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data, replacer));
}
async function body(req, maxBytes = 16384) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail(413, 'Request too large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(400, 'JSON object required');
  return value;
}
function only(value, keys) { if (Object.keys(value).some(k => !keys.includes(k))) fail(400, 'Unexpected field'); return value; }
function boardView(board, user) {
  return {
    schemaVersion: board.schemaVersion,
    project: { id: text(board.project.id), name: text(board.project.name), createdAt: text(board.project.createdAt), updatedAt: text(board.project.updatedAt) },
    tasks: board.tasks.map(t => taskView(t, user, board.activity || [])),
    activity: (board.activity || []).filter(a => ['collaboration:claim', 'collaboration:progress'].includes(a.type) && typeof a.userId === 'string')
      .map(a => ({ ts: text(a.ts), type: a.type, taskId: text(a.taskId), userId: text(a.userId), author: text(a.author) })),
  };
}
function runTask(command, payload, env) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, command], { env, windowsHide: true, timeout: command === 'sync-ops' ? 60000 : 15000, maxBuffer: command === 'sync-ops' ? 8 * 1048576 : 1048576 }, (err, stdout) => {
      let result;
      try { result = JSON.parse(stdout); } catch { return reject(Object.assign(new Error('Task operation failed'), { status: 500 })); }
      if (err || !result.ok) return reject(Object.assign(new Error(result.error || 'Task operation failed'), { status: result.status || 500 }));
      resolve(result);
    });
    child.stdin.on('error', () => {}); // execFile callback owns process failures.
    child.stdin.end(JSON.stringify(payload));
  });
}
function createCollaborationApi({ config, home, registryPath, summarize,
  readBoard = boardPath => JSON.parse(fs.readFileSync(boardPath, 'utf8')),
}) {
  const auth = createAuth({ home, registryPath });
  const streams = new Map();
  const ownerRequests = new WeakMap();
  const ownerContext = new AsyncLocalStorage();
  const env = { ...process.env, DASHBOARD_HOME: home, DASHBOARD_REGISTRY: registryPath };
  const canProject = (user, id) => user.role === 'owner' || user.projectIds.includes(id);
  const projects = user => Object.keys(readRegistry(registryPath).projects || {}).filter(id => canProject(user, id));
  function authorizedProject(user, id) {
    if (!canProject(user, id)) fail(404, 'Not found');
    try { return resolveProject(id, { registryPath }); } catch { fail(404, 'Not found'); }
  }
  function setCookie(res, raw, clear = false, name = COOKIE) {
    const existing = res.getHeader('Set-Cookie') || [];
    const cookies = Array.isArray(existing) ? existing : [existing];
    res.setHeader('Set-Cookie', [...cookies, `${name}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : name === DEVICE_COOKIE ? 7776000 : 604800}${config.secure ? '; Secure' : ''}`]);
  }
  function sessionResult(s) { return { ok: true, mode: 'collaboration', user: s ? s.user : null, ...(s ? { csrfToken: s.csrfToken } : {}) }; }
  function rejectForwarding(req) {
    if (Object.keys(req.headers).some(k => k === 'forwarded' || k.startsWith('x-forwarded-'))) fail(403, 'Untrusted forwarding headers');
  }
  function writeGuard(req, session, exempt) {
    if (req.headers.origin !== config.origin || req.headers['x-dashboard-request'] !== '1' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) fail(403, 'Invalid request origin or headers');
    // Forwarding headers are not credentials and cannot override trusted origin.
    rejectForwarding(req);
    if (!exempt && (!session || req.headers['x-dashboard-csrf'] !== session.csrfToken)) fail(403, 'Invalid CSRF token');
  }
  function withOwnerBody(req, callback) {
    const context = ownerRequests.get(req);
    if (!context) fail(401, 'Login required');
    try {
      return auth.withSession(context.raw, session => {
        if (session.user.role !== 'owner') fail(403, 'Forbidden');
        writeGuard(req, session, false);
        // Only the synchronous callback is protected. CLI children independently
        // reacquire auth -> board locks; async completion never retains this lock.
        return ownerContext.run(context, callback);
      });
    } catch (error) {
      if (!context.res.headersSent && !context.res.destroyed) json(context.res, error.status || 500,
        { ok: false, error: error.status ? error.message : 'Request failed' });
    }
  }
  function bodyChunk(req, bytes) {
    if (ownerRequests.has(req) && bodyChannel.hasSubscribers) {
      // Observability synchronization: no cookie, body, identity or secret.
      bodyChannel.publish({ path: req.url.split('?')[0], bytes });
    }
  }
  function ownerExecFile(executable, args, options, callback) {
    const context = ownerContext.getStore();
    if (!context) fail(401, 'Login required');
    const child = execFile(process.execPath, [CLI, 'owner-command'], { ...options, env, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        let result;
        try { result = JSON.parse(stdout); } catch {}
        // Never include serialized input or a credential in errors/logs.
        error.status = result?.status || 500;
        error.message = result?.error || 'Owner operation failed';
        return callback(error, '', error.message);
      }
      callback(null, stdout, stderr);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ sessionToken: context.raw, args: args.slice(1) }));
    return child;
  }
  function closeStream(res) { streams.delete(res); res.end(); }
  function liveStream(res, client) {
    try {
      const s = auth.session(client.token);
      if (!s || JSON.stringify(projects(s.user)) !== client.projects || s.user.role !== client.role) { closeStream(res); return null; }
      return s;
    } catch { closeStream(res); return null; }
  }
  function event(res, name, data) {
    if (res.destroyed || res.writableLength > 65536) return closeStream(res);
    res.write(`event: ${name}\ndata: ${JSON.stringify(data, publicJson)}\n\n`);
  }
  function sweep() { for (const [res, client] of streams) liveStream(res, client); }
  function broadcast(name, data) {
    for (const [res, client] of streams) {
      const s = liveStream(res, client);
      if (!s) continue;
      if (name === 'board:changed' && canProject(s.user, data.projectId)) event(res, name, { projectId: data.projectId, mtime: data.mtime });
      else if (name === 'ping') event(res, name, { ts: data.ts });
      else if (s.user.role === 'owner' && name !== 'board:changed') event(res, name, data);
    }
  }
  async function handle(req, res, pathname) {
    if (!pathname.startsWith('/api/')) return false;
    // Save only for the authenticated device snapshot path; legacy owner/member
    // representations must still ignore all conditional cache headers.
    const snapshotCondition = req.headers['if-none-match'];
    // Covers legacy owner routes as well: no shared cache or conditional 304 may
    // replay an owner representation after a cookie/account/permission change.
    delete req.headers['if-none-match']; delete req.headers['if-modified-since'];
    const writeHead = res.writeHead;
    res.writeHead = function(status, ...args) {
      res.removeHeader('ETag');
      for (const arg of args) if (arg && typeof arg === 'object') {
        for (const k of Object.keys(arg)) if (['etag', 'cache-control', 'vary'].includes(k.toLowerCase())) delete arg[k];
      }
      res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Vary', 'Cookie');
      return writeHead.call(res, status, ...args);
    };
    try {
      const raw = rawCookie(req);
      if (req.method === 'GET' && pathname === '/api/health') {
        // The owner UI reads modules from the existing full health response.
        // Anonymous probes stay independent of auth storage; other credentials
        // must be current, and a remembered device alone grants no health access.
        const current = raw ? auth.session(raw) : null;
        if (current?.user.role === 'owner') { ownerRequests.set(req, { raw, res }); return false; }
        json(res, 200, { ok: true, mode: 'collaboration' }); return true;
      }
      const deviceCookie = rawCookie(req, DEVICE_COOKIE);
      let session = auth.session(raw);
      if (req.method === 'GET' && pathname === '/api/auth/session') {
        if (!session && deviceCookie) {
          rejectForwarding(req);
          if ((req.headers.origin !== undefined && req.headers.origin !== config.origin) || req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Invalid request origin');
          session = auth.restoreSession(deviceCookie);
          if (session) setCookie(res, session.token);
          else setCookie(res, '', true, DEVICE_COOKIE);
        }
        json(res, 200, sessionResult(session)); return true;
      }
      if (!session && pathname === '/api/auth/logout' && req.method === 'POST') {
        // There is no valid session against which to verify CSRF. Keep origin,
        // fixed-header and JSON guards, change no ledger, clear stale browser
        // cookies and return 401 instead of silently authenticating on logout.
        writeGuard(req, null, true); only(await body(req), []);
        setCookie(res, '', true); setCookie(res, '', true, DEVICE_COOKIE);
        fail(401, 'Login required');
      }
      const publicWrite = ['/api/auth/login', '/api/auth/register', '/api/auth/device-login', '/api/auth/reset-password'].includes(pathname) && req.method === 'POST';
      if (!session && !publicWrite) fail(401, 'Login required');
      const contributions = pathname.match(/^\/api\/collaboration\/projects\/([^/]+)\/contributions$/);
      if (contributions) {
        const projectId = decodeURIComponent(contributions[1]);
        const project = authorizedProject(session.user, projectId);
        if (req.method !== 'GET') fail(405, 'Method not allowed');
        const values = new URL(req.url, config.origin).searchParams.getAll('weeks');
        if (values.length > 1 || (values.length === 1 && !['4', '8', '12'].includes(values[0]))) fail(400, 'Invalid weeks');
        const weeks = values.length ? Number(values[0]) : 8;
        const board = readBoard(project.board);
        if (!board) fail(404, 'Not found');
        json(res, 200, contributionView(board, { users: auth.projectDirectory(projectId), now: Date.now(), weeks, role: session.user.role }));
        return true;
      }
      if (!['GET', 'HEAD'].includes(req.method)) writeGuard(req, session, publicWrite);
      if (session?.user.role === 'viewer' && req.method !== 'GET' && !['/api/auth/password', '/api/auth/logout'].includes(pathname)) fail(403, 'Forbidden');
      if (pathname.startsWith('/api/auth/')) {
        if (req.method === 'GET' && pathname === '/api/auth/admin') { json(res, 200, { ok: true, ...auth.admin(raw) }); return true; }
        if (req.method !== 'POST') fail(404, 'Not found');
        const b = await body(req);
        const client = req.socket.remoteAddress || 'unknown';
        let result;
        if (pathname === '/api/auth/login') result = await auth.login(only(b, ['username', 'password']).username, b.password, client, deviceCookie);
        else if (pathname === '/api/auth/register') result = await auth.register(only(b, ['inviteToken', 'username', 'password', 'displayName']), client);
        else if (pathname === '/api/auth/device-login') result = auth.deviceLogin(only(b, ['token']).token, client);
        else if (pathname === '/api/auth/reset-password') result = await auth.resetPassword(only(b, ['resetToken', 'newPassword']));
        if (result) { setCookie(res, result.token); json(res, 200, sessionResult(result)); sweep(); return true; }
        if (!session) fail(401, 'Login required');
        if (pathname === '/api/auth/logout') { only(b, []); auth.logout(raw, deviceCookie); setCookie(res, '', true); setCookie(res, '', true, DEVICE_COOKIE); json(res, 200, { ok: true }); sweep(); return true; }
        if (pathname === '/api/auth/password') {
          await auth.changePassword(raw, only(b, ['currentPassword', 'newPassword']));
          json(res, 200, { ok: true }); sweep(); return true;
        }
        if (session.user.role !== 'owner') fail(403, 'Forbidden');
        if (pathname === '/api/auth/remember-device') {
          const remembered = auth.rememberDevice(raw, only(b, ['label']).label);
          setCookie(res, remembered.token, false, DEVICE_COOKIE);
          json(res, 200, { ok: true, device: remembered.device }); sweep(); return true;
        }
        if (pathname === '/api/auth/invites') result = auth.createInvite(raw, only(b, ['projectIds', 'expiresInHours', 'maxUses', 'role']));
        else if (pathname === '/api/auth/devices') result = auth.createDevice(raw, only(b, ['label']).label);
        else {
          const m = pathname.match(/^\/api\/auth\/(invites|devices|users)\/([^/]+)\/(revoke|access|reset)$/);
          if (!m) fail(404, 'Not found');
          if (m[1] === 'users' && m[3] === 'access') result = auth.access(raw, decodeURIComponent(m[2]), only(b, ['projectIds', 'disabled', 'role']));
          else if (m[1] === 'users' && m[3] === 'reset') { only(b, []); result = auth.createReset(raw, decodeURIComponent(m[2])); }
          else if (m[1] === 'invites' && m[3] === 'revoke') { only(b, []); result = auth.revokeInvite(raw, decodeURIComponent(m[2])); }
          else if (m[1] === 'devices' && m[3] === 'revoke') { only(b, []); result = auth.revokeDevice(raw, decodeURIComponent(m[2])); }
          else fail(404, 'Not found');
        }
        json(res, 200, { ok: true, ...result }); sweep(); return true;
      }
      if (pathname.startsWith('/api/sync/')) {
        if (session.user.role !== 'owner' || !session.deviceId) fail(403, 'Owner device session required');
        rejectForwarding(req);
        const { validateProjectId } = require('../core/syncLedger.cjs');
        const match = pathname.match(/^\/api\/sync\/projects\/([^/]+)\/(ops|snapshot|upload)$/);
        let projectId;
        if (match) {
          try { projectId = decodeURIComponent(match[1]); } catch { fail(400, 'Invalid project'); }
          validateProjectId(projectId);
        }
        const deviceSession = callback => auth.withSession(raw, current => {
          if (current.user.role !== 'owner' || !current.deviceId) fail(403, 'Owner device session required');
          if (req.method === 'POST') writeGuard(req, current, false);
          return callback(current);
        });
        const snapshot = id => {
          const proj = authorizedProject(session.user, id);
          const bytes = fs.readFileSync(proj.board);
          return { etag: crypto.createHash('sha256').update(bytes).digest('hex'), board: JSON.parse(bytes.toString('utf8')) };
        };
        if (req.method === 'GET' && pathname === '/api/sync/projects') {
          const result = deviceSession(() => {
            const reg = readRegistry(registryPath);
            return { ok: true, projects: Object.entries(reg.projects || {}).map(([id, entry]) => ({ id, name: entry.name || id, etag: snapshot(id).etag })) };
          });
          json(res, 200, result); return true;
        }
        if (req.method === 'GET' && match?.[2] === 'snapshot') {
          const result = deviceSession(() => snapshot(projectId));
          if (snapshotCondition === result.etag) { res.writeHead(304); res.end(); }
          else json(res, 200, { ok: true, ...result }, null);
          return true;
        }
        if (req.method === 'POST' && match?.[2] === 'ops') {
          const b = only(await body(req, 2 * 1024 * 1024), ['ackSeq', 'ops']);
          if (!Number.isSafeInteger(b.ackSeq) || b.ackSeq < 0 || !Array.isArray(b.ops) || b.ops.length < 1 || b.ops.length > 20) fail(400, 'Invalid sync batch');
          const result = await runTask('sync-ops', { ...b, projectId, sessionToken: raw }, env);
          json(res, 200, result, null); return true;
        }
        if (req.method === 'POST' && match?.[2] === 'upload') {
          const b = only(await body(req, 2 * 1024 * 1024), ['board', 'name']);
          const result = deviceSession(() => {
            if (!b.board || typeof b.board !== 'object' || Array.isArray(b.board) || !b.board.project
                || typeof b.board.project !== 'object' || Array.isArray(b.board.project)
                || (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim()))) fail(400, 'Invalid board or name');
            b.board.project.id = projectId;
            try { require('../core/boardSchema.cjs').assertValid(b.board); } catch { fail(400, 'Invalid board'); }
            const { withLock } = require('../core/lock.cjs');
            const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
            return withLock(registryPath + '.lock', () => {
              const reg = readRegistry(registryPath);
              reg.projects = reg.projects || {};
              if (Object.hasOwn(reg.projects, projectId)) fail(409, 'Project already exists');
              const root = path.join(home, 'projects', projectId);
              const file = path.join(root, 'board.json');
              fs.mkdirSync(root, { recursive: true });
              return withLock(file + '.lock', () => {
                if (fs.existsSync(file)) fail(409, 'Project already exists');
                atomicWriteJsonSync(file, b.board);
                Object.defineProperty(reg.projects, projectId, { value: { name: b.name || b.board.project.name || projectId, mainRepo: root, board: file }, enumerable: true });
                try { atomicWriteJsonSync(registryPath, reg); }
                catch (e) { fs.unlinkSync(file); throw e; }
                return { ok: true, etag: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
              });
            });
          });
          json(res, 200, result); return true;
        }
        fail(404, 'Not found');
      }
      const create = pathname.match(/^\/api\/collaboration\/projects\/([^/]+)\/tasks$/);
      if (create && req.method === 'POST') {
        const projectId = decodeURIComponent(create[1]);
        authorizedProject(session.user, projectId);
        const b = only(await body(req, 65536), ['title', 'plainTitle', 'description']);
        const result = await runTask('create', { ...b, projectId, sessionToken: raw, actorId: session.user.id }, env);
        json(res, 200, result); return true;
      }
      const task = pathname.match(/^\/api\/collaboration\/projects\/([^/]+)\/tasks\/([^/]+)\/(claim|progress|note|unclaim|park|unpark|done|cancel|reopen|join|leave|remove-collaborator)$/);
      if (task && req.method === 'POST') {
        const projectId = decodeURIComponent(task[1]); const taskId = decodeURIComponent(task[2]);
        authorizedProject(session.user, projectId);
        const fields = { claim: [], progress: ['percent', 'note'], note: ['text'], unclaim: ['reason'], park: ['reason'], unpark: ['reason'], done: [], cancel: ['reason'], reopen: ['reason'],
          join: [], leave: [], 'remove-collaborator': ['userId'] };
        const b = only(await body(req, 65536), fields[task[3]]);
        const result = await runTask(task[3], { ...b, projectId, taskId, sessionToken: raw, actorId: session.user.id }, env);
        json(res, 200, result); return true;
      }
      if (req.method === 'GET' && pathname === '/api/stream') {
        const allowed = projects(session.user);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        streams.set(res, { token: raw, role: session.user.role, projects: JSON.stringify(allowed) });
        event(res, 'hello', { ts: Date.now(), projects: allowed });
        const cleanup = () => streams.delete(res);
        req.on('close', cleanup); res.on('close', cleanup); res.on('error', cleanup);
        return true;
      }
      if (session.user.role === 'owner') { ownerRequests.set(req, { raw, res }); return false; }
      if (req.method === 'GET' && pathname === '/api/projects') {
        const reg = readRegistry(registryPath);
        const list = projects(session.user).map(id => {
          const proj = authorizedProject(session.user, id);
          const b = JSON.parse(fs.readFileSync(proj.board, 'utf8'));
          // Derive only the already-authorized board; preserve the existing
          // completed/void-card denominator rather than invent another metric.
          const { total, byStatus, progress, pendingCount, lastActivityTs } = summarize(b);
          const summary = { total, byStatus, progress, pendingCount, lastActivityTs };
          return { id: text(id), name: text(reg.projects[id].name || id), summary };
        });
        json(res, 200, { ok: true, projects: list }); return true;
      }
      const board = pathname.match(/^\/api\/board\/([^/]+)$/);
      if (req.method === 'GET' && board) {
        const proj = authorizedProject(session.user, decodeURIComponent(board[1]));
        json(res, 200, boardView(JSON.parse(fs.readFileSync(proj.board, 'utf8')), session.user)); return true;
      }
      fail(403, 'Forbidden');
    } catch (e) {
      json(res, e.status || 500, { ok: false, error: e.status ? e.message : 'Request failed' }); return true;
    }
  }
  return { handle, broadcast, sweep, withOwnerBody, ownerExecFile, bodyChunk,
    close: () => { for (const res of streams.keys()) closeStream(res); } };
}
module.exports = { configuration, createCollaborationApi, boardView, taskView };
