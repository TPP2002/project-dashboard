'use strict';
const fs = require('node:fs');
const { spawn: spawnChild } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const PROTOCOL = 1, RING_1S = 600, RING_1M = 1440, STALE_MS = 5000, SILENT_MS = 15000, CONNECT_MS = 30000, RELOAD_MS = 30000;
const BACKOFF_MS = [3000, 5000, 10000, 30000, 60000];
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

function parseRemoteHostsConfig(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { hosts: [], error: '配置文件不是有效的 JSON' }; }
  if (!data || !Array.isArray(data.hosts)) return { hosts: [], error: '配置字段 hosts 必须是数组' };
  const seen = new Set(), hosts = [];
  for (const [i, item] of data.hosts.entries()) {
    const fail = (field, reason) => ({ hosts: [], error: `第 ${i + 1} 项 ${field} ${reason}` });
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail('主机', '必须是对象');
    if (typeof item.name !== 'string' || !NAME.test(item.name)) return fail('name', '格式不正确');
    if (seen.has(item.name)) return fail('name', '重复');
    if (typeof item.label !== 'string' || item.label.length < 1 || item.label.length > 24) return fail('label', '长度须为 1~24 个字符');
    if (!Array.isArray(item.targets) || item.targets.length < 1 || item.targets.length > 4 || item.targets.some(x => typeof x !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(x))) return fail('targets', '须包含 1~4 个格式正确的目标');
    const agentPath = item.agentPath === undefined ? '/opt/hostmon/hostmon.py' : item.agentPath;
    const python = item.python === undefined ? 'python3' : item.python;
    if (typeof agentPath !== 'string' || !/^\/[A-Za-z0-9._/-]+$/.test(agentPath)) return fail('agentPath', '必须是有效的绝对路径');
    if (typeof python !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(python)) return fail('python', '格式不正确');
    seen.add(item.name); hosts.push({ name: item.name, label: item.label, targets: item.targets.slice(), agentPath, python });
  }
  return { hosts, error: null };
}

function createLineSplitter(onLine, { maxLine = 4 * 1024 * 1024, onOverflow = () => {} } = {}) {
  const decoder = new StringDecoder('utf8'); let buffer = '', dropping = false;
  return chunk => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (const part of text.split(/(\n)/)) {
      if (part === '\n') { if (!dropping) onLine(buffer.replace(/\r$/, '')); buffer = ''; dropping = false; }
      else if (!dropping) { buffer += part; if (Buffer.byteLength(buffer, 'utf8') > maxLine) { buffer = ''; dropping = true; onOverflow(); } }
    }
  };
}
function stale(s, now) { return s.lastDataAt === null || now - s.lastDataAt > STALE_MS || s.status !== 'online'; }
function summary(s, now) {
  const latest = s.latest, host = s.host, p = s.procs, all = p ? p.tasks : [], jobs = all.filter(x => x.kind !== 'system'), system = all.find(x => x.kind === 'system');
  const root = s.fs.find(x => x.mount === '/') || s.fs.reduce((a, b) => !a || b.totalMb > a.totalMb ? b : a, null);
  return { name: s.config.name, label: s.config.label, status: s.status, target: s.target, ageMs: s.lastDataAt === null ? null : now - s.lastDataAt,
    stale: stale(s, now), error: s.lastError, notice: s.notice, agentVersion: s.agentVersion, daemon: s.daemon, host, latest,
    capacity: latest && host ? { logicalCores: host.logicalCores, busyCores: latest.busyCores, freeCores: Math.max(0, Math.round((host.logicalCores - latest.busyCores) * 10) / 10), cpuPct: latest.cpu, memTotalMb: host.memTotalMb, memUsedMb: latest.mem.usedMb, memAvailMb: latest.mem.availMb } : null,
    disk: root ? { mount: root.mount, totalMb: root.totalMb, usedMb: root.usedMb, availMb: root.availMb } : null,
    spark: { stepMs: 1000, cpu: s.seconds.slice(-60).map(x => x.cpu), mem: s.seconds.slice(-60).map(x => x.mem.usedMb) },
    tasks: jobs.slice(0, 8).concat(system ? [system] : []), taskCount: jobs.length, totals: p ? p.totals : null, procsAt: s.procsAt };
}
function perfState(s, range, now) {
  const points = range === '24h' ? s.minutes.slice() : s.seconds.slice(range === '60s' ? -60 : -600);
  return { ok: true, name: s.config.name, range, resolution: range === '24h' ? '1m' : '1s', points, host: s.host, latest: s.latest, status: s.status, stale: stale(s, now) };
}
function processesState(s) { const p = s.procs; return { ok: true, name: s.config.name, at: s.procsAt, totals: p ? p.totals : null, tasks: p ? p.tasks : [], processes: p ? p.processes : [], omitted: p ? p.omitted : 0, fs: s.fs }; }

