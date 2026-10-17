'use strict';
// Execute the real server module without listening, external services, or real data roots.
// Test-only lexical access keeps instrumentation out of the production API/HTTP surface.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const serverFile = path.join(root, 'server/server.cjs');
const localRequire = createRequire(serverFile);

function serverFixture(dir, source = serverFile) {
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  let at = 1800000000000;
  class FixtureDate extends Date { static now() { return at; } }
  const intervals = new Set();
  const sandboxProcess = Object.create(process);
  sandboxProcess.env = { ...process.env, DASHBOARD_HOME: dir, DASHBOARD_REGISTRY: registry, DASHBOARD_MODULES: '', DASHBOARD_SCHED_SHARE: dir,
    DASHBOARD_POLL_MS: '1500', DASHBOARD_EVENT_WEBHOOK: '', DASHBOARD_CI_RUNNER_MAP: '{}', DASHBOARD_CI_REPOSITORIES: '' };
  sandboxProcess.on = () => {};
  const module = { exports: {} };
  const fixtureRequire = id => {
    if (id === '../core/resolveProject.cjs') return { ...localRequire(id), DASHBOARD_HOME: dir, REGISTRY_PATH: registry };
    if (id === '../core/settings.cjs') return { ...localRequire(id), readSettings: () => ({}), resolveModules: () => ({ cpu: false }), resolveSchedShare: () => dir };
    if (id === '../core/boardReadCache.cjs') return { ...localRequire(id), createBoardReadCache: options => localRequire(id).createBoardReadCache({ ...options, now: FixtureDate.now }) };
    return localRequire(id);
  };
  const expose = `\nmodule.exports.resourceFixture = { readSummaryCached, readArchiveCached, readMergedBoard, activitySnapshot,
    handleBoard, handleActivity, startIntervals, server, summaryCache, archiveCache, mergedBoardCache,
    sweepBoardReadCaches: typeof sweepBoardReadCaches === 'function' ? sweepBoardReadCaches : null };`;
  vm.runInNewContext(fs.readFileSync(source, 'utf8') + expose, {
    require: fixtureRequire, module, exports: module.exports, __dirname: path.dirname(serverFile), __filename: serverFile,
    process: sandboxProcess, console, Buffer, URL, URLSearchParams, Date: FixtureDate,
    setInterval(fn, ms) { const handle = { fn, ms, unref() {} }; intervals.add(handle); return handle; },
    clearInterval(handle) { intervals.delete(handle); }, setTimeout, clearTimeout,
  }, { filename: source });
  return { ...module.exports.resourceFixture, intervals, registry,
    advance(ms) { at += ms; },
    poll() { for (const timer of intervals) if (timer.ms === 1500) timer.fn(); },
  };
}

module.exports = { serverFixture };
