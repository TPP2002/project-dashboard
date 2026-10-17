import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(root, 'web/package.json'))
const ts = require('typescript')
const vue = require('vue'), pinia = require('pinia')
const prefs = { project: '', machine: '', submitter: '', engine: '', result: '', from: '', to: '', period: 'all' }
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export function harness(source = path.join(root, 'web/src/stores/sched.ts')) {
  const calls: any[] = [], metadata: any[] = [], detailCalls: any[] = [], snapshotCalls: any[] = [], intervals = new Map(), listeners = new Map(), streams: any[] = []
  const counters = { ledgerFetches: 0, metadataFetches: 0, snapshotFetches: 0, detailFetches: 0 }
  const storage = new Map([['dashboard.sched.filters.v1', JSON.stringify(prefs)]])
  let data: any = snapshot(['first', 'bad'])
  let holdMetadata = false, holdSnapshot = false
  let ledgerApi: any
  const failedIds = new Set(['bad'])
  const api = {
    fetchSnapshot: async (signal: AbortSignal) => {
      counters.snapshotFetches++
      if (holdSnapshot) { const d = deferred(); snapshotCalls.push({ signal, ...d }); return d.promise }
      return structuredClone(data)
    },
    fetchQueueTicket: async (id: string, signal: AbortSignal) => {
      counters.metadataFetches++
      const d = deferred(); metadata.push({ id, signal, ...d })
      if (holdMetadata) return d.promise
      if (failedIds.has(id)) throw new Error('fixture metadata failure')
      return { ticket: ticket(id) }
    },
    fetchTickets: (query: any, cursor: string, limit: number, signal: AbortSignal) => {
      return ledgerApi.fetchTickets(query, cursor, limit, signal)
    },
    fetchTicket: (id: string, signal: AbortSignal) => {
      counters.detailFetches++
      const d = deferred(); detailCalls.push({ id, signal, ...d }); return d.promise
    },
    postCommand: async () => ({ commandId: 'dash-20261017T000000000Z-test' }),
  }
  const document = { visibilityState: 'visible', addEventListener: (k: string, v: any) => listeners.set(k, v), removeEventListener: (k: string) => listeners.delete(k) }
  const sandbox: any = { AbortController, Date, URL, URLSearchParams, Error, console, document,
    fetch: (input: string, init: any) => {
      const url = new URL(input, 'http://fixture.invalid')
      assert.equal(url.pathname, '/api/sched/tickets')
      counters.ledgerFetches++
      const d = deferred()
      calls.push({ query: Object.fromEntries(url.searchParams), cursor: url.searchParams.get('cursor'), limit: Number(url.searchParams.get('limit')), signal: init.signal,
        resolve: (value: any) => d.resolve({ ok: true, json: async () => value }), reject: d.reject })
      return d.promise
    },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
    window: { setInterval: (fn: any, ms: number) => { assert.equal(ms, 5000); const id = intervals.size + 1; intervals.set(id, fn); return id }, clearInterval: (id: number) => intervals.delete(id) },
  }
  function load(file: string): any {
    const module = { exports: {} }
    const localRequire = (id: string): any => {
      if (id === 'vue') return vue
      if (id === 'pinia') return pinia
      if (id === '@/api/sched') return api
      if (id === '@/api/sse') return { BoardStream: class { options: any; constructor(options: any) { this.options = options; streams.push(this) } start() {} stop() {} } }
      if (id === '@/components/sched/preferences') return load(path.join(root, 'web/src/components/sched/preferences.ts'))
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id + '.ts'))
      throw new Error('Unexpected dependency: ' + id)
    }
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInNewContext(js, { ...sandbox, module, exports: module.exports, require: localRequire }, { filename: file })
    return module.exports
  }
  const container = pinia.createPinia()
  pinia.setActivePinia(container)
  ledgerApi = load(path.join(root, 'web/src/api/sched.ts'))
  const store = load(source).useSchedStore()
  return { store, calls, metadata, detailCalls, snapshotCalls, storage, intervals, counters, tick,
    setSnapshot: (value: any) => { data = value }, holdMetadata: () => { holdMetadata = true },
    holdSnapshot: () => { holdSnapshot = true }, failMetadata: (id: string, fail: boolean) => { if (fail) failedIds.add(id); else failedIds.delete(id) },
    drainObservations: () => { calls.length = 0; metadata.length = 0; detailCalls.length = 0; snapshotCalls.length = 0; streams.splice(0, Math.max(0, streams.length - 1)) },
    dispose: () => { store.stop(); pinia.disposePinia(container); pinia.setActivePinia(undefined) },
    event: () => streams.at(-1).options.onSchedChanged(),
    visibility: (value: string) => { document.visibilityState = value; listeners.get('visibilitychange')?.() },
  }
}
export function snapshot(ids: string[], share = 'fixture') {
  return { share, machines: [], queue: ids.map(ticketId => ({ ticketId })), recentReceipts: [], dispatcher: { config: { machine: 'fixture' } } }
}
export function ticket(id: string) {
  return { ticketId: id, request: { title: id, project: 'fixture', submitter: 'fixture', category: 'other', requestedCores: 1, allowedMachines: [], codeRef: { kind: 'content', value: id }, work: { type: 'fixture', targetPaths: [] } },
    timeline: Array.from({ length: 64 }, (_, seq) => ({ seq, data: { payload: 'x'.repeat(256) } })), attempts: [], timing: {} }
}
const page = (title: string, nextCursor: string | null = null) => ({ items: [{ title }], total: 1, nextCursor })

