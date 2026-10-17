'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const p = require('../packages/scheduler/src/protocol/contract.cjs');
const f = require('../packages/scheduler/fixtures/protocol/messages.cjs');
const { createObjectStore, contained } = require('../packages/scheduler/src/node/objects.cjs');

// Test-only source loader. Production uses package build output; this targeted
// fixture executes the real TS lifecycle closure without building the package.
function compileFixtureSource(source, file) {
  const ts = require('../web/node_modules/typescript');
  // Same import.meta.url semantics as packages/scheduler/build.cjs. The web
  // dependency is test-only; production retains its package-local compiler.
  function importMeta(context) {
    const f = context.factory;
    function visit(node) {
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        return f.createObjectLiteralExpression([f.createPropertyAssignment('url',
          f.createPropertyAccessExpression(f.createCallExpression(
            f.createPropertyAccessExpression(f.createCallExpression(f.createIdentifier('require'), undefined, [f.createStringLiteral('node:url')]), 'pathToFileURL'),
            undefined, [f.createIdentifier('__filename')]), 'href'))]);
      }
      return ts.visitEachChild(node, visit, context);
    }
    return node => ts.visitNode(node, visit);
  }
  const result = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    transformers: { before: [importMeta] } });
  const errors = (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
  return result.outputText;
}
function sourceLoader() {
  const root = path.resolve(__dirname, '../packages/scheduler/src'), cache = new Map();
  function load(file) {
    // The package build embeds these exact public files. The fixture uses the
    // same inputs without invoking a package build or a private generated file.
    if (file === path.join(root, 'sched', 'sched-suspend-native-assets')) {
      return { nativeSources: Object.fromEntries(['Windows原生接口.ps1', '进程树控制宿主.ps1', '许可归属核验.cs', '许可归属管道.cs']
        .map(name => [name, fs.readFileSync(path.join(root, 'sched', 'native', name), 'utf8').replace(/^\ufeff/, '').replace(/\r\n/g, '\n')])) };
    }
    if (!fs.existsSync(file)) file = [file.replace(/\.js$/, '.ts'), file + '.ts', file + '.cjs'].find(x => fs.existsSync(x));
    assert.ok(file && path.relative(root, file) !== '..' && !path.relative(root, file).startsWith('..' + path.sep), 'public closure only');
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    let source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.json')) { module.exports = JSON.parse(source); return module.exports; }
    if (file.endsWith('.ts')) source = compileFixtureSource(source, file);
    const localRequire = ref => {
      if (Module.isBuiltin(ref)) return require(ref);
      assert.ok(ref.startsWith('.'), `no external runtime import: ${ref}`);
      return load(path.resolve(path.dirname(file), ref));
    };
    localRequire.resolve = ref => require.resolve(path.resolve(path.dirname(file), ref));
    // Node strips the executable header before its CommonJS wrapper. Preserve
    // the newline for diagnostics; the production CLI keeps its hashbang.
    source = source.replace(/^\ufeff/, '').replace(/^#![^\r\n]*/, '');
    vm.runInThisContext(Module.wrap(source), { filename: file })(module.exports, localRequire, module, file, path.dirname(file));
    return module.exports;
  }
  return ref => load(path.join(root, ref));
}

test('fixture compiler preserves public build import.meta.url semantics without executing a CLI guard', () => {
  const filename = path.join(__dirname, 'synthetic path with spaces', '入口.ts');
  const output = compileFixtureSource(`import { pathToFileURL } from 'node:url';
    export const url = import.meta.url;
    if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
      throw new Error('fixture must not run as CLI');`, filename);
  const module = { exports: {} };
  vm.runInThisContext(Module.wrap(output), { filename })(module.exports, require, module, filename, path.dirname(filename));
  assert.equal(module.exports.url, require('node:url').pathToFileURL(filename).href);
  assert.doesNotMatch(output, /import\.meta/);
});
const cleanup = new WeakMap();
const onCleanup = (t, fn) => cleanup.get(t).push(fn);
async function temporary(t) {
  const parent = await fsp.realpath(os.tmpdir());
  const root = await fsp.mkdtemp(path.join(parent, 'scheduler-node-runtime-'));
  if (!cleanup.has(t)) {
    cleanup.set(t, []);
    t.after(async () => { for (const fn of cleanup.get(t).reverse()) await fn(); });
  }
  onCleanup(t, async () => {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('scheduler-node-runtime-'));
    await fsp.rm(root, { recursive: true, force: true });
  });
  return root;
}
async function lifecycleFixture(t) {
  const root = await temporary(t), load = sourceLoader();
  const deploy = load('sched/client/deployment-config.cjs');
  deploy.configureDeployment({ schemaVersion: 1, machines: [{ name: f.machine, dedicated: true }], projects: [],
    jobs: { 'test:targeted': { desc: 'Synthetic harmless task', argv: ['node', 'fixture.cjs'], acceptsTarget: true, workersEnv: 'FIXTURE_WORKERS', jobClass: 'shared' } } });
  const contract = load('bot/cluster-lifecycle-contract.ts'), control = load('bot/cluster-lifecycle-control.ts');
  const jobs = load('bot/cluster-job.ts'), states = load('bot/cluster-lifecycle-state.ts');
  const node = load('bot/cluster-agent-node-lifecycle.ts');
  const publication = structuredClone(f.payloads['handoff.publish']); publication.snapshot = null;
  const body = { ticketId: publication.permit.ticketId, jobId: publication.expected.jobId, kind: publication.submission.work.type,
    codeVersion: publication.codeRef.value, grantedCores: publication.grantedCores, ciAware: true,
    target: publication.submission.work.targetPaths.join(' '), workers: 1, queueRank: publication.queueRank };
  publication.expected = contract.buildLifecycleIdentity({ epoch: publication.lifecycleEpoch, jobId: body.jobId,
    submissionId: publication.submissionId, machine: f.machine, codeVersion: publication.codeRef.value,
    createdAt: publication.createdAt, createdBy: publication.submission.submitter, payload: jobs.clusterJobPayload(body) });
  const paths = control.lifecyclePaths(root, publication.lifecycleEpoch, f.machine);
  await fsp.mkdir(path.dirname(paths.control), { recursive: true });
  await fsp.writeFile(paths.control, JSON.stringify({ namespace: 'jobs-v12', lifecycleSchema: 12, epoch: publication.lifecycleEpoch,
    state: 'ACTIVE', codeVersion: publication.codeRef.value, configuredMachines: [f.machine], createdAt: f.at, createdBy: 'fixture' }));
  const lifecycle = node.createNodeLifecycle({ share: root, machine: f.machine, head: publication.codeRef.value });
  lifecycle.start(); onCleanup(t, () => lifecycle.close());
  return { root, load, publication, paths, lifecycle, states };
}

test('real jobs-v12 claim is idempotent and restart/claim-only never republishes', async t => {
  const x = await lifecycleFixture(t);
  assert.deepEqual(x.lifecycle.observe(x.publication), { state: 'absent', identity: x.publication.expected });
  assert.equal(x.lifecycle.publish(x.publication).state, 'inbox');
  assert.equal(x.lifecycle.publish(x.publication).state, 'inbox');
  assert.equal((await fsp.readdir(x.paths.claims)).length, 1);
  await fsp.unlink(path.join(x.paths.inbox, x.publication.submissionId + '.json'));
  assert.equal(x.lifecycle.publish(x.publication).state, 'claim');
  assert.deepEqual(await fsp.readdir(x.paths.inbox), []);
});

