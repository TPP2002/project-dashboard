'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const p = require('../protocol/contract.cjs');
const BLOCK = 128 * 1024;
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const filename = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value) || value === '.' || value === '..') throw new Error('OBJECT_NAME');
  return value;
};
async function contained(root, name) {
  root = path.resolve(root); const file = path.resolve(root, name);
  if (!inside(root, file)) throw new Error('OBJECT_ESCAPE');
  let current = path.parse(file).root;
  const parts = file.slice(current.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    const candidate = path.join(current, part);
    const stat = await fs.lstat(candidate, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('OBJECT_REPARSE');
    const canonical = path.resolve(await fs.realpath(candidate));
    // Walk from each canonical parent so Windows 8.3 names may expand without
    // granting a redirect to another directory. Links/junctions remain banned.
    if (path.relative(current, path.dirname(canonical)) !== '') throw new Error('OBJECT_REPARSE');
    if (path.relative(candidate, canonical) !== '') {
      if (process.platform !== 'win32') throw new Error('OBJECT_REPARSE');
      const target = await fs.lstat(canonical, { bigint: true });
      if (target.isSymbolicLink() || target.dev !== stat.dev || target.ino !== stat.ino) throw new Error('OBJECT_REPARSE');
    }
    current = canonical;
  }
  return current;
}
function bindingKey(identity) {
  if (!identity || !/^tk-[a-f0-9]{20}$/.test(identity.ticketId) || !/^a[1-9][0-9]*$/.test(identity.attemptId)
    || typeof identity.permitToken !== 'string' || !identity.permitToken) throw new Error('OBJECT_BINDING');
  return p.contentHash({ ticketId: identity.ticketId, attemptId: identity.attemptId, permitToken: identity.permitToken });
}
function createObjectStore({ root, maxObjectBytes = 512 * 1024 * 1024 }) {
  if (!path.isAbsolute(root) || !Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) throw new Error('OBJECT_CONFIG');
  const pending = new Map();
  async function init() { await fs.mkdir(root, { recursive: true }); await contained(root, '.'); }
  async function publish(identity, sourceRoot, name) {
    filename(name); const key = bindingKey(identity); await init();
    const source = await contained(sourceRoot, name);
    const input = await fs.open(source, 'r');
    const staging = `.object-${randomUUID()}.tmp`;
    let output;
    try {
      const before = await input.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(maxObjectBytes)) throw new Error('OBJECT_SIZE');
      output = await fs.open(path.join(root, staging), 'wx');
      const hash = createHash('sha256'), buffer = Buffer.alloc(BLOCK);
      let offset = 0;
      while (offset < Number(before.size)) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(BLOCK, Number(before.size) - offset), offset);
        if (!bytesRead) throw new Error('OBJECT_CHANGED');
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, offset + written);
          if (!result.bytesWritten) throw new Error('OBJECT_WRITE_STALLED');
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      const after = await input.stat({ bigint: true });
      await contained(sourceRoot, name);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('OBJECT_CHANGED');
      const digest = hash.digest('hex');
      const ref = { objectId: p.contentHash([key, name, digest, offset]), hash: digest, size: offset };
      await output.sync(); await output.close(); output = null;
      const destination = path.join(root, ref.objectId + '.blob');
      try { await fs.link(path.join(root, staging), destination); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await fs.open(await contained(root, ref.objectId + '.blob'), 'r');
        try {
          const existingStat = await existing.stat();
          if (!existingStat.isFile() || existingStat.size !== ref.size) throw new Error('OBJECT_SIZE');
          const verified = createHash('sha256'); let position = 0;
          while (position < ref.size) {
            const part = await existing.read(buffer, 0, Math.min(BLOCK, ref.size - position), position);
            if (!part.bytesRead) throw new Error('OBJECT_TRUNCATED');
            verified.update(buffer.subarray(0, part.bytesRead)); position += part.bytesRead;
          }
          if (verified.digest('hex') !== ref.hash) throw new Error('OBJECT_HASH');
        } finally { await existing.close(); }
      }
      // Metadata is an immutable allowlist, never a caller-supplied pathname.
      const metadata = path.join(root, ref.objectId + '.json');
      const bytes = p.canonicalJson({ ref, binding: key });
      try { const fd = await fs.open(metadata, 'wx'); try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); } }
      catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(await contained(root, ref.objectId + '.json'), 'utf8') !== bytes) throw error; }
      return ref;
    } finally { await input.close(); if (output) await output.close(); await fs.unlink(path.join(root, staging)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function read(identity, request, kind) {
    p.validateRequest(kind, request);
    const ref = request.object;
    if (!/^[0-9a-f]{64}$/.test(ref.objectId)) throw new Error('UNKNOWN_OBJECT');
    const metadata = JSON.parse(await fs.readFile(await contained(root, ref.objectId + '.json'), 'utf8'));
    if (metadata.binding !== bindingKey(identity) || p.canonicalJson(metadata.ref) !== p.canonicalJson(ref)) throw new Error('OBJECT_BINDING');
    const fd = await fs.open(await contained(root, ref.objectId + '.blob'), 'r');
    try {
      const stat = await fd.stat(); if (!stat.isFile() || stat.size !== ref.size || stat.size > maxObjectBytes) throw new Error('OBJECT_SIZE');
      const hash = createHash('sha256'), buffer = Buffer.alloc(BLOCK), data = Buffer.alloc(request.length);
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await fd.read(buffer, 0, Math.min(BLOCK, stat.size - offset), offset);
        if (!bytesRead) throw new Error('OBJECT_TRUNCATED');
        hash.update(buffer.subarray(0, bytesRead));
        const from = Math.max(offset, request.offset), to = Math.min(offset + bytesRead, request.offset + request.length);
        if (to > from) buffer.copy(data, from - request.offset, from - offset, to - offset);
        offset += bytesRead;
      }
      if (hash.digest('hex') !== ref.hash) throw new Error('OBJECT_HASH');
      return { ...request, dataBase64: data.toString('base64'), chunkHash: createHash('sha256').update(data).digest('hex') };
    } finally { await fd.close(); }
  }
  return {
    // Serialize identical captures only; hashing and copying yield every chunk.
    publish(identity, sourceRoot, name) {
      const key = p.canonicalJson([bindingKey(identity), sourceRoot, name]);
      if (!pending.has(key)) {
        const work = publish(identity, sourceRoot, name); pending.set(key, work);
        work.finally(() => pending.delete(key)).catch(() => {});
      }
      return pending.get(key);
    },
    read,
    async artifacts(identity, artifacts, artifactRoot) {
      if (!artifacts?.manifest && !artifacts?.zip) return undefined;
      try {
        const refs = { state: 'ready' };
        for (const name of ['manifest', 'zip']) if (artifacts[name]) refs[name] = await publish(identity, artifactRoot, filename(artifacts[name]));
        if (refs.zip && refs.zip.size !== artifacts.zipBytes) throw new Error('ARTIFACT_ZIP_SIZE');
        return refs;
      } catch (error) { return { state: 'unavailable', reason: String(error.message).slice(0, 4096) }; }
    },
  };
}
module.exports = { createObjectStore, contained, bindingKey };
