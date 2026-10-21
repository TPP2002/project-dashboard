import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import config from '../vite.config.ts'
import { drawerActions } from '../src/collaboration/board.ts'
import { collaborationOwnerUser, setAuthContext } from '../src/collaboration/http.ts'
import type { User } from '../src/collaboration/types.ts'

const require = createRequire(import.meta.url)
const rules = require('../../core/collaborationRules.cjs')
const owner: User = { id: 'owner', username: 'owner', displayName: '负责人', role: 'owner', projectIds: [], disabled: false }
// Load through the actual Vite plugin, then bundle the pure consumers in memory.
// No listening server, child process or persistent build artifact is needed.
const options = await (config as Function)({ mode: 'test', command: 'serve' })
const plugin = options.plugins.find((entry: { name: string }) => entry.name === 'virtual-collaboration-rules')
assert.ok(plugin, 'Vite must register the shared collaboration rules')
const resolved = await plugin.resolveId('virtual:collaboration-rules')
assert.equal(resolved, '\0virtual:collaboration-rules')
const source = await plugin.load(resolved)

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/collaboration/ownerActions.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'actual-vite-rules', setup(builder) {
    builder.onResolve({ filter: /^virtual:collaboration-rules$/ }, () => ({ path: resolved, namespace: 'rules' }))
    builder.onLoad({ filter: /.*/, namespace: 'rules' }, () => ({ contents: source, loader: 'js' }))
  } }],
})
const { ownerCardActions, ownerDrawerActions, ownerHiddenLegacyActions } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles![0]!.text).toString('base64'))
const working = { status: '施工中', assigneeUserId: owner.id, percent: 100 }

test('100 percent with done offers finish before progress and keeps confirmation', () => {
  assert.ok(rules.memberActions(working, owner).includes('done'))
  assert.deepEqual(ownerCardActions(working, owner), ['done', 'progress'])
  assert.equal(ownerDrawerActions(working, owner).find((entry: { action: string }) => entry.action === 'done')?.needs, 'confirm')
})

test('99 percent only offers progress on the card', () => {
  assert.deepEqual(ownerCardActions({ ...working, percent: 99 }, owner), ['progress'])
})

test('100 percent without done only offers progress', () => {
  const pending = { ...working, decisions: [{ answer: null }] }
  assert.ok(!rules.memberActions(pending, owner).includes('done'))
  assert.deepEqual(ownerCardActions(pending, owner), ['progress'])
  assert.deepEqual(ownerDrawerActions(pending, owner), drawerActions({ actions: rules.memberActions(pending, owner) }))
})

test('claimable cards retain claim; AI cards and signed-out users have no card action', () => {
  assert.deepEqual(ownerCardActions({ status: '待开工', percent: 100 }, owner), ['claim'])
  for (const ai of [{ aiWork: true }, { builder: 'AI' }, { gitBranch: ['work'] }]) {
    assert.deepEqual(ownerCardActions({ ...working, ...ai }, owner), [])
  }
  assert.deepEqual(ownerCardActions(working, null), [])
  assert.deepEqual(ownerCardActions({ ...working, assigneeUserId: 'member' }, owner), ['join'])
})

test('drawer moves only done before progress at 100 percent; otherwise preserves member order', () => {
  const baseline = drawerActions({ actions: rules.memberActions(working, owner) })
  const expected = baseline.filter(entry => entry.action !== 'done')
  expected.splice(expected.findIndex(entry => entry.action === 'progress'), 0, baseline.find(entry => entry.action === 'done')!)
  assert.deepEqual(ownerDrawerActions(working, owner), expected)
  for (const card of [{ ...working, percent: 50 }, { status: '待开工', percent: 100 }]) {
    assert.deepEqual(ownerDrawerActions(card, owner), drawerActions({ actions: rules.memberActions(card, owner) }))
  }
})

test('only collaboration owners hide duplicate legacy lifecycle actions; note stays', () => {
  assert.deepEqual(ownerHiddenLegacyActions(owner), ['park', 'unpark', 'cancel', 'reopen'])
  assert.deepEqual(ownerHiddenLegacyActions(null), [])
  for (const role of ['member', 'viewer'] as const) assert.deepEqual(ownerHiddenLegacyActions({ ...owner, role }), [])
  try {
    setAuthContext({ ok: true, mode: 'local', user: owner })
    assert.deepEqual(ownerHiddenLegacyActions(collaborationOwnerUser()), [])
    setAuthContext({ ok: true, mode: 'collaboration', user: owner })
    assert.deepEqual(ownerHiddenLegacyActions(collaborationOwnerUser()), ['park', 'unpark', 'cancel', 'reopen'])
  } finally { setAuthContext(null) }
})
