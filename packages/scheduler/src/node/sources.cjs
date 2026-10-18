'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const p = require('../protocol/contract.cjs');
const client = require('../sched/client/sched.cjs');

const same = (a, b) => p.canonicalJson(a) === p.canonicalJson(b);
const submissionIdentity = request => ({ stage: 'submission', ticketId: client.deriveTicketId(request.project, request.idempotencyKey),
  submissionHash: p.contentHash(request), project: request.project });
function git(cwd, args, timeoutMs = 12000) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    (error, output) => error ? reject(error) : resolve(output.trim())));
}
async function codeAt(cwd, request) {
  if (request.codeRef.kind === 'commit') return { kind: 'commit', value: await git(cwd, ['rev-parse', '--verify', 'HEAD']) };
  // Keep the original fingerprint algorithm off the supervision event loop.
  return new Promise((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      try { parentPort.postMessage({value:require(workerData.module).contentFingerprint(workerData.cwd,workerData.targets)}); }
      catch(e) { parentPort.postMessage({error:e.message}); }`, { eval: true, execArgv: [], workerData: {
      module: require.resolve('../sched/client/sched.cjs'), cwd, targets: request.work.targetPaths,
    } });
    let replied = false;
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('SOURCE_FINGERPRINT_TIMEOUT')); }, 120000);
    worker.once('message', value => { replied = true; clearTimeout(timer); value.error ? reject(new Error(value.error)) : resolve(value.value); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code || !replied) reject(new Error('SOURCE_FINGERPRINT_EXIT')); });
  });
}
async function original(gateway, identity, expectedSource, options) {
  const found = await gateway.submissionSources.get(identity, expectedSource, options);
  if (found.status !== 'found') throw new Error(found.reason || 'SOURCE_UNKNOWN');
  p.validateRequest('submission', found.request);
  if (!same(submissionIdentity(found.request), identity) || found.source.submissionHash !== identity.submissionHash
    || expectedSource && !same(expectedSource, found.source)) throw new Error('SOURCE_BINDING');
  if (found.source.method === 'ipc-peer' && found.source.observedOwnerSid !== found.peer.sid) throw new Error('SOURCE_PEER');
  if (!path.isAbsolute(found.localContext.cwd)) throw new Error('SOURCE_CWD');
  const cwd = await fs.realpath(found.localContext.cwd);
  if (path.resolve(cwd).toLowerCase() !== path.resolve(found.localContext.cwd).toLowerCase()) throw new Error('SOURCE_CWD_CHANGED');
  return { ...found, cwd };
}
module.exports = { original, codeAt, submissionIdentity, git };
