'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const p = require('../protocol/contract.cjs');
const { failure, timeout } = require('../transport/framed.cjs');
const { atomicWrite } = require('./store.cjs');
const { validateDomain } = require('./domain.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_MANIFESTS = 64, MAX_RETIRED = 4096, MAX_METADATA_BYTES = 8 * 1024 * 1024;

function expectReply(reply, kind, fallback) {
  if (reply.kind === 'result') {
    const result = p.validateResult(reply.payload);
    if (result.status === 'business_rejected' && result.reason?.startsWith('READ_VERSION_UNAVAILABLE: ')) {
      throw failure('READ_VERSION_UNAVAILABLE');
    }
  }
  if (reply.kind !== kind) throw failure(fallback);
}

class ProjectionCache {
  constructor({ config, authorityId, authorityEpoch, request, accessForPeer, receivedAt = () => performance.now() }) {
    this.config = config; this.authorityId = authorityId; this.authorityEpoch = authorityEpoch;
    this.request = request; this.receivedAt = receivedAt; this.accessForPeer = accessForPeer; this.session = null; this.manifests = new Map(); this.inflight = 0; this.fetching = new Map();
    if (!path.isAbsolute(config.root) || !fs.lstatSync(config.root).isDirectory() || fs.lstatSync(config.root).isSymbolicLink() ||
        !Number.isSafeInteger(config.maxObjectBytes) || config.maxObjectBytes < 1 || !Number.isSafeInteger(config.maxCacheBytes) ||
        config.maxCacheBytes < config.maxObjectBytes || config.ttlMs < 1 || config.ttlMs > 60000) throw failure('CACHE_CONFIG');
    this.lastMonotonic = performance.now();
    this.retired = new Map(); this.metadataBytes = 0;
  }
  connect(session) { this.disconnect(); this.session = session; }
  disconnect() { this.session = null; this.manifests.clear(); this.retired.clear(); this.metadataBytes = 0; }
  context(peer) {
    const principal = this.accessForPeer(peer);
    if (!principal) throw failure('READ_DENIED');
    return { principal, authorityId: this.authorityId, authorityEpoch: this.authorityEpoch,
      now: new Date().toISOString(), maxObjectBytes: this.config.maxObjectBytes };
  }
  scope() { return { kind: 'authority-read', authorityId: this.authorityId, authorityEpoch: this.authorityEpoch }; }
  owner(peer) { return p.contentHash([peer.sid, this.context(peer).principal]); }
  key(manifest, peer) { return p.contentHash([this.owner(peer), manifest.snapshotId, manifest.ledgerCursor, manifest.requestId]); }
  touch(key, record) { this.manifests.delete(key); this.manifests.set(key, record); }
  retire(key) {
    const record = this.manifests.get(key); if (!record) return;
    this.manifests.delete(key); this.retired.set(key, record);
  }
  trim() {
    while (this.manifests.size > MAX_MANIFESTS) this.retire(this.manifests.keys().next().value);
    while (this.retired.size > MAX_RETIRED || this.metadataBytes > MAX_METADATA_BYTES) {
      if (!this.retired.size) this.retire(this.manifests.keys().next().value);
      const key = this.retired.keys().next().value;
      this.metadataBytes -= this.retired.get(key).metadataBytes; this.retired.delete(key);
    }
  }
  pageFor(local, peer) {
    if (local.snapshotId === null && local.pageToken === null) return null;
    const owner = this.owner(peer), query = p.contentHash(local.selectors);
    for (const [key, record] of [...this.manifests, ...this.retired]) {
      if (record.owner !== owner || record.query !== query || record.manifest.snapshotId !== local.snapshotId ||
          (local.pageToken !== null && record.manifest.nextPageToken !== local.pageToken)) continue;
      this.fresh(record); this.checkScope(record.manifest);
      if (this.retired.has(key)) throw failure('READ_VERSION_UNAVAILABLE');
      return record;
    }
    throw failure('CACHE_MANIFEST_UNKNOWN');
  }
  checkScope(manifest) {
    if (p.canonicalJson(manifest.scope) !== p.canonicalJson(this.scope())) throw failure('MANIFEST_VERSION');
  }
  fresh(record) {
    const now = performance.now(), rollback = now < this.lastMonotonic; this.lastMonotonic = now;
    if (!this.session || record.session !== this.session || rollback || now >= record.deadline ||
        Date.now() >= Date.parse(record.manifest.expiresAt)) throw failure('CACHE_STALE');
  }
  file(entry) {
    if (!/^[a-f0-9]{64}$/.test(entry.object.hash)) throw failure('OBJECT_HASH');
    return path.join(this.config.root, `${entry.object.hash}.object`);
  }
  validate(bytes, entry, manifest, peer) {
    p.verifyProjectionObject(bytes, entry, manifest, this.context(peer));
    return validateDomain(bytes, entry, this.config.root);
  }
  async read(local, peer, callOptions) {
    const deadline = performance.now() + timeout(callOptions);
    const remainingOptions = () => {
      const timeoutMs = Math.ceil(deadline - performance.now());
      if (timeoutMs < 1) throw failure('TIMEOUT'); return { timeoutMs };
    };
    if (!this.session) throw failure('DISCONNECTED');
    const owner = this.owner(peer), previousPage = this.pageFor(local, peer);
    if (++this.inflight > 8) { this.inflight--; throw failure('BUFFER_PRESSURE'); }
    const session = this.session, pinned = [];
    try {
      const reply = await this.request('projection.catalog', { requestId: local.callId, scope: this.scope(),
        snapshotId: local.snapshotId, pageToken: local.pageToken, selectors: local.selectors, limit: 32 }, undefined, remainingOptions());
      if (session !== this.session) throw failure('CACHE_STALE');
      if (owner !== this.owner(peer)) throw failure('READ_DENIED');
      expectReply(reply, 'projection.manifest', 'MANIFEST_REQUIRED');
      // Start TTL at network receipt, before downloading objects. Cache reads never reset this timestamp.
      const received = this.receivedAt(reply), manifest = structuredClone(p.validateReadManifest(reply.payload));
      this.checkScope(manifest);
      if (manifest.requestId !== local.callId || (local.snapshotId !== null && manifest.snapshotId !== local.snapshotId) ||
          (previousPage && p.canonicalJson(previousPage.manifest.ledgerCursor) !== p.canonicalJson(manifest.ledgerCursor))) throw failure('MANIFEST_VERSION');
      if (!Number.isFinite(received)) throw failure('RECEIVE_TIME_UNKNOWN');
      const remaining = Date.parse(manifest.expiresAt) - Date.now();
      const record = { manifest, session, owner, query: p.contentHash(local.selectors),
        deadline: received + Math.min(this.config.ttlMs, remaining), objects: new Map() };
      record.metadataBytes = Buffer.byteLength(p.canonicalJson(manifest)) + 512;
      if (record.metadataBytes > MAX_METADATA_BYTES) throw failure('CACHE_CAPACITY');
      if (session !== this.session || remaining <= 0) throw failure('CACHE_STALE');
      this.fresh(record);
      let total = 0;
      for (const entry of manifest.entries) {
        const name = `${entry.object.hash}.object`; pinned.push(name); this.fetching.set(name, (this.fetching.get(name) ?? 0) + 1);
      }
      for (const entry of manifest.entries) {
        total += entry.object.size;
        if (entry.object.size > this.config.maxObjectBytes || total > this.config.maxCacheBytes) throw failure('CACHE_CAPACITY');
        if (entry.object.size) {
          const allowed = p.authorizeProjectionRead({ requestId: local.callId, scope: manifest.scope, snapshotId: manifest.snapshotId,
            ledgerCursor: manifest.ledgerCursor, entry, offset: 0, length: 1 }, manifest, this.context(peer));
          if (!allowed.allowed) throw failure(allowed.reason);
        } else p.verifyProjectionObject(Buffer.alloc(0), entry, manifest, this.context(peer));
        const file = this.file(entry); let bytes;
        if (fs.existsSync(file)) {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.object.size) throw failure('CACHE_CORRUPT');
          bytes = fs.readFileSync(file);
        } else {
          bytes = Buffer.alloc(entry.object.size);
          for (let offset = 0; offset < bytes.length;) {
            this.fresh(record);
            const length = Math.min(131072, bytes.length - offset);
            const requestId = randomUUID();
            const chunkReply = await this.request('projection.read', { requestId, scope: manifest.scope,
              snapshotId: manifest.snapshotId, ledgerCursor: manifest.ledgerCursor, entry, offset, length }, undefined, remainingOptions());
            this.fresh(record);
            if (owner !== this.owner(peer)) throw failure('READ_DENIED');
            expectReply(chunkReply, 'projection.chunk', 'CHUNK_REQUIRED');
            const chunk = p.validateRequest('projection.chunk', chunkReply.payload);
            if (chunk.requestId !== requestId || p.canonicalJson(chunk.scope) !== p.canonicalJson(manifest.scope) ||
                chunk.offset !== offset || chunk.length !== length || p.canonicalJson(chunk.entry) !== p.canonicalJson(entry) ||
                chunk.snapshotId !== manifest.snapshotId || p.canonicalJson(chunk.ledgerCursor) !== p.canonicalJson(manifest.ledgerCursor)) throw failure('CHUNK_VERSION');
            Buffer.from(chunk.dataBase64, 'base64').copy(bytes, offset); offset += length;
          }
        }
        this.validate(bytes, entry, manifest, peer);
        this.fresh(record);
        if (!fs.existsSync(file)) { this.makeRoom(bytes.length); atomicWrite(file, bytes); }
        record.objects.set(entry.object.objectId, { entry });
      }
      this.fresh(record);
      remainingOptions();
      const key = this.key(manifest, peer), old = this.manifests.get(key) ?? this.retired.get(key);
      if (old) record.deadline = Math.min(record.deadline, old.deadline);
      this.fresh(record);
      if (old) this.metadataBytes -= old.metadataBytes;
      this.manifests.delete(key); this.retired.delete(key);
      this.manifests.set(key, record); this.metadataBytes += record.metadataBytes; this.trim();
      return structuredClone(manifest);
    } finally {
      this.inflight--;
      for (const name of pinned) { const count = this.fetching.get(name) - 1; if (count) this.fetching.set(name, count); else this.fetching.delete(name); }
    }
  }
  makeRoom(required) {
    const files = fs.readdirSync(this.config.root).filter(name => /^[a-f0-9]{64}\.object$/.test(name));
    let used = 0;
    const pinned = new Set(this.fetching.keys());
    const records = files.map(name => { const stat = fs.lstatSync(path.join(this.config.root, name)); if (!stat.isFile() || stat.isSymbolicLink()) throw failure('CACHE_CORRUPT'); used += stat.size; return { name, size: stat.size }; });
    let count = records.length;
    for (const file of records) {
      if (used + required <= this.config.maxCacheBytes && count < 4096) break;
      if (!pinned.has(file.name)) {
        // Downloads pin all page files. Local chunk/findTicket reads are synchronous, so
        // eviction cannot interleave with their reads. Retire receipts before deleting bytes.
        for (const [key, record] of this.manifests) {
          if ([...record.objects.values()].some(object => `${object.entry.object.hash}.object` === file.name)) this.retire(key);
        }
        fs.unlinkSync(path.join(this.config.root, file.name)); used -= file.size; count--;
      }
    }
    this.trim();
    if (used + required > this.config.maxCacheBytes || count >= 4096) throw failure('CACHE_CAPACITY');
  }
  recordFor(local, peer) {
    const owner = this.owner(peer);
    let retiredMatch = false;
    for (const [key, record] of [...this.manifests, ...this.retired]) {
      if (record.owner !== owner) continue;
      if (record.manifest.snapshotId !== local.snapshotId || p.canonicalJson(record.manifest.ledgerCursor) !== p.canonicalJson(local.ledgerCursor)) continue;
      const entry = record.objects.get(local.entry.object.objectId)?.entry;
      if (!entry || p.canonicalJson(entry) !== p.canonicalJson(local.entry)) continue;
      this.fresh(record); this.checkScope(record.manifest);
      const allowed = p.authorizeProjectionRead({ requestId: local.callId, scope: record.manifest.scope, snapshotId: local.snapshotId,
        ledgerCursor: local.ledgerCursor, entry, offset: local.offset, length: local.length }, record.manifest, this.context(peer));
      if (!allowed.allowed) throw failure(allowed.reason);
      if (this.retired.has(key)) { retiredMatch = true; continue; }
      this.touch(key, record); return record;
    }
    if (retiredMatch) throw failure('READ_VERSION_UNAVAILABLE');
    throw failure('CACHE_MANIFEST_UNKNOWN');
  }
  chunk(local, peer) {
    const record = this.recordFor(local, peer), bytes = this.readBytes(local.entry);
    this.validate(bytes, local.entry, record.manifest, peer); this.fresh(record);
    const piece = bytes.subarray(local.offset, local.offset + local.length);
    return { requestId: local.callId, scope: record.manifest.scope, snapshotId: local.snapshotId, ledgerCursor: local.ledgerCursor,
      entry: local.entry, offset: local.offset, length: local.length, dataBase64: piece.toString('base64'), chunkHash: hash(piece) };
  }
  readBytes(entry) {
    const file = this.file(entry), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.object.size || stat.size > this.config.maxObjectBytes) throw failure('CACHE_CORRUPT');
    return fs.readFileSync(file);
  }
  findTicket(ticketId, peer) {
    const owner = this.owner(peer);
    for (const record of [...this.manifests.values()].reverse()) {
      if (record.owner !== owner) continue;
      try { this.fresh(record); } catch { continue; }
      for (const object of record.objects.values()) if (object.entry.kind === 'ticket' && object.entry.ticketId === ticketId) {
        const bytes = this.readBytes(object.entry);
        return this.validate(bytes, object.entry, record.manifest, peer);
      }
    }
    throw failure('TICKET_NOT_FRESH');
  }
}
module.exports = { ProjectionCache, hash };
