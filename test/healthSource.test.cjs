'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealthSource } = require('../core/healthSource.cjs');

test('current returns memory immediately while stamp I/O never resolves, then exposes resolved commit', async () => {
  let finish, reads = 0;
  const timers = [];
  const source = createHealthSource({ index: { ids: () => ['a'] }, now: () => 0,
    readStamp: () => { reads++; return new Promise(resolve => { finish = resolve; }); },
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
  });
  const initial = source.start();
  assert.deepEqual(source.current(), { projects: ['a'], latestReleaseCommit: null });
  assert.equal(reads, 1);
  assert.equal(timers.length, 0, 'no overlapping stamp reads while I/O is stuck');
  finish({ commit: 'abcdef' });
  await initial;
  assert.equal(source.current().latestReleaseCommit, 'abcdef');
  assert.equal(timers[0].ms, 30000);
  source.stop();
});

test('failed background reads preserve the previous commit and stop prevents rescheduling', async () => {
  let fail = false;
  const timers = [];
  const source = createHealthSource({ index: { ids: () => [] }, now: () => 0, readStamp: async () => { if (fail) throw Error('EIO'); return { commit: 'abc' }; },
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
  });
  await source.start();
  fail = true;
  await timers[0].fn();
  assert.equal(source.current().latestReleaseCommit, 'abc');
  source.stop();
  const count = timers.length;
  await timers.at(-1).fn();
  assert.equal(timers.length, count);
});

test('null stamp reader remains memory-only', () => {
  const source = createHealthSource({ index: { ids: () => ['dev'] }, readStamp: null });
  source.start();
  assert.deepEqual(source.current(), { projects: ['dev'], latestReleaseCommit: null });
  source.stop();
});

test('patch is immediately visible without I/O and remains after a background read of the saved file', async () => {
  let saved = { modules: { codex: false }, webhook: { configured: true, events: { done: true } } };
  let reads = 0;
  const timers = [];
  const source = createHealthSource({ index: { ids: () => ['a'] }, now: () => 0,
    initialDetails: { distBuilt: true },
    readDetails: async () => { reads++; return saved; },
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearTimer() {},
  });
  await source.start();
  saved = { modules: { codex: true }, webhook: { configured: true, events: { done: false } } };
  source.patch(saved);
  assert.deepEqual(source.current(), { ...saved, distBuilt: true, projects: ['a'], latestReleaseCommit: null });
  assert.equal(reads, 1, 'patch does not read files or trigger another refresh');
  assert.equal(timers.length, 1, 'patch leaves the refresh timer unchanged');
  await timers[0].fn();
  assert.deepEqual(source.current(), { ...saved, distBuilt: true, projects: ['a'], latestReleaseCommit: null });
  assert.equal(reads, 2);
  source.stop();
});

test('registry changes coalesce into one dirty follow-up and never overlap refreshes', async () => {
  const pending = [], timers = [];
  let ids = ['old'], active = 0, peak = 0, calls = 0;
  const source = createHealthSource({ index: { ids: () => ids }, now: () => 0,
    initialDetails: { hooksInstalled: {} },
    readDetails: () => {
      calls++; active++; peak = Math.max(peak, active);
      const projects = [...ids];
      return new Promise(resolve => pending.push(() => {
        active--; resolve({ hooksInstalled: Object.fromEntries(projects.map(id => [id, true])) });
      }));
    },
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
  });
  const first = source.start();
  ids = ['new'];
  assert.equal(source.refresh(), first);
  assert.equal(source.refresh(), first);
  assert.equal(calls, 1);
  assert.deepEqual(source.current().projects, ['new']);
  pending.shift()();
  // Let the first Promise.all finish and the coalesced follow-up start.
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  pending.shift()();
  await first;
  assert.deepEqual(source.current().hooksInstalled, { new: true });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 30000);
  source.stop();
  assert.equal(timers[0].cleared, true);
});

