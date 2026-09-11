'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const freePort = require('../../../scripts/free-port.cjs');
const c = require('../../../core/schedContract.cjs');
const ROOT = path.resolve(__dirname, '../../..');
const AT = '2026-09-12T00:00:00.000Z';
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function temporary(t, beforeCleanup = async () => {}) {
  const base = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, 'sched-fixture-'));
  t.after(async () => {
    await beforeCleanup();
    assert.equal(path.dirname(path.resolve(dir)), base);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function heartbeat(at = AT) {
  const machine = (name, host) => ({ name, preference: host ? 1 : 0, quotaCores: 20, grantedCores: 4,
    externalLoadCores: 1.25, availableCores: 2.75, overCommitted: false, fresh: true, online: true,
    ci: 'idle', ownerHold: false, reservation: host ? { requestedCores: 5, fulfilledCores: 3.5, untilAt: null } : null,
    heartbeatAt: at, loadSampledAt: at });
  return { machine: 'fixture-host', pid: 123, protocol: 25, head: 'a'.repeat(40), at, tick: 7,
    cursorSeq: 20, queued: 0, granted: 0, machines: [machine('fixture-host', true), machine('fixture-worker', false)], queue: [], locks: [] };
}
function initialize(share) {
  const paths = c.schedPaths(share);
  for (const dir of [paths.control, paths.staging, paths.tickets, paths.commands, paths.commandReceipts]) fs.mkdirSync(dir, { recursive: true });
  write(paths.format, { formatVersion: 1, capabilities: ['canonical-json-sha256', 'reservation-expiry'], createdAt: AT });
  write(paths.dispatcher, { machine: 'fixture-host', createdAt: AT, createdBy: 'fixture' });
  write(paths.heartbeat, heartbeat());
  return paths;
}
function ticket(index, { state = 'passed', project = 'sample', machine = 'fixture-worker', submitter = 'fixture-dispatcher', registerOnly = false } = {}) {
  const id = `tk-${index.toString(16).padStart(20, '0')}`;
  const createdAt = new Date(Date.parse(AT) + index * 60000).toISOString();
  const terminal = ['passed', 'failed', 'cancelled', 'voided'].includes(state);
  const requestedCores = registerOnly ? 0 : 4;
  const timing = { queuedMs: 1000, runningMs: 2000, pausedMs: 3000, slowMs: 4000 };
  const request = { idempotencyKey: `fixture-${index}`, project, submitter, category: registerOnly ? 'codex-build' : 'unit-test', title: `测试任务 ${index}`,
    work: { type: 'test', targetPaths: ['test/sample.test.cjs'] }, requestedCores, allowedMachines: ['fixture-host', 'fixture-worker'],
    codeRef: { kind: 'commit', value: 'b'.repeat(40) }, resources: { exclusive: [] }, createdAt };
  const permit = machine && !registerOnly ? { ticketId: id, attemptId: 'a1', token: 'fixture-token', machine, category: request.category, grantedCores: requestedCores, issuedAt: createdAt } : null;
  const endedAt = terminal ? new Date(Date.parse(createdAt) + 10000).toISOString() : null;
  return { formatVersion: 1, ticketId: id, request, contentHash: c.contentHash(request), state, registerOnly,
    pauseReasons: state === 'paused' ? ['manual'] : [], cancelRequested: false, currentAttemptId: 'a1', band: 1, queuedAt: createdAt,
    createdAt, updatedAt: endedAt || createdAt, endedAt, unsatisfiableReason: null, accountedAt: endedAt || createdAt,
    pendingQueue: null, timing, lastSeq: index,
    attempts: [{ attemptId: 'a1', queuedAt: createdAt, startedAt: state === 'queued' ? null : createdAt, endedAt,
      grantedCores: requestedCores, permit, intent: null, dispatchedAt: null, codeRef: request.codeRef,
      result: terminal ? { outcome: state, reason: 'fixture result' } : null, timing, segments: [] }],
    timeline: [{ v: 1, seq: index, at: createdAt, type: 'submitted', ticketId: id, attemptId: 'a1', data: { request, contentHash: c.contentHash(request) }, sha256: 'c'.repeat(64) }] };
}

async function startServer(t, options = {}) {
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill();
    });
  };
  const dir = temporary(t, stop), share = path.join(dir, 'share'), legacy = path.join(dir, 'leases');
  const paths = initialize(share);
  fs.mkdirSync(legacy);
  const registry = path.join(dir, 'registry.json');
  write(registry, { schemaVersion: '1.0', projects: {} });
  const env = { ...process.env, DASHBOARD_HOME: dir, DASHBOARD_REGISTRY: registry,
    DASHBOARD_GLOBAL_SETTINGS: path.join(dir, 'global-settings.json'), DASHBOARD_CODEX_SESSIONS: path.join(dir, 'sessions'),
    DASHBOARD_EVENT_WEBHOOK: '', DASHBOARD_MODULES: options.modules ?? 'cpu', DASHBOARD_NO_OPEN: '1', DASHBOARD_NO_RESTART: '1',
    DASHBOARD_POLL_MS: '500', DASHBOARD_SCHED_SHARE: share, CPU_LEASE_DIR: legacy, CPU_QUOTA_PCT: '100',
    DASHBOARD_PORT: String(await freePort()) };
  if (options.settingsShare) {
    write(path.join(dir, 'settings.json'), { schedShare: share });
    delete env.DASHBOARD_SCHED_SHARE;
  }
  child = spawn(process.execPath, [path.join(ROOT, 'server/server.cjs')], { cwd: ROOT, env, windowsHide: true });
  const base = await new Promise((resolve, reject) => {
    let out = '', err = '', settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`启动超时\n${out}\n${err}`)), 15000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => {
      out += value; const match = /127\.0\.0\.1:(\d+)\//.exec(out);
      if (match) finish(null, `http://127.0.0.1:${match[1]}`);
    });
    child.stderr.on('data', value => { err += value; });
    child.once('error', error => finish(error));
    child.once('exit', code => finish(new Error(`提前退出 ${code}\n${out}\n${err}`)));
  });
  const json = async (endpoint, body, headers = {}) => {
    const response = await fetch(base + endpoint, { headers, ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    }) });
    return { status: response.status, body: await response.json() };
  };
  return { dir, share, paths, legacy, base, json, stop };
}

function openStream(t, base) {
  return new Promise((resolve, reject) => {
    const pending = [], events = [];
    const req = http.get(base + '/api/stream', res => {
      let buffer = ''; res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const name = /^event:\s*(.+)$/m.exec(block)?.[1];
          const data = /^data:\s*(.+)$/m.exec(block)?.[1];
          if (!name || !data) continue;
          const event = { name, data: JSON.parse(data) }; events.push(event);
          for (const waiter of [...pending]) if (waiter.match(event)) {
            pending.splice(pending.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(event);
          }
        }
      });
      resolve({ wait: match => {
        const hit = events.find(match); if (hit) return Promise.resolve(hit);
        return new Promise((resolve, reject) => {
          const waiter = { match, resolve, timer: setTimeout(() => reject(new Error('等待调度推送超时')), 5000) };
          pending.push(waiter);
        });
      } });
    });
    req.on('error', reject);
    t.after(() => { req.destroy(); for (const waiter of pending) clearTimeout(waiter.timer); });
  });
}

module.exports = { temporary, initialize, heartbeat, ticket, startServer, openStream, write, AT };
