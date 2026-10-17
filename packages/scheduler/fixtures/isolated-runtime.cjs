'use strict'

// Run in a fresh process after deleting the isolated package's node_modules.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { builtinModules, Module, createRequire } = require('node:module')
const vm = require('node:vm')
const packageRoot = path.resolve(process.argv[2])
const sandbox = path.resolve(process.argv[3])
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  const result = originalResolve.call(this, request, ...args)
  if (!builtins.has(request)) {
    const relative = path.relative(packageRoot, result)
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `runtime dependency escaped isolated package: ${result}`)
  }
  return result
}
assert.equal(process.env.NODE_PATH, undefined)
assert.equal(fs.existsSync(path.join(packageRoot, 'node_modules')), false)
const load = file => require(path.join(packageRoot, 'dist', file))
const api = load('index.js')
const catalog = {
  schemaVersion: 1,
  machines: [{ name: 'fixture-host', dedicated: false }],
  projects: [{ id: 'sample', aliases: ['sample-alias'], repo: '.', accepted: true, machines: ['fixture-host'], menu: [
    { id: 'test', category: 'vitest', cores: 1, args: { kind: 'paths' }, forms: [{ cmd: ['node', '--test'], tail: 'args' }] },
  ] }],
  jobs: { test: { desc: 'Synthetic check', argv: ['node', '--test'], acceptsTarget: true, jobClass: 'vitest' } },
}
const empty = api.validateConfig({ schemaVersion: 1, machines: [], projects: [] })
assert.deepEqual(empty.projects, []); assert.deepEqual(empty.machines, [])
assert.equal(empty.ci.labels, null); assert.equal(empty.ci.takeover, null)
assert.throws(() => api.validateConfig({ ...catalog, unexpected: true }), /unknown field/)
assert.throws(() => api.validateConfig({ ...catalog, projects: [{ ...catalog.projects[0], machines: ['unknown'] }] }), /unknown machine/)
assert.throws(() => api.validateConfig({ ...catalog, projects: [{ ...catalog.projects[0], menu: [] }] }), /requires menu/)
assert.throws(() => api.validateConfig({ ...catalog, jobs: { test: { ...catalog.jobs.test, command: 'injected' } } }), /unknown field/)
api.configureDeployment(catalog)
const config = api.validateConfig(catalog)
assert.throws(() => api.configureDeployment({ schemaVersion: 1, machines: [], projects: [] }), /already initialized/)
const contract = load('sched/sched-contract.js')
const store = load('store.js')
const client = load('sched/client/sched.cjs')
assert.equal(client.SCHED_FORMAT_VERSION, 1)
// Exercise the real generated factories, including config and native assets.
// Only the in-memory evaluation appends access to its private factory function.
const clientFile = path.join(packageRoot, 'dist/sched/client/sched.cjs')
const generatedRuntime = vm.runInNewContext(fs.readFileSync(clientFile, 'utf8') + '\n;createSuspendRuntime()', {
  require: createRequire(clientFile), module: { exports: {} }, process, console, Buffer,
  __dirname: path.dirname(clientFile), setTimeout, clearTimeout, setInterval, clearInterval,
})
assert.equal(typeof generatedRuntime.startManagedExecution, 'function')
assert.equal(typeof api.createSchedulerDaemon, 'function')
assert.equal(load('sched/client/sched-projects.cjs').normalizeProjectId('sample-alias').id, 'sample')
const menu = load('sched/client/sched-menu.cjs')
assert.equal(menu.validateMenuArgs('sample', 'test', ['test/check.cjs']).ok, true)
assert.equal(menu.validateMenuArgs('sample', 'test', ['../escape.cjs']).ok, false)
assert.equal(menu.validateMenuArgs('sample', 'test', ['test/check.cjs;touch']).ok, false)
assert.equal(menu.validateMenuArgs('sample', 'missing', []).ok, false)
assert.throws(() => load('sched/sched-ci-labels-github.js').ghArgs({ kind: 'list-runners' }), /not configured/)
assert.throws(() => load('sched/sched-ci-takeover-github.js').createGithubReadClient({ token: 'synthetic' }), /not configured/)
assert.equal(load('bot/cluster-agent-ci-gate.js').isManagedJitWorkerPath('unconfigured/Runner.Worker.exe'), false)

