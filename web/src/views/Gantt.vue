<script setup lang="ts">
// AI 开发用「施工波次甘特」：横轴=波次(0/1/2/3)，纵轴=任务，进度块=percent 长度+状态色，箭头=依赖。
// 传统按日甘特对 AI 开发无用（一个任务可能几小时就完工），这里改用「进度感」而不是「时间感」。
import { computed, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import { statusColor } from '@/api/schema'
import { useEchart } from '@/charts/useEcharts'
import type { Task } from '@/types'

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')
const tasks = computed<Task[]>(() => store.currentBoard?.tasks ?? [])

function buildOption() {
  const list = tasks.value
  if (!list.length) return { title: { text: '无任务', left: 'center', top: 'center', textStyle: { color: '#8b98a9', fontSize: 13 } } }

  // 按波次分组，波次内按 id 排序
  const byWave = new Map<number, Task[]>()
  for (const t of list) {
    const w = typeof t.wave === 'number' ? t.wave : 0
    if (!byWave.has(w)) byWave.set(w, [])
    byWave.get(w)!.push(t)
  }
  const waves = [...byWave.keys()].sort((a, b) => a - b)
  const ordered: Task[] = []
  for (const w of waves) ordered.push(...byWave.get(w)!.sort((a, b) => a.id.localeCompare(b.id)))
  const cats = ordered.map((t) => t.id)
  const idIdx = new Map(ordered.map((t, i) => [t.id, i]))

  // 每条=进度块：横向长度=percent(0..100)，颜色=状态
  const barData = ordered.map((t) => ({
    value: [t.wave ?? 0, t.id, t.percent ?? 0, t.title, t.status],
    itemStyle: { color: statusColor(t.status), opacity: t.percent === 0 ? 0.35 : 1 },
  }))

  // 波次分隔线（垂直虚线）+ 波次标签
  const waveMarks = waves.map((w) => ({
    xAxis: w + 0.5,
    lineStyle: { color: '#2a3341', type: 'dashed' as const },
    label: { show: false },
  }))
  const waveTitles = waves.map((w) => ({
    x: 90 + (w - waves[0]) * 200,
    y: 22,
    style: { text: `第 ${w} 波 · ${byWave.get(w)!.length} 任务`, fill: '#7a8a9c', fontSize: 12 },
  }))

  // 依赖箭头：dependsOn 和 blockedBy 都画
  const arrows: { type: string; shape: object; style: object; z: number }[] = []
  for (const t of ordered) {
    const to = idIdx.get(t.id); if (to === undefined) continue
    const ttWave = t.wave ?? 0
    for (const src of t.deps?.dependsOn ?? []) {
      const from = idIdx.get(src); if (from === undefined) continue
      const s = ordered[from]; const sWave = s.wave ?? 0
      // 只画跨波次或跨相近任务的箭头（避免视觉混乱）
      arrows.push({
        type: 'line',
        shape: {},
        style: { stroke: '#4c8ce0', lineWidth: 1.4, opacity: 0.55 },
        z: 2,
      })
      // 具体坐标由 graphic 转换器算，这里塞入 meta 给 setOption
      Object.assign(arrows[arrows.length - 1], {
        _from: [sWave + 0.5, from],
        _to: [ttWave, to],
        _kind: 'depend',
      })
    }
  }

  return {
    grid: { left: 68, right: 24, top: 42, bottom: 32 },
    tooltip: {
      backgroundColor: '#1a2029', borderColor: '#2a3341', textStyle: { color: '#e6edf3' },
      formatter: (p: { data?: { value?: unknown[] } }) => {
        const v = p.data?.value as (string | number)[] | undefined
        if (!v) return ''
        return `<b>${v[1]}</b> ${v[3]}<br/>第 ${v[0]} 波 · ${v[4]} · 进度 ${v[2]}%`
      },
    },
    xAxis: {
      type: 'value',
      min: waves[0] - 0.5, max: waves[waves.length - 1] + 0.5,
      interval: 1,
      axisLabel: { color: '#8b98a9', formatter: (v: number) => Number.isInteger(v) ? `第${v}波` : '' },
      splitLine: { show: false },
      axisLine: { lineStyle: { color: '#2a3341' } },
    },
    yAxis: {
      type: 'category', inverse: true, data: cats,
      axisLabel: { color: '#8b98a9', fontSize: 11 },
      axisLine: { lineStyle: { color: '#2a3341' } },
      splitLine: { show: true, lineStyle: { color: '#1a2029' } },
    },
    // 用 custom series 画进度块：宽度按 percent(0-100 映射到 波次宽度 0.9)
    series: [{
      type: 'custom',
      data: barData,
      renderItem: (_: unknown, api: {
        value: (i: number) => number | string;
        coord: (p: (number | string)[]) => number[];
        size: (p: (number | string)[]) => number[];
        style: () => object;
      }) => {
        const wave = api.value(0) as number
        const pct = (api.value(2) as number) / 100
        const startX = api.coord([wave - 0.45, api.value(1)])
        const endX = api.coord([wave - 0.45 + 0.9 * pct, api.value(1)])
        const bgEndX = api.coord([wave - 0.45 + 0.9, api.value(1)])
        const height = 14
        return {
          type: 'group',
          children: [
            // 底色轨道（波次宽度全长）
            {
              type: 'rect',
              shape: { x: startX[0], y: startX[1] - height / 2, width: bgEndX[0] - startX[0], height, r: 3 },
              style: { fill: '#1a2029', stroke: '#2a3341', lineWidth: 0.5 },
            },
            // 进度块
            {
              type: 'rect',
              shape: { x: startX[0], y: startX[1] - height / 2, width: Math.max(endX[0] - startX[0], 2), height, r: 3 },
              style: api.style(),
            },
            // 百分比文字（≥10% 才显示，避免拥挤）
            pct >= 0.1 ? {
              type: 'text',
              style: {
                text: `${Math.round(pct * 100)}%`,
                x: endX[0] - 4, y: startX[1],
                textAlign: 'right', textVerticalAlign: 'middle',
                fill: '#e6edf3', fontSize: 10, fontWeight: 500,
              },
            } : { type: 'text', style: { text: '' } },
          ],
        }
      },
      encode: { x: 0, y: 1 },
    }],
    graphic: [
      ...waveTitles.map((t) => ({ type: 'text', ...t })),
    ],
    markLine: waveMarks.length ? {
      data: waveMarks,
      silent: true,
      symbol: ['none', 'none'],
      label: { show: false },
    } : undefined,
  }
}

const { el, update } = useEchart(buildOption, (chart) =>
  chart.on('click', (p: unknown) => {
    const q = p as { data?: { value?: unknown[] } }
    const v = q.data?.value as (string | number)[] | undefined
    if (v && typeof v[1] === 'string') store.openTask(v[1] as string, pid.value)
  }),
)
watch(() => store.currentBoard, update, { deep: true })
</script>

<template>
  <div class="wrap">
    <div class="head">
      <h2>📅 施工波次甘特</h2>
      <span class="pill" v-if="store.currentBoard">{{ store.currentBoard.project.name }}</span>
      <span class="muted small">横轴=施工波次 · 进度块长度=完成度 · 颜色=状态 · 点条打开任务</span>
    </div>
    <div class="chart card" ref="el" />
    <div class="legend">
      <span class="tip">💡 <b>为什么不按日期？</b> AI 开发一个任务可能几小时就完工，按日甘特意义不大。这里换成"波次+进度"，一眼看到"第几波在做、每个做到哪了、下一步该做谁"。</span>
    </div>
  </div>
</template>

<style scoped>
.wrap { display: flex; flex-direction: column; height: 100%; }
.head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.head h2 { font-size: 18px; }
.small { font-size: 12px; margin-left: auto; }
.chart { flex: 1; min-height: 480px; padding: 8px; }
.legend { margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.6; }
.tip { display: inline-block; padding: 8px 12px; background: var(--panel-2); border-left: 3px solid var(--accent); border-radius: var(--radius-sm); }
</style>