test('failed details refresh preserves previous fields independently of a successful stamp refresh', async () => {
  let fail = false;
  const timers = [];
  const source = createHealthSource({ index: { ids: () => ['a'] }, now: () => 0,
    readStamp: async () => ({ commit: fail ? 'new' : 'old' }),
    readDetails: async () => { if (fail) throw Error('disk failed'); return { distBuilt: true, hooksInstalled: { a: true } }; },
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearTimer() {},
  });
  await source.start();
  fail = true;
  await source.refresh();
  assert.deepEqual(source.current(), { projects: ['a'], latestReleaseCommit: 'new', distBuilt: true, hooksInstalled: { a: true } });
  source.stop();
});

test('a registry change at the refresh completion boundary still receives a follow-up', async () => {
  let reads = 0;
  const source = createHealthSource({ index: { ids: () => [] }, now: () => 0,
    readDetails: async () => ({ generation: ++reads }),
    setTimer: () => ({ unref() {} }), clearTimer() {},
  });
  const first = source.start();
  // Advance to the boundary between readAll completing and its finalizer.
  for (let i = 0; i < 3; i++) await Promise.resolve();
  const followUp = source.refresh();
  await Promise.all([first, followUp]);
  assert.equal(reads, 2);
  assert.equal(source.current().generation, 2);
  source.stop();
});

// Read source only to load the real handlers; every runtime file operation below is injected.
function serverHealthFixture({ index, promises, healthSource, clock = { time: 0 } }) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const settings = require('../core/settings.cjs');
  const source = fs.readFileSync(path.join(__dirname, '../server/server.cjs'), 'utf8');
  const helpers = source.slice(source.indexOf('async function readHealthHook('), source.indexOf('// ============ SSE ============'));
  const start = source.indexOf('function handleHealth(');
  const handler = source.slice(start, source.indexOf('\nfunction handleProjects(', start));
  const pollStart = source.indexOf('let settingsFingerprint;');
  const poll = source.slice(pollStart, source.indexOf('// ============ API 处理 ============', pollStart));
  const calls = [];
  const noDisk = () => { throw Error('synchronous disk access from health'); };
  const context = {
    module: { exports: {} }, path, index, healthSource,
    fs: new Proxy({ promises }, { get(target, name) { return name in target ? target[name] : noDisk; } }),
    hookForwardsProject: require('../core/hookProbe.cjs').hookForwardsProject,
    normalizeModules: settings.normalizeModules, normalizeWebhookEvents: settings.normalizeWebhookEvents,
    MODULE_IDS: settings.MODULE_IDS, process: { env: {}, platform: 'win32', pid: 1 },
    SETTINGS_PATH: '/settings', DIST_DIR: '/dist', WEBHOOK_CONFIGURED: true,
    MODE: 'release', SERVICE: 'claude-dashboard', VERSION: '1.0', DASH_ROOT: '/code', REGISTRY: '/registry', DASHBOARD_HOME: '/home',
    RELEASE_COMMIT: 'old', RELEASED_AT: null, lastSchedReadOkAt: null,
    state: { actualPort: 6060, startedAt: 0, subscribers: new Set() },
    Date: { now: () => clock.time }, releaseHome: () => '/release',
    releaseBehindOf: require('../core/releaseCheck.cjs').releaseBehindOf,
    readRegistrySafe: noDisk, readSettings: noDisk, resolveModules: noDisk, hooksInstalledMap: noDisk,
    collaborationApi: null, schedApi: { poll() {} }, broadcast() {},
    sendJson: (res, status, body) => calls.push({ status, body, at: clock.time }),
  };
  vm.runInNewContext(helpers + poll + handler + '\nmodule.exports = { readHealthDetails, handleHealth, pollServices };', context);
  return { ...context.module.exports, calls, source, handler, context };
}