// The probe uses the actual original store, not the presence of the new helper.
async function probe() {
  const h = harness(process.argv.includes('--source') ? process.argv[process.argv.indexOf('--source') + 1] : undefined)
  h.store.start(); await tick()
  h.setSnapshot(snapshot(['next'])); await h.store.refreshSnapshot()
  const removed = { details: Object.keys(h.store.queueDetails), errors: Object.keys(h.store.queueErrors) }
  for (let i = 0; i < 100; i++) h.event()
  const burstFetches = h.calls.length, aborted = h.calls.filter(c => c.signal.aborted).length
  h.store.stop()
  const stopped = { details: Object.keys(h.store.queueDetails), errors: Object.keys(h.store.queueErrors) }
  const checks = [
    ['removed queue metadata released', () => assert.deepEqual(removed.details, ['next'])],
    ['removed queue errors released', () => assert.deepEqual(removed.errors, [])],
    ['stop metadata released', () => assert.deepEqual(stopped.details, [])],
    ['stop errors released', () => assert.deepEqual(stopped.errors, [])],
    ['burst coalesced', () => assert.equal(burstFetches, 1)],
    ['same-query request not aborted', () => assert.equal(aborted, 0)],
  ] as const
  const results = checks.map(([name, run]) => { try { run(); return { name, passed: true } } catch (e) { return { name, passed: false, assertion: String(e) } } })
  console.log(JSON.stringify({ source: process.argv.includes('--source') ? process.argv[process.argv.indexOf('--source') + 1] : 'working store', removed, stopped, burstFetches, aborted, results }, null, 2))
  if (results.some(r => !r.passed)) process.exitCode = 1
}

