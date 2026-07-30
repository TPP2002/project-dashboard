<script setup lang="ts">
// 洞察：面向项目管理的四张分析图（敏捷视角），全部读时派生、echarts 懒加载。
// 1) 累计流图(CFD简化版)：立案/开工/完工三条累计线——三线间距=积压与在制品，看瓶颈
// 2) 每周吞吐·按项目堆叠：近12周每周完工多少、精力花在哪个项目
// 3) 周内节奏：周一~周日的完工分布——自己哪天效率最高
// 4) 周转时长分布：从开工到完工用了几天——发现拖尾任务
import { ref, computed, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import * as derive from '@/utils/derive'
import { useEchart } from '@/charts/useEcharts'
import type { Board } from '@/types'

const store = useBoardStore()
const selectedPid = ref<string>('all')
const boards = computed<Board[]>(() => {
  if (selectedPid.value === 'all') return store.allBoards
  const b = store.boards[selectedPid.value]
  return b ? [b] : []
})
const doneRecords = computed(() => derive.collectDoneRecords(boards.value).records)

// 项目固定配色（堆叠图用；与状态色错开）
const PROJ_COLORS = ['#4c8dff', '#2ea043', '#f5a623', '#a371f7', '#2bb0c9', '#d0637c', '#8a94a6']
const projColor = (i: number) => PROJ_COLORS[i % PROJ_COLORS.length]

const AXIS = { color: '#8b98a9', fontSize: 10 }
const TIP = { backgroundColor: '#1a2029', borderColor: '#2a3341', textStyle: { color: '#e6edf3' } }

// ---------- 1) 累计流图 ----------
function buildCfd() {
  const N = 90
  const days: string[] = []
  const d = new Date()
  d.setDate(d.getDate() - (N - 1))
  for (let i = 0; i < N; i++) { days.push(derive.localDay(d)); d.setDate(d.getDate() + 1) }
  const first = days[0]

  // 三个日期序列（design/start 用 dates 字段；done 用与每日成果一致的精确口径）
  const designDays: string[] = []
  const startDays: string[] = []
  for (const b of boards.value) {
    for (const t of b.tasks ?? []) {
      if (t.dates?.design) designDays.push(t.dates.design)
      if (t.dates?.start) startDays.push(t.dates.start)
    }
  }
  const doneDays = doneRecords.value.map((r) => r.day)
  const cum = (arr: string[]) => {
    const base = arr.filter((x) => x < first).length // 窗口前已有的存量
    const inWin: Record<string, number> = {}
    for (const x of arr) if (x >= first) inWin[x] = (inWin[x] || 0) + 1
    let acc = base
    return days.map((day) => (acc += inWin[day] || 0))
  }
  const cd = cum(designDays)
  const cs = cum(startDays)
  const cn = cum(doneDays)
  return {
    grid: { left: 44, right: 16, top: 34, bottom: 26 },
    legend: { top: 2, textStyle: { color: '#8b98a9', fontSize: 11 } },
    tooltip: { trigger: 'axis', ...TIP },
    xAxis: { type: 'category', data: days, axisLabel: { ...AXIS, formatter: (v: string) => v.slice(5) }, axisLine: { lineStyle: { color: '#2a3341' } } },
    yAxis: { type: 'value', axisLabel: AXIS, splitLine: { lineStyle: { color: '#1a2029' } } },
    series: [
      { name: '已立案（累计）', type: 'line', data: cd, symbol: 'none', lineStyle: { color: '#8a94a6', width: 1.4 }, areaStyle: { color: 'rgba(138,148,166,0.10)' }, itemStyle: { color: '#8a94a6' } },
      { name: '已开工（累计）', type: 'line', data: cs, symbol: 'none', lineStyle: { color: '#f5a623', width: 1.4 }, areaStyle: { color: 'rgba(245,166,35,0.10)' }, itemStyle: { color: '#f5a623' } },
      { name: '已完工（累计）', type: 'line', data: cn, symbol: 'none', lineStyle: { color: '#2ea043', width: 2 }, areaStyle: { color: 'rgba(46,160,67,0.16)' }, itemStyle: { color: '#2ea043' } },
    ],
  }
}
const cfdGap = computed(() => {
  // 当前积压（立案未开工）与在制（开工未完工）——用全量 boards 现状算，口径直白
  let design = 0, started = 0
  for (const b of boards.value) for (const t of b.tasks ?? []) {
    design++
    if (t.dates?.start || t.status === '施工中' || t.status === '收官' || t.status === '已完工') started++
  }
  const done = doneRecords.value.length
  return { backlog: design - started, wip: started - done < 0 ? 0 : started - done }
})

// ---------- 2) 每周吞吐 · 按项目堆叠 ----------
function mondayOf(day: string): string {
  const d = new Date(day)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return derive.localDay(d)
}
function buildWeekly() {
  const WEEKS = 12
  const mondays: string[] = []
  const d = new Date()
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - (WEEKS - 1) * 7)
  for (let i = 0; i < WEEKS; i++) { mondays.push(derive.localDay(d)); d.setDate(d.getDate() + 7) }
  const idx = new Map(mondays.map((m, i) => [m, i]))

  // 项目 → 每周计数
  const perProj = new Map<string, number[]>()
  const names = new Map<string, string>()
  for (const r of doneRecords.value) {
    const wk = idx.get(mondayOf(r.day))
    if (wk === undefined) continue
    if (!perProj.has(r.projectId)) { perProj.set(r.projectId, new Array(WEEKS).fill(0)); names.set(r.projectId, r.projectName) }
    perProj.get(r.projectId)![wk]++
  }
  const series = [...perProj.entries()].map(([pid, arr], i) => ({
    name: names.get(pid) || pid, type: 'bar', stack: 'total', data: arr,
    barMaxWidth: 26, itemStyle: { color: projColor(i) },
  }))
  return {
    grid: { left: 40, right: 16, top: 40, bottom: 26 },
    legend: { top: 2, textStyle: { color: '#8b98a9', fontSize: 10 }, type: 'scroll' },
    tooltip: { trigger: 'axis', ...TIP },
    xAxis: { type: 'category', data: mondays.map((m) => m.slice(5) + '周'), axisLabel: AXIS, axisLine: { lineStyle: { color: '#2a3341' } } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: AXIS, splitLine: { lineStyle: { color: '#1a2029' } } },
    series: series.length ? series : [{ type: 'bar', data: new Array(WEEKS).fill(0) }],
  }
}

