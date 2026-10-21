import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Uses the same node --import tsx --test runner as the other web checks.
const source = await readFile(new URL('../src/collaboration/AdminPanel.vue', import.meta.url), 'utf8')
function functionSource(name: string) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?(?=\\n(?:async )?function |\\nonMounted\\()`))
  assert.ok(match, `missing function ${name}`)
  return match[0]
}
const load = functionSource('load')

test('refresh retains management data until success and clears it only on failure', () => {
  const catchAt = load.indexOf('} catch (cause) {')
  const finallyAt = load.indexOf('} finally {')
  assert.ok(catchAt > load.indexOf('await Promise.all('))
  assert.ok(finallyAt > catchAt)
  assert.doesNotMatch(load.slice(0, catchAt), /data\.value\s*=\s*null/)
  assert.match(load.slice(catchAt, finallyAt), /data\.value = null[\s\S]*throw cause/)
  assert.doesNotMatch(load.slice(finallyAt), /data\.value\s*=\s*null/)
  assert.match(load, /if \(controller\.signal\.aborted\) return\s+data\.value = admin/)
  assert.match(functionSource('run'), /catch \(cause\)[^\n]*error\.value = cause instanceof Error \? cause\.message/)
})

test('default refresh reads only admin; initial and manual refresh also read projects', () => {
  assert.match(load, /async function load\(full = false\)/)
  assert.match(load, /apiJson<AdminData>\('\/api\/auth\/admin', undefined, controller\.signal\)/)
  assert.match(load, /full \? apiJson<\{ projects: Project\[\] \}>\('\/api\/projects', undefined, controller\.signal\) : undefined/)
  assert.equal((load.match(/\/api\/projects/g) || []).length, 1)
  assert.match(load, /if \(list\) \{\s+projects\.value = list\.projects\s+selected\.value = selected\.value\.filter/)
  assert.match(functionSource('refresh'), /return run\(\(\) => load\(true\)\)/)
  assert.match(source, /onMounted\(refresh\)/)
  assert.match(source, /@click="refresh"/)
})

test('every mutation uses the admin-only refresh including browser trust', () => {
  for (const name of ['createInvite', 'createDevice', 'revoke', 'saveUser', 'createReset']) {
    const body = functionSource(name)
    assert.match(body, /await load\(\)/, name)
    assert.doesNotMatch(body, /load\(true\)|\/api\/projects|\brefresh\(/, name)
  }
  assert.match(functionSource('trustBrowser'), /rememberBrowser\(label\.value, load, controller\.signal\)/)
})

test('created invitation is inserted first before the authoritative refresh', () => {
  const body = functionSource('createInvite')
  assert.match(body, /if \(data\.value\) data\.value\.invites\.unshift\(result\.invite\)/)
  assert.ok(body.indexOf('if (controller.signal.aborted) return') < body.indexOf('data.value.invites.unshift'))
  assert.ok(body.indexOf('data.value.invites.unshift') < body.indexOf('await load()'))
  assert.match(load, /data\.value = admin/)
})

test('refresh indicator leaves layout stable while initial and failed loads keep their messages', () => {
  assert.match(source, /const refreshing = ref\(false\)/)
  assert.match(load, /refreshing\.value = true\s+try/)
  assert.match(load, /finally \{\s+refreshing\.value = false/)
  assert.match(source, /<h1[^>]*>成员与邀请<small v-if="refreshing && data" class="admin-refreshing" role="status">正在刷新…<\/small><\/h1>/)
  assert.match(source, /\.admin-title\s*\{[^}]*position: relative/)
  assert.match(source, /\.admin-refreshing\s*\{[^}]*position: absolute/)
  assert.match(source, /<p v-if="!data">\{\{ busy \? '正在读取管理信息…' : '管理信息尚未加载，请刷新重试。' \}\}<\/p>\s+<template v-else>/)
})

test('refresh preserves newly issued secrets and the existing dismissal behavior', () => {
  assert.doesNotMatch(load, /secret\.value/)
  assert.match(functionSource('run'), /error\.value = ''; notice\.value = ''; secret\.value = null\s+try \{ await action\(\) \}/)
  for (const name of ['createInvite', 'createDevice', 'createReset']) {
    assert.match(functionSource(name), /secret\.value = [^\n]+[\s\S]*await load\(\)/)
  }
  assert.match(source, /<SecretDisplay v-if="secret" :token="secret.token" :kind="secret.kind" @dismiss="secret = null" \/>/)
})

test('unmount still aborts requests and clears management data and secrets', () => {
  assert.match(source, /onBeforeUnmount\(\(\) => \{ controller\.abort\(\); secret\.value = null; data\.value = null; projects\.value = \[\] \}\)/)
})
