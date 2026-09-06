<script setup lang="ts">
// 纯 SVG 进度环——Overview 首屏用，刻意不引 echarts（首屏零图表库）。
// 进度弧默认走灯条配色（--spec-ring）：颜色绕着圆环转圈，转满 360° 正好回到出发姿态，
// 所以循环天然无缝，不会出现「播到头再从头开始」的断点。传了 color 就当普通实色环用。
import { computed, onBeforeUnmount, ref, useId } from 'vue'
import { partColors, spectrumRevision } from '@/utils/spectrum'

const props = withDefaults(
  defineProps<{ percent: number; size?: number; stroke?: number; color?: string; sub?: string; spin?: number }>(),
  { size: 92, stroke: 9, color: '', sub: '', spin: 4.2 },
)
const clamped = computed(() => Math.max(0, Math.min(100, props.percent || 0)))
const r = computed(() => (props.size - props.stroke) / 2)
const circ = computed(() => 2 * Math.PI * r.value)
const offset = computed(() => circ.value * (1 - clamped.value / 100))
const mid = computed(() => props.size / 2)

// 同一页有多个环，渐变 id 必须各不相同，否则后挂载的会抢走前面的描边。
const gradientId = `ring-spec-${useId()}`

// 关掉动画偏好时不给 SMIL 动画——CSS 的 prefers-reduced-motion 规则管不到 SVG 动画元素。
const reduceMotion = ref(false)
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')
  const sync = (event: MediaQueryListEvent) => { reduceMotion.value = event.matches }
  reduceMotion.value = query.matches
  query.addEventListener('change', sync)
  onBeforeUnmount(() => query.removeEventListener('change', sync))
}

// 颜色从生效的色站变量回读，配色一改（spectrumRevision 变了）就重算。
const stops = computed(() => {
  void spectrumRevision.value
  const colors = partColors('ring')
  return colors.length >= 2 ? colors : []
})
const useGradient = computed(() => !props.color && stops.value.length > 0)
const arcStroke = computed(() => (useGradient.value ? `url(#${gradientId})` : props.color || 'var(--info)'))
</script>

<template>
  <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" role="img" :aria-label="`完成 ${Math.round(clamped)}%`">
    <defs v-if="useGradient">
      <linearGradient :id="gradientId" gradientUnits="userSpaceOnUse" :x1="0" :y1="mid" :x2="size" :y2="mid">
        <stop
          v-for="(color, index) in stops"
          :key="index"
          :offset="`${(index / (stops.length - 1)) * 100}%`"
          :stop-color="color"
        />
        <animateTransform
          v-if="!reduceMotion"
          attributeName="gradientTransform"
          type="rotate"
          :from="`0 ${mid} ${mid}`"
          :to="`360 ${mid} ${mid}`"
          :dur="`${spin}s`"
          repeatCount="indefinite"
        />
      </linearGradient>
    </defs>
    <circle :cx="mid" :cy="mid" :r="r" :stroke-width="stroke" fill="none" stroke="var(--surface-3)" />
    <circle
      :cx="mid" :cy="mid" :r="r" :stroke-width="stroke" fill="none" :stroke="arcStroke"
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
.pct { fill: var(--text); font-size: var(--fs-lg); font-weight: 700; }
.sub { fill: var(--text-2); font-size: var(--fs-xs); }
</style>