let now = Date.parse('2026-01-01T00:00:00.000Z'), nonce = 0
const sources = { now: () => new Date(now).toISOString(), nonce: () => `fixture-${++nonce}` }
const head = 'a'.repeat(40)
function snapshot() {
  const at = sources.now()
  return {
    control: { namespace: 'jobs-v12', lifecycleSchema: 12, state: 'ACTIVE', epoch: 'fixture-epoch', codeVersion: head,
      createdAt: at, createdBy: 'fixture', configuredMachines: ['fixture-host'] },
    machines: [{ machine: 'fixture-host', counts: { inbox: 0, running: 0, done: 0, failed: 0, quarantine: 0 },
      heartbeat: { machine: 'fixture-host', at, state: 'idle', pid: process.pid, ownerPid: process.pid,
        ownerToken: 'synthetic-owner', protocol: 25, head,
        load: { schema: 1, cores: 8, busyCores: 0, busyPct: 0, windowSec: 30, sampledAt: at,
          ci: { state: 'idle', ciWorkers: 0, observedAt: at, stateSince: at } } } }],
  }
}
const share = path.join(sandbox, 'data')
fs.mkdirSync(share)
store.initializeScheduler(share, sources)
store.createDispatcherConfig(share, 'fixture-host', 'fixture', sources)
function request(key, extra = {}) {
  return { idempotencyKey: key, project: 'sample', submitter: 'fixture', category: 'unit-test', title: 'Synthetic task',
    work: { type: 'test', targetPaths: ['test/check.cjs'] }, requestedCores: 1, allowedMachines: ['fixture-host'],
    codeRef: { kind: 'commit', value: head }, resources: { exclusive: [] }, createdAt: sources.now(), ...extra }
}
function events() {
  const result = store.readLedger(share)
  assert.equal(result.status, 'ok')
  return result.value.events
}
const options = { share, machine: 'fixture-host', host: 'fixture-os-host', pid: process.pid, protocol: 25, head, sources,
  readMachines: snapshot, ciLabels: null,
  // Explicit synthetic process observation. Never assert Linux PID == Windows PID.
  probeProcess: () => { throw Object.assign(new Error('unknown process identity'), { code: 'EPERM' }) },
}
const req = request('first')
const submitted = store.writeSubmission(share, req)
assert.equal(store.writeSubmission(share, req).retransmission, true)
assert.throws(() => store.writeSubmission(share, { ...req, title: 'Different content' }), /幂等键/)
for (const validate of [contract.validateSubmission, client.validateSubmission]) {
  assert.throws(() => validate(request('unknown', { allowedMachines: ['unknown'] })), /unknown machine/)
  assert.throws(() => validate(request('missing-menu', { work: { type: 'missing', targetPaths: ['.'] } })), /no menu/)
  assert.throws(() => validate(request('unknown-project', { project: 'not-registered' })), /not accepted/)
}
let daemon = api.createSchedulerDaemon({ ...options, config })
try {
  assert.throws(() => api.createSchedulerDaemon(options), /占用|owner|lease/i)
  assert.equal(daemon.tick(), true)
  const id = submitted.ticketId
  assert.equal(daemon.state.tickets[id].state, 'granted')
  const permit = daemon.state.tickets[id].attempts[0].permit
  assert.deepEqual({ ...permit, token: '<token>' }, { ticketId: id, attemptId: 'a1', machine: 'fixture-host', category: 'unit-test', grantedCores: 1, issuedAt: req.createdAt, token: '<token>' })
  assert.ok(permit.token.length > 0)
  now += 2000; assert.equal(daemon.tick(), true)
  assert.equal(events().filter(e => e.type === 'submitted').length, 1)
  assert.equal(events().filter(e => e.type === 'granted').length, 1)
  assert.deepEqual(daemon.state, store.projectLedger(events()))
  const reports = contract.schedPaths(share)
  const started = { ticketId: id, attemptId: 'a1', phase: 'started', machine: 'fixture-host', token: permit.token,
    pid: 4242, creationFileTime: '134336000000000001', codeRef: req.codeRef, at: sources.now() }
  const put = report => fs.writeFileSync(path.join(reports.reports, contract.reportName(report)), contract.canonicalJson(report))
  // Wrong token must never become a started event.
  put({ ...started, token: 'wrong-token' }); now += 2000; daemon.tick()
  assert.equal(daemon.state.tickets[id].state, 'granted')
  assert.equal(JSON.parse(fs.readFileSync(path.join(reports.reportReceipts, contract.reportName(started)))).status, 'rejected')
  put(started); now += 2000; daemon.tick()
  assert.equal(daemon.state.tickets[id].state, 'running')
  assert.equal(daemon.state.tickets[id].attempts[0].controller.creationFileTime, started.creationFileTime)
  const finished = { ticketId: id, attemptId: 'a1', phase: 'finished', machine: 'fixture-host', token: permit.token,
    result: 'passed', reason: 'Synthetic completion', at: sources.now() }
  put(finished); now += 2000; daemon.tick()
  assert.equal(daemon.state.tickets[id].state, 'passed')
  assert.equal(JSON.parse(fs.readFileSync(path.join(reports.reportReceipts, contract.reportName(finished)))).status, 'accepted')
  const seq = daemon.state.cursor.seq
  now += 2000; daemon.tick(); assert.equal(daemon.state.cursor.seq, seq)
  assert.deepEqual(daemon.state, store.projectLedger(events()))
  daemon.close()
  daemon = api.createSchedulerDaemon(options)
  now += 2000; daemon.tick()
  assert.equal(daemon.state.tickets[id].state, 'passed'); assert.equal(daemon.state.cursor.seq, seq)
  assert.equal(store.writeSubmission(share, req).retransmission, true)
  assert.throws(() => store.writeSubmission(share, { ...req, title: 'Conflict after replay' }), /幂等键/)
  // Same report identity with changed birth identity must fence the writer.
  const beforeConflict = events()
  put({ ...started, creationFileTime: '134336000000000002' })
  now += 2000
  assert.throws(() => daemon.tick(), /回报编号被不同内容重用/)
  assert.deepEqual(events(), beforeConflict)
  assert.throws(() => daemon.tick(), /停止/)
} finally { daemon.close() }