function createRemoteHostsMonitor(deps = {}) {
  const spawn = deps.spawn || spawnChild, now = deps.now || Date.now, later = deps.setTimeout || setTimeout, cancel = deps.clearTimeout || clearTimeout;
  const interval = deps.setInterval || setInterval, clearIntervalFn = deps.clearInterval || clearInterval;
  const readFile = deps.readFile || ((file) => fs.readFileSync(file, 'utf8')), statFile = deps.statFile || fs.statSync;
  const states = new Map(); let running = false, stopped = false, reloadTimer, watchdogTimer, lastStamp = Symbol('initial'), configError = null;
  function remove(s) { s.removed = true; if (s.retry) cancel(s.retry); s.retry = null; if (s.child) { const c = s.child; s.child = null; c.kill(); } s.status = 'offline'; }
  function disconnect(s, child, code, explicit) {
    if (s.child !== child) return;
    s.child = null; s.status = 'offline';
    if (!explicit && !s.forcedError) s.lastError = s.stderr.trim().split(/\r?\n/).filter(Boolean).pop() || `连接断开(退出码 ${code})`;
    const good = s.onlineAt !== null && now() - s.onlineAt >= 60000;
    if (good) s.failures = 0; else { s.failures++; s.targetIndex = (s.targetIndex + 1) % s.config.targets.length; }
    const delay = s.protocolBad ? BACKOFF_MS[BACKOFF_MS.length - 1] : BACKOFF_MS[Math.min(good ? 0 : s.failures - 1, BACKOFF_MS.length - 1)];
    if (running && !s.removed) s.retry = later(() => { s.retry = null; connect(s); }, delay);
  }
  function connect(s) {
    if (!running || s.removed) return;
    s.target = s.config.targets[s.targetIndex]; s.status = 'connecting'; s.startedAt = now(); s.onlineAt = null; s.stderr = ''; s.forcedError = false; s.protocolBad = false;
    let child;
    try { child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', s.target, s.config.python, s.config.agentPath, 'stream', '--backfill-minutes', '1440'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { child = {}; s.child = child; s.lastError = e.code === 'ENOENT' ? '本机找不到 ssh 命令' : e.message; disconnect(s, child, null, true); return; }
    s.child = child;
    const fail = message => { s.lastError = message; s.forcedError = true; child.kill(); };
    child.stdout.on('data', createLineSplitter(line => {
      let msg; try { msg = JSON.parse(line); } catch { s.badLines++; return; }
      if (!msg || typeof msg !== 'object') { s.badLines++; return; }
      if (msg.type === 'hello') {
        if (msg.protocol !== PROTOCOL) { s.protocolBad = true; fail(`采集程序协议版本不对:收到 ${msg.protocol},需要 1,请重装采集程序`); return; }
        s.status = 'online'; s.onlineAt = now(); s.host = msg.host; s.agentVersion = msg.agentVersion; s.daemon = msg.daemon; s.connectedAt = new Date(now()).toISOString(); s.lastError = null;
      } else if (msg.type === 'history' && Array.isArray(msg.points) && (msg.resolution === '1s' || msg.resolution === '1m')) {
        const points = msg.points.slice().sort((a, b) => a.t - b.t); if (msg.resolution === '1s') s.seconds = points.slice(-RING_1S); else s.minutes = points.slice(-RING_1M);
      } else if (msg.type === 'sample' && msg.point && typeof msg.point.t === 'number') {
        if (!s.seconds.length || msg.point.t > s.seconds[s.seconds.length - 1].t) { s.seconds.push(msg.point); if (s.seconds.length > RING_1S) s.seconds.shift(); s.latest = msg.point; }
      } else if (msg.type === 'minute' && msg.point && typeof msg.point.t === 'number') {
        s.minutes = s.minutes.filter(x => x.t !== msg.point.t); s.minutes.push(msg.point); s.minutes.sort((a, b) => a.t - b.t); s.minutes = s.minutes.slice(-RING_1M);
      } else if (msg.type === 'procs' && Array.isArray(msg.tasks) && Array.isArray(msg.processes)) {
        s.procs = msg; s.procsAt = msg.at || null; s.fs = Array.isArray(msg.fs) ? msg.fs : [];
      } else if (msg.type === 'notice' && typeof msg.code === 'string') {
        s.notice = { code: msg.code, message: msg.message, at: new Date(now()).toISOString() }; if (msg.code === 'daemon-stale') s.daemon = false; if (msg.code === 'daemon-back') s.daemon = true;
      } else { s.badLines++; return; }
      s.lastDataAt = now();
    }, { onOverflow: () => { s.badLines++; } }));
    child.stderr.on('data', chunk => { s.stderr = (s.stderr + chunk.toString()).slice(-2000); });
    child.on('error', error => { s.lastError = error.code === 'ENOENT' ? '本机找不到 ssh 命令' : error.message; disconnect(s, child, null, true); });
    child.on('exit', code => disconnect(s, child, code, false));
  }
  function reload() {
    let stamp, parsed;
    try { const st = statFile(deps.configFile); stamp = st.mtimeMs; } catch (e) { stamp = e.code === 'ENOENT' ? 'missing' : `error:${e.message}`; }
    if (stamp === lastStamp) return; lastStamp = stamp;
    if (stamp === 'missing') parsed = { hosts: [], error: null };
    else if (typeof stamp === 'string' && stamp.startsWith('error:')) parsed = { hosts: [], error: `读取配置失败: ${stamp.slice(6)}` };
    else { try { parsed = parseRemoteHostsConfig(readFile(deps.configFile, 'utf8')); } catch (e) { parsed = { hosts: [], error: `读取配置失败: ${e.message}` }; } }
    configError = parsed.error;
    const wanted = new Map(parsed.hosts.map(x => [x.name, x]));
    for (const [name, state] of states) if (!wanted.has(name) || JSON.stringify(state.config) !== JSON.stringify(wanted.get(name))) { remove(state); states.delete(name); }
    for (const config of parsed.hosts) if (!states.has(config.name)) {
      const s = { config, status: 'offline', target: null, targetIndex: 0, failures: 0, child: null, retry: null, removed: false, seconds: [], minutes: [], latest: null, lastDataAt: null, lastError: null, notice: null, agentVersion: null, daemon: null, host: null, procs: null, procsAt: null, fs: [], badLines: 0 };
      states.set(config.name, s); connect(s);
    }
  }
  function watchdog() { for (const s of states.values()) if (s.child) {
    if (s.status === 'online' && s.lastDataAt !== null && now() - s.lastDataAt > SILENT_MS) { s.lastError = '15 秒没收到数据,已断开重连'; s.forcedError = true; s.child.kill(); }
    else if (s.status === 'connecting' && now() - s.startedAt >= CONNECT_MS) { const last = s.stderr.trim().split(/\r?\n/).filter(Boolean).pop() || ''; s.lastError = `30 秒没连上:${last}`; s.forcedError = true; s.child.kill(); }
  } }
  return { start() { if (running || stopped) return; running = true; reload(); reloadTimer = interval(reload, RELOAD_MS); watchdogTimer = interval(watchdog, 5000); },
    stop() { if (stopped) return; stopped = true; running = false; if (reloadTimer) clearIntervalFn(reloadTimer); if (watchdogTimer) clearIntervalFn(watchdogTimer); for (const s of states.values()) remove(s); },
    list(at = now()) { return { ok: true, configError, hosts: Array.from(states.values(), s => summary(s, at)) }; },
    perf(name, range, at = now()) { if (!['60s', '10m', '24h'].includes(range)) throw new Error('range 只能是 60s、10m、24h'); const s = states.get(name); return s ? perfState(s, range, at) : null; },
    processes(name, at = now()) { const s = states.get(name); return s ? processesState(s, at) : null; } };
}
module.exports = { PROTOCOL, RING_1S, RING_1M, STALE_MS, SILENT_MS, CONNECT_MS, RELOAD_MS, BACKOFF_MS, parseRemoteHostsConfig, createLineSplitter, createRemoteHostsMonitor };
