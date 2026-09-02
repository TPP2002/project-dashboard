<script setup lang="ts">
// AI 开发用「施工波次甘特」：横轴=波次(0/1/2/3)，纵轴=任务，进度块=percent 长度+状态色，箭头=依赖。
// 传统按日甘特对 AI 开发无用（一个任务可能几小时就完工），这里改用「进度感」而不是「时间感」。
import { computed, ref, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import { statusTone, DONE_STATUSES } from '@/api/schema'
import { cssVar, useEchart } from '@/charts/useEcharts'
import DoneToggle from '@/components/DoneToggle.vue'
import type { Task } from '@/types'

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')
const allTasks = computed<Task[]>(() => store.currentBoard?.tasks ?? [])
// 默认折叠已完工——只显示进行中/刚开工/待办,避免完工任务堆积看着累。
const showDone = ref(false)
const doneCount = computed(() => allTasks.value.filter((t) => DONE_STATUSES.has(t.status)).length)
const tasks = computed<Task[]>(() =>
  showDone.value ? allTasks.value : allTasks.value.filter((t) => !DONE_STATUSES.has(t.status)),
)

function toneColor(status: string): string {
  const tone = statusTone(status)
  return cssVar(tone === 'n' ? '--text-3' : `--${tone}`)
}

function chartTheme() {
  return {
    text: cssVar('--text'),
    text2: cssVar('--text-2'),
    text3: cssVar('--text-3'),
    line: cssVar('--line'),
    lineStrong: cssVar('--line-strong'),
    surface: cssVar('--surface'),
    surface3: cssVar('--surface-3'),
    onSeries: cssVar('--chart-on-series'),
    fsXs: Number.parseFloat(cssVar('--fs-xs')),
    fsSm: Number.parseFloat(cssVar('--fs-sm')),
    fsBase: Number.parseFloat(cssVar('--fs-base')),
  }
}

function buildOption() {
  const theme = chartTheme()
  const list = tasks.value
  if (!list.length) {
    const txt = allTasks.value.length && !showDone.value
      ? '当前没有进行中的任务（已完工的已折叠，点上方"显示已完工"查看）'
      : '无任务'
    return { title: { text: txt, left: 'center', top: 'center', textStyle: { color: theme.text2, fontSize: theme.fsBase } } }
  }

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
  const barData = ordered.map((t, index) => ({
    value: [t.wave ?? 0, index, t.percent ?? 0, t.id, t.title, t.status],
    itemStyle: { color: toneColor(t.status), opacity: t.percent === 0 ? 0.35 : 1 },
  }))

  // 波次分隔线（垂直虚线）+ 波次标签
  const waveMarks = waves.map((w) => ({
    xAxis: w + 0.5,
    lineStyle: { color: theme.lineStrong, type: 'dashed' as const },
    label: { show: false },
  }))
  const waveTitles = waves.map((w) => ({
    x: 200 + (w - waves[0]) * 200,
    y: 22,
    style: { text: `第 ${w} 波 · ${byWave.get(w)!.length} 任务`, fill: theme.text3, fontSize: theme.fsSm },
  }))

  // 依赖箭头不在甘特上画（有专门的「依赖」页；此处画线只会糊成一团）——体检 B4 清除了从未渲染的死代码

  return {
    grid: { left: 190, right: 24, top: 42, bottom: 32 },
    tooltip: {
      backgroundColor: theme.surface, borderColor: theme.lineStrong, textStyle: { color: theme.text },
      formatter: (p: { data?: { value?: unknown[] } }) => {
        const v = p.data?.value as (string | number)[] | undefined
        if (!v) return ''
        return `<b>${v[3]}</b> ${v[4]}<br/>第 ${v[0]} 波 · ${v[5]} · 进度 ${v[2]}%`
      },
    },
    xAxis: {
      type: 'value',
      min: waves[0] - 0.5, max: waves[waves.length - 1] + 0.5,
      interval: 1,
      axisLabel: { color: theme.text3, fontSize: theme.fsXs, formatter: (v: number) => Number.isInteger(v) ? `第${v}波` : '' },
      splitLine: { show: false },
      axisLine: { lineStyle: { color: theme.lineStrong } },
    },
    yAxis: {
      type: 'category', inverse: true, data: cats,
      axisLabel: { color: theme.text3, fontSize: theme.fsXs, width: 170, overflow: 'truncate' },
      axisLine: { lineStyle: { color: theme.lineStrong } },
      splitLine: { show: true, lineStyle: { color: theme.line } },
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
        const taskIndex = api.value(1) as number
        const startX = api.coord([wave - 0.45, taskIndex])
        const endX = api.coord([wave - 0.45 + 0.9 * pct, taskIndex])
        const bgEndX = api.coord([wave - 0.45 + 0.9, taskIndex])
        const height = 14
        return {
          type: 'group',
          children: [
            // 底色轨道（波次宽度全长）
            {
              type: 'rect',
              shape: { x: startX[0], y: startX[1] - height / 2, width: bgEndX[0] - startX[0], height, r: 3 },
              style: { fill: theme.surface3, stroke: theme.lineStrong, lineWidth: 0.5 },
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
                fill: theme.onSeries, fontSize: theme.fsXs, fontWeight: 500,
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
    if (v && typeof v[3] === 'string') store.openTask(v[3] as string, pid.value)
  }),
)
watch(() => store.currentBoard, update, { deep: true })
watch(showDone, update)
</script>

<template>
  <div class="gantt-page">
    <div class="head">
      <h2>📅 施工波次甘特</h2>
      <span class="pill" v-if="store.currentBoard">{{ store.currentBoard.project.name }}</span>
      <DoneToggle v-model="showDone" :count="doneCount" />
      <span class="muted small">横轴=施工波次 · 进度块长度=完成度 · 颜色=状态 · 点条打开任务</span>
    </div>
    <div class="chart card" ref="el" />
    <div class="legend">
      <span class="tip">💡 <b>为什么不按日期？</b> AI 开发一个任务可能几小时就完工，按日甘特意义不大。这里换成"波次+进度"，一眼看到"第几波在做、每个做到哪了、下一步该做谁"。<br/><b>已完工默认折叠</b>——只看进行中/刚开工,清爽;想回顾历史完工点上方"显示已完工"即可（不会丢，随时能调出来）。</span>
    </div>
  </div>
</template>

<style scoped>
.gantt-page { display: flex; flex-direction: column; height: 100%; min-width: 0; }
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s3); flex-wrap: wrap; }
.small { margin-left: auto; font-size: var(--fs-sm); }
.chart { flex: 1; min-height: 480px; padding: var(--s2); }
.legend { margin-top: var(--s3); color: var(--text-2); font-size: var(--fs-sm); line-height: 1.6; }
.tip { display: inline-block; padding: var(--s2) var(--s3); border-left: 3px solid var(--info); border-radius: var(--r); background: var(--surface-2); }
</style>
