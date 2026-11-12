'use strict';

function createProjectIndex({ registryPath, fs = require('node:fs'), resolveProject, log = console.warn }) {
  let table = new Map();
  let fingerprint = null;
  let lastError = null;
  let refreshing = null;

  async function rebuild() {
    try {
      const meta = await fs.promises.stat(registryPath);
      if (fingerprint && meta.mtimeMs === fingerprint.mtimeMs && meta.size === fingerprint.size) {
        lastError = null;
        return false;
      }
      const registry = JSON.parse(await fs.promises.readFile(registryPath, 'utf8'));
      const next = new Map();
      for (const id of Object.keys(registry.projects || {})) {
        try { next.set(id, resolveProject(id, { registryPath })); }
        catch (error) {
          next.set(id, null);
          log(`[project-index] ${id}: ${error.message}`);
        }
      }
      table = next;
      fingerprint = { mtimeMs: meta.mtimeMs, size: meta.size };
      lastError = null;
      return true;
    } catch (error) {
      const key = `${error.code || ''}:${error.message}`;
      if (key !== lastError) log(`[project-index] registry: ${error.message}`);
      lastError = key;
      return false;
    }
  }

  function refresh() {
    if (!refreshing) refreshing = rebuild().finally(() => { refreshing = null; });
    return refreshing;
  }

  return {
    ids: () => [...table.keys()],
    get: id => table.get(id) || null,
    refresh,
    snapshot: () => Object.fromEntries(table),
  };
}

module.exports = { createProjectIndex };