test('settings fingerprint checks coalesce while stat is pending and refresh only on change including deletion', async () => {
  const pending = [];
  let stats = 0, refreshes = 0;
  const f = serverHealthFixture({ promises: {
    stat: () => { stats++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
  }, healthSource: { refresh: () => { refreshes++; } } });
  f.context.resolveModules = () => ({ cpu: false });
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  f.pollServices();
  f.pollServices();
  assert.equal(stats, 1, 'pending stat is not duplicated');
  pending.shift().resolve({ mtimeMs: 1, size: 10 });
  await settle();
  assert.equal(refreshes, 1);
  f.pollServices();
  pending.shift().resolve({ mtimeMs: 1, size: 10 });
  await settle();
  assert.equal(refreshes, 1, 'unchanged fingerprint reuses the cache');
  for (const meta of [{ mtimeMs: 1, size: 11 }, { mtimeMs: 2, size: 11 }]) {
    f.pollServices();
    pending.shift().resolve(meta);
    await settle();
  }
  assert.equal(refreshes, 3, 'either size or mtime change refreshes the cache');
  f.pollServices();
  pending.shift().reject(Object.assign(Error('missing'), { code: 'ENOENT' }));
  await settle();
  assert.equal(refreshes, 4, 'file deletion transitions to a null fingerprint');
  f.pollServices();
  pending.shift().reject(Error('still unavailable'));
  await settle();
  assert.equal(refreshes, 4, 'repeated unavailable fingerprint does not refresh repeatedly');
  f.pollServices();
  pending.shift().resolve({ mtimeMs: 2, size: 11 });
  await settle();
  assert.equal(refreshes, 5, 'recovery from a null fingerprint refreshes again');
});

test('health metadata reads hooks, settings and dist asynchronously and retains fields on I/O failure', async () => {
  const path = require('node:path');
  let failure = false, ids = ['split', 'worktree'];
  const projects = { split: { codeRepo: '/code' }, worktree: { codeRepo: '/wt' } };
  const index = { ids: () => ids, get: id => projects[id] };
  const promises = {
    stat: async file => { if (failure) throw Error('disk failed'); return { isDirectory: () => file !== path.join('/wt', '.git') }; },
    access: async () => { if (failure) throw Error('disk failed'); },
    readFile: async file => {
      if (failure) throw Error('disk failed');
      if (file === '/settings') return JSON.stringify({ modules: { reader: true }, webhookEvents: { done: false } });
      if (file === path.join('/wt', '.git')) return 'gitdir: ../common';
      return '#dashboard-hook:begin:split\n#dashboard-hook:begin:worktree';
    },
  };
  const f = serverHealthFixture({ index, promises });
  const first = await f.readHealthDetails({});
  assert.deepEqual(JSON.parse(JSON.stringify(first.hooksInstalled)), { split: true, worktree: true });
  assert.equal(first.distBuilt, true);
  assert.equal(first.modules.reader, true);
  assert.equal(first.modules.cpu, false);
  assert.equal(first.webhook.events.done, false);
  failure = true;
  ids = ['split'];
  const next = await f.readHealthDetails(first);
  assert.deepEqual(JSON.parse(JSON.stringify(next.hooksInstalled)), { split: true });
  assert.equal('distBuilt' in next, false);
  assert.equal('modules' in next, false);
  assert.equal('webhook' in next, false);
});

test('real health handler responds from memory while all background file reads are queued for 200 ms', () => {
  const clock = { time: 0 }, timers = [];
  let queued = 0;
  const queuedRead = () => { queued++; return new Promise(() => {}); };
  const source = createHealthSource({ index: { ids: () => ['a'] }, readStamp: queuedRead, readDetails: queuedRead,
    initialDetails: { hooksInstalled: { a: true }, distBuilt: true, webhook: { configured: false }, modules: {} },
    now: () => clock.time, setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
  });
  source.start();
  clock.time = 200;
  const f = serverHealthFixture({ healthSource: source, promises: new Proxy({}, { get: () => queuedRead }), clock });
  const began = clock.time;
  assert.equal(f.handleHealth({}, {}), undefined);
  assert.equal(f.calls.length, 1, 'response is sent synchronously without awaiting queued I/O');
  assert.equal(f.calls[0].status, 200);
  assert.ok(f.calls[0].at - began < 50);
  assert.deepEqual(f.calls[0].body.projects, ['a']);
  assert.equal(queued, 2, 'health did not start another file operation');
  assert.equal(timers.length, 0);
  assert.equal(f.handler.includes('Sync('), false);
  const route = f.source.slice(f.source.indexOf("const sub = segs[1];"));
  assert.ok(route.indexOf("sub === 'health'") < route.indexOf('const modules = resolveModules();'));
  source.stop();
});
