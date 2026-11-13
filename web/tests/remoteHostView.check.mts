import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { cardConclusion, freshnessText, offlineBannerText, fmtGb, fmtSize, fmtRss, fmtRate, runningFor, uptimeText, cacheText, sparkPath, sparkArea, mergePoints, memMix, niceMax, filterProcesses, sortProcesses, cardTaskMeta } from '../src/components/sched/remoteHostFormat'
import { remoteHostsPath } from '../src/api/remoteHosts'

test('card conclusions and freshness', () => {
  const host = { status: 'online', stale: false, latest: {}, capacity: { logicalCores: 32, freeCores: 3.4, memAvailMb: 77517 } } as any
  assert.deepEqual(cardConclusion(host), { text: '空闲 3.4 核 · 内存剩 75.7 GB', tone: 'warn', capacity: 'full' })
  assert.deepEqual(cardConclusion({ ...host, capacity: { ...host.capacity, freeCores: 20 } }), { text: '空闲 20 核 · 内存剩 75.7 GB', tone: 'ok', capacity: 'available' })
  assert.deepEqual(cardConclusion({ ...host, capacity: { ...host.capacity, freeCores: 0.6 } }), { text: '已满载 · 内存剩 75.7 GB', tone: 'warn', capacity: 'full' })
  assert.equal(cardConclusion({ ...host, capacity: { ...host.capacity, logicalCores: 4, freeCores: 0.6 } }).capacity, 'full')
  for (const h of [{ ...host, stale: true }, { ...host, status: 'offline' }]) assert.deepEqual(cardConclusion(h), { text: '连不上,正在重连', tone: 'bad', capacity: 'offline' })
  assert.deepEqual(cardConclusion({ ...host, status: 'connecting', latest: null }), { text: '正在连接', tone: 'muted', capacity: 'offline' })
  assert.deepEqual(cardConclusion({ ...host, capacity: null, latest: null }), { text: '已连上,等第一笔读数', tone: 'muted', capacity: 'offline' })
  for (const [age, stale, expected] of [[1200, false, '数据更新于 1 秒前'], [300, false, '数据更新于 1 秒前'], [75000, false, '数据更新于 1 分钟前'], [20000, true, '20 秒没收到数据 · 数据过期'], [184000, true, '3 分钟没收到数据 · 数据过期'], [null, true, '还没收到数据']] as const) assert.equal(freshnessText(age, stale), expected)
  assert.equal(freshnessText(null, false), '还没收到数据')
  assert.equal(offlineBannerText(184000, '30 秒没连上:timeout'), '3 分钟没收到数据,正在重连。30 秒没连上:timeout。下面是断线前的最后数据。')
  assert.equal(offlineBannerText(184000, null), '3 分钟没收到数据,正在重连。下面是断线前的最后数据。')
})

test('format values and durations', () => {
  assert.equal(fmtGb(96518), '94.3 GB'); assert.equal(fmtSize(149504), '146 GB'); assert.equal(fmtSize(506), '506 MB')
  assert.equal(fmtRss(16589), '16.2 GB'); assert.equal(fmtRss(310.4), '310 MB')
  assert.equal(fmtRate(3250000), '3.1 MB/s'); assert.equal(fmtRate(52000), '51 KB/s'); assert.equal(fmtRate(0), '0 KB/s')
  const now = Date.parse('2026-01-03T00:00:00Z')
  for (const [minutes, text] of [[134, '2 小时 14 分'], [6, '6 分'], [1620, '1 天 3 小时'], [0.5, '不到 1 分']] as const) assert.equal(runningFor(new Date(now - minutes * 60000).toISOString(), now), text)
  assert.equal(runningFor(null, now), null); assert.equal(uptimeText(8045), '2:14:05'); assert.equal(uptimeText(93784), '1 天 2:03:04')
  assert.equal(cacheText('32K'), '32 KB'); assert.equal(cacheText('4096K'), '4 MB'); assert.equal(cacheText('16384K'), '16 MB')
  assert.match(cardTaskMeta({ rssMb: 310, pids: 3, startedAt: new Date(now - 134 * 60000).toISOString() } as any, now), /· 已跑 2 小时 14 分$/)
  assert.match(cardTaskMeta({ rssMb: 310, pids: 3, startedAt: null } as any, now), /个进程$/)
})

