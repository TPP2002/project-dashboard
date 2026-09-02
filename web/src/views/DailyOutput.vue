<script setup lang="ts">
// 每日成果：按天追踪"完成了多少任务卡"。敏捷吞吐量（Throughput）视角。
// 组成：统计卡（今/周/月/连击/日均）+ 产出热力日历（纯CSS，近17周）+ 近30天柱状图（echarts懒加载）
//      + 选中日的成果清单（完工卡 + 当日动作统计）。
// 范围默认【全部项目】——"我今天总共干了多少"是工作总量视角；可切单项目。
import { ref, computed, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import * as derive from '@/utils/derive'
import { cssVar, useEchart } from '@/charts/useEcharts'
import { fmtShort } from '@/utils/format'
import type { Board } from '@/types'

const store = useBoardStore()
// 本页局部项目选择：默认「全部项目」（一天的总产出），也可点任意单个项目单看——
// 负责人点名要能逐项目查看，不跟顶栏下拉绑定（那个是"当前项目"语义，这里是自由挑选）。
const selectedPid = ref<string>('all')
const boards = computed<Board[]>(() => {
  if (selectedPid.value === 'all') return store.allBoards
  const b = store.boards[selectedPid.value]
  return b ? [b] : []
})

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

// ---------- 完工趋势柱状图（档位可切：30/60/90天/全部） ----------
const RANGES = [
  { days: 30, label: '近30天' },
  { days: 60, label: '近60天' },
  { days: 90, label: '近90天' },
  { days: 0, label: '全部' },
] as const
const rangeDays = ref<number>(30)
/** 当前档位实际天数（全部=从最早完工记录到今天，至少30天） */
function actualDays(): number {
  if (rangeDays.value > 0) return rangeDays.value
  const recs = doneData.value.records
  if (!recs.length) return 30
  const earliest = recs[recs.length - 1].day // records 按日倒序，末位最早
  const span = Math.ceil((Date.now() - new Date(earliest).getTime()) / 86400000) + 1
  return Math.max(span, 30)
}
function buildOption() {
  const theme = {
    text: cssVar('--text'),
    text3: cssVar('--text-3'),
    line: cssVar('--line'),
    lineStrong: cssVar('--line-strong'),
    surface: cssVar('--surface'),
    surface2: cssVar('--surface-2'),
    info: cssVar('--chart-1'),
    ok: cssVar('--chart-2'),
    focus: cssVar('--chart-5'),
    infoBg: cssVar('--info-bg'),
    fsXs: Number.parseFloat(cssVar('--fs-xs')),
  }
  const n = actualDays()
  const days: string[] = []
  const counts: number[] = []
  const d = new Date()
  d.setDate(d.getDate() - (n - 1))
  for (let i = 0; i < n; i++) {
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
    grid: { left: 40, right: 16, top: 30, bottom: n > 90 ? 46 : 26 },
    // 长档位加缩放：滚轮/捏合可缩放（inside），超90天再给底部滑条
    dataZoom: [
      { type: 'inside' },
      ...(n > 90 ? [{
        type: 'slider', height: 16, bottom: 4,
        backgroundColor: theme.surface2, borderColor: theme.line,
        fillerColor: theme.infoBg, textStyle: { color: theme.text3 },
        handleStyle: { color: theme.info, borderColor: theme.lineStrong },
      }] : []),
    ],
    tooltip: {
      trigger: 'axis',
      backgroundColor: theme.surface, borderColor: theme.lineStrong, textStyle: { color: theme.text },
      formatter: (ps: { axisValue?: string; seriesName?: string; data?: unknown }[]) => {
        const day = ps[0]?.axisValue ?? ''
        const lines = ps.map((p) => `${p.seriesName}：${p.data ?? 0}`)
        return `<b>${day}</b><br/>${lines.join('<br/>')}`
      },
    },
    xAxis: {
      type: 'category', data: days,
      axisLabel: { color: theme.text3, fontSize: theme.fsXs, formatter: (v: string) => v.slice(5) },
      axisLine: { lineStyle: { color: theme.lineStrong } },
    },
    yAxis: {
      type: 'value', minInterval: 1,
      axisLabel: { color: theme.text3, fontSize: theme.fsXs },
      splitLine: { lineStyle: { color: theme.line } },
    },
    series: [
      {
        name: '完工卡', type: 'bar', data: counts, barMaxWidth: 16,
        itemStyle: { color: theme.ok, borderRadius: [3, 3, 0, 0] },
        emphasis: { itemStyle: { color: theme.focus } },
      },
      {
        name: '7日均线', type: 'line', data: ma, smooth: true, symbol: 'none',
        lineStyle: { color: theme.info, width: 1.6, type: 'dashed' }, itemStyle: { color: theme.info },
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
watch([byDay, rangeDays], update)
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
        <button class="seg" :class="{ on: selectedPid === 'all' }" @click="selectedPid = 'all'">全部项目</button>
        <button
          v-for="p in store.projectList" :key="p.id"
          class="seg" :class="{ on: selectedPid === p.id }"
          @click="selectedPid = p.id"
        >{{ p.name }}</button>
      </div>
    </div>

    <!-- 统计卡 -->
    <div class="statbar">
      <div class="stat card">
        <span v-if="stats.todayN > 0" class="glow glow-top stat-edge" />
        <b class="v ok">{{ stats.todayN }}</b><span class="l">今日完成</span>
      </div>
      <div class="stat card"><b class="v">{{ stats.week }}</b><span class="l">本周</span></div>
      <div class="stat card"><b class="v">{{ stats.month }}</b><span class="l">本月</span></div>
      <div class="stat card" :class="{ fire: stats.streak >= 3 }">
        <b class="v">{{ stats.streak }}<i v-if="stats.streak >= 3" class="fi">🔥</i></b><span class="l">连续产出（天）</span>
      </div>
      <div class="stat card"><b class="v">{{ stats.avg30 }}</b><span class="l">日均（近30天）</span></div>
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

    <!-- 完工趋势柱状图（档位可切） -->
    <div class="card block">
      <div class="block-t">
        完工趋势
        <span class="muted small">绿柱=当日完工卡 · 蓝虚线=7日均 · 点柱子看明细 · 滚轮可缩放</span>
        <span class="spacer" />
        <div class="scope">
          <button
            v-for="r in RANGES" :key="r.days"
            class="seg" :class="{ on: rangeDays === r.days }"
            @click="rangeDays = r.days"
          >{{ r.label }}</button>
        </div>
      </div>
      <div class="chart" ref="el" />
    </div>

    <!-- 当日明细 -->
    <div class="card block">
      <div class="block-t">
        {{ fmtDayCN(selectedDay) }}
        <span class="badge" :class="selectedRecords.length ? 'ok' : 'n'">完成 {{ selectedRecords.length }} 卡</span>
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
          class="drow row" @click="store.openTask(r.task.id, r.projectId)"
        >
          <span class="pill proj">{{ r.projectName }}</span>
          <span class="tid mono">{{ r.task.id }}</span>
          <span class="tt g">{{ r.task.title }}</span>
          <span class="spacer" />
          <span v-if="r.ts" class="time mono rt">{{ fmtShort(r.ts).slice(6) }}</span>
          <span v-for="p in r.task.prNumbers || []" :key="p" class="pill">PR #{{ p }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s4); flex-wrap: wrap; }
.undated { color: var(--text-3); cursor: help; }

/* 项目选择：圆角小片按钮，可换行（7 个选项一排放不下时自动折行） */
.scope { display: flex; flex-wrap: wrap; gap: var(--s1); justify-content: flex-end; }
.seg {
  padding: var(--s1) var(--s3); border: 1px solid var(--line); border-radius: var(--r);
  background: var(--surface-2); color: var(--text-2); cursor: pointer; font-size: var(--fs-sm);
  transition: border-color .14s, color .14s, background .14s;
}
.seg:hover { color: var(--text); border-color: var(--line-strong); }
.seg.on { background: var(--info-bg); color: var(--info); font-weight: 600; border-color: var(--info); }

.statbar { display: flex; gap: var(--s3); margin-bottom: var(--s4); flex-wrap: wrap; }
.stat {
  display: flex; flex-direction: column; align-items: center; min-width: 104px;
  padding: var(--s3) var(--s5);
}
.stat .v { display: inline-flex; align-items: center; gap: var(--s1); }
.stat .v.ok { color: var(--ok); }
.stat-edge { position: absolute; inset: 0 0 auto; width: 100%; }
.stat.fire .v { color: var(--warn); }
.fi { font-size: var(--fs-base); font-style: normal; }

.block { display: flex; flex-direction: column; gap: var(--s3); margin-bottom: var(--s4); padding: var(--s3) var(--s4); }
.block-t { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; font-size: var(--fs-base); font-weight: 600; }
.small { font-size: var(--fs-sm); font-weight: 400; }

/* 热力日历 */
.heat-wrap { --cell: 14px; --gap: var(--s1); overflow-x: auto; padding-bottom: var(--s1); }
.heat-months { position: relative; height: var(--s4); margin-left: var(--s5); }
.hm { position: absolute; top: 0; color: var(--text-3); font-size: var(--fs-xs); }
.heat { display: flex; gap: var(--s1); }
.heat-dows {
  display: flex; flex-direction: column; justify-content: space-between;
  width: 20px; height: calc(7 * var(--cell) + 6 * var(--gap)); padding: var(--s1) 0;
  color: var(--text-3); font-size: var(--fs-xs); text-align: right;
}
.heat-grid { display: flex; gap: var(--gap); }
.heat-col { display: flex; flex-direction: column; gap: var(--gap); }
.cell {
  width: var(--cell); height: var(--cell); padding: 0; border: 1px solid transparent;
  border-radius: var(--r-sm); background: var(--surface-2); cursor: pointer;
}
.cell[data-level='1'] { background: var(--heat-1); }
.cell[data-level='2'] { background: var(--heat-2); }
.cell[data-level='3'] { background: var(--heat-3); }
.cell[data-level='4'] { background: var(--heat-4); }
.cell:hover:not(.future) { border-color: var(--text); }
.cell.sel { border-color: var(--warn); box-shadow: 0 0 0 1px var(--warn); }
.cell.today:not(.sel) { border-color: var(--line-strong); }
.cell.future { opacity: 0.25; cursor: default; }
.lgd { display: inline-flex; align-items: center; gap: var(--s1); }
.lgd-cell { display: inline-block; width: var(--s3); height: var(--s3); border-radius: var(--r-sm); background: var(--surface-2); }
.lgd-cell[data-level='1'] { background: var(--heat-1); }
.lgd-cell[data-level='2'] { background: var(--heat-2); }
.lgd-cell[data-level='3'] { background: var(--heat-3); }
.lgd-cell[data-level='4'] { background: var(--heat-4); }

.chart { height: 240px; }

/* 当日明细 */
.acts { display: flex; gap: var(--s1); flex-wrap: wrap; }
.act { font-size: var(--fs-xs); }
.empty-day { padding: var(--s3) 0 var(--s2); font-size: var(--fs-base); }
.dlist { display: flex; flex-direction: column; }
.drow { cursor: pointer; }
.drow + .drow { margin-top: var(--s2); }
.drow .proj { flex: none; color: var(--info); }
.drow .tid { flex: none; color: var(--text-2); font-weight: 600; }
.drow .time { flex: none; }
</style>
