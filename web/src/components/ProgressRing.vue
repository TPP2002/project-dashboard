<script setup lang="ts">
// 纯 SVG 进度环——Overview 首屏用，刻意不引 echarts（首屏零图表库）。
import { computed } from 'vue'
const props = withDefaults(
  defineProps<{ percent: number; size?: number; stroke?: number; color?: string; sub?: string }>(),
  { size: 92, stroke: 9, color: '#4c8dff', sub: '' },
)
const clamped = computed(() => Math.max(0, Math.min(100, props.percent || 0)))
const r = computed(() => (props.size - props.stroke) / 2)
const circ = computed(() => 2 * Math.PI * r.value)
const offset = computed(() => circ.value * (1 - clamped.value / 100))
const mid = computed(() => props.size / 2)
</script>

<template>
  <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`">
    <circle :cx="mid" :cy="mid" :r="r" :stroke-width="stroke" fill="none" stroke="var(--panel-2)" />
    <circle
      :cx="mid" :cy="mid" :r="r" :stroke-width="stroke" fill="none" :stroke="color"
      stroke-linecap="round" :stroke-dasharray="circ" :stroke-dashoffset="offset"
      :transform="`rotate(-90 ${mid} ${mid})`" class="arc"
    />
    <text :x="mid" :y="mid" text-anchor="middle" dominant-baseline="central" class="pct">
      {{ Math.round(clamped) }}%
    </text>
    <text v-if="sub" :x="mid" :y="mid + size * 0.2" text-anchor="middle" class="sub">{{ sub }}</text>
  </svg>
</template>

<style scoped>
.arc { transition: stroke-dashoffset 0.6s ease; }
.pct { fill: var(--text); font-size: 19px; font-weight: 700; }
.sub { fill: var(--muted); font-size: 10px; }
</style>
