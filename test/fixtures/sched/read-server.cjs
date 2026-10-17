'use strict';
/** Real production request handler on an ephemeral listener, with fixture-only infrastructure. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once, EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { createSchedApi } = require('../../../server/schedApi.cjs');

async function readServer({ directory, share, executor, onCleanup }) {
  const filename = path.resolve(__dirname, '../../../server/server.cjs');
  const localRequire = createRequire(filename), loaded = { exports: {} };
  const dist = path.join(directory, 'web', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>read fixture</title>');
  fs.writeFileSync(path.join(dist, 'fixture.js'), 'window.fixture = true;');
  const registry = path.join(directory, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const fakeProcess = new EventEmitter();
  Object.assign(fakeProcess, { pid: process.pid, platform: process.platform, env: {
    DASHBOARD_HOME: directory, DASHBOARD_REGISTRY: registry, DASHBOARD_NO_OPEN: '1', DASHBOARD_EVENT_WEBHOOK: '',
  } });
  const context = { module: loaded, exports: loaded.exports, __dirname: path.dirname(filename), __filename: filename,
    process: fakeProcess, console, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name === '../core/resolveProject.cjs') return { ...localRequire(name), DASHBOARD_HOME: directory,
        REGISTRY_PATH: registry, readRegistry: () => ({ schemaVersion: '1.0', projects: {} }) };
      if (name === '../core/runtimeRoot.cjs') return { ...localRequire(name), runtimeMode: () => 'dev', readStamp: () => null };
      if (name === '../core/settings.cjs') return { ...localRequire(name), readSettings: () => ({}),
        resolveSchedShare: () => share, resolveModules: () => ({ cpu: true }) };
      if (name === './schedApi.cjs') return { createSchedApi: options => createSchedApi({ ...options, executor }) };
      return localRequire(name);
    },
  };
  // Point only static-file serving at the private fixture; execute the actual router and health handler.
  const source = fs.readFileSync(filename, 'utf8').replace(
    "const DIST_DIR = path.join(DASH_ROOT, 'web', 'dist');", `const DIST_DIR = ${JSON.stringify(dist)};`);
  vm.runInNewContext(source + '\nmodule.exports.fixture = { server, state };', context, { filename });
  const { server, state } = loaded.exports.fixture;
  onCleanup(async () => {
    const stopped = new Promise(resolve => server.close(resolve));
    await executor.close();
    server.closeAllConnections();
    await stopped;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.actualPort = server.address().port;
  return { server, base: `http://127.0.0.1:${state.actualPort}` };
}

module.exports = { readServer };
