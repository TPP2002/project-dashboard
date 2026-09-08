<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CustomSeriesRenderItem } from 'echarts'
import { useBoardStore } from '@/stores/board'
import { DONE_STATUSES } from '@/api/schema'
import { cssVar, useEchart } from '@/charts/useEcharts'
import DoneToggle from '@/components/DoneToggle.vue'
import { humanTitle } from '@/utils/taskTitle'
import { localDayStart } from '@/utils/kanbanFlow'
import { reducedMotion } from '@/utils/iconMotion'
import type { Task } from '@/types'

const DAY_OPTIONS = [7, 30, 90] as const
const DAYS_KEY = 'board-gantt-days'
const WAVE_COLORS = ['--project-blue', '--project-green', '--project-amber', '--project-pink', '--project-purple', '--project-gray'] as const
function loadDays(): (typeof DAY_OPTIONS)[number] {
  try {
    const raw = localStorage.getItem(DAYS_KEY)
    return DAY_OPTIONS.find(days => String(days) === raw) ?? 30
  } catch (_) { return 30 /* 本机存储不可用时保留默认窗口。 */ }
}
const days = ref(loadDays())
function selectDays(value: (typeof DAY_OPTIONS)[number]) {
  days.value = value
  try { localStorage.setItem(DAYS_KEY, String(value)) }
  catch (_) { /* 存不下时仍在本页生效，刷新后回到上次保存的窗口。 */ }
}

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')
const allTasks = computed<Task[]>(() => store.currentBoard?.tasks ?? [])
const showDone = ref(false)
const doneCount = computed(() => allTasks.value.filter(task => DONE_STATUSES.has(task.status)).length)
const tasks = computed(() => showDone.value ? allTasks.value : allTasks.value.filter(task => !DONE_STATUSES.has(task.status)))
// 仅展示时钟；每分钟刷新跨度，跨过本地零点后窗口和「今天」一起推进。
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 60_000) })
onBeforeUnmount(() => { if (clock !== null) clearInterval(clock) })
const windowRange = computed(() => {
  const date = new Date(now.value)
  const [y, m, d] = [date.getFullYear(), date.getMonth(), date.getDate()]
  return { start: new Date(y, m, d - days.value).getTime(), today: new Date(y, m, d).getTime(), end: new Date(y, m, d + 1).getTime() }
})
interface TimelineRow { label: string; task?: Task; start: number | null; end: number; wave: number }
const rows = computed<TimelineRow[]>(() => {
  const entries = tasks.value.map(task => {
    const done = localDayStart(task.dates?.done)
    const end = done === null ? now.value : new Date(done).setHours(23, 59, 0, 0)
    return { label: task.id, task, start: localDayStart(task.dates?.start), end, wave: task.wave ?? 0 }
  })
  const scheduled = entries.filter(row => row.start !== null)
    .sort((a, b) => a.wave - b.wave || a.start! - b.start! || a.task.id.localeCompare(b.task.id))
  const result: TimelineRow[] = []
  let previousWave: number | undefined
  for (const row of scheduled) {
    if (row.wave !== previousWave) result.push({ label: `第 ${row.wave} 波`, start: null, end: 0, wave: row.wave })
    result.push(row)
    previousWave = row.wave
  }
  const unscheduled = entries.filter(row => row.start === null).sort((a, b) => a.wave - b.wave || a.task.id.localeCompare(b.task.id))
  if (unscheduled.length) result.push({ label: '没有开工日', start: null, end: 0, wave: 0 }, ...unscheduled)
  return result
})
const chartHeight = computed(() => Math.max(480, rows.value.length * 30 + 90))