if (process.argv.includes('--probe')) await probe()
else if (!process.argv.includes('--harness-only')) {
  test('actual store releases departed queue details/errors and stop preserves preferences/commands', async () => {
    const h = harness()
    try {
      h.store.start(); await tick(); h.store.applyFilters({ ...prefs, project: 'saved-project' })
      await h.store.command({ kind: 'owner-hold', data: {} }); await tick()
      const commands = h.storage.get('dashboard.sched.commands.v1'), filters = h.storage.get('dashboard.sched.filters.v1')
      assert.ok(h.store.queueErrors.bad)
      h.setSnapshot(snapshot(['next'])); await h.store.refreshSnapshot()
      assert.deepEqual(Object.keys(h.store.queueDetails), ['next'])
      assert.deepEqual(Object.keys(h.store.queueErrors), [])
      assert.equal('timeline' in h.store.queueDetails.next, false)
      assert.equal('attempts' in h.store.queueDetails.next, false)
      h.store.stop()
      assert.deepEqual(Object.keys(h.store.queueDetails), [])
      assert.deepEqual(Object.keys(h.store.queueErrors), [])
      assert.equal(h.store.snapshot, null); assert.equal(h.store.ledger, null)
      assert.equal(h.store.detail, null); assert.equal(h.store.related, null)
      assert.equal(h.storage.get('dashboard.sched.commands.v1'), commands)
      assert.equal(h.storage.get('dashboard.sched.filters.v1'), filters)
      assert.equal(h.store.filters.project, 'saved-project')
      assert.equal(h.intervals.size, 0)
      h.store.start(); await tick()
      assert.equal(h.store.commands.length, 1); assert.equal(h.store.filters.project, 'saved-project')
    } finally { h.store.stop() }
  })
  test('100 identical events keep one request plus one refresh and publish final result', async () => {
    const h = harness()
    try {
      h.store.start(); await tick()
      for (let i = 0; i < 100; i++) h.event()
      assert.equal(h.calls.length, 1); assert.equal(h.calls[0].signal.aborted, false)
      h.calls[0].resolve(page('initial')); await tick()
      assert.equal(h.calls.length, 2)
      h.calls[1].resolve(page('latest', 'page2')); await tick()
      assert.equal(h.store.ledger.items[0].title, 'latest'); assert.equal(h.store.ledgerLoading, false)
      h.store.movePage(1); assert.equal(h.calls.at(-1).cursor, 'page2')
    } finally { h.store.stop() }
  })
  test('changed query, hiding, stop cancel immediately and late results never win', async () => {
    const h = harness()
    try {
      h.store.start(); await tick(); h.event()
      h.store.applyFilters({ ...prefs, project: 'new' })
      assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.calls.length, 2)
      h.calls[0].resolve(page('stale')); await tick(); assert.equal(h.store.ledger, null)
      h.calls[1].reject(new Error('visible failure')); await tick(); assert.equal(h.store.ledgerError, 'visible failure')
      void h.store.loadLedger(); h.event(); h.visibility('hidden')
      assert.equal(h.calls.at(-1).signal.aborted, true)
      const count = h.calls.length; h.calls.at(-1).resolve(page('hidden')); await tick(); assert.equal(h.calls.length, count)
      h.visibility('visible'); await tick()
      h.calls.at(-1).resolve(page('fresh')); await tick(); assert.equal(h.store.ledger.items[0].title, 'fresh')
      void h.store.loadLedger(); h.event(); h.store.stop()
      h.calls.at(-1).resolve(page('stopped')); await tick(); assert.equal(h.calls.length, count + 2)
      assert.equal(h.store.ledger, null); assert.equal(h.store.snapshot, null)
    } finally { h.store.stop() }
  })
  test('page identity change cancels a pending refresh and ignores its late response', async () => {
    const h = harness()
    try {
      h.store.start(); await tick(); h.event()
      h.store.page = 1; void h.store.loadLedger()
      assert.equal(h.calls.length, 2); assert.equal(h.calls[0].signal.aborted, true)
      h.calls[1].resolve(page('new-page')); await tick()
      h.calls[0].resolve(page('stale-page')); await tick()
      assert.equal(h.store.ledger.items[0].title, 'new-page'); assert.equal(h.store.ledgerLoading, false)
    } finally { h.dispose() }
  })
  test('late metadata success/error after stop/share change cannot repopulate queue', async () => {
    const h = harness(); h.holdMetadata()
    try {
      h.store.start(); await tick()
      const old = [...h.metadata]; h.store.stop()
      h.setSnapshot(snapshot([], 'other')); h.store.start(); await tick()
      old[0].resolve({ ticket: ticket('first') }); old[1].reject(new Error('late error')); await tick()
      assert.deepEqual(Object.keys(h.store.queueDetails), []); assert.deepEqual(Object.keys(h.store.queueErrors), [])
    } finally { h.store.stop() }
  })
  test('share changes refresh same-id metadata; active errors stay visible until retry succeeds', async () => {
    const h = harness()
    try {
      h.store.start(); await tick()
      const firstCount = h.metadata.length
      h.setSnapshot(snapshot(['first', 'bad'], 'changed-share')); await h.store.refreshSnapshot()
      assert.equal(h.metadata.length, firstCount + 2)
      assert.match(h.store.queueErrors.bad, /fixture metadata failure/)
      h.failMetadata('bad', false); h.holdMetadata()
      const retry = h.store.refreshSnapshot(); await tick()
      assert.match(h.store.queueErrors.bad, /fixture metadata failure/, 'active error stays visible while retrying')
      h.metadata.at(-1).resolve({ ticket: ticket('bad') }); await retry
      assert.equal(h.store.queueDetails.bad.request.title, 'bad')
      assert.equal(h.store.queueErrors.bad, undefined)
      assert.deepEqual(Object.keys(h.store.queueDetails.first.request).sort(), ['project', 'submitter', 'title'])
    } finally { h.dispose() }
  })
  test('stop clears loaded page/detail and prevents late snapshot/detail from restoring state', async () => {
    const h = harness()
    try {
      h.store.start(); await tick(); h.calls[0].resolve(page('loaded')); await tick()
      const opening = h.store.openDetail('first'); h.detailCalls[0].resolve({ ticket: ticket('first'), related: { children: [] } }); await opening
      assert.ok(h.store.detail); assert.ok(h.store.ledger); assert.ok(h.store.snapshot)
      h.store.stop()
      for (const key of ['snapshot', 'ledger', 'detail', 'related', 'detailId']) assert.equal(h.store[key], null)
      h.holdSnapshot(); h.store.start(); await tick()
      const lateSnapshot = h.snapshotCalls.at(-1), lateDetail = h.store.openDetail('late')
      h.store.stop()
      lateSnapshot.resolve(snapshot(['resurrected']))
      h.detailCalls.at(-1).resolve({ ticket: ticket('late'), related: {} }); await lateDetail; await tick()
      assert.equal(h.store.snapshot, null); assert.equal(h.store.detail, null); assert.equal(h.store.ledger, null)
      assert.deepEqual(Object.keys(h.store.queueDetails), [])
    } finally { h.dispose() }
  })
  test('repeated enter/exit, errors and cancellation leave no page residency or intervals', async () => {
    const h = harness()
    try {
      for (let cycle = 0; cycle < 20; cycle++) {
        h.setSnapshot(snapshot([`cycle-${cycle}`, 'bad'])); h.store.start(); await tick()
        assert.equal(Object.keys(h.store.queueDetails).length, 1); assert.equal(Object.keys(h.store.queueErrors).length, 1)
        h.event(); const current = h.calls.at(-1)
        h.store.stop(); current.resolve(page('late')); await tick()
        assert.equal(h.store.snapshot, null); assert.equal(h.store.ledger, null)
        assert.equal(h.intervals.size, 0)
        assert.equal(Object.keys(h.store.queueDetails).length + Object.keys(h.store.queueErrors).length, 0)
        h.drainObservations()
      }
    } finally { h.dispose() }
  })
}
