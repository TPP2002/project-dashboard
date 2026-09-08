<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import { computed, onBeforeUnmount, watch, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import { statusTone } from '@/api/schema'
import { cssVar, useEchart } from '@/charts/useEcharts'
import { humanTitle } from '@/utils/taskTitle'
import { dependencySubgraph, layeredLayout } from '@/utils/graphLayout'
import { reducedMotion } from '@/utils/iconMotion'

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')
const showAll = ref(false)
const query = ref('')
const graph = computed(() => dependencySubgraph(store.currentBoard?.tasks ?? [], { showAll: showAll.value }))
const matches = computed(() => {
  const text = query.value.trim().toLowerCase()
  return text ? graph.value.nodes.filter(task => task.id.toLowerCase().includes(text) || humanTitle(task).toLowerCase().includes(text)) : []
})
const focusId = computed(() => matches.value[0]?.id)
const highlighted = computed(() => new Set(dependencySubgraph(graph.value.nodes, {
  showAll: true, focusId: focusId.value,
}).nodes.filter(task => task.highlighted).map(task => task.id)))

function toneColor(status: string): string {
  const tone = statusTone(status)
  return cssVar(tone === 'n' ? '--text-3' : `--${tone}`)
}

function buildOption() {
  const theme = {
    text: cssVar('--text'), text2: cssVar('--text-2'), text3: cssVar('--text-3'),
    lineStrong: cssVar('--line-strong'), surface: cssVar('--surface'),
    info: cssVar('--info'), bad: cssVar('--bad'),
    fsXs: Number.parseFloat(cssVar('--fs-xs')), fsBase: Number.parseFloat(cssVar('--fs-base')),
  }
  const { nodes, edges } = graph.value
  if (!nodes.length) return {
    animation: !reducedMotion.value,
    title: { text: '没有卡之间的依赖关系，点「显示全部」看全部活跃卡', left: 'center', top: 'center',
      textStyle: { color: theme.text2, fontSize: theme.fsBase, width: Math.max(0, (el.value?.clientWidth ?? 0) - 40), overflow: 'break' } },
  }
  const positions = layeredLayout(nodes, edges, { width: el.value?.clientWidth ?? 0, height: el.value?.clientHeight ?? 0 })
  const opacity = (id: string) => !focusId.value || highlighted.value.has(id) ? 1 : 0.25
  return {
    animation: !reducedMotion.value,
    tooltip: {
      transitionDuration: reducedMotion.value ? 0 : 0.4,
      renderMode: 'richText', backgroundColor: theme.surface, borderColor: theme.lineStrong, textStyle: { color: theme.text },
      formatter: (p: { dataType?: string; name?: string; value?: string }) => p.dataType === 'node' ? `${p.name}\n${p.value ?? ''}` : '',
    },
    series: [{
      type: 'graph', layout: 'none', roam: true, draggable: true,
      edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 9,
      lineStyle: { color: theme.lineStrong, curveness: 0.12 },
      emphasis: { focus: 'adjacency' },
      data: nodes.map(task => ({
        name: task.id, value: humanTitle(task), ...positions.get(task.id), symbolSize: 34,
        itemStyle: { color: toneColor(task.status), opacity: opacity(task.id),
          borderColor: theme.info, borderWidth: task.id === focusId.value ? 3 : 0 },
        label: { show: true, color: theme.text, fontSize: theme.fsXs, opacity: opacity(task.id), textBorderColor: theme.surface, textBorderWidth: 3 },
      })),
      links: edges.map(edge => ({
        source: edge.source, target: edge.target,
        ...(edge.kind === 'related' ? { symbol: ['none', 'none'] } : {}),
        lineStyle: {
          color: edge.kind === 'dependsOn' ? theme.info : edge.kind === 'blockedBy' ? theme.bad : theme.text3,
          type: edge.kind === 'dependsOn' ? 'solid' : edge.kind === 'blockedBy' ? 'dashed' : 'dotted',
          width: edge.kind === 'dependsOn' ? 2 : edge.kind === 'blockedBy' ? 2.5 : 1.5,
          curveness: edge.kind === 'related' ? 0.2 : 0.12,
          opacity: Math.min(opacity(edge.source), opacity(edge.target)),
        },
      })),
    }],
  }
}

let layoutObserver: ResizeObserver | null = null
const { el, update } = useEchart(buildOption, chart => {
  chart.on('click', (p: unknown) => {
    const q = p as { dataType?: string; name?: string }
    if (q.dataType === 'node' && q.name) store.openTask(q.name, pid.value)
  })
  // 通用入口只 resize 图表；固定布局还要按容器的新宽高重新生成坐标。
  layoutObserver = new ResizeObserver(() => { chart.resize(); update() })
  if (el.value) layoutObserver.observe(el.value)
})
onBeforeUnmount(() => layoutObserver?.disconnect())
watch([graph, focusId, reducedMotion], update, { deep: true })
</script>

<template>
  <div class="dependency-page">
    <div class="head">
      <h2><Icon name="network" class="head-ic" :size="20" />依赖关系图</h2>
      <span class="pill" v-if="store.currentBoard">{{ store.currentBoard.project.name }}</span>
      <input v-model="query" type="search" class="field graph-search" placeholder="搜索卡号 / 人话标题" aria-label="搜索卡号或人话标题">
      <button class="done-toggle" :class="{ on: showAll }" type="button" :aria-pressed="showAll" @click="showAll = !showAll">显示全部</button>
      <span class="muted small">蓝实线=依赖 · 红虚线=阻塞 · 灰点线=关联；点节点开任务，可拖拽/缩放</span>
    </div>
    <p v-if="query.trim()" class="focus-status muted small" role="status">
      <template v-if="focusId">匹配 {{ matches.length }} 张，聚焦 {{ focusId }} 及一跳邻居；其余淡化。</template>
      <template v-else>当前范围没有匹配的卡，可清空搜索或点「显示全部」。</template>
    </p>
    <div class="chart card" ref="el" />
  </div>
</template>

<style scoped>
.dependency-page { display: flex; flex-direction: column; height: 100%; min-width: 0; }
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s3); flex-wrap: wrap; }
.small { font-size: var(--fs-sm); }
.graph-search { width: 240px; max-width: 100%; }
.focus-status { margin: 0 0 var(--s3); }
.done-toggle { display: inline-flex; align-items: center; gap: var(--s1); padding: var(--s1) var(--s2); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); color: var(--text-2); cursor: pointer; font-size: var(--fs-sm); user-select: none; }
.done-toggle:hover { border-color: var(--line-strong); color: var(--text); }
.done-toggle.on { border-color: var(--ok); background: var(--ok-bg); color: var(--ok); }
.chart { flex: 1; min-height: 460px; }
</style>
