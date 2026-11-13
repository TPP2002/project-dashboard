import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { describeSubmitter, formatSpan, reservationBanner } from '../src/components/sched/reservation'

const require = createRequire(import.meta.url)
const { parseSubmitter } = require('../../core/schedSubmitter.cjs')
for (const [input, result] of [[null, '来源没记下'], ['', '来源没记下'], ['dashboard', '看板发出（当时没记来源）'],
  ['dashboard;client=page;addr=127.0.0.1;ua=x', '看板页面（本机）'],
  ['dashboard;client=api;addr=192.0.2.10;ua=x', '接口直调（192.0.2.10）'],
  ['dashboard;client=page;addr=::1;ua=x', '看板页面（本机）'], ['dashboard;client=page;addr=localhost;ua=x', '看板页面（本机）'],
  ['dashboard;client=other;addr=unknown;ua=x', '看板发出'], ['某名字', '某名字 发出']] as const) {
  assert.equal(describeSubmitter(input), result)
  const parsed = parseSubmitter(input)
  if (input?.startsWith('dashboard;')) {
    const label = parsed.client === 'page' ? '看板页面' : parsed.client === 'api' ? '接口直调' : '看板发出'
    const addr = parsed.addr && parsed.addr !== 'unknown' ? `（${['127.0.0.1', '::1', 'localhost'].includes(parsed.addr) ? '本机' : parsed.addr}）` : ''
    assert.equal(result, label + addr)
  }
  else if (input === 'dashboard') assert.equal(parsed.legacy, true)
  else if (input) assert.equal(parsed.raw, input)
  else assert.equal(parsed, null)
}
for (const [ms, value] of [[59999, '不到 1 分钟'], [60000, '1 分钟'], [3599999, '59 分钟'], [3600000, '1 小时'], [95000000, '26 小时 23 分']] as const) assert.equal(formatSpan(ms), value)
const at = new Date(2026, 0, 2, 3, 4).toISOString(), now = Date.parse(at)
const res = { requestedCores: 5 as const, fulfilledCores: 3, untilAt: null }
const change = { at, requestedCores: 5 as const, untilAt: null, submitter: 'dashboard' }
assert.equal(reservationBanner(null, change, now), null)
assert.equal(reservationBanner({ ...res, requestedCores: 0 }, change, now), null)
assert.deepEqual(reservationBanner(res, change, now), { tone: 'warn', title: '主机给你留着 5 核（已兑现 3 核）', detail: '01-02 03:04 设的 · 看板发出（当时没记来源） · 不限期，已经留了 不到 1 分钟', unlimited: true })
assert.equal(reservationBanner(res, change, now + 10800000)?.tone, 'bad')
assert.match(reservationBanner(res, change, now + 10800000)?.detail ?? '', /已经留了 3 小时/)
assert.equal(reservationBanner(res, null, now)?.detail, '设置时间读不到 · 不限期')
assert.equal(reservationBanner(res, { ...change, requestedCores: 10 }, now + 10800000)?.tone, 'warn')
const untilAt = new Date(now + 3600000).toISOString()
assert.equal(reservationBanner({ ...res, untilAt }, { ...change, untilAt }, now)?.tone, 'info')
assert.match(reservationBanner({ ...res, untilAt }, { ...change, untilAt }, now)?.detail ?? '', /还剩 1 小时/)
assert.match(reservationBanner({ ...res, untilAt }, { ...change, untilAt }, now + 3600000)?.detail ?? '', /已到期，等派单员取消/)
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const api = read('../src/api/sched.ts'), card = read('../src/components/sched/ReserveCard.vue'), view = read('../src/views/SchedConsole.vue'), banner = read('../src/components/sched/ReservationBanner.vue')
assert.match(api, /X-Dashboard-Client/); assert.match(api, /sched-console/)
assert.match(api, /endpoint === 'command' \? \{ 'X-Dashboard-Client': 'sched-console' \}/)
for (const text of ['1 小时后取消', '3 小时后取消', '不限期', '确定不限期', '算了', '不限期的预留要你手动取消，忘了会一直扣着主机的核', 'confirmNoExpiry: true']) assert.ok(card.includes(text))
assert.match(card, /ref<60 \| 180 \| null>\(180\)/)
assert.doesNotMatch(card.match(/<span class="reserve-status"[\s\S]*?<\/span>/)?.[0] ?? '', /自动取消|手动取消前一直留/)
assert.match(view, /<ReserveCard[^>]*\/>\s*<ReservationBanner/)
assert.ok(banner.includes('现在取消')); assert.doesNotMatch(banner.match(/<style[\s\S]*?<\/style>/)?.[0] ?? '', /#|rgb\(|hsl\(/i)
for (const file of readdirSync(new URL('../src/components/sched/', import.meta.url)).filter(name => /\.(vue|ts)$/.test(name))) assert.doesNotMatch(read(`../src/components/sched/${file}`), /(?:window\.)?\b(?:confirm|alert|prompt)\s*\(/)
assert.doesNotMatch(view, /(?:window\.)?\b(?:confirm|alert|prompt)\s*\(/)