test('fresh node initialization satisfies the original status reader and refuses existing data', async t => {
  const parent = await temporary(t), root = path.join(parent, 'fresh-lifecycle'), load = sourceLoader();
  const init = load('node/initialize.cjs').initializeFreshNode;
  const input = { root, machine: f.machine, head: '1'.repeat(40) };
  const result = init(input);
  const status = load('bot/cluster-lifecycle-status.ts').readLifecycleStatusSnapshot(root, undefined, { tolerateMachineFaults: true });
  assert.equal(status.control.epoch, result.epoch); assert.deepEqual(status.control.configuredMachines, [f.machine]);
  const control = load('bot/cluster-lifecycle-control.ts').activeLifecycleControlPath(root), before = await fsp.readFile(control, 'utf8');
  assert.throws(() => init(input), { code: 'EEXIST' });
  assert.equal(await fsp.readFile(control, 'utf8'), before);
  assert.throws(() => init({ ...input, root: 'relative' }), /ABSOLUTE_ROOT/);
});

test('original lifecycle transition keeps notStarted/refused/null exit and rerun plan intact', async t => {
  const results = [
    { ok: false, exitCode: null, notStarted: { attemptId: 'a1', state: 'granted', waitedMs: 25 } },
    { ok: false, exitCode: 2, refused: 'fixture-before-start' },
    { ok: false, exitCode: 1, rerunPlan: { complete: true, eligible: [], slowTimeouts: 0, otherTimeouts: 0, retainedFailures: 0, sharedHookTimeouts: 0, notes: [] } },
  ];
  assert.throws(() => p.validateJobResult({ ...results[0], refused: 'fixture-before-start' }));
  for (const result of results) {
  const x = await lifecycleFixture(t); x.lifecycle.publish(x.publication);
  const base = { share: x.root, epoch: x.publication.lifecycleEpoch, machine: f.machine, submissionId: x.publication.submissionId };
  x.states.transitionLifecycleJob({ ...base, from: 'inbox', to: 'running' });
  p.validateJobResult(result);
  x.states.transitionLifecycleJob({ ...base, from: 'running', to: 'failed', result });
  const observed = x.lifecycle.observe(x.publication);
  const { extractNodeJobResult } = x.load('bot/cluster-agent-node-lifecycle.ts');
  assert.deepEqual(observed.identity, x.publication.expected);
  assert.deepEqual(observed.record.result, { ...x.publication.expected, ...result });
  assert.deepEqual(extractNodeJobResult(observed.record, observed.identity), result);
  assert.throws(() => extractNodeJobResult({ ...observed.record,
    result: { ...observed.record.result, payloadSha256: '0'.repeat(64) } }, observed.identity), /身份漂移/);
  assert.throws(() => extractNodeJobResult({ ...observed.record,
    result: { ...observed.record.result, unexpectedField: true } }, observed.identity), 'unknown result fields still fail closed');

  // Exercise the real observation consumer, not just the extractor: it must
  // send strict JobResult; the original jobs-v12 record keeps its identity.
  const gateway = { execution: { prepareObservation() { throw new Error('unused'); } }, port: {},
    runtime: { current: async () => ({ generation: 1, connection: 'connected', scope: f.scope }) },
    replyTo: (request, kind, payload) => ({ kind, payload }) };
  const config = { mode: 'remote', machine: f.machine, head: x.publication.codeRef.value,
    lifecycleRoot: x.root, stateRoot: path.join(x.root, 'node'), artifactRoot: path.join(x.root, 'artifacts'), snapshotRoot: path.join(x.root, 'snapshots') };
  const runtime = x.load('node/runtime.cjs').createWindowsNode({ config, gateway, dependencies: {
    lifecycle: x.lifecycle, reader: {}, ciObserver: { start() {}, stop() {}, read: () => ({ state: 'idle' }) },
    loadSampler: { start() {}, stop() {}, read: () => ({}), readMemory: () => null },
  } });
  await runtime.start();
  try {
    const request = f.envelope('handoff.observe-request', { payload: { ...f.payloads['handoff.observe-request'], expected: observed.identity } });
    const reply = await runtime.handleCloudRequest(request);
    p.validateRequest('handoff.observe', reply.payload);
    assert.equal(reply.payload.state, 'failed', runtime.health().fault ?? 'terminal observation');
    assert.deepEqual(reply.payload.identity, observed.identity);
    assert.deepEqual(reply.payload.result, result); assert.equal(reply.payload.exitCode, result.exitCode);
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(config.stateRoot, 'objects', reply.payload.resultObject.objectId + '.blob'), 'utf8')),
      result);
  } finally { await runtime.close(); }
  const wrong = structuredClone(x.publication); wrong.expected.payloadSha256 = '0'.repeat(64);
  assert.throws(() => x.lifecycle.observe(wrong));
  }
});

test('runtime consumes gateway scope and reply factory; no replacement uplink session', async t => {
  const x = await lifecycleFixture(t); x.lifecycle.close();
  const { createWindowsNode } = x.load('node/runtime.cjs');
  let generation = 1;
  const replies = [];
  const gateway = {
    execution: { prepareObservation() { throw new Error('not used by handoff'); } }, port: {},
    runtime: { current: async () => ({ generation, connection: 'connected', scope: f.scope }) },
    replyTo(request, kind, payload, identity) {
      assert.ok(!['submission', 'session.open', 'report.started'].includes(kind));
      const result = { kind, payload, identity }; replies.push(result); return result;
    },
  };
  const runtime = createWindowsNode({ config: { mode: 'remote', machine: f.machine, head: x.publication.codeRef.value,
    lifecycleRoot: x.root, stateRoot: path.join(x.root, 'node'), artifactRoot: path.join(x.root, 'artifacts'), snapshotRoot: path.join(x.root, 'snapshots') }, gateway,
    dependencies: { reader: {}, ciObserver: { start() {}, stop() {}, read: () => ({ state: 'idle', observedAt: new Date().toISOString() }) },
      loadSampler: { start() {}, stop() {}, read: () => ({}), readMemory: () => null } } });
  onCleanup(t, () => runtime.close()); await runtime.start();
  const request = f.envelope('handoff.publish', { payload: x.publication });
  const actual = { ...request, payload: x.publication }; actual.contentHash = p.envelopeHash(actual);
  assert.equal((await runtime.handleCloudRequest(actual)).payload.status, 'business_accepted');
  assert.equal((await runtime.handleCloudRequest(actual)).payload.status, 'business_accepted');
  assert.equal(replies.length, 2);
  generation++;
  assert.equal((await runtime.handleCloudRequest(actual)).payload.status, 'business_accepted');
  assert.equal(runtime.health().active, true, 'a new generation remains usable for subsequent requests');
});

