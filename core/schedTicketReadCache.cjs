'use strict';
/** Private ticket parsing cache. Raw source weights are NOT V8 heap/RSS limits. No timers. */
const fs = require('node:fs');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const { createHash } = require('node:crypto');

const MAX_ENTRIES = 20000, MAX_BYTES = 64 * 1024 * 1024, MAX_ITEM_BYTES = 1024 * 1024;
const IDLE_MS = 10 * 60 * 1000;

function createTicketReadCache({ maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES,
  maxItemBytes = MAX_ITEM_BYTES, idleMs = IDLE_MS, now = () => Date.now() } = {}) {
  const entries = new Map();
  let directory = null, weightBytes = 0, lastUsedAt = null;
  function remove(file) {
    const old = entries.get(file);
    if (old) { entries.delete(file); weightBytes -= old.weight; }
  }
  function clear() { entries.clear(); weightBytes = 0; directory = null; lastUsedAt = null; }
  function sweep(at = now(), currentDirectory = directory) {
    if (directory !== currentDirectory || (lastUsedAt !== null && at - lastUsedAt >= idleMs)) clear();
  }
  return {
    // Called even before enumeration: a failed read of a different share must release the old one.
    select(nextDirectory) {
      sweep(now(), nextDirectory);
      directory = nextDirectory; lastUsedAt = now();
    },
    // Only call after the entire directory has been successfully listed and checked.
    prune(files) {
      const names = new Set(files);
      for (const file of entries.keys()) if (!names.has(file)) remove(file);
    },
    read(file, id, validate) {
      try {
        const fullPath = path.join(directory, file);
        const stat = fs.statSync(fullPath);
        const old = entries.get(file);
        if (old && old.size === stat.size && old.mtimeMs === stat.mtimeMs) return old.value;
        const raw = fs.readFileSync(fullPath);
        if (!isUtf8(raw)) throw new Error(`[sched] 文件不是有效 UTF-8:${fullPath}`);
        const hash = createHash('sha256').update(raw).digest('hex');
        if (old && old.hash === hash) {
          old.size = stat.size; old.mtimeMs = stat.mtimeMs;
          return old.value;
        }
        // Replacements release their previous weight, including on parse/validation failure.
        remove(file);
        const value = validate(JSON.parse(raw.toString('utf8')), id);
        // Stable resident set: a sequential scan cannot evict all previously useful entries.
        if (raw.length <= maxItemBytes && entries.size < maxEntries && weightBytes + raw.length <= maxBytes) {
          entries.set(file, { hash, value, size: stat.size, mtimeMs: stat.mtimeMs, weight: raw.length }); weightBytes += raw.length;
        }
        return value;
      } catch (error) { remove(file); throw error; }
    },
    sweep, clear,
    stats: () => ({ entries: entries.size, weightBytes, maxEntries, maxBytes, maxItemBytes, idleMs, lastUsedAt }),
  };
}

// Internal state shared by schedRead's private consumers and the server lifecycle only.
const ticketReadCache = createTicketReadCache();
module.exports = { createTicketReadCache, ticketReadCache, MAX_ENTRIES, MAX_BYTES, MAX_ITEM_BYTES, IDLE_MS };
