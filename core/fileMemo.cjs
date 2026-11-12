'use strict';
const nodeFs = require('node:fs');
const path = require('node:path');
const { atomicWriteJsonSync } = require('./atomicWrite.cjs');

function createFileMemo({ fs = nodeFs, persistPath = null, maxEntries = 50000, persistDelayMs = 2000 } = {}) {
  const entries = new Map(), pending = new Map(), loadsByKey = Object.create(null);
  let hits = 0, loads = 0, loaded = false, dirty = false, timer = null, warned = false;
  const idOf = (file, key) => JSON.stringify([key, path.resolve(file)]);
  const fingerprint = (file) => {
    try { const { size, mtimeMs, ctimeMs } = fs.statSync(file); return { size, mtimeMs, ctimeMs }; }
    catch (error) { return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR') ? { missing: true } : null; }
  };
  const same = (a, b) => a && b && (a.missing || b.missing ? a.missing === true && b.missing === true : a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs);
  function freeze(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const item of Object.values(value)) freeze(item, seen);
    return Object.freeze(value);
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!persistPath || !dirty) return;
    const result = { schemaVersion: 1, entries: {} };
    for (const entry of entries.values()) if (entry.persist && !entry.fp.missing) {
      const group = result.entries[entry.key] ||= {};
      group[entry.file] = { ...entry.fp, value: entry.value };
    }
    try { atomicWriteJsonSync(persistPath, result); dirty = false; }
    catch (error) { if (!warned) { warned = true; console.warn('file memo persistence failed:', error.message); } }
  }
  function changed() {
    if (!persistPath) return;
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, persistDelayMs);
    timer.unref();
  }
  function remove(id) {
    const old = entries.get(id);
    if (old) { entries.delete(id); if (old.persist) changed(); }
  }
  function trim() {
    while (entries.size > maxEntries) remove(entries.keys().next().value);
  }
  function loadPersisted() {
    if (loaded) return;
    loaded = true;
    if (!persistPath) return;
    try {
      const data = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
      if (data?.schemaVersion !== 1 || !data.entries || typeof data.entries !== 'object') return;
      for (const [key, group] of Object.entries(data.entries)) for (const [file, item] of Object.entries(group || {})) {
        if (!item || typeof item !== 'object' || !path.isAbsolute(file)) continue;
        const id = idOf(file, key);
        if (!entries.has(id)) entries.set(id, { key, file, fp: { size: item.size, mtimeMs: item.mtimeMs, ctimeMs: item.ctimeMs }, value: freeze(item.value), persist: true });
      }
      trim();
    } catch (_) { /* unreadable persistence is an empty cache */ }
  }
  function lookup(file, key, persist) {
    if (persist) loadPersisted();
    const id = idOf(file, key), fp = fingerprint(file), old = entries.get(id);
    if (!fp) { remove(id); return { id, fp }; }
    if (old && same(fp, old.fp)) {
      if (persist && !old.persist && !old.fp.missing) {
        JSON.stringify(old.value);
        old.persist = true;
        changed();
      }
      entries.delete(id); entries.set(id, old); hits++;
      return { id, fp, hit: true, value: old.value };
    }
    if (old) remove(id);
    return { id, fp };
  }
  function store(id, file, key, fp, value, persist) {
    if (!fp || !same(fp, fingerprint(file))) return value;
    if (persist && !fp.missing) JSON.stringify(value);
    const entry = { file: path.resolve(file), key, fp, value: freeze(value), persist: !!persist && !fp.missing };
    entries.set(id, entry); if (entry.persist) changed(); trim();
    return value;
  }
  function count(key) { loads++; loadsByKey[key] = (loadsByKey[key] || 0) + 1; }
  function sync(file, key, load) {
    const item = lookup(file, key, false);
    if (item.hit) return item.value;
    count(key);
    return store(item.id, file, key, item.fp, load(), false);
  }
  function asyncMemo(file, key, load, { persist = false } = {}) {
    const id = idOf(file, key);
    if (pending.has(id)) return pending.get(id);
    const item = lookup(file, key, persist);
    if (item.hit) return Promise.resolve(item.value);
    count(key);
    const promise = Promise.resolve().then(load).then((value) => store(id, file, key, item.fp, value, persist))
      .finally(() => pending.delete(id));
    pending.set(id, promise);
    return promise;
  }
  return { sync, async: asyncMemo, flush, stats: () => ({ entries: entries.size, hits, loads, loadsByKey: { ...loadsByKey } }) };
}
module.exports = { createFileMemo };