// Direct owner fencing is independent from daemon replay and report rejection.
const ownerShare = path.join(sandbox, 'owner-data'); fs.mkdirSync(ownerShare)
store.initializeScheduler(ownerShare, sources)
const firstOwner = store.claimSchedulerOwner({ ...options, share: ownerShare })
assert.throws(() => store.claimSchedulerOwner({ ...options, share: ownerShare, pid: process.pid + 1 }), /占用|owner|lease/i)
const ownerFile = path.join(contract.schedControlPaths(ownerShare).owner, 'sched-dispatcher.json')
const ownerRecord = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
fs.writeFileSync(ownerFile, JSON.stringify({ ...ownerRecord, token: 'replacement-owner-token' }))
let committed = false
assert.throws(() => firstOwner.commit(() => { committed = true }), /身份|token|租约|owner/i)
assert.equal(committed, false); assert.equal(firstOwner.stopped, true)

// The default Linux origin adapter must not consult a local PID or become trusted.
const { createOriginProbe } = load('sched/sched-origin-probe.js')
const probe = createOriginProbe({ platform: 'linux', execFile: () => { throw new Error('must not invoke Windows probe on Linux') } })
probe.request([{ ticketId: submitted.ticketId, attemptId: 'a1', path: path.join(share, 'request.json') }]); probe.pump()
const readings = probe.take()
assert.equal(readings.length, 1); assert.equal(readings[0].verdict, 'failed'); assert.equal(readings[0].detail, 'non-win32')
probe.close()
const reclaim = load('sched/sched-reclaim.js')
if (process.platform !== 'win32') {
  assert.throws(() => load('sched/sched-daemon.js').probeDispatcherExecutionProcess(process.pid, 0), /adapter unavailable/)
}
assert.equal(reclaim.processIsGone(42, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }), false)
assert.equal(reclaim.processIsGone(42, () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }) }), true)

