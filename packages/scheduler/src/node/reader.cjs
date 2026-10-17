'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const p = require('../protocol/contract.cjs');
const { createRemoteClient } = require('../sched/client/remote.cjs');

// In-process consumer of the same authenticated local semantic port. It does not
// open a session, allocate an uplink sequence or read the former authority.
function createNodeReader(gateway, config) {
  const options = { timeoutMs: config.timeoutMs ?? 12000 };
  const validationRoot = path.join(config.stateRoot, 'validation');
  const call = async request => gateway.semantic.accept(await gateway.localExecutionPeer(), request, options);
  return createRemoteClient({ timeoutMs: options.timeoutMs, port: {
    call, runtime: gateway.runtime,
    async readObject(entry, manifest) {
      // No chunk-local retry: READ_VERSION_UNAVAILABLE reaches the shared
      // whole-read budget, which discards this buffer and all preceding pages.
      if (entry.object.size > (config.maxObjectBytes ?? 512 * 1024 * 1024)) throw new Error('OBJECT_SIZE');
      const bytes = Buffer.alloc(entry.object.size);
      for (let offset = 0; offset < bytes.length;) {
        const length = Math.min(131072, bytes.length - offset), callId = randomUUID();
        const reply = await call({ kind: 'read-object', callId, snapshotId: manifest.snapshotId,
          ledgerCursor: manifest.ledgerCursor, entry, offset, length });
        if (reply.kind !== 'bytes' || reply.callId !== callId) throw new Error('OBJECT_REPLY');
        const chunk = p.validateRequest('projection.chunk', reply.chunk);
        if (chunk.requestId !== callId || chunk.offset !== offset || chunk.length !== length
          || p.canonicalJson(chunk.entry) !== p.canonicalJson(entry) || chunk.snapshotId !== manifest.snapshotId
          || p.canonicalJson(chunk.scope) !== p.canonicalJson(manifest.scope)
          || p.canonicalJson(chunk.ledgerCursor) !== p.canonicalJson(manifest.ledgerCursor)) throw new Error('OBJECT_CHUNK_BINDING');
        Buffer.from(chunk.dataBase64, 'base64').copy(bytes, offset); offset += length;
      }
      const { createHash } = require('node:crypto');
      if (createHash('sha256').update(bytes).digest('hex') !== entry.object.hash) throw new Error('OBJECT_HASH');
      const catalog = require('../sched/client/deployment-config.cjs').getDeploymentConfig();
      p.verifyProjectionObject(bytes, entry, manifest, { authorityId: manifest.scope.authorityId, authorityEpoch: manifest.scope.authorityEpoch,
        now: new Date().toISOString(), maxObjectBytes: config.maxObjectBytes ?? 512 * 1024 * 1024,
        principal: { id: config.machine, role: 'windows', machines: [config.machine], nodeIds: [], allowedKinds: [],
          readAccess: { role: 'node', machine: config.machine,
            projects: catalog.projects.filter(x => x.accepted && x.machines.includes(config.machine)).map(x => x.id),
            authorityKinds: p.SHARED_READ_KINDS } } });
      if (entry.kind === 'snapshot-bundle') {
        if (entry.contentType !== 'application/octet-stream') throw new Error('SNAPSHOT_CONTENT_TYPE');
        return bytes;
      }
      if (entry.kind === 'artifact-zip' || entry.kind === 'log-segment') return bytes;
      await fs.mkdir(validationRoot, { recursive: true });
      // Reuse gateway's original-domain validator for the full authenticated body.
      return require('../gateway/domain.cjs').validateDomain(bytes, entry, validationRoot);
    },
  } });
}
module.exports = { createNodeReader };
