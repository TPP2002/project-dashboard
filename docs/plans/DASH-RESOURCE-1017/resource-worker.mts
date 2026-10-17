// Controller-only experiment worker. Native Node 24 type stripping; no esbuild service.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../../..')
const require = createRequire(import.meta.url)
const { serverFixture } = require('./server-fixture.cjs')
const arg = (name: string) => { const i = process.argv.indexOf(name); assert.ok(i >= 0, 'missing ' + name); return process.argv[i + 1]! }
const mode = arg('--mode'), fixtureDir = path.resolve(arg('--fixture'))
assert.ok(mode === 'old' || mode === 'new')
assert.ok(process.env.SCHED_PERMIT, 'worker must inherit the controller sched permit')
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'))
assert.equal(typeof (globalThis as any).gc, 'function', 'worker requires --expose-gc (experiment only)')
process.argv.push('--harness-only')
const { harness, snapshot } = await import('../../../web/tests/schedResourceLifecycle.check.mts')
const h = harness(path.join(root, mode === 'old' ? 'docs/plans/DASH-RESOURCE-1017/original-sched.ts' : 'web/src/stores/sched.ts'))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-resource-worker-'))
const f = serverFixture(scratch, path.join(root, mode === 'old' ? 'docs/plans/DASH-RESOURCE-1017/original-server.cjs' : 'server/server.cjs'))
const samples: any[] = []
const gc = () => { (globalThis as any).gc(); (globalThis as any).gc() }
function sample(phase: string) {
  const { heapUsed, external, rss } = process.memoryUsage()
  const value = { phase, heapUsed, external, rss }; samples.push(value); return value
}
function queueState(withByteWeight = true) {
  const details = Object.keys(h.store.queueDetails).length, errors = Object.keys(h.store.queueErrors).length
  return { details, errors,
    serializedByteWeight: details + errors === 0 ? 0 : withByteWeight ? Buffer.byteLength(JSON.stringify([h.store.queueDetails, h.store.queueErrors])) : null,
    snapshotReleased: h.store.snapshot === null, ledgerReleased: h.store.ledger === null, intervals: h.intervals.size }
}
function cacheState() {
  const result: any = {}
  for (const name of ['summaryCache', 'archiveCache', 'mergedBoardCache']) {
    const cache = f[name]
    const weightBytes = typeof cache.weightBytes === 'number' ? cache.weightBytes : [...cache.values()].reduce((sum: number, value: any) =>
      sum + (value.version ? JSON.parse(value.version).reduce((n: number, row: any[]) => n + row[2], 0) : value.size), 0)
    result[name] = { entries: cache.size, rawByteWeight: weightBytes }
  }
  return result
}
async function settleLedger(title: string) {
  for (let round = 0; round < 4 && h.calls.length; round++) {
    for (const call of h.calls.splice(0)) call.resolve({ items: [{ title }], total: 1, nextCursor: null })
    await h.tick()
  }
  assert.equal(h.calls.length, 0, 'bounded trailing refresh must finish')
}
const started = performance.now(), cpuStart = process.cpuUsage()
gc(); const before = sample('baseline-after-gc')
let output: any
try {
  h.setSnapshot(snapshot([], 'controlled-fixture')); h.store.start(); await h.tick(); await settleLedger('initial-ledger')
  for (let i = 0; i < manifest.queueTransitions; i++) {
    const failed = `failed-${i}`, ids = Array.from({ length: manifest.queueWidth }, (_, j) => `seed-${manifest.seed}-${i}-${j}`)
    h.failMetadata(failed, true)
    h.setSnapshot(snapshot([...ids, failed], 'controlled-fixture')); await h.store.refreshSnapshot()
    if (i % 10 === 0) sample(`queue-${i}`)
    h.failMetadata(failed, false); h.drainObservations()
  }
  const afterQueueFlow = queueState()
  sample('queue-flow-before-gc')
  h.setSnapshot(snapshot([], 'controlled-fixture')); await h.store.refreshSnapshot()
  const afterQueueRemoval = queueState()
  h.store.stop(); h.drainObservations(); await h.tick()
  const afterQueueStop = queueState()
  sample('queue-stop-before-gc')
  gc(); const afterQueueReclaim = sample('queue-removal-stop-after-gc')

  h.store.start(); await h.tick()
  const burstStartCount = h.counters.ledgerFetches - 1
  for (let i = 0; i < 100; i++) h.event()
  const burst = { events: 100, includingInitialBeforeSettle: h.calls.length,
    abortedBeforeSettle: h.calls.filter((call: any) => call.signal.aborted).length, totalFetchesAfterSettle: 0, finalResultCorrect: false }
  await settleLedger('fixture-final-ledger')
  burst.totalFetchesAfterSettle = h.counters.ledgerFetches - burstStartCount
  burst.finalResultCorrect = h.store.ledger?.items[0]?.title === 'fixture-final-ledger'
  assert.equal(burst.finalResultCorrect, true)
  h.store.stop(); h.drainObservations()
  const exitSamples = []
  for (let i = 0; i < 20; i++) {
    const bad = `exit-failure-${i}`; h.failMetadata(bad, true)
    h.setSnapshot(snapshot([`exit-${i}`, bad], 'controlled-fixture')); h.store.start(); await h.tick()
    h.event(); h.store.stop(); await settleLedger('late-cancelled-result')
    exitSamples.push(queueState(false))
    h.failMetadata(bad, false); h.drainObservations()
  }
  const afterRepeatedExits = queueState()
  sample('after-repeated-exits-before-gc'); gc(); const afterRepeatedExitReclaim = sample('after-repeated-exits-after-gc')

  f.startIntervals()
  const responseHash = createHash('sha256')
  for (let i = 0; i < manifest.boards.length; i++) {
    const file = path.join(fixtureDir, manifest.boards[i])
    responseHash.update(JSON.stringify(f.readSummaryCached(file)))
    responseHash.update(JSON.stringify(f.readMergedBoard(file, f.activitySnapshot(file))))
    if (i % 8 === 0) sample(`board-load-${i}`)
  }
  const loaded = cacheState(); sample('caches-loaded-before-gc'); gc(); const afterCacheLoad = sample('caches-loaded-after-gc')
  // Failure/replacement use a separate scratch tree; the shared A/B fixture stays immutable.
  const failedFile = path.join(scratch, 'failure-board.json'), failedArchive = path.join(scratch, 'activity-202601.json')
  let failedReads = 0
  const failureStates = []
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(failedFile, JSON.stringify({ tasks: [], activity: [{ ts: '2026-10-17T00:00:00Z', text: `version-${i}` }] }))
    fs.writeFileSync(failedArchive, JSON.stringify([{ ts: '2026-01-01T00:00:00Z', text: 'ok' }]))
    f.readSummaryCached(failedFile); f.readMergedBoard(failedFile, f.activitySnapshot(failedFile))
    fs.writeFileSync(failedArchive, 'invalid-json')
    try { f.readMergedBoard(failedFile, f.activitySnapshot(failedFile)) } catch { failedReads++ }
    failureStates.push(cacheState())
  }
  assert.equal(failedReads, 5)
  f.advance(600001); f.poll()
  const afterIdle = cacheState(); sample('idle-before-gc'); gc(); const afterIdleReclaim = sample('idle-after-gc')
  // Refill once to distinguish close release from idle release.
  const first = path.join(fixtureDir, manifest.boards[0])
  f.readSummaryCached(first); f.readMergedBoard(first, f.activitySnapshot(first))
  f.server.emit('close')
  const afterClose = cacheState(), intervalsAfterClose = f.intervals.size
  gc(); const afterCloseReclaim = sample('close-after-gc')
  if (mode === 'new') {
    assert.equal(afterQueueRemoval.details + afterQueueRemoval.errors, 0)
    assert.equal(afterQueueStop.details + afterQueueStop.errors, 0)
    assert.ok(afterQueueStop.snapshotReleased && afterQueueStop.ledgerReleased)
    assert.equal(burst.includingInitialBeforeSettle, 1); assert.equal(burst.abortedBeforeSettle, 0); assert.equal(burst.totalFetchesAfterSettle, 2)
    for (const state of exitSamples) { assert.equal(state.details + state.errors, 0); assert.ok(state.snapshotReleased && state.ledgerReleased); assert.equal(state.intervals, 0) }
    for (const state of [loaded, ...failureStates]) for (const name of Object.keys(state)) {
      assert.ok(state[name].entries <= (name === 'archiveCache' ? 64 : 50)); assert.ok(state[name].rawByteWeight <= 16 * 1024 * 1024)
    }
    for (const state of [afterIdle, afterClose]) for (const value of Object.values(state) as any[]) { assert.equal(value.entries, 0); assert.equal(value.rawByteWeight, 0) }
    assert.equal(intervalsAfterClose, 0)
  }
  const peakSampled = Object.fromEntries(['heapUsed', 'external', 'rss'].map(key => [key, Math.max(...samples.map(s => s[key]))]))
  output = { mode, seed: manifest.seed, node: process.version, platform: process.platform, arch: process.arch,
    queueTransitions: manifest.queueTransitions, queueWidth: manifest.queueWidth, enterExitCycles: 20,
    before, peakSampled, osHighWaterRssBytes: process.resourceUsage().maxRSS * 1024,
    afterQueueReclaim, afterRepeatedExitReclaim, afterCacheLoad, afterIdleReclaim, afterCloseReclaim,
    wallMs: performance.now() - started, cpuMicros: process.cpuUsage(cpuStart), samples,
    afterQueueFlow, afterQueueRemoval, afterQueueStop, afterRepeatedExits, exitSamples, burst, fetchCounts: { ...h.counters },
    caches: { loaded, failureStates, afterIdle, afterClose, intervalsAfterClose },
    responseSha256: responseHash.digest('hex'), explicitGc: true,
    notes: ['rawByteWeight and serializedByteWeight are residency budgets, not V8 heap sizes', 'peakSampled is a sampled peak; osHighWaterRssBytes is the process OS high-water mark', 'heap samples cover the combined workload and cannot separately attribute server versus store residency', 'wall/CPU includes instrumentation and explicit GC, not pure product throughput; per-exit nonempty byte weights are omitted to avoid repeated observer serialization', 'server module and real store/API run against controlled fixtures; no production data or network'] }
} finally {
  h.dispose()
  const resolved = path.resolve(scratch), tempRoot = path.resolve(os.tmpdir()) + path.sep
  assert.ok(resolved.startsWith(tempRoot) && path.basename(resolved).startsWith('dash-resource-worker-'))
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 })
}
console.log(JSON.stringify(output, null, 2))