test('artifact/log objects are bounded immutable copies, reject wrong token, corrupt bytes and traversal', async t => {
  const root = await temporary(t), inputs = path.join(root, 'inputs'); await fsp.mkdir(inputs);
  assert.equal(await contained(root, 'inputs'), await fsp.realpath(inputs), 'short temporary-root spelling resolves to the same canonical directory');
  await assert.rejects(contained(root, '../escape'), /OBJECT_ESCAPE/);
  const bytes = Buffer.alloc(300000, 65); await fsp.writeFile(path.join(inputs, 'workload.log'), bytes);
  const store = createObjectStore({ root: path.join(root, 'objects') });
  const ref = await store.publish(f.granted, inputs, 'workload.log');
  const request = { requestId: 'fixture-object-read', object: ref, offset: 131072, length: 131072 };
  const chunk = await store.read(f.granted, request, 'log.read');
  p.validateRequest('log.chunk', chunk); assert.deepEqual(Buffer.from(chunk.dataBase64, 'base64'), bytes.subarray(131072, 262144));
  await assert.rejects(store.read({ ...f.granted, permitToken: 'other' }, request, 'log.read'), /BINDING/);
  await assert.rejects(store.publish(f.granted, inputs, '../workload.log'), /OBJECT_NAME/);
  const linked = path.join(root, 'linked');
  await fsp.symlink(inputs, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.publish(f.granted, linked, 'workload.log'), /REPARSE/);
  await fsp.symlink(inputs, path.join(root, 'inputs', 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(contained(root, 'inputs/redirect/workload.log'), /REPARSE/);
  await fsp.writeFile(path.join(root, 'objects', ref.objectId + '.blob'), Buffer.alloc(bytes.length, 66));
  await assert.rejects(store.read(f.granted, request, 'log.read'), /OBJECT_HASH/);
  await assert.rejects(store.publish(f.granted, inputs, 'workload.log'), /OBJECT_HASH/);
});

test('original suspension controller retains CI/manual/owner reasons and timing; remote manage never releases', async t => {
  const root = await temporary(t), load = sourceLoader();
  const { SuspensionController } = load('sched/sched-suspend.ts');
  const { SuspendStore } = load('sched/sched-suspend-store.ts');
  const { measureSuspensionWindow } = load('sched/sched-suspend-timing.ts');
  const member = { pid: 123, creationFileTime: '133000000000000000' };
  let clock = 1000, suspended = false, released = 0;
  const native = {
    async launch(input) { input.recordHost(member); return { root: member, host: member }; },
    async release() { released++; }, async members() { return [member]; },
    async act(action) { if (action === 'suspend') suspended = true; if (action === 'resume') suspended = false; return { status: 'ok' }; },
    async check(action) { return { confirmed: action === 'suspend' ? suspended : action === 'resume' ? !suspended : true }; },
    async close() {}, async kill() {}, async poll() { return { empty: false, exitCode: null }; },
  };
  const controller = new SuspensionController({ store: new SuspendStore(path.join(root, 'suspend.json')), native,
    now: () => clock, warn: () => {} });
  const intent = { manual: false, ownerHold: false };
  await controller.manage({ ticketId: f.granted.ticketId, attemptId: 'a1', token: f.granted.permitToken, machine: f.machine,
    share: root, category: 'unit-test', ownerPid: process.pid, command: process.execPath, args: [], cwd: root,
    env: { SCHED_MODE: 'remote' }, remoteStartGate: true }, intent, () => ({ state: 'active', observedAt: clock }));
  assert.equal(released, 0); assert.equal(suspended, true); assert.deepEqual(controller.snapshot.reasons, ['ci']);
  // Preserve the original 60s fresh-idle debounce without waiting a real minute.
  for (clock = 11000; clock <= 71000; clock += 10000)
    await controller.tick({ state: 'idle', observedAt: clock }, intent);
  assert.equal(suspended, false); assert.deepEqual(controller.snapshot.reasons, []);
  clock = 81000;
  await controller.tick({ state: 'idle', observedAt: clock }, { manual: true, ownerHold: true });
  assert.deepEqual(controller.snapshot.reasons, ['manual', 'owner-hold']);
  clock = 91000;
  await controller.tick({ state: 'idle', observedAt: clock }, { manual: false, ownerHold: true });
  assert.equal(suspended, true); assert.deepEqual(controller.snapshot.reasons, ['owner-hold']);
  clock = 101000; await controller.tick({ state: 'idle', observedAt: clock }, intent);
  assert.equal(suspended, false);
  assert.deepEqual(measureSuspensionWindow(1000, clock, controller.snapshot),
    { rawMs: 100000, suspendedMs: 90000, elapsedMs: 10000, comparable: true });
  assert.equal(controller.settleLostTree(), false, 'remote mode never infers exit from numeric PIDs');
  // The identical legacy path still owns its original initial release.
  const local = new SuspensionController({ store: new SuspendStore(path.join(root, 'local.json')), native,
    now: () => clock, warn: () => {} });
  await local.manage({ ticketId: f.granted.ticketId, attemptId: 'a2', token: f.granted.permitToken, machine: f.machine,
    share: root, category: 'unit-test', ownerPid: process.pid, command: process.execPath, args: [], cwd: root, env: {} }, intent,
    () => ({ state: 'idle', observedAt: clock }));
  assert.equal(released, 1);
});

test('artifact discovery only publishes actual named files and verifies zipBytes', async t => {
  const root = await temporary(t), inputs = path.join(root, 'artifacts'); await fsp.mkdir(inputs);
  await fsp.writeFile(path.join(inputs, 'result.json'), '{}'); await fsp.writeFile(path.join(inputs, 'result.zip'), 'fixture');
  const store = createObjectStore({ root: path.join(root, 'objects') });
  const artifacts = { state: 'zipped', manifest: 'result.json', zip: 'result.zip', zipBytes: 7 };
  const good = await store.artifacts(f.granted, artifacts, inputs);
  assert.equal(good.state, 'ready'); assert.equal(good.zip.size, 7); assert.equal(good.manifest.size, 2);
  assert.equal((await store.artifacts(f.granted, { ...artifacts, zipBytes: 8 }, inputs)).state, 'unavailable');
  assert.equal((await store.artifacts(f.granted, { ...artifacts, zip: 'missing.zip' }, inputs)).state, 'unavailable');
});

// Real CLI and workload processes, with a strict in-process gateway/native-port
// fixture. JobObject/watchdog evidence belongs to cloudSchedulerNodeNative.
async function localRunFixture(t, settings = {}) {
  const root = await temporary(t), load = sourceLoader(), { spawn } = require('node:child_process');
  const { createHash, randomUUID } = require('node:crypto');
  const projectRoot = path.join(root, 'caller-worktree'); await fsp.mkdir(projectRoot);
  await fsp.writeFile(path.join(projectRoot, 'task.cjs'), 'process.stdout.write("out-seven");process.stderr.write("err-seven");process.exitCode=7;');
  const client = load('sched/client/sched.cjs');
  const allowedMachines = settings.handoff ? [f.machine, 'fixture-origin'] : [f.machine];
  load('sched/client/deployment-config.cjs').configureDeployment({ schemaVersion: 1, machines: allowedMachines.map(name => ({ name, dedicated: true })),
    projects: [{ id: 'fixture-local', repo: projectRoot, accepted: true, machines: allowedMachines,
      ...(settings.handoff ? { deps: { manifests: ['package.json', 'package-lock.json'], install: [['npm', 'ci']] } } : {}), menu: [
      { id: 'other', category: 'shared', cores: 1, args: { kind: 'none' }, forms: [{ cmd: ['node', 'unused.cjs'], tail: 'none' }] },
      { id: 'fixture-menu', category: 'shared', cores: 1, artifacts: ['product.txt'], args: { kind: 'none' }, forms: [{ cmd: ['node', 'menu.cjs'], tail: 'none' }] },
    ] }], jobs: {} });
  const tickets = new Map(), originals = new Map(), prepared = new Map(), gates = [], observations = [];
  const peer = { sid: 'S-1-5-21-1001-1002-1003-1004', pid: process.pid, creationFileTime: '133000000000000001', logonSessionId: 'fixture-logon' };
  // Mock caller remains synthetic. The real-native fixture obtains the local
  // controller's complete OS identity through the same public transport probe.
  const controllerPeer = settings.realNative
    ? await require('../packages/scheduler/src/transport/local-ipc.cjs').readParentIdentity({
      powershell: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    }, { timeoutMs: 30000 })
    : { ...peer, pid: process.pid + 1, creationFileTime: '133000000000000002' };
  let scope = structuredClone(f.scope), generation = 1, connected = true, sequence = 0, lostStart = false, lostReply = false;
  let boundGeneration = 0;
  const cursor = { seq: 20, hash: 'a'.repeat(64) };
  const notice = () => ({ generation, connection: connected ? 'connected' : 'disconnected', scope: connected ? scope : null });
  const frame = (kind, payload, identity) => {
    const value = { protocolVersion: p.PROTOCOL_VERSION, authorityId: scope.authorityId, authorityEpoch: scope.authorityEpoch,
      nodeId: scope.nodeId, nodeSession: scope.nodeSession, sequence: ++sequence, messageId: randomUUID(), kind, payload,
      ...(identity ? { execution: identity } : {}) };
    value.contentHash = p.envelopeHash(value); p.decodeFrame(p.encodeFrame(value)); return value;
  };
  const receipt = envelope => ({ messageId: envelope.messageId, envelopeHash: envelope.contentHash,
    ...(p.IMMUTABLE_KINDS.includes(envelope.kind) ? p.operationIdentity(envelope) : { operationKey: null, operationHash: null }),
    status: 'business_accepted', businessCursor: cursor, outcome: envelope.kind.startsWith('report.')
      ? { kind: 'report', ticketId: envelope.execution.ticketId, attemptId: envelope.execution.attemptId, phase: envelope.payload.phase }
      : { kind: 'applied' } });
  function ticket(key = randomUUID()) {
    const request = { idempotencyKey: key, project: 'fixture-local', submitter: 'fixture', category: 'other', title: 'Harmless real argv',
      work: { type: 'other', targetPaths: ['task.cjs'] }, requestedCores: 1, allowedMachines: [f.machine],
      codeRef: client.contentFingerprint(projectRoot, ['task.cjs']), resources: { exclusive: [] }, createdAt: new Date().toISOString() };
    const id = client.deriveTicketId(request.project, key), value = structuredClone(require('../packages/scheduler/fixtures/protocol/read-directory.cjs').tickets.find(x => x.state === 'granted'));
    Object.assign(value, { ticketId: id, request, contentHash: p.contentHash(request), timeline: [], lastSeq: cursor.seq });
    value.attempts[0].permit = { ticketId: id, attemptId: 'a1', token: randomUUID(), machine: f.machine, category: 'other', grantedCores: 1, issuedAt: request.createdAt };
    value.attempts[0].grantedCores = 1;
    tickets.set(id, value); originals.set(id, { status: 'found', request, peer: structuredClone(peer), localContext: { cwd: projectRoot },
      source: { proofId: randomUUID(), method: 'ipc-peer', callId: key, submissionHash: value.contentHash, observedOwnerSid: peer.sid } });
    return value;
  }
  const reader = { ticket: async id => tickets.get(id) ?? null,
    read: async () => ({ objects: [{ entry: { kind: 'ci-policy' }, value: { formatVersion: 1, mode: 'freeze' } }] }),
    waiting: async id => { assert.ok(tickets.has(id)); },
    cancel: async id => { tickets.get(id).cancelRequested = true; } };
  const gateway = {
    runtime: { current: async () => notice() }, localExecutionPeer: async () => controllerPeer,
    submissionSources: { async get(identity, expected) {
      const found = originals.get(identity.ticketId);
      if (!found || found.source.submissionHash !== identity.submissionHash || expected && p.canonicalJson(expected) !== p.canonicalJson(found.source))
        return { status: 'unknown', reason: 'original missing or changed' };
      return structuredClone(found);
    } },
    replyTo: async (request, kind, payload) => ({ kind, payload }),
    execution: {
      async prepareObservation(actualPeer, observation) {
        assert.deepEqual(actualPeer, controllerPeer, 'trusted controller peer, never submitter peer');
        const envelope = frame(observation.kind, observation.payload, observation.identity), preparationId = randomUUID();
        prepared.set(preparationId, envelope); observations.push(observation); return { preparationId, envelope };
      },
      async sendPrepared(actualPeer, id) {
        assert.deepEqual(actualPeer, controllerPeer);
        const envelope = prepared.get(id); assert.ok(envelope); prepared.delete(id);
        if (envelope.kind === 'report.started') {
          const value = tickets.get(envelope.execution.ticketId); value.state = 'running';
          value.attempts[0].controller = { machine: f.machine, ...envelope.execution.controller };
          if (lostStart) { lostStart = false; throw new Error('fixture lost started business ACK'); }
          return { envelope, reply: frame('result', receipt(envelope)) };
        }
        const q = envelope.payload;
        if (boundGeneration !== generation) {
          boundGeneration = generation;
          assert.equal(q.challengeSequence, 1, 'bootstrap must precede the fresh projection');
          assert.ok(gates.every(g => !g.released || g.fenced), 'bootstrap never releases a tree');
          const { outcome, ...base } = receipt(envelope);
          return { envelope, reply: frame('result', { ...base, status: 'business_rejected', reason: 'STALE_CURSOR' }) };
        }
        return { envelope, reply: frame('lease.renewal', { ...scope, ...envelope.execution, ledgerSeq: q.ledgerSeq,
          challenge: q.challenge, challengeSequence: q.challengeSequence, leaseId: randomUUID(), leaseSequence: sequence + 1, ttlMs: q.requestedTtlMs }, envelope.execution) };
      },
      async acceptObservation(actualPeer, observation) {
        assert.deepEqual(actualPeer, controllerPeer); observations.push(observation);
        if (observation.kind === 'execution.heartbeat' && !observation.payload.suspend.ended) {
          const gate = gates.find(g => g.identity.attemptId === observation.identity.attemptId && g.identity.ticketId === observation.identity.ticketId);
          assert.equal(observation.payload.childPid, gate.root.pid);
          assert.notEqual(observation.payload.childPid, observation.identity.controller.pid);
        }
        return receipt(frame(observation.kind, observation.payload, observation.identity));
      },
    },
    async readProjection() { assert.equal(boundGeneration, generation, 'freshSnapshot requires authenticated runtime binding'); return { kind: 'state.snapshot' }; },
    port: { readFreshProjection() { return { allowed: true, projection: { ...structuredClone(f.payloads['state.snapshot']), ...scope, snapshotId: randomUUID(), complete: true,
      generatedAt: new Date().toISOString(), ledgerSeq: cursor.seq, businessCursor: cursor, sessionWatermark: 1, liveWatermark: 1,
      attempts: gates.filter(g => !g.fenced).map(g => ({ ...g.identity, state: 'running', permitLedgerSeq: 19,
        grantedCores: 1, cancelRequested: false })) } }; } },
    semantic: { async accept(actualPeer, request) { assert.deepEqual(actualPeer, peer); assert.equal(request.kind, 'command');
      tickets.get(request.command.data.ticketId).cancelRequested = true;
      return { kind: 'business', result: receipt(frame('command', request.command)) }; } },
  };
  function nativeFactory(input) {
    if (settings.realNative) {
      assert.equal(process.platform, 'win32', 'published execution fixture requires a real Windows JobObject');
      const native = require('../packages/scheduler/src/node/native.cjs').createNativeGate(input);
      const gate = { ...native, fenced: false, released: false,
        async prepare(identity, hooks) {
          const value = await native.prepare(identity, hooks); gate.identity = value.identity; gate.root = value.root; return value;
        },
        async release(...args) { const result = await native.release(...args); gate.released = true; return result; },
        async fence() { gate.fenced = true; return native.fence(); },
      };
      gates.push(gate); return gate;
    }
    const rootIdentity = { pid: 2000 + gates.length, creationFileTime: String(133000000000000010n + BigInt(gates.length)) };
    const controllerIdentity = { pid: 4000 + gates.length, creationFileTime: String(133000000000000100n + BigInt(gates.length)) };
    let preparedValue, child, exited = false, code = null, lease, released = false;
    const gate = { gateId: randomUUID(), fenced: false, root: rootIdentity,
      async prepare(identity, hooks = {}) {
        if (!preparedValue) { hooks.recordHost?.(controllerIdentity); gate.identity = { ...identity, stage: 'started', controller: controllerIdentity };
          preparedValue = { identity: gate.identity, controller: controllerIdentity, root: rootIdentity }; }
        return preparedValue;
      },
      async recordChallengeSend(id, envelope) { assert.equal(id, gate.gateId); gate.challenge = envelope; },
      async acceptLease(id, envelope) { assert.equal(id, gate.gateId); lease = envelope; return envelope; },
      async release(id, started, ack, projection, accepted) {
        assert.equal(ack.status, 'business_accepted'); assert.equal(accepted, lease); assert.ok(!released); released = true;
        assert.ok(gate.challenge.payload.challengeSequence >= 2); gate.released = true;
        child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.env, windowsHide: true });
        const out = fs.createWriteStream(path.join(input.directory, 'workload.stdout.log'));
        const err = fs.createWriteStream(path.join(input.directory, 'workload.stderr.log'));
        child.stdout.pipe(out); child.stderr.pipe(err);
        gate.closed = new Promise(resolve => child.once('close', async value => {
          await Promise.all([out, err].map(stream => stream.writableFinished ? undefined : new Promise(done => stream.once('finish', done))));
          code = value; exited = true; resolve();
        }));
        return true;
      },
      async poll() { return { verdict: exited ? 'tree-exited' : 'alive', empty: exited, exitCode: code, expired: gate.fenced }; },
      async members() { return exited ? [] : [rootIdentity]; }, async act() { return { status: 'ok' }; }, async check() { return { confirmed: true }; },
      async fence() { gate.fenced = true; if (child && !exited) { child.kill(); await gate.closed; } else if (!child) exited = true; },
      async close() { if (child && !exited) { child.kill(); await gate.closed; } },
    }; gates.push(gate); return gate;
  }
  const config = { mode: 'remote', machine: f.machine, head: '1'.repeat(40), stateRoot: path.join(root, 'node'),
    lifecycleRoot: path.join(root, 'lifecycle'), artifactRoot: path.join(root, 'artifacts'), snapshotRoot: path.join(root, 'snapshots') };
  let lifecycle = { start() {}, renew() {}, close() {}, heartbeat: () => f.payloads['machine.observation'].lifecycle };
  if (settings.handoff) {
    const control = load('bot/cluster-lifecycle-control.ts');
    const paths = control.lifecyclePaths(config.lifecycleRoot, f.payloads['handoff.publish'].lifecycleEpoch, f.machine);
    await fsp.mkdir(path.dirname(paths.control), { recursive: true });
    await fsp.writeFile(paths.control, JSON.stringify({ namespace: 'jobs-v12', lifecycleSchema: 12,
      epoch: f.payloads['handoff.publish'].lifecycleEpoch, state: 'ACTIVE', codeVersion: config.head,
      configuredMachines: [f.machine], createdAt: f.at, createdBy: 'fixture' }));
    lifecycle = load('bot/cluster-agent-node-lifecycle.ts').createNodeLifecycle({ share: config.lifecycleRoot, machine: f.machine, head: config.head });
  }
  const runtime = load('node/runtime.cjs').createWindowsNode({ config, gateway, dependencies: { reader, nativeFactory,
    lifecycle,
    ciObserver: { start() {}, stop() {}, read: () => ({ state: 'idle',
      observedAt: new Date(load('sched/sched-suspend-timing.ts').suspendClock() - 1000).toISOString() }) },
    loadSampler: { start() {}, stop() {}, read: () => ({}), readMemory: () => null } } });
  await runtime.start(); onCleanup(t, () => runtime.close());
  const bodies = new Map();
  const port = { runtime: gateway.runtime,
    async call(request) {
      p.validateLocalSemanticRequest(request);
      if (request.kind === 'read') {
        const value = tickets.get(request.selectors[0].ticketId), bytes = Buffer.from(JSON.stringify(value)), objectId = randomUUID(); bodies.set(objectId, bytes);
        return { kind: 'read', manifest: { requestId: request.callId, scope: { kind: 'authority-read', authorityId: scope.authorityId, authorityEpoch: scope.authorityEpoch },
          snapshotId: 'local-fixture', ledgerCursor: cursor, issuedAt: new Date(Date.now() - 100).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
          entries: [{ kind: 'ticket', ticketId: value.ticketId, snapshotId: 'local-fixture', ledgerCursor: cursor, audience: { kind: 'owner' }, contentType: 'application/json',
            object: { objectId, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } }], nextPageToken: null } };
      }
      const reply = await runtime.handleLocalExecution(peer, request, { timeoutMs: 1000 });
      if (request.kind === 'local-run' && lostReply) { lostReply = false; throw new Error('fixture dropped start reply'); }
      return reply;
    },
    async readObject(entry) { const bytes = bodies.get(entry.object.objectId); assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.object.hash); return JSON.parse(bytes); },
  };
  return { root, projectRoot, config, runtime, gateway, client, port, peer, ticket, tickets, originals, gates, observations, reader, load, lifecycle, frame,
    loseStart: () => { lostStart = true; }, loseReply: () => { lostReply = true; },
    disconnect: () => { connected = false; generation++; }, reconnect: () => { connected = true; generation++; scope = { ...scope, nodeSession: randomUUID(), gatewayInstance: randomUUID() }; } };
}

