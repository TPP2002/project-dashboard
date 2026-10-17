#!/usr/bin/env node
'use strict';
/** Controller-run fixture comparison. Never reads a configured share or starts a server. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const ROOT = fs.realpathSync(path.resolve(__dirname, '../../..'));
const BASE = '4a0e73ca2034c759d3da185b918f09b15106d6d4';
const NOW = Date.parse('2026-10-17T00:00:00.000Z'), SEED = 1017;
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };
const argv = process.argv.slice(2);
function option(name, fallback) {
  const at = argv.indexOf(name); return at === -1 ? fallback : argv[at + 1];
}
function demand(condition, reason) { if (!condition) throw new Error(reason); }
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }
function git(...args) { return execFileSync('git', ['-c', `safe.directory=${ROOT}`, '-C', ROOT, ...args], { encoding: 'utf8', windowsHide: true }); }
const c = require(path.join(ROOT, 'core/schedContract.cjs'));
const SOURCE_FILES = ['core/schedRead.cjs', 'core/schedTicketReadCache.cjs', 'core/schedLedger.cjs',
  'core/schedVerifiedBytes.cjs', 'core/schedEstimates.cjs', 'core/schedRelations.cjs', 'core/schedContract.cjs',
  'core/schedEngines.cjs', 'core/schedCsv.cjs', 'server/server.cjs'];
function sourceHashes() { return Object.fromEntries([...SOURCE_FILES, 'docs/plans/DASH-TICKET-CACHE-1017/comparison.cjs']
  .map(file => [file, hash(fs.readFileSync(path.join(ROOT, file)))])); }
function fixtureHash(directory) {
  const digest = createHash('sha256'); let files = 0, bytes = 0;
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      demand(!stat.isSymbolicLink(), 'fixture must not contain links');
      if (stat.isDirectory()) visit(file);
      else {
        demand(stat.isFile(), 'fixture must contain only ordinary files');
        const raw = fs.readFileSync(file), relative = path.relative(directory, file).split(path.sep).join('/');
        digest.update(JSON.stringify([relative, raw.length, hash(raw)]) + '\n'); files++; bytes += raw.length;
      }
    }
  }
  visit(directory); return { sha256: digest.digest('hex'), files, bytes };
}
function makeFixture(directory, count) {
  const share = path.join(directory, 'share'), paths = c.schedPaths(share);
  for (const dir of [paths.control, paths.tickets, paths.commandReceipts, paths.staging, path.join(paths.root, 'ledger')]) fs.mkdirSync(dir, { recursive: true });
  const at = new Date(NOW).toISOString(), earlier = ms => new Date(NOW - ms).toISOString();
  write(paths.format, { formatVersion: 1, capabilities: ['canonical-json-sha256'], createdAt: at });
  write(paths.dispatcher, { machine: 'fixture-worker', createdAt: at, createdBy: 'comparison' });
  const machine = { name: 'fixture-worker', preference: 0, quotaCores: 20, grantedCores: 4,
    externalLoadCores: 1, availableCores: 15, overCommitted: false, fresh: true, online: true,
    ci: 'idle', ownerHold: false, reservation: { requestedCores: 0, fulfilledCores: 0, untilAt: null }, heartbeatAt: at, loadSampledAt: at };
  write(paths.heartbeat, { machine: machine.name, pid: 123, protocol: 25, head: 'a'.repeat(40), at, tick: 1,
    cursorSeq: count * 8, queued: 0, granted: 1, machines: [machine], queue: [], locks: [] });
  let seed = SEED, seq = 0;
  const history = new Map();
  for (let i = 1; i <= count; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const id = `tk-${i.toString(16).padStart(20, '0')}`, createdAt = earlier((count - i + 1) * 15000);
    const startedAt = new Date(Date.parse(createdAt) + 1000).toISOString();
    const endedAt = new Date(Date.parse(startedAt) + 2000 + seed % 2000).toISOString();
    const active = i === count, state = active ? 'running' : 'passed';
    const timing = { queuedMs: 1000, runningMs: 2000 + seed % 2000, pausedMs: 100, slowMs: 200 };
    const request = { idempotencyKey: `fixture-${i}`, project: `fixture-${i % 2}`, title: `fixture task ${i}`, submitter: 'fixture-comparison', category: 'unit-test',
      requestedCores: 4, allowedMachines: ['fixture-worker'], work: { type: 'test', targetPaths: ['test/fixture.test.cjs'] },
      codeRef: { kind: 'commit', value: 'b'.repeat(40) }, resources: { exclusive: [] }, createdAt,
      ...(i > 1 ? { parentTicketId: 'tk-00000000000000000001' } : {}) };
    const contentHash = c.contentHash(request), submissionId = `fixture-${i}`;
    const attempt = { attemptId: 'a1', grantedCores: 4, queuedAt: createdAt, startedAt, endedAt: active ? null : endedAt,
      timing, permit: { ticketId: id, attemptId: 'a1', token: 'fixture-only', machine: 'fixture-worker',
        category: request.category, grantedCores: 4, issuedAt: createdAt },
      intent: { machine: 'fixture-worker', submissionId }, dispatchedAt: createdAt, codeRef: request.codeRef,
      result: active ? null : { outcome: 'passed', reason: 'fixture completed', exitCode: 0,
        logFile: `sched/logs/${id}-a1.log`, usage: { peakCores: 4, p90Cores: 3, samples: 8 } },
      segments: [{ from: startedAt, to: endedAt, state: 'running', cores: 4, samples: [1, 2, 3, 4] },
        { from: startedAt, to: endedAt, state: 'slow', cores: 2, samples: [1, 2] }] };
    const offset = ms => new Date(Date.parse(createdAt) + ms).toISOString();
    const events = [
      { type: 'submitted', at: createdAt, data: { request, contentHash } },
      { type: 'dispatch-intent', at: offset(100), data: { intent: attempt.intent } },
      { type: 'dispatched', at: offset(200), data: { submissionId } },
      { type: 'granted', at: offset(300), data: { permit: attempt.permit } },
      { type: 'started', at: startedAt, data: {} },
      { type: 'paused', at: offset(1100), data: { reasons: ['ci'] } },
      { type: 'resumed', at: offset(1200), data: { reasons: [] } },
      { type: active ? 'fixture-running' : 'finished', at: active ? at : endedAt, data: { outcome: state } },
    ].map(event => {
      const payload = { v: 1, seq: ++seq, ticketId: id, attemptId: 'a1', ...event };
      const full = { ...payload, sha256: c.contentHash(payload) }, day = event.at.slice(0, 10);
      if (!history.has(day)) history.set(day, []);
      history.get(day).push(JSON.stringify(full)); return full;
    });
    write(path.join(paths.tickets, `${id}.json`), { formatVersion: 1, ticketId: id, state, request, registerOnly: false,
      cancelRequested: false, pauseReasons: [], currentAttemptId: 'a1', createdAt, updatedAt: active ? at : endedAt,
      endedAt: active ? null : endedAt, contentHash, band: 1, queuedAt: createdAt, unsatisfiableReason: null,
      accountedAt: active ? at : endedAt, pendingQueue: null, timing, lastSeq: seq,
      attempts: [{ ...attempt, attemptId: 'previous', startedAt: createdAt, endedAt: startedAt,
        permit: { ...attempt.permit, attemptId: 'previous' },
        result: { outcome: 'handoff-interrupted', reason: 'fixture previous attempt' } }, attempt],
      timeline: events, history: [{ at: createdAt, message: 'representative retained history', samples: [seed % 10, 2, 4] }] });
  }
  // Date-partitioned files preserve the globally increasing lifecycle event sequence.
  for (const [day, events] of history) fs.writeFileSync(path.join(paths.root, 'ledger', `${day}.jsonl`), events.join('\n') + '\n');
  write(path.join(directory, 'registry.json'), { schemaVersion: '1.0', projects: {} });
  return share;
}
function loadReader(kind, oldSource) {
  const filename = path.join(ROOT, 'core/schedRead.cjs');
  if (kind === 'new') return require(filename);
  const loaded = new Module(filename, module); loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(oldSource, filename); return loaded.exports;
}
function cacheState(kind) {
  return kind === 'new' ? require(path.join(ROOT, 'core/schedTicketReadCache.cjs')).ticketReadCache.stats() : null;
}
function installCounters(directory) {
  const originalRead = fs.readFileSync, originalParse = JSON.parse, originalRecord = c.requireRecord;
  const counts = { reads: 0, parses: 0, validations: 0 };
  fs.readFileSync = function (file, ...args) {
    if (typeof file === 'string' && path.dirname(file) === directory) counts.reads++;
    return originalRead.call(this, file, ...args);
  };
  JSON.parse = function (text, ...args) {
    // Ticket JSON starts with these root properties. Ledger lines do not, and are counted separately by neither side.
    if (typeof text === 'string' && text.startsWith('{"formatVersion":1,"ticketId":')) counts.parses++;
    return originalParse.call(this, text, ...args);
  };
  c.requireRecord = function (value, label) {
    if (label === '单子快照') counts.validations++;
    return originalRecord(value, label);
  };
  return { counts, restore() { fs.readFileSync = originalRead; JSON.parse = originalParse; c.requireRecord = originalRecord; } };
}
function lifecycleServer(directory) {
  // Compile the real server without starting it; capture its real close listener, not a simulated cache.clear call.
  process.env.DASHBOARD_HOME = directory;
  process.env.DASHBOARD_REGISTRY = path.join(directory, 'registry.json');
  process.env.DASHBOARD_GLOBAL_SETTINGS = path.join(directory, 'absent-settings.json');
  process.env.DASHBOARD_MODULES = ''; process.env.DASHBOARD_SCHED_SHARE = path.join(directory, 'share');
  const filename = path.join(ROOT, 'server/server.cjs'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(filename, 'utf8') +
    '\nmodule.exports.comparisonLifecycle = { server, sweepBoardReadCaches };', filename);
  return loaded.exports.comparisonLifecycle;
}
function worker() {
  const directory = fs.realpathSync(option('--fixture')), tmp = fs.realpathSync(os.tmpdir());
  demand(inside(tmp, directory) && path.basename(directory).startsWith('dash-ticket-cache-1017-fixture-'), 'only this worktree temporary fixture is allowed');
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
  demand(marker.root === ROOT && marker.nonce === option('--nonce'), 'fixture owner mismatch');
  const kind = option('--kind'); demand(['old', 'new'].includes(kind), 'worker kind required');
  const logs = fs.realpathSync(path.dirname(option('--result')));
  demand(inside(tmp, logs) && !inside(ROOT, logs) && logs !== ROOT, 'worker output must be outside tested source in temporary logs');
  demand(path.dirname(fs.realpathSync(option('--old-source'))) === logs, 'baseline source must be in the comparison log directory');
  demand(!fs.existsSync(option('--result')), 'worker must not overwrite a prior result');
  const share = path.join(directory, 'share'), frozen = fixtureHash(share);
  demand(frozen.sha256 === option('--input-hash'), 'fixture changed before worker');
  const oldSource = fs.readFileSync(option('--old-source'), 'utf8');
  const sources = sourceHashes(), reader = loadReader(kind, oldSource), lifecycle = lifecycleServer(directory);
  const { counts, restore } = installCounters(c.schedPaths(share).tickets);
  const result = { kind, node: process.version, platform: process.platform, arch: process.arch, now: NOW, seed: SEED,
    input: frozen, sources, oldSourceHash: hash(oldSource), baselineMemory: process.memoryUsage(), phases: [] };
  const output = createHash('sha256');
  function measure(name, action) {
    const before = { ...counts }, cpu = process.cpuUsage(), start = performance.now();
    const value = action(), wallMs = performance.now() - start, used = process.cpuUsage(cpu);
    demand(!value || typeof value !== 'object' || value.ok !== false, `${name} returned unreadable output`);
    demand(!value || typeof value !== 'object' || (value.readable !== false && value.related?.readable !== false), `${name} has unreadable data`);
    if (name.includes('snapshot')) demand(value.historyError === null, 'fixture ledger must be readable');
    const memory = process.memoryUsage(), serialized = c.canonicalJson(value);
    output.update(name + '\n' + serialized + '\n');
    result.phases.push({ name, wallMs, cpuUserUs: used.user, cpuSystemUs: used.system,
      counts: Object.fromEntries(Object.keys(counts).map(key => [key, counts[key] - before[key]])),
      cache: cacheState(kind), memory, outputHash: hash(serialized), outputBytes: Buffer.byteLength(serialized) });
  }
  const id = 'tk-00000000000000000001';
  try {
    measure('cold-snapshot', () => reader.snapshot(share, NOW));
    measure('warm-snapshot-1', () => reader.snapshot(share, NOW));
    measure('warm-snapshot-2', () => reader.snapshot(share, NOW));
    measure('page', () => reader.ticketPage(share, { limit: '200' }));
    measure('export-filtered', () => reader.exportTickets(share, { project: 'fixture-0' }));
    measure('detail-related', () => { const ticket = reader.ticketDetail(share, id); return { ticket, related: reader.relatedTickets(share, ticket) }; });
    result.outputHash = output.digest('hex'); result.counts = { ...counts };
    const beforeIdle = { cache: cacheState(kind), memory: process.memoryUsage() };
    lifecycle.sweepBoardReadCaches((beforeIdle.cache?.lastUsedAt ?? Date.now()) + 600000);
    result.idle = { before: beforeIdle, after: { cache: cacheState(kind), memory: process.memoryUsage() }, clockAdvancedMs: 600000 };
    // Refill to prove close actually frees a nonempty cache. Neither phase is included in timed work or output hash.
    reader.ticketPage(share, { limit: '1' });
    result.close = { before: { cache: cacheState(kind), memory: process.memoryUsage() } };
    lifecycle.server.emit('close');
    result.close.after = { cache: cacheState(kind), memory: process.memoryUsage() };
    if (kind === 'new') {
      demand(result.idle.before.cache.entries > 0 && result.idle.after.cache.entries === 0 && result.idle.after.cache.weightBytes === 0, 'idle release not proven');
      demand(result.close.before.cache.entries > 0 && result.close.after.cache.entries === 0 && result.close.after.cache.weightBytes === 0, 'close release not proven');
    }
  } finally { restore(); }
  demand(fixtureHash(share).sha256 === frozen.sha256, 'fixture changed during worker');
  demand(JSON.stringify(sourceHashes()) === JSON.stringify(sources), 'source changed during worker');
  fs.writeFileSync(option('--result'), JSON.stringify(result, null, 2));
}
function parent() {
  const count = Number(option('--tickets', '12000')), groups = Number(option('--groups', '3'));
  demand(Number.isSafeInteger(count) && count >= 12000, 'at least 12000 tickets required');
  demand(Number.isSafeInteger(groups) && groups >= 3, 'at least three ABBA groups required');
  const oldRef = option('--old-ref', BASE); demand(/^[a-f0-9]{40}$/.test(oldRef), 'old-ref must be a complete immutable SHA');
  const tmp = fs.realpathSync(os.tmpdir());
  const logDirectory = option('--output') ? path.resolve(option('--output')) : fs.mkdtempSync(path.join(tmp, 'ticket-cache-comparison-'));
  // Every output must be outside the tested source tree, including when an ancestor is a junction.
  fs.mkdirSync(logDirectory, { recursive: true });
  const logs = fs.realpathSync(logDirectory);
  demand(!inside(ROOT, logs) && logs !== ROOT, 'logs must be outside tested source tree');
  demand(inside(tmp, logs), 'comparison logs must be in a temporary output directory');
  demand(fs.readdirSync(logs).length === 0, 'use an empty log directory; never overwrite raw evidence');
  const oldSource = git('show', `${oldRef}:core/schedRead.cjs`), oldFile = path.join(logs, 'old-schedRead.cjs');
  demand(!oldSource.includes('schedTicketReadCache'), 'baseline already includes the candidate ticket cache');
  // The comparison isolates schedRead + its private cache; all shared dependencies must match baseline.
  for (const file of SOURCE_FILES.filter(file => !['core/schedRead.cjs', 'core/schedTicketReadCache.cjs', 'server/server.cjs'].includes(file))) {
    const baseline = git('show', `${oldRef}:${file}`).replace(/\r\n/g, '\n');
    const current = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
    demand(hash(baseline) === hash(current), `baseline dependency drift: ${file}`);
  }
  fs.writeFileSync(oldFile, oldSource);
  const directory = fs.mkdtempSync(path.join(tmp, 'dash-ticket-cache-1017-fixture-')), nonce = randomUUID();
  write(path.join(directory, 'owner.json'), { root: ROOT, nonce });
  const share = makeFixture(directory, count), frozen = fixtureHash(share), sources = sourceHashes();
  const manifest = { verdict: 'NOT_PROVEN', oldRef, oldSourceHash: hash(oldSource), sources, fixture: directory,
    input: frozen, count, groups, seed: SEED, now: NOW, order: [], runs: [], memoryPolicy: 'raw weight is not heap; no forced GC; RSS is descriptive only' };
  write(path.join(logs, 'manifest.json'), manifest);
  for (let group = 0; group < groups; group++) for (const [position, kind] of ['old', 'new', 'new', 'old'].entries()) {
    const label = `${group + 1}-${position + 1}-${kind}`, resultFile = path.join(logs, `${label}.json`);
    demand(JSON.stringify(sourceHashes()) === JSON.stringify(sources), 'source changed between workers');
    const child = spawnSync(process.execPath, [__filename, '--worker', '--kind', kind, '--fixture', directory,
      '--nonce', nonce, '--input-hash', frozen.sha256, '--old-source', oldFile, '--result', resultFile],
    { cwd: ROOT, env: { ...process.env }, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    fs.writeFileSync(path.join(logs, `${label}.stdout.log`), child.stdout || '');
    fs.writeFileSync(path.join(logs, `${label}.stderr.log`), child.stderr || '');
    demand(!child.error && child.status === 0, `worker failed: ${label}; raw logs retained`);
    manifest.order.push(label); manifest.runs.push(JSON.parse(fs.readFileSync(resultFile, 'utf8')));
    write(path.join(logs, 'manifest.json'), manifest);
  }
  demand(fixtureHash(share).sha256 === frozen.sha256, 'input changed after comparison');
  const equal = new Set(manifest.runs.map(run => run.outputHash)).size === 1;
  manifest.outputEqual = equal;
  const median = values => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2; };
  function metric(kind, field) { return manifest.runs.filter(run => run.kind === kind).map(run => run.phases.filter(phase => phase.name.startsWith('warm-snapshot')).reduce((n, phase) => n + (field === 'cpu' ? (phase.cpuUserUs + phase.cpuSystemUs) / 1000 : phase.wallMs), 0)); }
  manifest.warm = {};
  for (const field of ['cpu', 'wall']) {
    const old = metric('old', field), candidate = metric('new', field);
    const oldMedian = median(old), newMedian = median(candidate);
    const variation = Math.max(...old.map(value => Math.abs(value - oldMedian)), ...candidate.map(value => Math.abs(value - newMedian)));
    manifest.warm[field] = { old, candidate, oldMedian, newMedian, gain: oldMedian - newMedian, maxAbsoluteDeviation: variation,
      exceedsObservedVariation: oldMedian - newMedian > variation };
  }
  manifest.pairs = [];
  for (let group = 0; group < groups; group++) for (const [oldPosition, newPosition] of [[0, 1], [3, 2]]) {
    const old = manifest.runs[group * 4 + oldPosition], candidate = manifest.runs[group * 4 + newPosition];
    manifest.pairs.push({ group: group + 1, oldPosition: oldPosition + 1, newPosition: newPosition + 1,
      oldOutputHash: old.outputHash, newOutputHash: candidate.outputHash,
      oldParses: old.counts.parses, newParses: candidate.counts.parses,
      oldValidations: old.counts.validations, newValidations: candidate.counts.validations });
  }
  manifest.parsingReduced = manifest.pairs.every(pair => pair.newParses < pair.oldParses && pair.newValidations < pair.oldValidations);
  manifest.verdict = equal && manifest.parsingReduced && Object.values(manifest.warm).every(metric => metric.exceedsObservedVariation) ? 'FIXTURE_GAIN_OBSERVED' : 'NOT_PROVEN';
  write(path.join(logs, 'manifest.json'), manifest);
  console.log(JSON.stringify({ verdict: manifest.verdict, outputEqual: equal, inputHash: frozen.sha256, runs: manifest.runs.length, logs }));
  demand(equal, 'complete output hash mismatch; retain NOT_PROVEN and raw evidence');
}
try {
  demand(typeof process.env.SCHED_PERMIT === 'string' && process.env.SCHED_PERMIT.trim() !== '', 'SCHED_PERMIT is required; controller must queue this comparison');
  if (argv.includes('--worker')) worker(); else parent();
} catch (error) { console.error(error.stack); process.exitCode = 1; }
