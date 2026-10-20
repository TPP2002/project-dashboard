import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compile, createSSRApp, defineComponent } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { toChineseError } from '../src/collaboration/errorText.ts'
import { ApiError, responseJson } from '../src/collaboration/http.ts'
import { consumeInvite } from '../src/collaboration/flow.ts'

test('every literal server/CLI failure has a Chinese translation; unknown English retains its original', async () => {
  const messages = new Set<string>(['Too many attempts', 'Task operation failed'])
  for (const file of ['core/collaborationAuth.cjs', 'server/collaborationApi.cjs', 'cli/collaboration.cjs']) {
    const source = await readFile(new URL('../../' + file, import.meta.url), 'utf8')
    for (const match of source.matchAll(/fail\(\d+,\s*'([^']*)'\)/g)) messages.add(match[1]!)
  }
  assert.ok(messages.size > 50)
  for (const message of messages) {
    const translated = toChineseError(400, message)
    assert.match(translated, /\p{Script=Han}/u, message)
    assert.doesNotMatch(translated, /原文:/, message)
  }
  assert.equal(toChineseError(400, 'Invalid current password'), '当前密码不对')
  assert.equal(toChineseError(500, 'Unknown upstream failure'), '操作失败(原文:Unknown upstream failure)')
  assert.equal(toChineseError(400, '原有中文提示'), '原有中文提示')
  await assert.rejects(responseJson(new Response('{"error":"Invalid current password"}', { status: 400 })),
    error => error instanceof ApiError && error.status === 400 && error.message === '当前密码不对')
})

test('both invitation fragment forms consume escaped tokens and remove them without adding history', () => {
  for (const prefix of ['#invite=', '#/invite=']) {
    const token = '码+a/b?=&'
    const state = { existing: true }
    let replacement: unknown[] = []
    const location = { href: `https://board.example/?keep=yes${prefix}${encodeURIComponent(token)}` }
    const history = { state, replaceState: (...args: unknown[]) => {
      replacement = args
      location.href = new URL(String(args[2]), location.href).href
    } }
    assert.equal(consumeInvite(location, history), token)
    assert.deepEqual(replacement, [state, '', '/?keep=yes'])
    assert.equal(consumeInvite(location, history), '')
  }
})

test('rendered project checkboxes carry project names, not the default on value', async () => {
  const source = await readFile(new URL('../src/collaboration/ProjectChoices.vue', import.meta.url), 'utf8')
  const template = source.match(/<template>([\s\S]*?)<\/template>/)?.[1]
  assert.ok(template)
  const component = defineComponent({
    props: ['projects', 'modelValue', 'disabled'],
    setup: () => ({ toggle: () => {} }),
    render: compile(template),
  })
  const html = await renderToString(createSSRApp(component, {
    projects: [{ id: 'alpha', name: '项目甲' }, { id: 'beta', name: '项目乙' }],
    modelValue: ['alpha'], disabled: false,
  }))
  const inputs = html.match(/<input\b[^>]*>/g) ?? []
  assert.equal(inputs.length, 2)
  assert.match(inputs[0]!, /aria-label="项目甲"/)
  assert.match(inputs[1]!, /aria-label="项目乙"/)
  assert.match(html, />项目甲<\/label>/)
  assert.match(html, />项目乙<\/label>/)
})
