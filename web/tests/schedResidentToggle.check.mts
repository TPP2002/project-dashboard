/**
 * schedResidentToggle.check.mts —— 调度台「显示常驻占用」开关的字符级断言(AD-20261116-SCHED-HIDE-RESIDENT)。
 * 常驻服务(看板常驻、CI 守候员、云同步这类长期占核的单子)默认从机器卡的「调度中的单子」收起,
 * 勾选页头开关才列出;判据一律 ticket.resident === true,缺省或 false 都是普通单。
 * 选择记在本机浏览器 localStorage,键名 'dashboard.sched.showResident.v1',读到的值不严格等于 true 一律回默认(隐藏)。
 * 收起时机器卡要说明还收起几条,不能让人以为那些核凭空没了。
 * 【旧源码必须可执行】新增导出经命名空间在运行期取用:基线上它们是 undefined,红在明确断言上,
 * 不靠加载报错糊弄对照。跑法:node --import tsx --test 本文件;test/schedResidentToggle.test.cjs 包装执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as format from '../src/components/sched/format.ts'
import * as prefs from '../src/components/sched/preferences.ts'

const { visibleTickets, residentCount, isResidentTicket } = format as {
  visibleTickets?: <T extends { resident?: boolean }>(tickets: T[], showResident: boolean) => T[]
  residentCount?: (tickets: { resident?: boolean }[]) => number
  isResidentTicket?: (ticket: { resident?: boolean }) => boolean
}
const { loadShowResident, saveShowResident } = prefs as {
  loadShowResident?: () => boolean
  saveShowResident?: (value: boolean) => boolean
}

/** 缺导出时红在明确断言上,不抛 TypeError。 */
function requireFn<T>(value: T | undefined, name: string): T {
  assert.equal(typeof value, 'function', `必须导出 ${name}`)
  return value as T
}

const readSource = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

/** 造一张最小单子,模板会用到的字段都给齐。 */
function ticket(options: { resident?: boolean; ticketId?: string } = {}) {
  return { ticketId: options.ticketId ?? 'tk-00000000000000000001', project: 'proj', title: `单子 ${options.ticketId ?? '1'}`,
    submitter: 'tester', category: 'unit-test', machine: 'machine-a', grantedCores: 2, state: 'granted' as const,
    result: 'passed' as const, resultReason: null, registerOnly: false, resident: options.resident,
    pauseReasons: [] as string[], cancelRequested: false, createdAt: '2026-11-16T00:00:00.000Z', endedAt: null,
    queuedMs: 0, runningMs: 0, pausedMs: 0, slowMs: 0 }
}
const plain = (id: string, resident?: boolean) => ticket({ ticketId: id, resident })

test('T1 visibleTickets(…, false) 去掉常驻单,保留普通与缺省单,顺序与原对象不变,传入数组不被改', () => {
  const filter = requireFn(visibleTickets, 'visibleTickets')
  const first = plain('a'), second = plain('b', false), third = plain('c', true), fourth = plain('d')
  const source = [first, second, third, fourth]
  const result = filter(source, false)
  assert.deepEqual(result, [first, second, fourth])
  assert.equal(result[0], first)
  assert.equal(result[1], second)
  assert.equal(result[2], fourth)
  assert.equal(source.length, 4, '传入数组不被改')
  assert.deepEqual(source, [first, second, third, fourth])
})

test('T2 visibleTickets(…, true) 返回全部且顺序不变;空数组两种都返回空', () => {
  const filter = requireFn(visibleTickets, 'visibleTickets')
  const first = plain('a', true), second = plain('b')
  const source = [first, second]
  assert.deepEqual(filter(source, true), [first, second])
  assert.equal(filter([], true).length, 0)
  assert.equal(filter([], false).length, 0)
})

