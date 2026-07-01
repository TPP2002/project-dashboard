<script setup lang="ts">
// 时间轴甘特（echarts 堆叠条实现）。echarts 按需 import()，不进首屏。
import { computed, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import { statusColor } from '@/api/schema'
import { useEchart } from '@/charts/useEcharts'
import type { Task } from '@/types'

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')
const rows = computed<Task[]>(() => (store.currentBoard?.tasks ?? []).filter((t) => t.dates?.start))

const DAY = 86400000
const fmtMD = (ts: number) => {
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${d.getDate()}`
}

function buildOption() {
  const list = rows.value
  if (!list.length) return { title: { text: '无带开工日期的任务', left: 'center', top: 'center', textStyle: { color: '#8b98a9', fontSize: 13 } } }
  const starts = list.map((t) => new Date(t.dates!.start as string).getTime())
  const min = Math.min(...starts)
  const now = Date.now()
  const cats = list.map((t) => t.id)
  const offsets: number[] = []
  const durs: { value: number; itemStyle: { color: string }; task: Task }[] = []
  list.forEach((t, i) => {
    const s = (starts[i] - min) / DAY
    const endTs = t.dates?.done ? new Date(t.dates.done).getTime() : now
    const e = (endTs - min) / DAY
    offsets.push(s)
    durs.push({ value: Math.max(e - s, 0.5), itemStyle: { color: statusColor(t.status) }, task: t })
  })
  return {
    grid: { left: 66, right: 24, top: 12, bottom: 30 },
    tooltip: {
      backgroundColor: '#1a2029', borderColor: '#2a3341', textStyle: { color: '#e6edf3' },
      formatter: (p: { dataIndex: number }) => {
        const t = list[p.dataIndex]
        return `<b>${t.id}</b> ${t.title}<br/>${t.dates?.start} → ${t.dates?.done || '进行中'}`
      },
    },
    xAxis: {
      type: 'value',
      axisLabel: { color: '#8b98a9', formatter: (v: number) => fmtMD(min + v * DAY) },
      splitLine: { lineStyle: { color: '#222b37' } },
    },
    yAxis: {
      type: 'category', inverse: true, data: cats,
      axisLabel: { color: '#8b98a9' }, axisLine: { lineStyle: { color: '#2a3341' } },
    },
    series: [
      { type: 'bar', stack: 'g', itemStyle: { color: 'transparent' }, data: offsets, silent: true },
      { type: 'bar', stack: 'g', barWidth: 14, data: durs, itemStyle: { borderRadius: 3 } },
    ],
  }
}

const { el, update } = useEchart(buildOption, (chart) =>
  chart.on('click', (p: unknown) => {
    const idx = (p as { dataIndex?: number; componentType?: string }).dataIndex
    if (typeof idx === 'number' && rows.value[idx]) store.openTask(rows.value[idx].id, pid.value)
  }),
)
watch(() => store.currentBoard, update, { deep: true })
</script>

<template>
  <div class="wrap">
    <div class="head"><h2>📅 甘特图</h2><span class="pill" v-if="store.currentBoard">{{ store.currentBoard.project.name }}</span><span class="muted small">点条形打开任务</span></div>
    <div class="chart card" ref="el" />
  </div>
</template>

<style scoped>
.wrap { display: flex; flex-direction: column; height: 100%; }
.head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.head h2 { font-size: 18px; }
.small { font-size: 12px; margin-left: auto; }
.chart { flex: 1; min-height: 420px; padding: 8px; }
</style>
