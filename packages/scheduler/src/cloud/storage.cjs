'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const p = require('../protocol/contract.cjs');
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });

function readJson(file, maxBytes = 4 * 1024 * 1024) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw failure('IO_FAILURE', 'persistent record exceeds bound or is not a regular file');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function syncDirectory(directory) {
  // Windows FlushFileBuffers on a directory is unsupported. Every file is flushed
  // before MoveFileEx; Linux additionally persists the directory rename/link.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function ensureDirectory(directory) {
  if (fs.existsSync(directory)) {
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw failure('IO_FAILURE', 'non-directory storage root');
    return;
  }
  ensureDirectory(path.dirname(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  syncDirectory(path.dirname(directory));
}
function atomicBytes(file, bytes, immutable = false) {
  ensureDirectory(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    if (immutable) {
      try { fs.linkSync(temp, file); }
      catch (error) {
        if (error.code !== 'EEXIST' || !fs.readFileSync(file).equals(Buffer.from(bytes))) throw error;
      }
    } else fs.renameSync(temp, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
// Local domain objects retain their original JSON semantics. Wire limits belong
// at encodeFrame; a complete ticket or WAL can legitimately exceed one frame.
function atomicJson(file, value, immutable = false) { atomicBytes(file, Buffer.from(JSON.stringify(value)), immutable); }

/** Disk point indexes, not a process-lifetime Map. Receipts, identities and
 * tombstones are retained for the authority's lifetime. Archival requires a
 * stopped/fenced writer and a complete restorable authority backup. */
function createStore(root, { fault = () => {} } = {}) {
  ensureDirectory(root);
  const metaPath = path.join(root, 'revision.json'), journalPath = path.join(root, 'transaction.json');
  const file = (table, key) => {
    if (!/^[a-z-]+$/.test(table)) throw failure('IO_FAILURE', 'invalid table');
    const digest = p.contentHash(key);
    return path.join(root, table, digest.slice(0, 2), `${digest}.json`);
  };
  const revision = () => readJson(metaPath)?.revision ?? 0;
  const get = (table, key) => {
    const record = readJson(file(table, key));
    if (!record) return null;
    if (p.canonicalJson(record.key) !== p.canonicalJson(key)) throw failure('IO_FAILURE', 'index collision');
    return record.value;
  };
  function apply(journal) {
    const current = revision();
    if (current !== journal.before && current !== journal.after) throw failure('FENCED', 'journal revision conflict');
    if (current === journal.before) {
      for (const change of journal.changes) {
        atomicJson(file(change.table, change.key), { key: change.key, value: change.value });
        fault('index-written', change);
      }
      atomicJson(metaPath, { revision: journal.after });
      fault('revision-written', journal);
    }
    fs.unlinkSync(journalPath); syncDirectory(root);
  }
  return {
    root, get, revision,
    recover() { const journal = readJson(journalPath, 64 * 1024 * 1024); if (journal) apply(journal); },
    commit(expectedRevision, changes) {
      if (readJson(journalPath, 64 * 1024 * 1024) || revision() !== expectedRevision) throw failure('FENCED', 'CAS failed');
      if (!Array.isArray(changes) || changes.length > 64) throw failure('IO_FAILURE', 'transaction exceeds bound');
      const journal = { before: expectedRevision, after: expectedRevision + 1, changes };
      for (const change of changes) if (Buffer.byteLength(JSON.stringify({ key: change.key, value: change.value })) > 4 * 1024 * 1024) throw failure('IO_FAILURE', 'persistent record exceeds read bound');
      if (Buffer.byteLength(JSON.stringify(journal)) > 64 * 1024 * 1024) throw failure('IO_FAILURE', 'journal exceeds recovery bound');
      atomicJson(journalPath, journal, true); fault('journal-synced', journal);
      apply(journal); return journal.after;
    },
    put(table, key, value) { return this.commit(revision(), [{ table, key, value }]); },
    immutable(table, key, value) {
      if (Buffer.byteLength(JSON.stringify({ key, value })) > 4 * 1024 * 1024) throw failure('IO_FAILURE', 'persistent record exceeds read bound');
      atomicJson(file(table, key), { key, value }, true);
    },
    /** Enumeration is bounded by an explicit admission cap, not a history scan. */
    pending() { return get('meta', 'pending') ?? []; },
    reserve(key) {
      const pending = this.pending();
      if (pending.includes(key)) return;
      if (pending.length >= 256) throw failure('IO_FAILURE', 'immutable inbox full; retry same operation');
      this.put('meta', 'pending', pending.concat(key));
    },
    release(key) { this.put('meta', 'pending', this.pending().filter(value => value !== key)); },
  };
}
module.exports = { createStore, atomicJson, atomicBytes, readJson, ensureDirectory, syncDirectory, hashBytes, failure };