// ---------- 3) 周内节奏 ----------
function buildWeekday() {
  const counts = new Array(7).fill(0) // 周一..周日
  for (const r of doneRecords.value) {
    const dow = (new Date(r.day).getDay() + 6) % 7
    counts[dow]++
  }
  const max = Math.max(...counts)
  return {
    grid: { left: 40, right: 16, top: 16, bottom: 26 },
    tooltip: { trigger: 'axis', ...TIP },
    xAxis: { type: 'category', data: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'], axisLabel: AXIS, axisLine: { lineStyle: { color: '#2a3341' } } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: AXIS, splitLine: { lineStyle: { color: '#1a2029' } } },
    series: [{
      name: '完工卡', type: 'bar', data: counts, barMaxWidth: 30,
      itemStyle: { color: (p: { value: number }) => p.value === max && max > 0 ? '#56d364' : '#2ea043', borderRadius: [3, 3, 0, 0] },
    }],
  }
}

// ---------- 4) 周转时长分布 ----------
const cycleData = computed(() => {
  const buckets = { 当天: 0, '1-2天': 0, '3-7天': 0, '8-14天': 0, '15天+': 0 }
  let sampled = 0
  const slow: { id: string; days: number }[] = []
  for (const b of boards.value) {
    for (const t of b.tasks ?? []) {
      if (t.status !== '已完工' || !t.dates?.start || !t.dates?.done) continue
      sampled++
      const days = Math.round((new Date(t.dates.done).getTime() - new Date(t.dates.start).getTime()) / 86400000)
      if (days < 1) buckets['当天']++
      else if (days <= 2) buckets['1-2天']++
      else if (days <= 7) buckets['3-7天']++
      else if (days <= 14) buckets['8-14天']++
      else buckets['15天+']++
      if (days > 2) slow.push({ id: t.id, days })
    }
  }
  slow.sort((a, z) => z.days - a.days)
  return { buckets, sampled, slow: slow.slice(0, 8) }
})
function buildCycle() {
  const b = cycleData.value.buckets
  const keys = Object.keys(b) as (keyof typeof b)[]
  return {
    grid: { left: 58, right: 30, top: 16, bottom: 26 },
    tooltip: { trigger: 'axis', ...TIP },
    xAxis: { type: 'value', minInterval: 1, axisLabel: AXIS, splitLine: { lineStyle: { color: '#1a2029' } } },
    yAxis: { type: 'category', data: keys, inverse: true, axisLabel: { ...AXIS, fontSize: 11 }, axisLine: { lineStyle: { color: '#2a3341' } } },
    series: [{
      type: 'bar', data: keys.map((k) => b[k]), barMaxWidth: 20,
      itemStyle: { color: '#4c8dff', borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: 'right', color: '#8b98a9', fontSize: 10 },
    }],
  }
}

// script-setup 顶层 ref 名与 template 的 ref="xxx" 字符串同名即自动绑定
const { el: cfdEl, update: updCfd } = useEchart(buildCfd)
const { el: weeklyEl, update: updWeekly } = useEchart(buildWeekly)
const { el: weekdayEl, update: updWeekday } = useEchart(buildWeekday)
const { el: cycleEl, update: updCycle } = useEchart(buildCycle)
watch([boards], () => { updCfd(); updWeekly(); updWeekday(); updCycle() })
</script>

<template>
  <div>
    <div class="head">
      <h2>📊 洞察</h2>
      <span class="muted small">项目管理四张图 · 全部现算不落盘</span>
      <span class="spacer" />
      <div class="scope">
        <button class="seg" :class="{ on: selectedPid === 'all' }" @click="selectedPid = 'all'">全部项目</button>
        <button
          v-for="p in store.projectList" :key="p.id"
          class="seg" :class="{ on: selectedPid === p.id }"
          @click="selectedPid = p.id"
        >{{ p.name }}</button>
      </div>
    </div>

    <div class="card block">
      <div class="block-t">累计流图（近90天）
        <span class="pill">现在：待开工积压 {{ cfdGap.backlog }} · 在制 {{ cfdGap.wip }}</span>
      </div>
      <div class="hint muted">三条线的<b>间距</b>就是健康度：灰线(立案)和黄线(开工)离得远=想法攒着没人做；黄线和绿线(完工)离得远=同时开工太多收不了尾。三线贴着走=节奏健康。</div>
      <div class="chart" ref="cfdEl" />
    </div>

    <div class="card block">
      <div class="block-t">每周吞吐 · 按项目分色（近12周）</div>
      <div class="hint muted">每根柱子=那一周总共完工多少卡，颜色=花在哪个项目。柱子忽高忽低=节奏不稳；某色长期霸榜=精力都在那个项目上。</div>
      <div class="chart" ref="weeklyEl" />
    </div>

    <div class="two">
      <div class="card block">
        <div class="block-t">周内节奏（累计）</div>
        <div class="hint muted">历史所有完工卡按"周几"归堆——最亮那根就是你的高产日。</div>
        <div class="chart sm" ref="weekdayEl" />
      </div>

      <div class="card block">
        <div class="block-t">周转时长分布 <span class="pill">{{ cycleData.sampled }} 卡有完整起止</span></div>
        <div class="hint muted">从开工到完工用了几天。堆在"当天"=快进快出（健康）；"3天+"的是拖尾卡，值得回头看看卡在哪。</div>
        <div class="chart sm" ref="cycleEl" />
        <div v-if="cycleData.slow.length" class="slow">
          <span class="muted small">最拖的几张：</span>
          <span v-for="s in cycleData.slow" :key="s.id" class="pill" :title="s.days + ' 天'">{{ s.id }} · {{ s.days }}天</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.head h2 { font-size: 18px; }
.small { font-size: 12px; }

.scope { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.seg {
  background: var(--panel-2); color: var(--muted); border: 1px solid var(--border);
  border-radius: 999px; padding: 3px 11px; font-size: 12px; cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.seg:hover { color: var(--text); border-color: var(--accent); }
.seg.on { background: var(--accent-soft); color: var(--text); font-weight: 600; border-color: var(--accent); }

.block { padding: 14px 16px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 10px; }
.block-t { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hint { font-size: 12px; line-height: 1.6; }
.chart { height: 260px; }
.chart.sm { height: 220px; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
.slow { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
</style>
