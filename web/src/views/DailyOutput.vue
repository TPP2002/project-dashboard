<script setup lang="ts">
// 每日成果：按天追踪"完成了多少任务卡"。敏捷吞吐量（Throughput）视角。
// 组成：统计卡（今/周/月/连击/日均）+ 产出热力日历（纯CSS，近17周）+ 近30天柱状图（echarts懒加载）
//      + 选中日的成果清单（完工卡 + 当日动作统计）。
// 范围默认【全部项目】——"我今天总共干了多少"是工作总量视角；可切单项目。
import { ref, computed, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import * as derive from '@/utils/derive'
import { useEchart } from '@/charts/useEcharts'
import { fmtShort } from '@/utils/format'
import type { Board } from '@/types'

const store = useBoardStore()
// 本页局部范围开关（不与中心视图的 centerScopeAll 混用：本页默认全部项目）
const scopeAll = ref(true)
const boards = computed<Board[]>(() =>
  scopeAll.value ? store.allBoards : store.currentBoard ? [store.currentBoard] : [],
)
const curName = computed(
  () => store.projectList.find((p) => p.id === store.currentProjectId)?.name ?? '当前项目',
)

// ---------- 完工记录派生 ----------
const doneData = computed(() => derive.collectDoneRecords(boards.value))
const byDay = computed(() => derive.groupDoneByDay(doneData.value.records))
const today = computed(() => derive.todayLocal())

function countOf(day: string): number {
  return byDay.value.get(day)?.length ?? 0
}
/** 过去 n 天（含今天）完工数 */
function countLastDays(n: number): number {
  let sum = 0
  const d = new Date()
  for (let i = 0; i < n; i++) {
    sum += countOf(derive.localDay(d))
    d.setDate(d.getDate() - 1)
  }
  return sum
}
const stats = computed(() => {
  const todayN = countOf(today.value)
  // 本周（周一起）
  const d = new Date()
  const dow = (d.getDay() + 6) % 7 // 周一=0
  let week = 0
  for (let i = 0; i <= dow; i++) {
    week += countOf(derive.localDay(d))
    d.setDate(d.getDate() - 1)
  }
  // 本月（1号起）
  const m = new Date()
  let month = 0
  for (let i = m.getDate(); i >= 1; i--) {
    month += countOf(derive.localDay(m))
    m.setDate(m.getDate() - 1)
  }
  const streak = derive.doneStreak(byDay.value)
  const avg30 = Math.round((countLastDays(30) / 30) * 10) / 10
  return { todayN, week, month, streak, avg30 }
})

// ---------- 热力日历（近17周，列=周、行=周一~周日） ----------
interface Cell { day: string; count: number; level: number; future: boolean }
const WEEKS = 17
const heatmap = computed<Cell[][]>(() => {
  // 末列 = 本周；末列的周一
  const now = new Date()
  const dow = (now.getDay() + 6) % 7
  const monday = new Date(now)
  monday.setDate(now.getDate() - dow - (WEEKS - 1) * 7)
  const cols: Cell[][] = []
  const cursor = new Date(monday)
  const todayStr = today.value
  for (let w = 0; w < WEEKS; w++) {
    const col: Cell[] = []
    for (let r = 0; r < 7; r++) {
      const day = derive.localDay(cursor)
      const count = countOf(day)
      col.push({ day, count, level: levelOf(count), future: day > todayStr })
      cursor.setDate(cursor.getDate() + 1)
    }
    cols.push(col)
  }
  return cols
})
function levelOf(n: number): number {
  if (n <= 0) return 0
  if (n <= 2) return 1
  if (n <= 5) return 2
  if (n <= 9) return 3
  return 4
}
/** 热力图月份标签：每列首（周一）所在月发生变化时标注 */
const monthLabels = computed(() => {
  const labels: { idx: number; text: string }[] = []
  let prev = -1
  heatmap.value.forEach((col, i) => {
    const mm = new Date(col[0].day).getMonth()
    if (mm !== prev) {
      labels.push({ idx: i, text: `${mm + 1}月` })
      prev = mm
    }
  })
  return labels
})

// ---------- 选中日期（默认今天；点热力格/柱子切换） ----------
const selectedDay = ref(derive.todayLocal())
const selectedRecords = computed(() => byDay.value.get(selectedDay.value) ?? [])
const selectedActs = computed(() => derive.activityCountsOfDay(boards.value, selectedDay.value))
const ACT_LABEL: Record<string, [string, string]> = {
  done: ['🏁', '完工'], claim: ['🙋', '认领'], progress: ['📈', '进度更新'],
  decide: ['✅', '拍板'], pending: ['❓', '登记待拍板'], note: ['📝', '备注'],
  park: ['🚫', '暂缓'], block: ['⛔', '阻塞'],
}
const actList = computed(() =>
  Object.entries(selectedActs.value)
    .sort((a, z) => z[1] - a[1])
    .map(([ty, n]) => ({ ty, n, icon: ACT_LABEL[ty]?.[0] ?? '·', label: ACT_LABEL[ty]?.[1] ?? ty })),
)
function fmtDayCN(day: string): string {
  const d = new Date(day)
  if (isNaN(d.getTime())) return day
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 · 周${wd}`
}

// ---------- 近30天柱状图 ----------
function buildOption() {
  const days: string[] = []
  const counts: number[] = []
  const d = new Date()
  d.setDate(d.getDate() - 29)
  for (let i = 0; i < 30; i++) {
    const day = derive.localDay(d)
    days.push(day)
    counts.push(countOf(day))
    d.setDate(d.getDate() + 1)
  }
  // 7日移动平均
  const ma: (number | null)[] = counts.map((_, i) => {
    if (i < 6) return null
    let s = 0
    for (let j = i - 6; j <= i; j++) s += counts[j]
    return Math.round((s / 7) * 10) / 10
  })
  return {
    grid: { left: 40, right: 16, top: 30, bottom: 26 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1a2029', borderColor: '#2a3341', textStyle: { color: '#e6edf3' },
      formatter: (ps: { axisValue?: string; seriesName?: string; data?: unknown }[]) => {
        const day = ps[0]?.axisValue ?? ''
        const lines = ps.map((p) => `${p.seriesName}：${p.data ?? 0}`)
        return `<b>${day}</b><br/>${lines.join('<br/>')}`
      },
    },
    xAxis: {
      type: 'category', data: days,
      axisLabel: { color: '#8b98a9', fontSize: 10, formatter: (v: string) => v.slice(5) },
      axisLine: { lineStyle: { color: '#2a3341' } },
    },
    yAxis: {
      type: 'value', minInterval: 1,
      axisLabel: { color: '#8b98a9', fontSize: 10 },
      splitLine: { lineStyle: { color: '#1a2029' } },
    },
    series: [
      {
        name: '完工卡', type: 'bar', data: counts, barMaxWidth: 16,
        itemStyle: { color: '#2ea043', borderRadius: [3, 3, 0, 0] },
        emphasis: { itemStyle: { color: '#3fb950' } },
      },
      {
        name: '7日均线', type: 'line', data: ma, smooth: true, symbol: 'none',
        lineStyle: { color: '#4c8dff', width: 1.6, type: 'dashed' }, itemStyle: { color: '#4c8dff' },
      },
    ],
  }
}
const { el, update } = useEchart(buildOption, (chart) =>
  chart.on('click', (p: unknown) => {
    const q = p as { name?: string }
    if (q.name) selectedDay.value = q.name
  }),
)
watch([byDay], update)
</script>

<template>
  <div>
    <div class="head">
      <h2>📆 每日成果</h2>
      <span class="pill">累计 {{ doneData.records.length }} 卡完工</span>
      <span
        v-if="doneData.undated"
        class="pill undated"
        :title="doneData.undated + ' 张已完工卡没有完工日期记录（早期手工登记），未计入按天统计'"
      >{{ doneData.undated }} 张无日期</span>
      <span class="spacer" />
      <div class="scope">
        <button class="seg" :class="{ on: scopeAll }" @click="scopeAll = true">全部项目</button>
        <button class="seg" :class="{ on: !scopeAll }" @click="scopeAll = false">{{ curName }}</button>
      </div>
    </div>

    <!-- 统计卡 -->
    <div class="statbar">
      <div class="stat" :class="{ glow: stats.todayN > 0 }">
        <b class="ok">{{ stats.todayN }}</b><span>今日完成</span>
      </div>
      <div class="stat"><b>{{ stats.week }}</b><span>本周</span></div>
      <div class="stat"><b>{{ stats.month }}</b><span>本月</span></div>
      <div class="stat" :class="{ fire: stats.streak >= 3 }">
        <b>{{ stats.streak }}<i v-if="stats.streak >= 3" class="fi">🔥</i></b><span>连续产出（天）</span>
      </div>
      <div class="stat"><b>{{ stats.avg30 }}</b><span>日均（近30天）</span></div>
    </div>

    <!-- 热力日历 -->
    <div class="card block">
      <div class="block-t">
        产出热力图 <span class="muted small">近 {{ 17 }} 周 · 点格子看当天明细</span>
        <span class="spacer" />
        <span class="lgd small muted">
          少 <i v-for="l in 5" :key="l" class="lgd-cell" :data-level="l - 1" /> 多
        </span>
      </div>
      <div class="heat-wrap">
        <div class="heat-months mono">
          <span
            v-for="ml in monthLabels" :key="ml.idx"
            class="hm" :style="{ left: `calc(${ml.idx} * (var(--cell) + var(--gap)))` }"
          >{{ ml.text }}</span>
        </div>
        <div class="heat">
          <div class="heat-dows mono"><span>一</span><span>三</span><span>五</span><span>日</span></div>
          <div class="heat-grid">
            <div v-for="(col, wi) in heatmap" :key="wi" class="heat-col">
              <button
                v-for="c in col" :key="c.day"
                class="cell" :data-level="c.level"
                :class="{ future: c.future, sel: c.day === selectedDay, today: c.day === today }"
                :disabled="c.future"
                :title="`${c.day} · 完工 ${c.count} 卡`"
                @click="selectedDay = c.day"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 近30天柱状图 -->
    <div class="card block">
      <div class="block-t">近 30 天完工趋势 <span class="muted small">绿柱=当日完工卡 · 蓝虚线=7日均 · 点柱子看明细</span></div>
      <div class="chart" ref="el" />
    </div>

    <!-- 当日明细 -->
    <div class="card block">
      <div class="block-t">
        {{ fmtDayCN(selectedDay) }}
        <span class="pill" :class="{ okpill: selectedRecords.length }">完成 {{ selectedRecords.length }} 卡</span>
        <button v-if="selectedDay !== today" class="btn btn-sm btn-ghost" @click="selectedDay = today">回到今天</button>
      </div>

      <div v-if="actList.length" class="acts">
        <span v-for="a in actList" :key="a.ty" class="pill act">{{ a.icon }} {{ a.label }} {{ a.n }}</span>
      </div>

      <div v-if="!selectedRecords.length" class="empty-day muted">
        这天没有完工的任务卡{{ actList.length ? '（但有上面这些动作）' : '' }}
      </div>
      <div v-else class="dlist">
        <div
          v-for="r in selectedRecords" :key="r.projectId + r.task.id"
          class="drow" @click="store.openTask(r.task.id, r.projectId)"
        >
          <span class="pill proj">{{ r.projectName }}</span>
          <span class="tid mono">{{ r.task.id }}</span>
          <span class="tt">{{ r.task.title }}</span>
          <span class="spacer" />
          <span v-if="r.ts" class="time mono muted">{{ fmtShort(r.ts).slice(6) }}</span>
          <span v-for="p in r.task.prNumbers || []" :key="p" class="pill">PR #{{ p }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.head h2 { font-size: 18px; }
.undated { color: var(--muted-2); cursor: help; }

.scope { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.seg { background: var(--panel-2); color: var(--muted); border: none; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.seg + .seg { border-left: 1px solid var(--border); }
.seg:hover { color: var(--text); }
.seg.on { background: var(--accent-soft); color: var(--text); font-weight: 600; }

.statbar { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.stat {
  display: flex; flex-direction: column; align-items: center;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 10px 22px; min-width: 104px;
}
.stat b { font-size: 22px; display: inline-flex; align-items: center; gap: 3px; }
.stat b.ok { color: var(--ok); }
.stat span { font-size: 12px; color: var(--muted); }
.stat.glow { border-color: rgba(46, 160, 67, 0.55); box-shadow: 0 0 14px rgba(46, 160, 67, 0.15); }
.stat.fire b { color: #f5a623; }
.fi { font-size: 14px; font-style: normal; }

.block { padding: 14px 16px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 12px; }
.block-t { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.small { font-size: 12px; font-weight: 400; }

/* 热力日历 */
.heat-wrap { --cell: 14px; --gap: 3px; overflow-x: auto; padding-bottom: 4px; }
.heat-months { position: relative; height: 16px; margin-left: 26px; }
.hm { position: absolute; top: 0; font-size: 10px; color: var(--muted-2); }
.heat { display: flex; gap: 6px; }
.heat-dows {
  display: flex; flex-direction: column; justify-content: space-between;
  font-size: 9px; color: var(--muted-2); padding: 1px 0; width: 20px; text-align: right;
  height: calc(7 * var(--cell) + 6 * var(--gap));
}
.heat-grid { display: flex; gap: var(--gap); }
.heat-col { display: flex; flex-direction: column; gap: var(--gap); }
.cell {
  width: var(--cell); height: var(--cell); border-radius: 3px; border: 1px solid transparent;
  background: var(--panel-2); padding: 0; cursor: pointer;
}
.cell[data-level='1'] { background: #14432a; }
.cell[data-level='2'] { background: #1a6334; }
.cell[data-level='3'] { background: #2ea043; }
.cell[data-level='4'] { background: #56d364; }
.cell:hover:not(.future) { border-color: var(--text); }
.cell.sel { border-color: #f5a623; box-shadow: 0 0 0 1px #f5a623; }
.cell.today:not(.sel) { border-color: rgba(230, 237, 243, 0.45); }
.cell.future { opacity: 0.25; cursor: default; }
.lgd { display: inline-flex; align-items: center; gap: 3px; }
.lgd-cell { width: 10px; height: 10px; border-radius: 2px; display: inline-block; background: var(--panel-2); }
.lgd-cell[data-level='1'] { background: #14432a; }
.lgd-cell[data-level='2'] { background: #1a6334; }
.lgd-cell[data-level='3'] { background: #2ea043; }
.lgd-cell[data-level='4'] { background: #56d364; }

.chart { height: 240px; }

/* 当日明细 */
.okpill { color: var(--ok); border-color: rgba(46, 160, 67, 0.4); }
.acts { display: flex; gap: 6px; flex-wrap: wrap; }
.act { font-size: 11px; }
.empty-day { font-size: 13px; padding: 14px 0 6px; }
.dlist { display: flex; flex-direction: column; }
.drow { display: flex; align-items: center; gap: 9px; padding: 8px 8px; border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; }
.drow:hover { background: var(--panel-2); }
.drow + .drow { border-top: 1px solid var(--border-soft); }
.drow .proj { color: var(--accent); flex: none; }
.drow .tid { color: var(--muted); font-weight: 600; flex: none; }
.drow .tt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drow .time { font-size: 11px; flex: none; }
</style>