test('original CLI run uses caller worktree/non-menu argv, preserves both streams and exit 7, dropped replies start once', { timeout: 30000 }, async t => {
  const x = await localRunFixture(t), ticket = x.ticket(); x.loseReply(); x.loseStart();
  const out = [], err = [];
  const result = await x.client.run(ticket.ticketId, { mode: 'remote', remotePort: x.port, remoteConfig: { authorityId: f.scope.authorityId },
    root: x.projectRoot, command: process.execPath, args: ['task.cjs'], env: { ...process.env, SCHED_PERMIT: 'forged-by-caller' },
    remoteOutput: bytes => out.push(bytes), remoteError: bytes => err.push(bytes) });
  assert.equal(result.exitCode, 7); assert.equal(result.jobResult.exitCode, 7);
  assert.equal(Buffer.concat(out).toString(), 'out-seven'); assert.equal(Buffer.concat(err).toString(), 'err-seven');
  assert.equal(x.gates.length, 1); assert.equal(x.observations.filter(v => v.kind === 'report.started').length, 2);
  const starts = x.observations.filter(v => v.kind === 'report.started'); assert.deepEqual(starts[0], starts[1]);
  assert.ok(x.observations.filter(v => v.kind === 'lease.challenge').length >= 2, 'bootstrap rejection requires a fresh formal lease');
  assert.ok(x.observations.some(v => v.kind === 'execution.heartbeat' && v.payload.childPid === x.gates[0].root.pid));
});