test('chart and process helpers', () => {
  assert.equal(sparkPath([0, 50, 100], 120, 40, 100), 'M0.00,40.00 L60.00,20.00 L120.00,0.00')
  assert.equal(sparkPath([150], 120, 40, 100), 'M0.00,0.00 L120.00,0.00'); assert.equal(sparkPath([], 120, 40, 100), '')
  assert.match(sparkArea([0, 50, 100], 120, 40, 100), /^M0\.00,40\.00 L.*L120\.00,40\.00 Z$/)
  const merged = mergePoints(Array.from({ length: 600 }, (_, i) => ({ t: i + 1 })), [599, 600, 601, 602].map(t => ({ t })), 600)
  assert.equal(merged.length, 600); assert.equal(merged.at(-1)?.t, 602); assert.ok(merged.every((p, i) => !i || p.t > merged[i - 1]!.t))
  const mix = memMix({ usedMb: 30, cachedMb: 90 } as any, 100); assert.ok(Math.abs(mix.usedPct + mix.cachePct + mix.freePct - 100) < 0.01)
  assert.deepEqual(mix, { usedPct: 30, cachePct: 70, freePct: 0 })
  assert.equal(niceMax([0.3, 1.7], 1), 2); assert.equal(niceMax([3.2e6], 1), 5e6); assert.equal(niceMax([], 1), 1)
  const list = [{ pid: 4120, name: 'one', command: 'selfplay', user: 'demo', rssMb: 1 }, { pid: 2, name: 'two', command: '', user: 'demo', rssMb: 4 }] as any[]
  assert.equal(filterProcesses(list, 'SELF').length, 1); assert.equal(filterProcesses(list, '4120')[0].pid, 4120); assert.deepEqual(filterProcesses(list, ''), list)
  assert.equal(sortProcesses(list, 'rssMb', 'desc')[0].pid, 2); assert.equal(list[0].pid, 4120)
})

test('paths and page wiring', async () => {
  assert.equal(remoteHostsPath('my server', 'perf', '10m'), '/api/sched/remote-hosts/my%20server/perf?range=10m'); assert.equal(remoteHostsPath(), '/api/sched/remote-hosts')
  const read = (p: string) => readFile(new URL(`../src/${p}`, import.meta.url), 'utf8')
  const router = await read('router/index.ts'); assert.match(router, /path:\s*['"]\/sched\/remote\/:name['"][^\n]*module:\s*['"]cpu['"] /)
  const consolePage = await read('views/SchedConsole.vue'); assert.match(consolePage, /import RemoteHostCard/); assert.match(consolePage, /class="sched-machines"[^]*?<MachineCard[^]*?<RemoteHostCard[^]*?<\/div>/)
  const card = await read('components/sched/RemoteHostCard.vue'); for (const s of ['性能详情', '不参与派单', '在跑的任务']) assert.ok(card.includes(s))
  const perf = await read('views/RemoteHostPerf.vue'); for (const s of ['返回调度台', '60 秒', '10 分钟', '24 小时', '逻辑处理器', '没有匹配的进程']) assert.ok(perf.includes(s))
  assert.match(perf, /v-if="item === 'cpu' && host\.host" class="perf-spec"/)
  assert.match(perf, /k === 'mem' && \(!host\.host \|\| host\.host\.memTotalMb == null\)/)
  assert.match(perf, /item !== 'mem' \|\| \(host\.host && host\.host\.memTotalMb != null\)/)
  assert.match(await read('components/SideNav.vue'), /startsWith\(['"]\/sched\//)
  for (const content of [card, perf, await read('components/sched/remote/PerfChart.vue')]) for (const style of content.matchAll(/<style[^>]*>([^]*?)<\/style>/g)) assert.doesNotMatch(style[1]!, /#[\da-f]{3,8}\b|rgb\(/i)
})
