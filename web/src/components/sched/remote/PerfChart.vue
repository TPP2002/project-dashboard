<script setup lang="ts">
import { watch } from 'vue'
import { cssVar, useEchart } from '@/charts/useEcharts'
import type { RemotePoint, RemoteRange } from '@/api/remoteHosts'
const props = defineProps<{ points: RemotePoint[]; values: number[]; second?: number[]; max: number; color: `--${string}`; secondColor?: `--${string}`; range: RemoteRange; cpu?: boolean; half?: boolean }>()
const { el, update } = useEchart(() => ({
  animation: false, grid: { left: 0, right: 0, top: 0, bottom: 0 },
  tooltip: { trigger: 'axis', formatter: (items: { dataIndex: number; value: number }[]) => { const i = items[0]?.dataIndex ?? 0, p = props.points[i]; if (!p) return ''; const time = new Date(p.t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', ...(props.range === '24h' ? {} : { second: '2-digit' }) }); return `${time}<br>${props.cpu && 'cpuMax' in p ? `均值 ${props.values[i]}%<br>最高 ${p.cpuMax}%` : props.values[i] ?? ''}${props.second ? `<br>${props.second[i] ?? ''}` : ''}` } },
  xAxis: { type: 'category', data: props.points.map(p => p.t), boundaryGap: false, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { show: false }, splitLine: { show: true, interval: Math.max(0, Math.floor(props.points.length / 10) - 1), lineStyle: { color: cssVar('--line') } } },
  yAxis: { type: 'value', min: 0, max: props.max, splitNumber: 5, axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: cssVar('--line') } } },
  series: [props.values, ...(props.second ? [props.second] : [])].map((data, i) => ({ type: 'line', data, showSymbol: false, lineStyle: { color: cssVar(i ? (props.secondColor ?? props.color) : props.color), width: 1.5 }, areaStyle: { color: cssVar(i ? (props.secondColor ?? props.color) : props.color), opacity: .14 } }))
}))
watch(() => [props.points, props.values, props.second, props.max, props.range], update, { deep: true })
</script>
<template><div ref="el" class="chart" :class="{ half }" /></template>
<style scoped>
.chart { height:260px; border:1px solid var(--line-strong); background:var(--surface); }.chart.half { height:150px; }
@media (max-width:760px) { .chart:not(.half) { height:200px; } }
</style>
