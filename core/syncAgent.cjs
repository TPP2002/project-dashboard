'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn: systemSpawn } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { resolveProject, readRegistry } = require('./resolveProject.cjs');
const { readOutbox } = require('./syncOutbox.cjs');
const { withLock, pidAlive } = require('./lock.cjs');
const { atomicWriteJsonSync, atomicWriteFileSync } = require('./atomicWrite.cjs');
const { assertValid } = require('./boardSchema.cjs');
const { syncRoot, registryFile, readConfig, validateConfig, loadDeviceCredential } = require('./syncCredential.cjs');
const { createSyncClient } = require('./syncClient.cjs');

const backoffDelay = attempt => Math.min(2000 * 2 ** attempt, 300000);
function buildSshArgs(input) {
  const config = validateConfig(input);
  if (config.mode !== 'ssh') throw new Error('需要 SSH 连接配置');
  return ['-N', '-L', `127.0.0.1:${config.localPort}:127.0.0.1:${config.remotePort}`,
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', config.sshHost];
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
const taskIds = row => [...new Set([...(row.flags?._ || []).filter(v => typeof v === 'string'),
  ...(typeof row.flags?.taskId === 'string' ? [row.flags.taskId] : [])])];
function safeError(error) {
  if (error.code === 'LOGIN_REQUIRED') return '请重新登录云端';
  if (error.code === 'INVALID_BOARD') return '云端看板格式无效，未写回本机';
  if (error.code === 'RETRY') return '云端暂未确认全部操作，稍后重试';
  if (Number.isInteger(error.httpStatus)) return `云端请求失败（HTTP ${error.httpStatus}）`;
  return '同步失败，请检查网络、连接配置或本机文件';
}
function createSyncAgent({ registryPath, now = Date.now, client: injectedClient, spawn = systemSpawn, intervals = {}, protector } = {}) {
  registryPath = registryFile(registryPath);
  const root = syncRoot(registryPath);
  const timing = { watch: 1000, sync: 10000, poll: 30000, credential: 30000, status: 10000, ...intervals };
  const timestamp = () => new Date(now()).toISOString();
  const startedAt = timestamp();
  let client = injectedClient, config, credential, running = false, runPromise, lockFd;
  let tunnel = null, attempt = 0, retryAt = 0, stream = null, streamConnected = false, streamRetryAt = 0;
  let streamAbort, wake, sleepTimer, shuttingDown = false;
  const queues = new Map(), projectErrors = new Map();
  const agent = { pid: process.pid, startedAt, state: 'reconnecting', nextRetryAt: null, lastError: null,
    origin: null, deviceLabel: null, deviceExpiresAt: null };
  function projects() {
    return Object.entries(readRegistry(registryPath).projects || {}).filter(([, e]) => e.cloud?.enabled === true)
      .map(([id]) => resolveProject(id, { registryPath }));
  }
  function project(id) {
    const proj = resolveProject(id, { registryPath });
    return proj.cloud ? proj : null;
  }
  function state(proj) {
    const value = readJson(path.join(proj.syncDir, 'state.json'), { v: 1, ackedSeq: 0, etag: null,
      lastPullAt: null, lastPushAt: null, lastArchiveDay: null, untracked: [] });
    if (value.v !== 1 || !Number.isSafeInteger(value.ackedSeq) || value.ackedSeq < 0 || !Array.isArray(value.untracked)) {
      throw new Error('同步进度文件无效');
    }
    return value;
  }
  function saveState(proj, value) {
    fs.mkdirSync(proj.syncDir, { recursive: true });
    atomicWriteJsonSync(path.join(proj.syncDir, 'state.json'), value);
  }
  function locked(proj, fn) {
    fs.mkdirSync(path.dirname(proj.board), { recursive: true });
    return withLock(proj.lock, fn);
  }
  function log(level, event, id, count, httpStatus) {
    const dir = path.join(root, 'logs'); fs.mkdirSync(dir, { recursive: true });
    const today = timestamp().slice(0, 10).replace(/-/g, '');
    for (const name of fs.readdirSync(dir)) {
      const match = /^agent-(\d{4})(\d{2})(\d{2})\.log$/.exec(name);
      if (match && Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`) < now() - 14 * 86400000) fs.unlinkSync(path.join(dir, name));
    }
    fs.appendFileSync(path.join(dir, `agent-${today}.log`), JSON.stringify({ at: timestamp(), level, event,
      ...(id ? { project: id } : {}), ...(count === undefined ? {} : { count }),
      ...(Number.isInteger(httpStatus) ? { httpStatus } : {}) }) + '\n');
  }
  function publish() {
    const summary = Object.create(null);
    for (const proj of projects()) {
      summary[proj.id] = locked(proj, () => {
        const current = state(proj), pending = readOutbox(proj).filter(r => r.kind === 'op' && r.seq > current.ackedSeq);
        const rejected = readJson(path.join(proj.syncDir, 'rejected.json'), { items: [] });
        return { remoteProjectId: proj.cloud.remoteProjectId, pending: pending.length,
          oldestPendingAt: pending[0]?.clientTs || null, ackedSeq: current.ackedSeq,
          rejectedUnseen: rejected.items.filter(r => !r.seen).length, untracked: current.untracked.length,
          lastPushAt: current.lastPushAt, lastPullAt: current.lastPullAt, lastError: projectErrors.get(proj.id) || current.lastError || null };
      });
    }
    fs.mkdirSync(root, { recursive: true });
    atomicWriteJsonSync(path.join(root, 'status.json'), { v: 1, updatedAt: timestamp(), agent: { ...agent }, projects: summary });
  }
  function failure(error, id) {
    agent.lastError = safeError(error);
    agent.state = error.code === 'LOGIN_REQUIRED' ? 'login-required' : 'reconnecting';
    if (!error.syncRetryAt) error.syncRetryAt = now() + (error.code === 'LOGIN_REQUIRED' ? timing.credential : backoffDelay(attempt++));
    retryAt = error.syncRetryAt;
    agent.nextRetryAt = new Date(retryAt).toISOString();
    if (id) {
      projectErrors.set(id, agent.lastError);
      const proj = project(id);
      if (proj) locked(proj, () => { const current = state(proj); current.lastError = agent.lastError; saveState(proj, current); });
    }
    if (!error.syncReported) log('warn', 'sync-failed', id, undefined, error.httpStatus);
    error.syncReported = true;
    publish();
  }
  function success(id) {
    if (id) projectErrors.delete(id);
    attempt = 0; retryAt = 0;
    agent.state = 'connected'; agent.nextRetryAt = null; agent.lastError = null;
  }
  async function connection() {
    if (client) return client;
    config = readConfig(registryPath);
    try { credential = await loadDeviceCredential(registryPath, protector); }
    catch { throw Object.assign(new Error('请重新登录云端'), { code: 'LOGIN_REQUIRED' }); }
    if (!credential || credential.origin !== config.origin || Date.parse(credential.expiresAt) <= now()) {
      throw Object.assign(new Error('请重新登录云端'), { code: 'LOGIN_REQUIRED' });
    }
    agent.origin = config.origin; agent.deviceLabel = credential.label; agent.deviceExpiresAt = credential.expiresAt;
    client = createSyncClient({ config, credential });
    startTunnel();
    return client;
  }
  function serialized(id, fn) {
    const previous = queues.get(id) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      try { const result = await fn(); success(id); publish(); return result; }
      catch (error) { failure(error, id); throw error; }
    });
    queues.set(id, work);
    void work.finally(() => { if (queues.get(id) === work) queues.delete(id); }).catch(() => {});
    return work;
  }
  function rememberUntracked(current, row) {
    if (!current.untracked.some(r => r.seq === row.seq && r.source === row.source)) {
      current.untracked.push({ seq: row.seq, taskIds: row.taskIds || [], source: row.source, clientTs: row.clientTs });
      current.untracked = current.untracked.slice(-50);
    }
  }
  async function pullProject(proj) {
    const before = locked(proj, () => ({ current: state(proj), rows: readOutbox(proj) }));
    const dirtyUntracked = before.rows.some(r => r.kind === 'untracked' && r.seq > before.current.ackedSeq);
    const snapshot = await (await connection()).snapshot(proj.cloud.remoteProjectId, dirtyUntracked ? null : before.current.etag);
    if (!snapshot.notModified) {
      try { snapshot.board.project.id = proj.id; assertValid(snapshot.board); }
      catch { throw Object.assign(new Error('云端看板格式无效'), { code: 'INVALID_BOARD' }); }
    }
    locked(proj, () => {
      const current = state(proj);
      if (!snapshot.notModified) {
        const cloud = snapshot.board, local = readJson(proj.board, { tasks: [] });
        const base = readJson(path.join(proj.syncDir, 'base.json'), { tasks: [] });
        const pending = readOutbox(proj).some(r => r.kind === 'op' && r.seq > current.ackedSeq);
        const baseTasks = new Map(base.tasks.map(t => [t.id, t]));
        const changed = local.tasks.filter(t => !isDeepStrictEqual(t, baseTasks.get(t.id)));
        let result = cloud;
        if (pending) {
          const preserve = new Map(changed.map(t => [t.id, t]));
          result = { ...cloud, tasks: cloud.tasks.map(t => preserve.get(t.id) || t) };
          const ids = new Set(result.tasks.map(t => t.id));
          result.tasks.push(...changed.filter(t => !ids.has(t.id)));
        } else {
          const cloudTasks = new Map(cloud.tasks.map(t => [t.id, t]));
          // Only recorded untracked changes are warnings; acknowledged operations
          // may legitimately differ from base until this pull reconciles them.
          const untrackedIds = new Set([...current.untracked, ...readOutbox(proj).filter(r => r.kind === 'untracked')].flatMap(r => r.taskIds || []));
          const overwritten = changed.filter(t => untrackedIds.has(t.id) && !isDeepStrictEqual(t, cloudTasks.get(t.id))).map(t => t.id);
          if (overwritten.length) rememberUntracked(current, { seq: current.ackedSeq, taskIds: overwritten,
            source: 'overwritten-by-cloud', clientTs: timestamp() });
        }
        try { assertValid(result); } catch { throw Object.assign(new Error('写回看板格式无效'), { code: 'INVALID_BOARD' }); }
        fs.mkdirSync(proj.syncDir, { recursive: true });
        atomicWriteJsonSync(proj.board, result);
        atomicWriteJsonSync(path.join(proj.syncDir, 'base.json'), cloud);
        current.etag = snapshot.etag;
      }
      current.lastPullAt = timestamp(); current.lastError = null; saveState(proj, current);
    });
    log('info', snapshot.notModified ? 'pull-unchanged' : 'pull', proj.id);
    return snapshot;
  }
  async function sendProject(proj) {
    while (true) {
      const input = locked(proj, () => ({ current: state(proj), rows: readOutbox(proj) }));
      const pending = input.rows.filter(r => r.seq > input.current.ackedSeq);
      if (!pending.length) return;
      const rows = []; let ops = 0;
      for (const row of pending) {
        if (row.kind === 'op' && ops === 20) break;
        rows.push(row); if (row.kind === 'op') ops++;
      }
      const batch = rows.filter(r => r.kind === 'op');
      const response = batch.length ? await (await connection()).sendOps(proj.cloud.remoteProjectId, input.current.ackedSeq, batch) : { results: [] };
      let retry = false;
      locked(proj, () => {
        const current = state(proj);
        const rejected = readJson(path.join(proj.syncDir, 'rejected.json'), { v: 1, items: [] });
        for (const row of rows) {
          if (row.seq <= current.ackedSeq) continue;
          if (row.seq !== current.ackedSeq + 1) { retry = true; break; }
          if (row.kind === 'untracked') rememberUntracked(current, row);
          else {
            const receipt = response.results?.find(r => r.opId === row.opId && r.seq === row.seq);
            if (!receipt || !['applied', 'rejected'].includes(receipt.status)) { retry = true; break; }
            if (receipt.status === 'rejected' && !rejected.items.some(r => r.opId === row.opId)) {
              const reason = { 400: '操作参数不符合云端规则', 403: '云端不允许此操作',
                404: '云端项目或任务不存在', 409: '任务归属或状态冲突' }[receipt.httpStatus] || '云端拒绝此改动';
              rejected.items.push({ seq: row.seq, opId: row.opId, command: row.command, taskIds: taskIds(row),
                httpStatus: receipt.httpStatus, error: `${reason}${receipt.httpStatus ? `（HTTP ${receipt.httpStatus}）` : ''}`,
                at: timestamp(), seen: false });
            }
          }
          current.ackedSeq = row.seq;
          // A rejected op/untracked edit may leave the server etag unchanged.
          // Force reconciliation after confirmation instead of keeping a draft.
          current.etag = null;
        }
        while (rejected.items.length > 200) {
          const seen = rejected.items.findIndex(r => r.seen); rejected.items.splice(seen < 0 ? 0 : seen, 1);
        }
        fs.mkdirSync(proj.syncDir, { recursive: true });
        if (rejected.items.length) atomicWriteJsonSync(path.join(proj.syncDir, 'rejected.json'), rejected);
        if (batch.length) current.lastPushAt = timestamp();
        saveState(proj, current);
      });
      log('info', 'push', proj.id, batch.length);
      await pullProject(proj);
      if (retry) throw Object.assign(new Error('等待云端重试'), { code: 'RETRY' });
    }
  }
  function archive(proj) {
    locked(proj, () => {
      const current = state(proj), day = timestamp().slice(0, 10);
      if (current.lastArchiveDay === day) return;
      const rows = readOutbox(proj), archived = rows.filter(r => r.seq <= current.ackedSeq);
      fs.mkdirSync(proj.syncDir, { recursive: true });
      if (archived.length) {
        const file = path.join(proj.syncDir, `outbox-archive-${day.slice(0, 7).replace('-', '')}.jsonl`);
        // A crash after archive append but before queue replacement is recoverable
        // without duplicate archive rows (sequence numbers never repeat).
        let existing = '';
        try { existing = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const seqs = new Set(existing.split('\n').filter(Boolean).map(s => JSON.parse(s).seq));
        const addition = archived.filter(r => !seqs.has(r.seq)).map(r => JSON.stringify(r) + '\n').join('');
        if (addition) { const fd = fs.openSync(file, 'a'); try { fs.writeFileSync(fd, addition); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
        atomicWriteFileSync(path.join(proj.syncDir, 'outbox.jsonl'), rows.filter(r => r.seq > current.ackedSeq).map(r => JSON.stringify(r) + '\n').join(''));
      }
      current.lastArchiveDay = day; saveState(proj, current);
    });
  }
  const sendPending = id => serialized(id, async () => { const proj = project(id); if (proj) await sendProject(proj); });
  const pull = id => serialized(id, async () => { const proj = project(id); if (proj) await pullProject(proj); });
  async function syncOnce() {
    let firstError;
    for (const proj of projects()) {
      try { await serialized(proj.id, async () => { await sendProject(proj); await pullProject(proj); archive(proj); }); }
      catch (error) { firstError ||= error; }
    }
    if (firstError) { failure(firstError); throw firstError; }
    publish();
  }
  function acquire() {
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'agent.lock');
    try { lockFd = fs.openSync(file, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = Number(fs.readFileSync(file, 'utf8')); } catch { /* A newly acquired lock must not be stolen. */ }
      if (pid && !pidAlive(pid)) { fs.unlinkSync(file); return acquire(); }
      throw Object.assign(new Error('同步程序已经运行'), { code: 'ALREADY_RUNNING' });
    }
    fs.writeSync(lockFd, String(process.pid));
  }
  function release() {
    if (lockFd === undefined) return;
    fs.closeSync(lockFd); lockFd = undefined;
    fs.unlinkSync(path.join(root, 'agent.lock'));
  }
  function startTunnel() {
    if (config.mode !== 'ssh' || tunnel) return;
    const child = spawn('ssh', buildSshArgs(config), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    tunnel = child; child.stderr?.resume();
    const ended = () => {
      if (tunnel !== child) return;
      tunnel = null;
      if (!shuttingDown) { disconnect(); failure(new Error('隧道断开')); wake?.(); }
    };
    child.once('exit', ended); child.once('error', ended);
  }
  function disconnect() {
    streamAbort?.abort(); streamConnected = false;
    client?.close?.(); if (!injectedClient) client = null;
  }
  function killTunnel() { if (tunnel) { const child = tunnel; tunnel = null; child.kill(); } }
  function startStream() {
    if (stream || !client?.subscribe || now() < streamRetryAt) return;
    streamAbort = new AbortController();
    stream = client.subscribe(async event => {
      for (const proj of projects()) if (proj.cloud.remoteProjectId === event.projectId) await pull(proj.id);
    }, { signal: streamAbort.signal, onOpen: () => { streamConnected = true; } })
      .catch(error => { if (running && !streamAbort.signal.aborted) failure(error); })
      .finally(() => { stream = null; streamConnected = false; streamRetryAt = now() + backoffDelay(attempt); });
  }
  async function loop() {
    let lastSync = -Infinity, lastPoll = -Infinity, lastStatus = -Infinity;
    const signatures = new Map();
    while (running) {
      try {
        const reconnect = path.join(root, 'reconnect.request');
        if (fs.existsSync(reconnect)) {
          fs.unlinkSync(reconnect); disconnect(); killTunnel(); retryAt = 0; streamRetryAt = 0; lastSync = -Infinity;
          config = readConfig(registryPath);
        }
        if (now() >= retryAt) {
          if (agent.state === 'login-required') disconnect();
          await connection(); startTunnel();
          if (now() - lastSync >= timing.sync) { await syncOnce(); lastSync = now(); }
          else {
            for (const proj of projects()) {
              let signature = '';
              try { const stat = fs.statSync(path.join(proj.syncDir, 'outbox.jsonl')); signature = `${stat.size}:${stat.mtimeMs}`; }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
              if (signatures.get(proj.id) !== signature) { await sendPending(proj.id); signatures.set(proj.id, signature); }
            }
          }
          startStream();
          if (!streamConnected && now() - lastPoll >= timing.poll) {
            for (const proj of projects()) await pull(proj.id);
            lastPoll = now();
          }
        }
        if (now() - lastStatus >= timing.status) { publish(); lastStatus = now(); }
      } catch (error) { failure(error); }
      if (running) await new Promise(resolve => {
        wake = () => { clearTimeout(sleepTimer); wake = null; resolve(); };
        sleepTimer = setTimeout(wake, timing.watch);
      });
    }
  }
  async function run() {
    if (runPromise) throw Object.assign(new Error('同步程序已经运行'), { code: 'ALREADY_RUNNING' });
    acquire(); running = true; shuttingDown = false;
    const exit = () => { killTunnel(); release(); };
    process.once('exit', exit);
    runPromise = (async () => {
      try { config = readConfig(registryPath); agent.origin = config.origin; publish(); await loop(); }
      finally {
        running = false; shuttingDown = true; disconnect(); killTunnel();
        await Promise.allSettled([...queues.values()]);
        agent.state = 'stopped'; agent.nextRetryAt = null; publish();
        process.removeListener('exit', exit); release();
      }
    })();
    return runPromise;
  }
  async function stop() {
    running = false; shuttingDown = true; disconnect(); killTunnel(); wake?.();
    if (runPromise) await runPromise;
    else { agent.state = 'stopped'; agent.nextRetryAt = null; publish(); }
  }
  return { sendPending, pull, syncOnce, run, stop };
}
module.exports = { createSyncAgent, buildSshArgs, backoffDelay };