function taskTip(task: Task): string {
  return `${task.id} ${humanTitle(task)}\n开工：${task.dates?.start || '没有开工日'}\n完工：${task.dates?.done || '未完工（到今天）'}\n第 ${task.wave ?? 0} 波 · ${task.status} · ${task.percent ?? 0}%`
}
function buildOption() {
  const theme = {
    text: cssVar('--text'), text2: cssVar('--text-2'), text3: cssVar('--text-3'),
    line: cssVar('--line'), lineStrong: cssVar('--line-strong'), surface: cssVar('--surface'), bad: cssVar('--bad'),
    fsXs: Number.parseFloat(cssVar('--fs-xs')), fsBase: Number.parseFloat(cssVar('--fs-base')),
  }
  if (!tasks.value.length) return {
    animation: !reducedMotion.value,
    title: { text: allTasks.value.length && !showDone.value ? '当前没有进行中的任务（点上方「显示已完工」查看）' : '无任务',
      left: 'center', top: 'center', textStyle: { color: theme.text2, fontSize: theme.fsBase } },
  }
  const palette = WAVE_COLORS.map(token => cssVar(token))
  const colorOf = (wave: number) => palette[((Math.trunc(wave) % palette.length) + palette.length) % palette.length]
  const range = windowRange.value
  const list = rows.value
  const barData = list.flatMap((row, index) => row.task ? [{
    value: [row.start ?? range.today, row.start === null ? range.today : row.end, index], task: row.task,
  }] : [])
  const renderItem: CustomSeriesRenderItem = (params, api) => {
    const row = list[Number(api.value(2))]
    const grid = params.coordSys as typeof params.coordSys & { x: number; y: number; width: number; height: number }
    const start = api.coord([api.value(0), api.value(2)])
    const end = api.coord([api.value(1), api.value(2)])
    const opacity = row.task?.status === '暂缓' ? 0.5 : 1
    const color = colorOf(row.wave)
    if (row.start === null) return {
      type: 'line', shape: { x1: Math.max(grid.x, start[0] - 9), x2: Math.min(grid.x + grid.width, start[0] + 9), y1: start[1], y2: start[1] },
      style: { stroke: color, lineWidth: 4, lineDash: [2, 3], opacity },
    }
    // 只裁切图形；data 中仍保存完整起止日期供提示框读取。
    if (end[0] < grid.x || start[0] > grid.x + grid.width || end[0] < start[0]) return
    const left = Math.max(grid.x, start[0])
    const right = Math.min(grid.x + grid.width, Math.max(left + 2, end[0]))
    return {
      type: 'rect', shape: { x: left, y: start[1] - 8, width: right - left, height: 16, r: 3 },
      style: { fill: color, opacity },
    }
  }
  return {
    animation: !reducedMotion.value,
    grid: { left: 190, right: 28, top: 36, bottom: 36 },
    tooltip: {
      transitionDuration: reducedMotion.value ? 0 : 0.4,
      renderMode: 'richText', backgroundColor: theme.surface, borderColor: theme.lineStrong, textStyle: { color: theme.text },
      formatter: (p: { data?: { task?: Task }; componentType?: string; value?: string }) => {
        const task = p.data?.task ?? (p.componentType === 'yAxis' ? list.find(row => row.label === p.value)?.task : undefined)
        return task ? taskTip(task) : ''
      },
    },
    xAxis: {
      type: 'time', min: range.start, max: range.end,
      axisLabel: { color: theme.text3, fontSize: theme.fsXs, formatter: (value: number) => {
        const date = new Date(value)
        return `${date.getMonth() + 1}/${date.getDate()}`
      } },
      axisLine: { lineStyle: { color: theme.lineStrong } },
      splitLine: { show: true, lineStyle: { color: theme.line } },
    },
    yAxis: {
      type: 'category', inverse: true, data: list.map(row => row.task ? row.label : {
        value: row.label, textStyle: { color: theme.text, fontWeight: 600 },
      }),
      triggerEvent: true, tooltip: { show: true },
      axisLabel: { interval: 0, color: theme.text3, fontSize: theme.fsXs, width: 170, overflow: 'truncate' },
      axisLine: { lineStyle: { color: theme.lineStrong } },
      splitLine: { show: true, lineStyle: { color: theme.line } },
    },
    series: [{
      type: 'custom', coordinateSystem: 'cartesian2d', clip: true, renderItem, data: barData,
      encode: { x: [0, 1], y: 2 },
      markLine: {
        silent: true, symbol: ['none', 'none'], data: [{ xAxis: range.today }],
        label: { show: true, formatter: '今天', color: theme.bad },
        lineStyle: { color: theme.bad, width: 2, type: 'solid' },
      },
    }],
  }
}
const { el, chart, update } = useEchart(buildOption, chart => chart.on('click', (p: unknown) => {
  const q = p as { data?: { task?: Task }; componentType?: string; value?: string }
  const task = q.data?.task ?? (q.componentType === 'yAxis' ? rows.value.find(row => row.label === q.value)?.task : undefined)
  if (task) store.openTask(task.id, pid.value)
}))
watch([rows, days, reducedMotion], () => { chart.value?.resize(); update() }, { deep: true, flush: 'post' })
</script>

<template>
  <div class="gantt-page">
    <div class="head">
      <h2><Icon name="gantt" class="head-ic" :size="20" />时间轴甘特</h2>
      <span class="pill" v-if="store.currentBoard">{{ store.currentBoard.project.name }}</span>
      <div class="day-options" role="group" aria-label="甘特时间窗口">
        <button v-for="value in DAY_OPTIONS" :key="value" class="btn btn-sm" type="button" :aria-pressed="days === value" @click="selectDays(value)">{{ value }} 天</button>
      </div>
      <DoneToggle v-model="showDone" :count="doneCount" />
      <span class="muted small">横轴是日期；条从开工日到完工日（未完工到今天）</span>
    </div>
    <div class="chart-scroll"><div class="chart card" ref="el" :style="{ height: chartHeight + 'px' }" /></div>
    <p class="legend">颜色表示波次；暂缓的条变淡。没有开工日的卡在底部以今天的点状短条示意；悬停条或任务编号看完整日期，点任务打开详情。</p>
  </div>
</template>

<style scoped>
.gantt-page { display: flex; flex-direction: column; height: 100%; min-width: 0; }
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s3); flex-wrap: wrap; }
.small { margin-left: auto; font-size: var(--fs-sm); }
.day-options { display: flex; gap: var(--s1); }
.day-options [aria-pressed="true"] { color: var(--info); border-color: var(--info); background: var(--info-bg); }
.chart-scroll { flex: 1; min-height: 0; overflow: auto; }
.chart { min-height: 480px; min-width: 640px; }
.legend { margin: var(--s3) 0 0; color: var(--text-2); font-size: var(--fs-sm); line-height: 1.6; }
</style>
