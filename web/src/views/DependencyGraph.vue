<script setup lang="ts">
// 依赖关系图（echarts force graph）。依赖=实线箭头，阻塞=红色虚线。echarts 按需 import()。
import { computed, ref, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import { statusTone, DONE_STATUSES } from '@/api/schema'
import { cssVar, useEchart } from '@/charts/useEcharts'
import DoneToggle from '@/components/DoneToggle.vue'

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')
// 默认折叠已完工节点(连带其依赖线),只看活跃任务的关系网
const showDone = ref(false)
const doneCount = computed(() => (store.currentBoard?.tasks ?? []).filter((t) => DONE_STATUSES.has(t.status)).length)

function toneColor(status: string): string {
  const tone = statusTone(status)
  return cssVar(tone === 'n' ? '--text-3' : `--${tone}`)
}

function buildOption() {
  const theme = {
    text: cssVar('--text'),
    text2: cssVar('--text-2'),
    text3: cssVar('--text-3'),
    lineStrong: cssVar('--line-strong'),
    surface: cssVar('--surface'),
    info: cssVar('--info'),
    bad: cssVar('--bad'),
    fsXs: Number.parseFloat(cssVar('--fs-xs')),
    fsBase: Number.parseFloat(cssVar('--fs-base')),
  }
  const allTasks = store.currentBoard?.tasks ?? []
  const tasks = showDone.value ? allTasks : allTasks.filter((t) => !DONE_STATUSES.has(t.status))
  const ids = new Set(tasks.map((t) => t.id))
  const nodes = tasks.map((t) => ({
    name: t.id,
    value: t.title,
    symbolSize: 34,
    itemStyle: { color: toneColor(t.status) },
    label: {
      show: true,
      color: theme.text,
      fontSize: theme.fsXs,
      textBorderColor: theme.surface,
      textBorderWidth: 3,
    },
  }))
  const links: unknown[] = []
  const seenRelated = new Set<string>()
  for (const t of tasks) {
    for (const d of t.deps?.dependsOn ?? []) {
      if (ids.has(d)) links.push({ source: d, target: t.id, lineStyle: { color: theme.info, width: 2 } })
    }
    for (const d of t.deps?.blockedBy ?? []) {
      if (ids.has(d)) links.push({ source: d, target: t.id, lineStyle: { color: theme.bad, type: 'dashed', width: 2.5 } })
    }
    for (const d of t.deps?.relatedTasks ?? []) {
      if (!ids.has(d)) continue
      const key = [t.id, d].sort().join('-')
      if (seenRelated.has(key)) continue
      seenRelated.add(key)
      links.push({ source: t.id, target: d, symbol: ['none', 'none'], lineStyle: { color: theme.text3, type: 'dotted', width: 1.5, curveness: 0.2 } })
    }
  }
  if (!nodes.length) return { title: { text: '无任务', left: 'center', top: 'center', textStyle: { color: theme.text2, fontSize: theme.fsBase } } }
  return {
    tooltip: {
      backgroundColor: theme.surface, borderColor: theme.lineStrong, textStyle: { color: theme.text },
      formatter: (p: { dataType?: string; name?: string; value?: string }) =>
        p.dataType === 'node' ? `<b>${p.name}</b> ${p.value ?? ''}` : '',
    },
    series: [
      {
        type: 'graph', layout: 'force', roam: true, draggable: true,
        force: { repulsion: 200, edgeLength: 120, gravity: 0.08 },
        edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 9,
        lineStyle: { color: theme.lineStrong, curveness: 0.12 },
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
watch(showDone, update)
</script>

<template>
  <div class="dependency-page">
    <div class="head">
      <h2>🕸️ 依赖关系图</h2>
      <span class="pill" v-if="store.currentBoard">{{ store.currentBoard.project.name }}</span>
      <DoneToggle v-if="doneCount" v-model="showDone" :count="doneCount" />
      <span class="muted small">蓝实线=依赖 · 红虚线=阻塞 · 灰点线=关联；点节点开任务，可拖拽/缩放</span>
    </div>
    <div class="chart card" ref="el" />
  </div>
</template>

<style scoped>
.dependency-page { display: flex; flex-direction: column; height: 100%; min-width: 0; }
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s3); flex-wrap: wrap; }
.small { font-size: var(--fs-sm); }
.chart { flex: 1; min-height: 460px; }
</style>
