<script setup lang="ts">
// 依赖关系图（echarts force graph）。依赖=实线箭头，阻塞=红色虚线。echarts 按需 import()。
import { computed, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import { statusColor } from '@/api/schema'
import { useEchart } from '@/charts/useEcharts'

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')

function buildOption() {
  const tasks = store.currentBoard?.tasks ?? []
  const ids = new Set(tasks.map((t) => t.id))
  const nodes = tasks.map((t) => ({
    name: t.id,
    value: t.title,
    symbolSize: 34,
    itemStyle: { color: statusColor(t.status) },
    label: { show: true, color: '#e6edf3', fontSize: 11 },
  }))
  const links: unknown[] = []
  for (const t of tasks) {
    for (const d of t.deps?.dependsOn ?? []) {
      if (ids.has(d)) links.push({ source: d, target: t.id })
    }
    for (const d of t.deps?.blockedBy ?? []) {
      if (ids.has(d)) links.push({ source: d, target: t.id, lineStyle: { color: '#d0637c', type: 'dashed', width: 2 } })
    }
  }
  if (!nodes.length) return { title: { text: '无任务', left: 'center', top: 'center', textStyle: { color: '#8b98a9', fontSize: 13 } } }
  return {
    tooltip: {
      backgroundColor: '#1a2029', borderColor: '#2a3341', textStyle: { color: '#e6edf3' },
      formatter: (p: { dataType?: string; name?: string; value?: string }) =>
        p.dataType === 'node' ? `<b>${p.name}</b> ${p.value ?? ''}` : '',
    },
    series: [
      {
        type: 'graph', layout: 'force', roam: true, draggable: true,
        force: { repulsion: 200, edgeLength: 120, gravity: 0.08 },
        edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 9,
        lineStyle: { color: '#5f6b7a', curveness: 0.12 },
        emphasis: { focus: 'adjacency' },
        data: nodes, links,
      },
    ],
  }
}

const { el, update } = useEchart(buildOption, (chart) =>
  chart.on('click', (p: unknown) => {
    const q = p as { dataType?: string; name?: string }
    if (q.dataType === 'node' && q.name) store.openTask(q.name, pid.value)
  }),
)
watch(() => store.currentBoard, update, { deep: true })
</script>

<template>
  <div class="wrap">
    <div class="head">
      <h2>🕸️ 依赖关系图</h2>
      <span class="pill" v-if="store.currentBoard">{{ store.currentBoard.project.name }}</span>
      <span class="muted small">实线=依赖，红虚线=阻塞；点节点开任务，可拖拽/缩放</span>
    </div>
    <div class="chart card" ref="el" />
  </div>
</template>

<style scoped>
.wrap { display: flex; flex-direction: column; height: 100%; }
.head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.head h2 { font-size: 18px; }
.small { font-size: 12px; }
.chart { flex: 1; min-height: 460px; }
</style>