test('T3 residentCount 数对个数;isResidentTicket 只认 true', () => {
  const count = requireFn(residentCount, 'residentCount')
  const judge = requireFn(isResidentTicket, 'isResidentTicket')
  assert.equal(count([]), 0)
  assert.equal(count([plain('a', true), plain('b', true)]), 2)
  assert.equal(count([plain('a'), plain('b', false)]), 0)
  assert.equal(count([plain('a', true), plain('b'), plain('c', true)]), 2)
  assert.equal(judge({ resident: true }), true)
  assert.equal(judge({}), false)
  assert.equal(judge({ resident: false }), false)
})

const KEY = 'dashboard.sched.showResident.v1'
/** 覆盖 localStorage,每个用例前后还原,不污染同进程其它用例。 */
function withStorage(value: Storage | undefined, run: () => void) {
  const original = Reflect.get(globalThis, 'localStorage')
  if (value === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
  else Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true })
  try { run() } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
    else Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true, writable: true })
  }
}
function storageFrom(raw: Record<string, string>): Storage {
  const map = new Map(Object.entries(raw))
  const keys = () => [...map.keys()]
  return { get length() { return map.size }, key: index => keys()[index] ?? null,
    getItem: key => (map.has(key) ? map.get(key)! : null), setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) }, clear: () => map.clear(), keys } as Storage
}

test('T4 loadShowResident / saveShowResident 正常读写,落盘键名与取值精确', () => {
  const load = requireFn(loadShowResident, 'loadShowResident')
  const save = requireFn(saveShowResident, 'saveShowResident')
  const store = storageFrom({})
  withStorage(store, () => {
    assert.equal(load(), false, '存储为空返回 false')
    assert.equal(save(true), true)
    assert.equal(load(), true)
    assert.equal(store.getItem(KEY), 'true', '落盘值恰为 true')
    assert.deepEqual(store.keys(), [KEY], '键名恰为约定字面量')
    assert.equal(save(false), true)
    assert.equal(load(), false)
    assert.equal(store.getItem(KEY), 'false', '落盘值恰为 false')
    assert.deepEqual(store.keys(), [KEY])
  })
})

test('T5 脏值一律回默认 false,不冒充用户选择', () => {
  const load = requireFn(loadShowResident, 'loadShowResident')
  for (const raw of ['"true"', '1', 'null', '{"a":1}', '[true]', 'not json']) {
    withStorage(storageFrom({ [KEY]: raw }), () => {
      assert.equal(load(), false, `脏值 ${raw} 必须回默认 false`)
    })
  }
})

