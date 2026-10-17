'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');
const protocol = require('../protocol/contract.cjs');

const quoteWindows = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
const same = (a, b) => protocol.canonicalJson(a) === protocol.canonicalJson(b);

// One private anonymous pipe and one JobObject per attempt. Neither this adapter
// nor the C# host ever attaches to an existing service or adopts a numeric PID.
function createNativeGate({ scope, directory, executable, args, cwd, env = process.env, timeoutMs = 12000, maxLogBytes = 64 * 1024 * 1024, permitAuthorityFactory }) {
  if (process.platform !== 'win32') throw new Error('WINDOWS_NATIVE_REQUIRED');
  if (!path.isAbsolute(executable) || !/\.exe$/i.test(executable)) throw new Error('ABSOLUTE_EXECUTABLE_REQUIRED');
  if (!Array.isArray(args) || args.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('INVALID_ARGV');
  fs.mkdirSync(directory, { recursive: true });
  const hostEnv = {};
  for (const name of ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'ProgramFiles', 'ProgramFiles(x86)', 'PATH']) {
    const key = Object.keys(process.env).find(k => k.toLowerCase() === name.toLowerCase());
    if (key) hostEnv[name] = process.env[key];
  }
  Object.assign(hostEnv, { LOCALAPPDATA: directory, TEMP: directory, TMP: directory });
  const powershell = path.join(hostEnv.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, '../sched/native/remote-host.ps1')], { env: hostEnv, windowsHide: true, stdio: 'pipe' });
  const pending = new Map();
  const gateId = randomUUID();
  let sequence = 0, dead, identity, preparation, closing = false, stderr = '';
  const fail = error => {
    dead = Object.assign(error, { nativeHostUnavailable: true });
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
  };
  child.on('error', fail); child.stdin.on('error', fail);
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
  const closed = new Promise(resolve => child.once('close', code => {
    fail(new Error(`NATIVE_CLOSED:${code}:${stderr}`)); resolve(code);
  }));
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const result = JSON.parse(line), call = pending.get(result.id);
      if (!call) return;
      clearTimeout(call.timer); pending.delete(result.id);
      if (result.error) call.reject(Object.assign(new Error(result.error), { nativeRequestKind: call.kind })); else call.resolve(result.value);
    } catch (error) { fail(error); child.stdin.end(); }
  });
  const request = (kind, fields = {}) => new Promise((resolve, reject) => {
    if (dead || closing) { reject(dead ?? new Error('NATIVE_CLOSING')); return; }
    const id = ++sequence;
    const bytes = JSON.stringify({ id, kind, scope, identity, ...fields }) + '\n';
    if (Buffer.byteLength(bytes) > protocol.MAX_FRAME_BYTES) { reject(new Error('FRAME_TOO_LARGE')); return; }
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`NATIVE_TIMEOUT:${kind}`), { nativeRequestKind: kind })); }, timeoutMs);
    pending.set(id, { resolve, reject, timer, kind });
    child.stdin.write(bytes, error => { if (error) fail(error); });
  });
  const assertGate = id => { if (id !== gateId) throw new Error('UNKNOWN_GATE'); };
  return {
    gateId,
    async prepare(granted, { recordHost } = {}) {
      if (preparation) {
        if (!same(preparation.granted, granted)) throw new Error('PREPARE_IDENTITY_CHANGED');
        return preparation.promise;
      }
      const promise = (async () => {
        const before = await request('identity');
        if (before.error || before.pid !== child.pid || !before.creationFileTime) throw new Error('CONTROLLER_BIRTH_UNKNOWN');
        if (recordHost) recordHost({ pid: before.pid, creationFileTime: before.creationFileTime });
        const permitAuthority = permitAuthorityFactory?.({ pid: before.pid, creationFileTime: before.creationFileTime });
        const prepared = await request('prepare', { identity: granted, exe: executable,
          commandLine: [executable, ...args].map(quoteWindows).join(' '), cwd, dir: directory,
          environment: Object.keys(env).sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase())).map(key => {
            if (key.includes('=') || key.includes('\0') || String(env[key]).includes('\0')) throw new Error('INVALID_ENV');
            return `${key}=${env[key]}`;
          }).join('\0') + '\0\0', maxLogBytes, ...(permitAuthority ? { permitAuthority } : {}) });
        if (!same(prepared.controller, { pid: before.pid, creationFileTime: before.creationFileTime })) throw new Error('CONTROLLER_BIRTH_CHANGED');
        identity = prepared.identity;
        return { ...prepared, gateId, ...(permitAuthority ? { verifier: permitAuthority.verifier } : {}) };
      })();
      preparation = { granted: structuredClone(granted), promise };
      return promise;
    },
    async recordChallengeSend(id, envelope) {
      assertGate(id); protocol.decodeFrame(protocol.encodeFrame(envelope));
      return request('challenge', { envelope });
    },
    async acceptLease(id, envelope) {
      assertGate(id); protocol.validateLease(envelope.payload); protocol.decodeFrame(protocol.encodeFrame(envelope));
      return request('lease', { envelope });
    },
    async release(id, started, ack, projection, lease) {
      assertGate(id); protocol.validateResult(ack); protocol.validateProjection(projection);
      protocol.decodeFrame(protocol.encodeFrame(started));
      return request('release', { started, ack, projection, lease });
    },
    poll: binding => request('poll', binding ? { identity: binding } : {}),
    members: () => request('members'),
    action: action => request('action', { action }),
    act: (action, member, operationId) => request('act', { action, member, operationId }),
    check: (action, member, operationId) => request('check', { action, member, operationId }),
    stop: binding => request('stop', binding ? { identity: binding } : {}),
    fence: () => request('fence'),
    async close() {
      if (!closing) { closing = true; child.stdin.end(); }
      let timer;
      try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('NATIVE_CLOSE_UNKNOWN')), timeoutMs); })]); }
      finally { clearTimeout(timer); }
    },
  };
}
function suspensionTree(gate, granted) {
  return {
    async launch(input) {
      const prepared = await gate.prepare(granted, { recordHost: input.recordHost });
      return { root: prepared.root, host: prepared.controller };
    },
    async release() { throw new Error('REMOTE_RELEASE_REQUIRES_NATIVE_GATE'); },
    members: () => gate.members(),
    act: (action, member, operationId) => gate.act(action, member, operationId),
    check: (action, member, operationId) => gate.check(action, member, operationId),
    async poll() {
      const result = await gate.poll();
      if (result.verdict === 'unknown') throw Object.assign(new Error('TREE_STATE_UNKNOWN'), { nativeRequestKind: 'poll' });
      return { empty: result.empty, exitCode: result.exitCode };
    },
    kill: () => gate.fence(), close: () => gate.close(),
  };
}
module.exports = { createNativeGate, quoteWindows, suspensionTree };