const cancelShare = path.join(sandbox, 'cancel-data'); fs.mkdirSync(cancelShare)
store.initializeScheduler(cancelShare, sources); store.createDispatcherConfig(cancelShare, 'fixture-host', 'fixture', sources)
const cancelOptions = { ...options, share: cancelShare }
const cancelledId = store.writeSubmission(cancelShare, request('cancel-before-start')).ticketId
const cancelling = api.createSchedulerDaemon(cancelOptions)
try {
  cancelling.tick(); assert.equal(cancelling.state.tickets[cancelledId].state, 'granted')
  const unstarted = structuredClone(cancelling.state.tickets[cancelledId])
  const timeoutEvents = []
  const deadline = Date.parse(unstarted.attempts[0].permit.issuedAt) + contract.GRANTED_START_RECLAIM_AFTER_MS
  reclaim.reclaimUnstartedGrants({ at: new Date(deadline - 1).toISOString(), machine: 'fixture-host', tickets: [unstarted], append: draft => timeoutEvents.push(draft) })
  assert.equal(timeoutEvents.length, 0)
  reclaim.reclaimUnstartedGrants({ at: new Date(deadline).toISOString(), machine: 'fixture-host', tickets: [unstarted], append: draft => timeoutEvents.push(draft) })
  assert.equal(timeoutEvents.length, 1); assert.equal(timeoutEvents[0].type, 'finished')
  assert.equal(timeoutEvents[0].data.reason, reclaim.GRANTED_NEVER_STARTED_REASON)
  const command = { commandId: 'fixture-cancel', kind: 'cancel', data: { ticketId: cancelledId }, submitter: 'fixture',
    createdAt: sources.now(), expiresAt: new Date(now + 60000).toISOString() }
  fs.writeFileSync(contract.commandPath(cancelShare, command.commandId), contract.canonicalJson(command))
  now += 2000; cancelling.tick(); now += 2000; cancelling.tick()
  assert.equal(cancelling.state.tickets[cancelledId].state, 'cancelled')
  const receipt = JSON.parse(fs.readFileSync(path.join(contract.schedPaths(cancelShare).commandReceipts, `${command.commandId}.json`)))
  assert.equal(receipt.status, 'executed')
} finally { cancelling.close() }
// A corrupt committed line must never replay as an empty successful ledger.
const ledgerDirectory = contract.schedPaths(cancelShare).ledger
const ledgerFile = path.join(ledgerDirectory, fs.readdirSync(ledgerDirectory)[0])
const committedLines = fs.readFileSync(ledgerFile, 'utf8').trimEnd().split('\n')
const corrupt = JSON.parse(committedLines[0]); corrupt.sha256 = '0'.repeat(64)
committedLines[0] = JSON.stringify(corrupt)
fs.writeFileSync(ledgerFile, committedLines.join('\n') + '\n')
assert.throws(() => store.readLedger(cancelShare), /校验|checksum|摘要/i)
console.log('isolated scheduler runtime: config, grant, reports, replay, fencing, cancellation, timeout and Linux fail-closed passed')
