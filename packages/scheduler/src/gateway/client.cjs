'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const p = require('../protocol/contract.cjs');
const { createNativeClientSession } = require('../transport/local-ipc.cjs');
const { failure, timeout } = require('../transport/framed.cjs');

function createSemanticClient(config) {
  const received = new WeakMap(), preparations = new Map(), connection = createNativeClientSession(config);
  async function call(input, options) {
    const request = p.validateLocalSemanticRequest(input); timeout(options);
    const before = ['read', 'wait'].includes(request.kind) ? await connection.call('cli', { method: 'runtime' }, options) : null;
    let reply = await connection.call('cli', { method: 'call', request }, options);
    const executionRequest = ['local-run', 'local-run-read', 'local-run-cancel'].includes(request.kind);
    if (executionRequest && reply?.kind !== 'execution') throw failure('LOCAL_REPLY_KIND');
    if (reply?.kind === 'execution') {
      if (!executionRequest) throw failure('LOCAL_REPLY_KIND');
      reply = p.validateLocalExecutionReply(reply);
      if (request.kind !== 'local-run' && reply.runId !== request.runId) throw failure('LOCAL_REPLY_ID');
      if (request.kind === 'local-run-read') {
        if (reply.stdout.offset !== request.stdoutOffset || reply.stderr.offset !== request.stderrOffset) throw failure('LOCAL_REPLY_OFFSET');
        const bytes = reply.stdout.nextOffset - reply.stdout.offset + reply.stderr.nextOffset - reply.stderr.offset;
        if (bytes > request.maxBytes) throw failure('LOCAL_REPLY_LIMIT');
      }
    } else if (reply.kind === 'business') {
      p.validateResult(reply.result);
      if (!['submit', 'command', 'resident-renew'].includes(request.kind)) throw failure('LOCAL_REPLY_KIND');
    } else if (reply.kind === 'read') {
      if (!['read', 'wait'].includes(request.kind)) throw failure('LOCAL_REPLY_KIND');
      p.validateReadManifest(reply.manifest);
      if (reply.manifest.requestId !== request.callId) throw failure('LOCAL_REPLY_ID');
      const at = performance.now(), after = await connection.call('cli', { method: 'runtime' }, options);
      if (before.connection !== 'connected' || after.connection !== 'connected' || before.generation !== after.generation ||
          p.canonicalJson(before.scope) !== p.canonicalJson(after.scope)) throw failure('FENCED');
      received.set(reply.manifest, { at, generation: after.generation, scope: p.canonicalJson(after.scope) });
    } else if (reply.kind === 'bytes') {
      if (request.kind !== 'read-object' || reply.callId !== request.callId) throw failure('LOCAL_REPLY_ID');
      p.validateRequest('projection.chunk', reply.chunk);
      if (reply.chunk.requestId !== request.callId || reply.chunk.snapshotId !== request.snapshotId ||
          p.canonicalJson(reply.chunk.ledgerCursor) !== p.canonicalJson(request.ledgerCursor) ||
          p.canonicalJson(reply.chunk.entry) !== p.canonicalJson(request.entry) ||
          reply.chunk.offset !== request.offset || reply.chunk.length !== request.length) throw failure('LOCAL_REPLY_OBJECT');
    } else if (reply.kind !== 'pending' || reply.callId !== request.callId) throw failure('LOCAL_REPLY_KIND');
    return reply;
  }
  return Object.freeze({
    call, close() { preparations.clear(); connection.close(); },
    async readObject(entry, manifest, options = { timeoutMs: config.timeoutMs }) {
      if (!Number.isSafeInteger(config.cacheTtlMs) || config.cacheTtlMs < 1 || config.cacheTtlMs > 60000 ||
          !Number.isSafeInteger(config.maxObjectBytes) || config.maxObjectBytes < 1 || !path.isAbsolute(config.validationRoot ?? '')) throw failure('NOT_CONFIGURED');
      const validationStat = fs.lstatSync(config.validationRoot);
      if (!validationStat.isDirectory() || validationStat.isSymbolicLink()) throw failure('NOT_CONFIGURED');
      const receipt = received.get(manifest), at = receipt?.at;
      if (at === undefined || performance.now() - at >= config.cacheTtlMs || Date.now() >= Date.parse(manifest.expiresAt)) throw failure('CACHE_STALE');
      const before = await connection.call('cli', { method: 'runtime' }, options);
      if (before.connection !== 'connected' || before.generation !== receipt.generation || p.canonicalJson(before.scope) !== receipt.scope) throw failure('FENCED');
      if (!manifest.entries.some(item => p.canonicalJson(item) === p.canonicalJson(entry)) || entry.object.size > config.maxObjectBytes) throw failure('OBJECT_NOT_IN_MANIFEST');
      const bytes = Buffer.alloc(entry.object.size);
      for (let offset = 0; offset < bytes.length;) {
        const length = Math.min(131072, bytes.length - offset);
        const response = await call({ kind: 'read-object', callId: randomUUID(), snapshotId: manifest.snapshotId,
          ledgerCursor: manifest.ledgerCursor, entry, offset, length }, options);
        Buffer.from(response.chunk.dataBase64, 'base64').copy(bytes, offset); offset += length;
      }
      if (performance.now() - at >= config.cacheTtlMs || Date.now() >= Date.parse(manifest.expiresAt)) throw failure('CACHE_STALE');
      const after = await connection.call('cli', { method: 'runtime' }, options);
      if (after.connection !== 'connected' || after.generation !== receipt.generation || p.canonicalJson(after.scope) !== receipt.scope) throw failure('FENCED');
      // The server publishes only domain-validated bodies. The client independently verifies transfer integrity.
      if (before.scope.authorityId !== config.authorityId || manifest.scope.authorityEpoch !== before.scope.authorityEpoch) throw failure('FENCED');
      const verified = p.verifyProjectionObject(bytes, entry, manifest, { principal: config.readPrincipal,
        authorityId: config.authorityId, authorityEpoch: before.scope.authorityEpoch, now: new Date().toISOString(), maxObjectBytes: config.maxObjectBytes });
      return require('./domain.cjs').validateDomain(Buffer.from(verified.bytes), entry, config.validationRoot);
    },
    runtime: Object.freeze({
      current(options) { return connection.call('cli', { method: 'runtime' }, options); },
      async *changes(afterGeneration, options) {
        while (true) {
          const notice = await connection.call('cli', { method: 'runtime-change', afterGeneration }, options);
          if (!Number.isSafeInteger(notice.generation) || notice.generation <= afterGeneration) throw failure('RUNTIME_GENERATION');
          afterGeneration = notice.generation; yield notice;
        }
      },
    }),
    execution: Object.freeze({
      async acceptObservation(observation, options) {
        const result = await connection.call('execution', { method: 'observe', request: observation }, options);
        return p.validateResult(result);
      },
      async prepareObservation(observation, options) {
        for (const [id, value] of preparations) if (performance.now() >= value.expiresAt) preparations.delete(id);
        if (preparations.size >= 32) throw failure('PREPARATION_CAPACITY');
        const prepared = await connection.call('execution', { method: 'prepare', request: observation }, options);
        const envelope = p.decodeFrame(p.encodeFrame(prepared.envelope));
        if (typeof prepared.preparationId !== 'string' || envelope.kind !== observation.kind ||
            p.canonicalJson(envelope.payload) !== p.canonicalJson(observation.payload) ||
            p.canonicalJson(envelope.execution ?? null) !== p.canonicalJson(observation.identity ?? null)) throw failure('PREPARATION_BINDING');
        preparations.set(prepared.preparationId, { envelope, expiresAt: performance.now() + 5000 }); return prepared;
      },
      async sendPrepared(preparationId, options) {
        const expected = preparations.get(preparationId);
        if (!expected || performance.now() >= expected.expiresAt) { preparations.delete(preparationId); throw failure('UNKNOWN_PREPARATION'); }
        preparations.delete(preparationId);
        const result = await connection.call('execution', { method: 'send-prepared', preparationId }, options);
        if (p.canonicalJson(result.envelope) !== p.canonicalJson(expected.envelope)) throw failure('PREPARATION_BINDING');
        p.validateResponse(result.envelope, result.reply); return result;
      },
    }),
  });
}
module.exports = { createSemanticClient };