test('T6 localStorage 的 getItem、setItem 都抛错时,两个函数都不抛出且返回 false', () => {
  const load = requireFn(loadShowResident, 'loadShowResident')
  const save = requireFn(saveShowResident, 'saveShowResident')
  const hostile = { getItem: () => { throw new Error('deny') }, setItem: () => { throw new Error('deny') },
    removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage
  withStorage(hostile, () => {
    let loaded = true, saved = true
    assert.doesNotThrow(() => { loaded = load() })
    assert.doesNotThrow(() => { saved = save(true) })
    assert.equal(loaded, false)
    assert.equal(saved, false)
  })
})

test('T7 源码形状:页头有开关与勾选框,两张机器卡都传了开关,机器卡说明被收起条数且不依赖 preferences', () => {
  const view = readSource('../src/views/SchedConsole.vue')
  assert.ok(view.includes('type="checkbox"'))
  assert.ok(view.includes('显示常驻占用'))
  const cards = view.match(/<MachineCard/g)?.length ?? 0
  const bound = view.match(/:show-resident=/g)?.length ?? 0
  assert.equal(cards, 2)
  assert.equal(bound, 2)
  assert.equal(cards, bound, '每张机器卡都要接上开关')
  const card = readSource('../src/components/sched/MachineCard.vue')
  assert.ok(card.includes('个常驻占用已隐藏'))
  assert.doesNotMatch(card, /from '\.\/preferences'/)
})

/** 内存中编译实际 MachineCard(依赖表同 schedMachineDisplay),渲染本卡的「调度中的单子」列表。 */
async function machineCardHtml(tickets: unknown[], showResident: boolean | undefined) {
  const webRequire = (await import('node:module')).createRequire(import.meta.url)
  const { parse, compileScript, compileTemplate } = webRequire('vue/compiler-sfc')
  const ts = webRequire('typescript'), { createSSRApp, h } = webRequire('vue')
  const { renderToString } = webRequire('vue/server-renderer')
  const directory = fileURLToPath(new URL('../src/components/sched/', import.meta.url))
  function evaluate(source: string, requireFn = webRequire) {
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } })
    const output = { exports: {} }
    new Function('require', 'module', 'exports', outputText)(requireFn, output, output.exports)
    return output.exports
  }
  function compile(name: string, dependencies: Record<string, unknown>) {
    const filename = directory + name
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
    assert.deepEqual(errors, [], `${name} 模板必须能解析`)
    const script = compileScript(descriptor, { id: name })
    const template = compileTemplate({ id: name, filename, source: descriptor.template.content,
      compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
    const resolve = (id: string) => Object.hasOwn(dependencies, id) ? dependencies[id] : webRequire(id)
    const component = evaluate(script.content, resolve).default
    component.render = evaluate(template.code, resolve).render
    return component
  }
  const fmt = evaluate(readFileSync(directory + 'format.ts', 'utf8'))
  const EstimateText = compile('EstimateText.vue', { './format': fmt })
  const display = evaluate(readFileSync(new URL('../../core/schedMachineDisplay.mjs', import.meta.url), 'utf8'))
  const MachineCard = compile('MachineCard.vue', { './format': fmt, './EstimateText.vue': { default: EstimateText },
    '@/api/schedCiJobs': evaluate(readFileSync(new URL('../src/api/schedCiJobs.ts', import.meta.url), 'utf8')),
    '../../../../core/schedMachineDisplay.mjs': display })
  const now = Date.parse('2026-11-16T10:00:00Z')
  const props: Record<string, unknown> = {
    machine: { name: 'machine-a', online: true, fresh: true, ci: 'idle', ciRunners: null,
      heartbeatAt: new Date(now).toISOString(), loadSampledAt: new Date(now).toISOString(),
      quotaCores: 4, grantedCores: 0, externalLoadCores: 0, availableCores: 4 },
    host: 'machine-a', tickets, estimates: {}, now, busy: false }
  if (showResident !== undefined) props.showResident = showResident
  const html = await renderToString(createSSRApp({ render: () => h(MachineCard, props) }))
  return html.replace(/<[^>]*>/g, '')
}

test('T8 机器卡默认收起常驻单并说明收起几条,勾选或缺省属性时照旧列出', async () => {
  const tickets = [plain('a'), plain('b', false), plain('c', true), plain('d', true), plain('e', true)]
  const hidden = await machineCardHtml(tickets, false)
  assert.match(hidden, /调度中的单子（2）/)
  assert.match(hidden, /另有 3 个常驻占用已隐藏/)
  assert.doesNotMatch(hidden, /单子 c/)
  const shown = await machineCardHtml(tickets, true)
  assert.match(shown, /调度中的单子（5）/)
  assert.doesNotMatch(shown, /个常驻占用已隐藏/)
  const omitted = await machineCardHtml(tickets, undefined)
  assert.match(omitted, /调度中的单子（5）/, '不传 showResident 时与 true 一致')
  assert.doesNotMatch(omitted, /个常驻占用已隐藏/)
})

test('T8 只有常驻单且隐藏时,机器卡既提示没有调度中的单子,也说明收起了几条', async () => {
  const tickets = [plain('c', true), plain('d', true), plain('e', true)]
  const hidden = await machineCardHtml(tickets, false)
  assert.match(hidden, /这台机器没有调度中的单子/)
  assert.match(hidden, /另有 3 个常驻占用已隐藏/)
  const shown = await machineCardHtml(tickets, true)
  assert.match(shown, /调度中的单子（3）/)
})
