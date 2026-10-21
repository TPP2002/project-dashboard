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
const virtual = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/collaboration/ownerActions.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'actual-vite-rules', setup(builder) {
    builder.onResolve({ filter: /^virtual:collaboration-rules$/ }, () => ({ path: resolved, namespace: 'rules' }))
    builder.onLoad({ filter: /.*/, namespace: 'rules' }, () => ({ contents: source, loader: 'js' }))
  } }],
})
const { ownerCardAction, ownerDrawerActions } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles![0]!.text).toString('base64'))
const states = ['未开工', '待开工', '待拍板', '已拍板', '可复工', '施工中', '暂缓', '待收单', '收官', '已完工', '已作废']
const cards = states.flatMap(status => [
  { status }, { status, assigneeUserId: 'member' }, { status, assigneeUserId: owner.id },
  { status, assigneeUserId: 'member', collaborators: [{ userId: owner.id }] },
  { status, builder: 'AI' }, { status, gitBranch: ['work'] },
  { status, decisions: [{ answer: null }] }, { status, decisions: [{ answer: '' }] },
  { status, blockReason: '等待' }, { status, deps: { blockedBy: ['UP'] } },
])

test('virtual memberActions and aiWork exactly match CJS across states and identities', () => {
  for (const card of cards) for (const user of [owner, { ...owner, role: 'member' }, { ...owner, role: 'viewer' }, { ...owner, disabled: true }, null]) {
    assert.deepEqual(virtual.memberActions(card, user), rules.memberActions(card, user))
    assert.equal(virtual.aiWork(card), rules.aiWork(card))
  }
})

test('owner card follows the approved ownership priority, including legacy and AI cards', () => {
  assert.equal(ownerCardAction({ status: '待开工' }, owner), 'claim')
  assert.equal(ownerCardAction({ status: '施工中', assigneeUserId: owner.id }, owner), 'progress')
  assert.equal(ownerCardAction({ status: '施工中', assigneeUserId: 'member', collaborators: [{ userId: owner.id }] }, owner), 'progress')
  assert.equal(ownerCardAction({ status: '施工中', assigneeUserId: 'member' }, owner), 'join')
  for (const ai of [{ aiWork: true }, { builder: 'AI' }, { gitBranch: ['work'] }, { prNumbers: [1] }, { commitShas: ['abc'] }]) {
    assert.equal(ownerCardAction({ status: '施工中', assigneeUserId: owner.id, ...ai }, owner), null)
    assert.equal(ownerCardAction({ status: '待开工', ...ai }, owner), null)
  }
  assert.equal(ownerCardAction({ status: '已完工', assigneeUserId: owner.id }, owner), null)
  for (const answer of [undefined, null, '']) assert.notEqual(ownerCardAction({ status: '待开工', decisions: [{ answer }] }, owner), 'claim')
  assert.equal(ownerCardAction({}, owner), null)
  assert.equal(ownerCardAction({ status: '待开工' }, null), null)
})

test('owner drawer keeps the member drawer order and excludes note and removeCollaborator', () => {
  for (const card of cards) {
    const entries = ownerDrawerActions(card, owner)
    assert.deepEqual(entries, drawerActions({ actions: rules.memberActions(card, owner) }))
    assert.ok(entries.every((entry: { action: string }) => !['note', 'removeCollaborator'].includes(entry.action)))
  }
  assert.ok(ownerDrawerActions({ status: '施工中', assigneeUserId: 'member' }, owner).some((entry: { action: string }) => entry.action === 'progress'))
})

test('owner session accessor is unavailable in local mode and for members, visitors and signed-out users', () => {
  try {
    for (const mode of ['local', 'collaboration'] as const) for (const role of ['owner', 'member', 'viewer'] as const) {
      const user = { ...owner, role }
      setAuthContext({ ok: true, mode, user })
      assert.equal(collaborationOwnerUser(), mode === 'collaboration' && role === 'owner' ? user : null)
    }
    setAuthContext({ ok: true, mode: 'collaboration', user: null })
    assert.equal(collaborationOwnerUser(), null)
    setAuthContext(null)
    assert.equal(collaborationOwnerUser(), null)
  } finally { setAuthContext(null) }
})
