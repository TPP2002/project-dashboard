'use strict';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

/** Raw source bytes are a budget weight, not a bound on the V8 heap or RSS. No timers. */
function createBoardReadCache({ maxEntries = 50, maxBytes = DEFAULT_MAX_BYTES, idleMs = DEFAULT_IDLE_MS, now = Date.now } = {}) {
  const entries = new Map();
  let weightBytes = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key); weightBytes -= entry.weight;
    return true;
  }
  function sweep(at = now()) {
    let removed = 0;
    for (const [key, entry] of entries) {
      if (at - entry.usedAt >= idleMs) { remove(key); removed++; }
    }
    return removed;
  }
  return {
    get size() { return entries.size; },
    get weightBytes() { return weightBytes; },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      const at = now();
      if (at - entry.usedAt >= idleMs) { remove(key); return undefined; }
      entries.delete(key); entries.set(key, entry); entry.usedAt = at;
      return entry.value;
    },
    set(key, value, weight) {
      if (!Number.isFinite(weight) || weight < 0) throw new RangeError('cache weight must be finite non-negative source bytes');
      remove(key); sweep();
      // The caller still returns the fully read value; an oversize item only bypasses residency.
      if (weight > maxBytes || maxEntries < 1) return;
      while (entries.size >= maxEntries || weightBytes + weight > maxBytes) remove(entries.keys().next().value);
      entries.set(key, { value, weight, usedAt: now() }); weightBytes += weight;
    },
    delete: remove,
    sweep,
    clear() { entries.clear(); weightBytes = 0; },
  };
}

module.exports = { createBoardReadCache, DEFAULT_MAX_BYTES, DEFAULT_IDLE_MS };