test('published menu job imports the verified bundle, claims jobs-v12, runs a real child and returns logs/artifacts', { timeout: 60000 }, async t => {
  const x = await localRunFixture(t, { handoff: true, realNative: true });
  const { execFile } = require('node:child_process'), { createHash } = require('node:crypto');
  const git = args => new Promise((resolve, reject) => execFile('git', args,
    { cwd: x.projectRoot, windowsHide: true, timeout: 12000, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  await fsp.writeFile(path.join(x.projectRoot, 'menu.cjs'), 'require("node:fs").writeFileSync("product.txt","original");process.exitCode=7;');
  await fsp.writeFile(path.join(x.projectRoot, 'package.json'), JSON.stringify({ name: 'harmless-node-fixture', version: '1.0.0', private: true }));
  await fsp.writeFile(path.join(x.projectRoot, 'package-lock.json'), JSON.stringify({ name: 'harmless-node-fixture', version: '1.0.0',
    lockfileVersion: 3, requires: true, packages: { '': { name: 'harmless-node-fixture', version: '1.0.0' } } }));
  await git(['init', '-b', 'main']); await git(['add', 'task.cjs', 'menu.cjs', 'package.json', 'package-lock.json']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=', 'commit', '-m', 'synthetic base']);
  const base = await git(['rev-parse', 'HEAD']);
  const value = x.ticket(), ticketId = value.ticketId, permit = value.attempts[0].permit;
  Object.assign(value.request, { execution: 'auto', origin: 'fixture-origin', menu: { item: 'fixture-menu', args: [] },
    allowedMachines: ['fixture-origin', f.machine], codeRef: { kind: 'commit', value: base }, work: { type: 'fixture-menu', targetPaths: ['.'] } });
  value.contentHash = p.contentHash(value.request);
  await fsp.writeFile(path.join(x.projectRoot, 'menu.cjs'), 'const fs=require("node:fs");fs.writeFileSync("product.txt","snapshot");process.stdout.write("menu-out");process.stderr.write("menu-err");process.exitCode=7;');
  const snapshots = x.load('sched/client/sched-snapshot.cjs'), bundleRoot = path.join(x.root, 'origin-bundle');
  await fsp.mkdir(bundleRoot);
  const made = await snapshots.createSnapshot({ repoPath: x.projectRoot, ticketId, tempDir: bundleRoot, timeoutMs: 12000 });
  assert.equal(made.ok, true);
  const bundled = await snapshots.createBundle({ repoPath: x.projectRoot, ticketId, mainCommit: base, destDir: bundleRoot, timeoutMs: 12000 });
  assert.equal(bundled.ok, true);
  const bytes = await fsp.readFile(path.join(bundleRoot, ticketId + '.bundle'));
  const metadata = { schema: 1, ticketId, attemptId: 'a1', requestId: 'fixture-snapshot', createdAt: new Date().toISOString(), state: 'ready',
    commit: made.commit, base, bundle: ticketId + '.bundle', bundleBytes: bytes.length,
    object: { objectId: 'origin-object', hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } };
  const publication = { ...structuredClone(f.payloads['handoff.publish']), submissionId: `${ticketId}--a1`,
    submission: value.request, permit, codeRef: { kind: 'commit', value: made.commit }, snapshot: metadata, grantedCores: 1 };
  delete publication.queueRank; delete publication.rerun;
  const job = { ticketId, jobId: publication.submissionId, kind: 'fixture-menu', codeVersion: made.commit, grantedCores: 1,
    auto: { project: 'fixture-local', item: 'fixture-menu', args: [], bundle: metadata.bundle, commit: made.commit, base } };
  publication.expected = x.load('bot/cluster-lifecycle-contract.ts').buildLifecycleIdentity({ epoch: publication.lifecycleEpoch,
    jobId: job.jobId, submissionId: publication.submissionId, machine: f.machine, codeVersion: made.commit,
    createdAt: publication.createdAt, createdBy: value.request.submitter, payload: x.load('bot/cluster-job.ts').clusterJobPayload(job) });
  const originalRead = x.reader.read;
  x.reader.read = async selectors => selectors[0].kind === 'snapshot-bundle' ? { objects: [{ entry: {
    kind: 'snapshot-bundle', ticketId, attemptId: 'a1', contentType: 'application/octet-stream',
    object: { ...metadata.object, objectId: 'cloud-version-object' } }, value: bytes }] } : originalRead(selectors);
  const identity = { stage: 'granted', ticketId, attemptId: 'a1', permitToken: permit.token };
  const request = x.frame('handoff.publish', publication, identity);
  assert.equal((await x.runtime.handleCloudRequest(request)).payload.status, 'business_accepted');
  await x.runtime.handleCloudRequest(request);
  const deadline = Date.now() + 45000;
  let observed;
  do { observed = x.lifecycle.observe(publication); if (['done', 'failed'].includes(observed.state)) break;
    await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
  assert.equal(observed.state, 'failed', x.runtime.health().fault ?? 'job did not complete');
  assert.equal(observed.record.result.exitCode, 7, JSON.stringify({ result: observed.record.result, health: x.runtime.health() })); assert.equal(observed.record.result.refused, undefined);
  assert.equal(observed.record.result.artifacts.state, 'zipped'); assert.equal(x.gates.length, 1);
  assert.equal(await git(['rev-parse', 'HEAD']), base, 'configured repository was not checked out or rewritten');
  const observePayload = { submissionId: publication.submissionId, ownerMachine: publication.ownerMachine, authorityHost: publication.authorityHost,
    intentId: publication.intentId, lifecycleEpoch: publication.lifecycleEpoch, requestId: 'fixture-observe', timeoutMs: 12000, expected: publication.expected };
  // finish persistence follows the lifecycle transition in the same execution loop.
  await new Promise(resolve => setTimeout(resolve, 50));
  const report = (await x.runtime.handleCloudRequest(x.frame('handoff.observe-request', observePayload, identity))).payload;
  p.validateRequest('handoff.observe', report); assert.equal(report.artifactObjects.state, 'ready'); assert.ok(report.log);
  const resultObject = await x.runtime.handleCloudRequest(x.frame('artifact.read', { requestId: 'fixture-result', object: report.resultObject,
    offset: 0, length: report.resultObject.size }, identity));
  const { suspension, ...resultBody } = JSON.parse(Buffer.from(resultObject.payload.dataBase64, 'base64'));
  p.validateJobResult(resultBody); assert.equal(resultBody.exitCode, 7);
  assert.equal(suspension.ticketId, ticketId); assert.equal(suspension.token, permit.token);
  assert.equal(observed.record.result.submissionId, publication.submissionId, 'original lifecycle evidence keeps its identity');
  const log = await x.runtime.handleCloudRequest(x.frame('log.read', { requestId: 'fixture-log', object: report.log,
    offset: 0, length: report.log.size }, identity));
  assert.match(Buffer.from(log.payload.dataBase64, 'base64').toString(), /menu-out[\s\S]*menu-err/);
});

test('original IPC source is checked; a copied request with a different original owner cannot launch', async t => {
  const x = await localRunFixture(t), ticket = x.ticket(); x.originals.get(ticket.ticketId).peer.sid = 'S-1-5-21-99';
  const reply = await x.runtime.handleLocalExecution(x.peer, { kind: 'local-run', callId: 'source-denied',
    submission: { stage: 'submission', ticketId: ticket.ticketId, project: ticket.request.project, submissionHash: ticket.contentHash },
    command: process.execPath, args: ['task.cjs'], cwd: x.projectRoot, env: {} }, { timeoutMs: 1000 });
  assert.equal(reply.state, 'terminal'); assert.equal(reply.terminal.refused, 'source-refused'); assert.equal(x.gates.length, 0);
  await assert.rejects(x.runtime.handleLocalExecution(x.peer, { kind: 'report.started', callId: 'forged' }, { timeoutMs: 1000 }));
});

test('disconnect fences old execution; new scope accepts a different task without reviving the old tree', { timeout: 30000 }, async t => {
  const x = await localRunFixture(t), first = x.ticket();
  const request = { kind: 'local-run', callId: 'long-running', submission: { stage: 'submission', ticketId: first.ticketId,
    project: first.request.project, submissionHash: first.contentHash }, command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'], cwd: x.projectRoot, env: { ...process.env } };
  const startedRun = await x.runtime.handleLocalExecution(x.peer, request, { timeoutMs: 1000 });
  const deadline = Date.now() + 10000;
  while (!x.observations.some(o => o.kind === 'lease.challenge') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const beforeDisconnect = await x.runtime.handleLocalExecution(x.peer, { kind: 'local-run-read', callId: 'before-disconnect',
    runId: startedRun.runId, stdoutOffset: 0, stderrOffset: 0, maxBytes: 65536, waitMs: 0 }, { timeoutMs: 1000 });
  assert.equal(x.gates.length, 1, JSON.stringify({ reply: beforeDisconnect, health: x.runtime.health() })); x.disconnect();
  while (!x.gates[0].fenced && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(x.gates[0].fenced, true); x.reconnect();
  const second = x.ticket(), result = await x.client.run(second.ticketId, { mode: 'remote', remotePort: x.port,
    root: x.projectRoot, command: process.execPath, args: ['task.cjs'], env: { ...process.env }, remoteOutput() {}, remoteError() {} });
  assert.equal(result.exitCode, 7, JSON.stringify({ result, health: x.runtime.health() })); assert.equal(x.gates.length, 2); assert.equal(x.runtime.health().active, true);
  const retry = await x.runtime.handleLocalExecution(x.peer, request, { timeoutMs: 1000 });
  assert.notEqual(retry.state, 'queued'); assert.equal(x.gates.length, 2);
});

test('pre-start content drift refuses the real command before creating any native controller', { timeout: 15000 }, async t => {
  const x = await localRunFixture(t), ticket = x.ticket();
  await fsp.appendFile(path.join(x.projectRoot, 'task.cjs'), '\n// changed after submission\n');
  const result = await x.client.run(ticket.ticketId, { mode: 'remote', remotePort: x.port,
    root: x.projectRoot, command: process.execPath, args: ['task.cjs'], env: {}, remoteOutput() {}, remoteError() {} });
  assert.equal(result.exitCode, 2); assert.equal(result.jobResult.refused, 'launch-refused');
  assert.match(result.jobResult.reason, /CODE_REF_MISMATCH/); assert.equal(x.gates.length, 0);
});

test('durable pending local claim survives restart as unknown and never starts a replacement tree', async t => {
  const x = await localRunFixture(t), ticket = x.ticket();
  const request = { kind: 'local-run', callId: 'pending-before-crash', submission: { stage: 'submission', ticketId: ticket.ticketId,
    project: ticket.request.project, submissionHash: ticket.contentHash }, command: process.execPath,
    args: ['task.cjs'], cwd: x.projectRoot, env: {} };
  const runId = p.contentHash([x.peer.sid, request.callId]), directory = path.join(x.config.stateRoot, 'local-runs');
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(directory, runId + '.json'), JSON.stringify({ runId, sid: x.peer.sid, callId: request.callId,
    requestHash: p.contentHash(request), ticketId: ticket.ticketId, state: 'queued', terminal: null }));
  const reply = await x.runtime.handleLocalExecution(x.peer, request, { timeoutMs: 1000 });
  assert.equal(reply.state, 'unknown'); assert.equal(reply.terminal, null); assert.equal(x.gates.length, 0);
  await assert.rejects(x.runtime.handleLocalExecution(x.peer, { ...request, args: ['different.cjs'] }, { timeoutMs: 1000 }), /LOCAL_CALL_CONFLICT/);
  await assert.rejects(x.runtime.handleLocalExecution({ ...x.peer, sid: 'S-1-5-21-8' },
    { kind: 'local-run-cancel', callId: 'other-owner', runId }, { timeoutMs: 1000 }), /RUN_OWNER/);
});

test('snapshot reader uses the trusted semantic peer, frozen manifest and bounded full-hash-checked binary objects', async t => {
  const root = await temporary(t), load = sourceLoader(), { createHash } = require('node:crypto');
  load('sched/client/deployment-config.cjs').configureDeployment({ schemaVersion: 1, machines: [{ name: f.machine, dedicated: true }],
    projects: [{ id: 'fixture-read', repo: root, accepted: true, machines: [f.machine], menu: [{ id: 'other', category: 'shared',
      cores: 1, args: { kind: 'none' }, forms: [{ cmd: ['node', 'task.cjs'], tail: 'none' }] }] }], jobs: {} });
  const bytes = Buffer.alloc(300001, 91), hash = value => createHash('sha256').update(value).digest('hex');
  const selector = { kind: 'snapshot-bundle', ticketId: f.granted.ticketId, attemptId: f.granted.attemptId };
  const ledgerCursor = { seq: 9, hash: 'a'.repeat(64) };
  const entry = { ...selector, snapshotId: 'frozen-bundle', ledgerCursor, audience: { kind: 'machine-project', machine: f.machine, project: 'fixture-read' },
    contentType: 'application/octet-stream', object: { objectId: 'cloud-assigned-version', hash: hash(bytes), size: bytes.length } };
  const peer = { sid: 'S-1-5-21-1-2-3-4', pid: 41, creationFileTime: '133000000000000001', logonSessionId: 'fixture' };
  const readScope = { kind: 'authority-read', authorityId: f.scope.authorityId, authorityEpoch: f.scope.authorityEpoch };
  const lengths = []; let corrupt = false, ownerOnly = false, catalogs = 0;
  const gateway = { localExecutionPeer: async () => peer,
    runtime: { current: async () => ({ generation: 1, connection: 'connected', scope: f.scope }) },
    semantic: { async accept(actual, request) {
      assert.equal(actual, peer); p.validateLocalSemanticRequest(request);
      if (request.kind === 'read') { catalogs++; return { kind: 'read', manifest: { requestId: request.callId, scope: readScope, snapshotId: entry.snapshotId,
        ledgerCursor, issuedAt: new Date(Date.now() - 100).toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString(),
        entries: [{ ...entry, ...(ownerOnly ? { audience: { kind: 'owner' } } : {}) }], nextPageToken: null } }; }
      assert.equal(request.kind, 'read-object'); assert.equal(request.snapshotId, entry.snapshotId); lengths.push(request.length);
      const part = Buffer.from(bytes.subarray(request.offset, request.offset + request.length)); if (corrupt) part[0] ^= 1;
      return { kind: 'bytes', callId: request.callId, chunk: { requestId: request.callId, scope: readScope,
        snapshotId: request.snapshotId, ledgerCursor, entry: request.entry, offset: request.offset, length: request.length,
        dataBase64: part.toString('base64'), chunkHash: hash(part) } };
    } } };
  const reader = load('node/reader.cjs').createNodeReader(gateway, { stateRoot: root, machine: f.machine });
  assert.deepEqual((await reader.read([selector])).objects[0].value, bytes);
  assert.deepEqual(lengths, [131072, 131072, 37857]);
  corrupt = true; await assert.rejects(reader.read([selector]), /OBJECT_HASH/);
  assert.equal(catalogs, 2, 'hash failure does not restart');
  corrupt = false; ownerOnly = true; await assert.rejects(reader.read([selector]), /READ_DENIED/);
  assert.equal(catalogs, 3, 'permission failure does not restart'); ownerOnly = false;

  const accept = gateway.semantic.accept;
  for (const failureAt of ['catalog', 'chunk', 'both-attempts']) {
    const requests = []; let attempt = 0;
    const first = Object.assign(new Error('old snapshot evicted'), { code: 'READ_VERSION_UNAVAILABLE' });
    const second = Object.assign(new Error('replacement snapshot evicted'), { code: 'READ_VERSION_UNAVAILABLE' });
    gateway.semantic.accept = async (actual, request) => {
      requests.push(structuredClone(request));
      if (request.kind === 'read') {
        attempt++;
        assert.equal(request.snapshotId, null); assert.equal(request.pageToken, null);
        assert.deepEqual(request.selectors, [selector]);
        entry.snapshotId = `${failureAt}-version-${attempt}`;
        ledgerCursor.seq++; ledgerCursor.hash = String(attempt).repeat(64);
        bytes.fill(attempt === 1 ? 91 : 122);
        entry.object = { objectId: `${entry.snapshotId}-object`, hash: hash(bytes), size: bytes.length };
        if (failureAt === 'catalog' && attempt === 1) throw first;
      } else if (request.offset > 0 && (attempt === 1 || failureAt === 'both-attempts')) {
        throw attempt === 1 ? first : second;
      }
      return accept(actual, request);
    };
    if (failureAt === 'both-attempts') await assert.rejects(reader.read([selector]), error => error === second);
    else {
      const result = await reader.read([selector]);
      assert.equal(result.objects.length, 1); assert.equal(result.snapshotId, `${failureAt}-version-2`);
      assert.deepEqual(result.objects[0].value, Buffer.alloc(300001, 122), 'no bytes retained from the previous cursor');
      assert.equal(result.objects[0].entry.object.hash, hash(result.objects[0].value));
    }
    assert.equal(attempt, 2, 'Node and remote client share one retry budget');
    assert.equal(new Set(requests.map(r => r.callId)).size, requests.length);
    const replacement = requests.filter(r => r.kind === 'read-object' && r.snapshotId === `${failureAt}-version-2`);
    assert.equal(replacement[0].offset, 0, 'new buffer starts at zero');
    if (failureAt !== 'both-attempts') assert.deepEqual(replacement.map(r => r.length), [131072, 131072, 37857]);
  }
});

test('node consumer source parses and every static runtime import stays inside the public package', () => {
  const ts = require('../web/node_modules/typescript'), root = path.resolve(__dirname, '../packages/scheduler/src');
  const pending = fs.readdirSync(path.join(root, 'node')).filter(n => n.endsWith('.cjs')).map(n => path.join(root, 'node', n));
  const seen = new Set(), gatewayPorts = new Set(['gateway/client.cjs', 'gateway/domain.cjs']);
  while (pending.length) {
    const file = pending.pop(); if (seen.has(file)) continue; seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /[Ff]:[\\/]\s*(?:stock-rogue|project-dashboard|calib-share)/, 'no private installation paths');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
    assert.equal(parsed.parseDiagnostics.length, 0, parsed.parseDiagnostics.map(x => ts.flattenDiagnosticMessageText(x.messageText, '\n')).join('\n'));
    function visit(node) {
      let ref;
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ref = node.moduleSpecifier.text;
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) ref = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'require' && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) ref = node.arguments[0].text;
      if (ref && !Module.isBuiltin(ref)) {
        assert.ok(ref.startsWith('.'), `external dependency: ${ref} in ${file}`);
        const target = path.resolve(path.dirname(file), ref), relative = path.relative(root, target);
        assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `private import: ${ref}`);
        const found = [target, target + '.ts', target + '.cjs', target.replace(/\.js$/, '.ts')].find(x => fs.existsSync(x) && fs.statSync(x).isFile());
        if (found) pending.push(found);
        else assert.ok(gatewayPorts.has(relative.replaceAll('\\', '/')) || relative.endsWith('sched-suspend-native-assets'),
          `missing owned dependency: ${relative}`);
        // The two gateway implementations and generated native asset module are
        // composition/build inputs owned by the controller, not fixture stubs.
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  }
  assert.ok(seen.size > 20, 'traverse the actual lifecycle/permit/suspension closure');
});
