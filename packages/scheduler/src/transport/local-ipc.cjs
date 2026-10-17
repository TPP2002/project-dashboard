'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { randomUUID } = require('node:crypto');
const { FramedStream, jsonCodec, failure, bounded, timeout } = require('./framed.cjs');
const p = require('../protocol/contract.cjs');

const helperCodec = { encode: jsonCodec.encode, decode(bytes) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } };
function nativeDiagnostics(child, stream) {
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-4096); });
  stream.on('closed', error => {
    if (error?.code === 'DISCONNECTED' && stderr.trim()) error.message += ': ' + stderr.trim();
  });
  return () => stderr;
}
function nativeProcess(config) {
  if (process.platform !== 'win32') throw failure('WINDOWS_REQUIRED');
  if (!path.isAbsolute(config.powershell)) throw failure('NATIVE_HOST_NOT_CONFIGURED');
  return spawn(config.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'native-pipe.ps1'),
    '-Source', path.join(__dirname, 'native-pipe.cs')], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
}
function checkPeer(peer, policies) {
  if (!peer || !/^S-1-\d+(?:-\d+)+$/.test(peer.sid) || !Number.isSafeInteger(peer.pid) || peer.pid < 1 ||
      !/^[1-9]\d*$/.test(peer.creationFileTime) || !/^[0-9a-f]{16}$/.test(peer.logonSessionId)) throw failure('PEER_IDENTITY');
  if (!policies.some(policy => policy.sid === peer.sid && policy.logonSessionId === peer.logonSessionId &&
      (policy.pid === undefined || policy.pid === peer.pid && policy.creationFileTime === peer.creationFileTime))) throw failure('PEER_DENIED');
  return Object.freeze({ ...peer });
}
// Trusted configuration/bootstrap utility, deliberately absent from semantic RPC. Identity
// always comes from the native OS probe of this process; callers cannot supply a PID or SID.
async function readParentIdentity(config, options) {
  const ms = timeout(options), child = nativeProcess(config);
  const stream = new FramedStream(child.stdout, child.stdin, { codec: helperCodec, timeoutMs: ms });
  nativeDiagnostics(child, stream);
  child.on('error', error => stream.close(error)); child.on('exit', () => stream.close(failure('DISCONNECTED')));
  stream.once('closed', () => child.kill());
  const reply = new Promise((resolve, reject) => {
    stream.once('closed', reject);
    stream.once('frame', frame => {
      try {
        if (frame.type !== 'parent-identity' || Object.keys(frame).sort().join(',') !== 'peer,type' ||
            !frame.peer || Object.keys(frame.peer).sort().join(',') !== 'creationFileTime,logonSessionId,pid,sid' ||
            frame.peer.pid !== process.pid) throw failure('PEER_IDENTITY');
        resolve(checkPeer(frame.peer, [frame.peer]));
      } catch (error) { reject(error); }
    });
  });
  reply.catch(() => {});
  try {
    await stream.send({ mode: 'parent-identity', timeoutMs: ms, parentPid: process.pid }, options);
    return await bounded(reply, options, () => stream.close(failure('TIMEOUT')));
  } finally { stream.close(); }
}
async function createNativeServer(config, accept) {
  if (config.cli.name === config.execution.name) throw failure('ENDPOINTS_MUST_DIFFER');
  const cliSids = config.cli.peers.map(x => x.sid);
  let executionPeers, parentPeer;
  const probes = new Map();
  const child = nativeProcess(config);
  const exited = new Promise(resolve => child.once('close', resolve));
  const stream = new FramedStream(child.stdout, child.stdin, { codec: helperCodec, timeoutMs: config.timeoutMs });
  const diagnostics = nativeDiagnostics(child, stream);
  child.on('error', error => stream.close(error)); child.on('exit', () => stream.close(failure('DISCONNECTED')));
  stream.once('closed', () => child.kill());
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  stream.once('closed', readyReject);
  stream.once('closed', error => { for (const probe of probes.values()) probe.reject(error); probes.clear(); });
  async function verifyExecution(peer, options = { timeoutMs: config.timeoutMs }) {
    checkPeer(peer, executionPeers ?? []);
    if (stream.closed) throw failure('DISCONNECTED');
    if (probes.size >= 32) throw failure('BUFFER_PRESSURE');
    const id = randomUUID();
    let resolve, reject;
    const answer = new Promise((yes, no) => { resolve = yes; reject = no; }); answer.catch(() => {});
    probes.set(id, { resolve, reject });
    try {
      await stream.send({ control: 'verify-peer', id, pid: peer.pid }, options);
      const actual = await bounded(answer, options);
      checkPeer(actual, [peer]);
      return actual;
    } finally { probes.delete(id); }
  }
  stream.on('frame', async frame => {
    try {
      if (frame.type === 'ready') {
        if (executionPeers) throw failure('NATIVE_FRAME');
        if (frame.parentPeer?.pid !== process.pid) throw failure('PEER_IDENTITY');
        parentPeer = checkPeer(frame.parentPeer, [{ sid: config.serviceSid, logonSessionId: config.serviceLogonSessionId }]);
        // Shared-account broad policies bind only this composition process, never every process
        // with that SID. Other trusted hosts require an administrator-configured exact birth.
        executionPeers = config.execution.peers.map(policy => {
          if (cliSids.includes(policy.sid) && policy.pid === undefined) {
            checkPeer(parentPeer, [policy]); return parentPeer;
          }
          if (policy.pid !== undefined) checkPeer(policy, [policy]);
          return Object.freeze({ ...policy });
        });
        readyResolve(); return;
      }
      if (frame.type === 'peer') {
        const probe = probes.get(frame.id); if (!probe) return; // expired private probe
        frame.error ? probe.reject(failure('PEER_DENIED')) : probe.resolve(frame.peer);
        return;
      }
      if (frame.type !== 'request' || !['cli', 'execution'].includes(frame.endpoint) || !/^[0-9a-f]{32}$/.test(frame.id)) throw failure('NATIVE_FRAME');
      const bytes = Buffer.from(frame.dataBase64, 'base64');
      if (bytes.length > 300000 || bytes.toString('base64') !== frame.dataBase64) throw failure('FRAME_TOO_LARGE');
      const request = jsonCodec.decode(bytes);
      let response;
      try {
        const peer = checkPeer(frame.peer, frame.endpoint === 'execution' ? executionPeers : config.cli.peers);
        response = { ok: true, id: request.id, value: await bounded(accept(frame.endpoint, peer, request), { timeoutMs: config.timeoutMs }) };
      }
      catch (error) { response = { ok: false, id: request.id ?? 'invalid', error: error.code ?? 'IO_FAILURE' }; }
      const reply = Buffer.from(jsonCodec.encode(response));
      if (reply.length > 300000) throw failure('FRAME_TOO_LARGE');
      await stream.send({ id: frame.id, dataBase64: reply.toString('base64') });
    } catch (error) { stream.close(error); }
  });
  try {
    await stream.send({ timeoutMs: config.timeoutMs, serviceSid: config.serviceSid, parentPid: process.pid,
      protectedWriterSids: config.protectedWriterSids, protectedPaths: config.protectedPaths,
      endpoints: ['cli', 'execution'].map(kind => ({ kind, name: config[kind].name, allowedSids: config[kind].peers.map(x => x.sid) })) });
    await bounded(ready, { timeoutMs: config.startupTimeoutMs }, () => stream.close(failure('TIMEOUT')));
    for (const peer of executionPeers) if (peer.pid !== undefined) await verifyExecution(peer);
  } catch (error) { stream.close(error); throw error; }
  return { close() { stream.close(); return bounded(exited, { timeoutMs: config.startupTimeoutMs }); },
    onClose(listener) { stream.once('closed', listener); }, diagnostics, verifyExecution,
    localExecutionPeer() { if (stream.closed) throw failure('DISCONNECTED'); return checkPeer(parentPeer, executionPeers); } };
}
async function nativeCall(config, endpoint, request, options) {
  const ms = timeout(options), child = nativeProcess(config);
  const stream = new FramedStream(child.stdout, child.stdin, { codec: jsonCodec, timeoutMs: ms });
  nativeDiagnostics(child, stream);
  child.on('error', error => stream.close(error)); child.on('exit', () => stream.close(failure('DISCONNECTED')));
  stream.on('closed', () => child.kill());
  const id = randomUUID(), input = { id, ...request };
  const reply = new Promise((resolve, reject) => {
    stream.once('closed', reject);
    stream.once('frame', frame => {
      if (frame.id !== id || typeof frame.ok !== 'boolean') return reject(failure('UNKNOWN_REPLY'));
      frame.ok ? resolve(frame.value) : reject(failure(frame.error));
    });
  });
  reply.catch(() => {});
  try {
    await stream.send({ mode: 'client', timeoutMs: ms, name: config[endpoint].name,
      serviceSid: config.serviceSid, serviceLogonSessionId: config.serviceLogonSessionId,
      dataBase64: Buffer.from(jsonCodec.encode(input)).toString('base64') });
    return await bounded(reply, options, () => stream.close(failure('TIMEOUT')));
  } finally { stream.close(); }
}
function createNativeClientSession(config) {
  let child, stream, tail = Promise.resolve(), queued = 0, bytesQueued = 0, closed = false;
  async function start() {
    if (stream) return;
    child = nativeProcess(config);
    stream = new FramedStream(child.stdout, child.stdin, { codec: jsonCodec, timeoutMs: config.timeoutMs });
    nativeDiagnostics(child, stream);
    child.on('error', error => stream.close(error)); child.on('exit', () => stream.close(failure('DISCONNECTED')));
    stream.on('closed', () => { closed = true; child.kill(); });
    await stream.send({ mode: 'client-session', timeoutMs: config.timeoutMs, cli: config.cli, execution: config.execution ?? { name: 'unused' },
      serviceSid: config.serviceSid, serviceLogonSessionId: config.serviceLogonSessionId });
  }
  return {
    call(endpoint, request, options) {
      timeout(options);
      if (closed) return Promise.reject(failure('DISCONNECTED'));
      const id = randomUUID(), bytes = Buffer.from(jsonCodec.encode({ id, ...request }));
      if (queued >= 32 || bytesQueued + bytes.length > p.MAX_FRAME_BYTES || bytes.length > 300000) return Promise.reject(failure('BUFFER_PRESSURE'));
      queued++; bytesQueued += bytes.length;
      const work = tail.then(async () => {
        if (closed) throw failure('DISCONNECTED');
        await start();
        let frameListener, closeListener;
        try {
          const response = new Promise((resolve, reject) => {
            frameListener = frame => {
              if (frame.id !== id || typeof frame.ok !== 'boolean') reject(failure('UNKNOWN_REPLY'));
              else if (!frame.ok) reject(failure(frame.error)); else resolve(frame.value);
            };
            closeListener = reject; stream.once('frame', frameListener); stream.once('closed', closeListener);
          });
          response.catch(() => {});
          await stream.send({ endpoint, dataBase64: bytes.toString('base64') });
          return await response;
        } finally { stream.removeListener('frame', frameListener); stream.removeListener('closed', closeListener); }
      });
      const result = bounded(work, options, () => { closed = true; stream?.close(failure('TIMEOUT')); });
      tail = result.catch(() => {}).finally(() => { queued--; bytesQueued -= bytes.length; });
      return result;
    },
    close() { closed = true; stream?.close(); },
  };
}
module.exports = { createNativeServer, nativeCall, createNativeClientSession, checkPeer, readParentIdentity };
