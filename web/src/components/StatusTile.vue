<script setup lang="ts">
// 状态瓦片（D 灯条语言）：底色 + 记号 + 边框（静止细线 / 按语义色流动的灯条）。
// 一枚瓦片同时讲三件事——什么颜色（这事好不好）、什么记号（这事在干嘛）、边框动不动（这事推不推得动）。
// 记号与灯条参数在 icons/statusGlyphs.ts（正本是 v3 定稿设计稿），本组件只负责画和「什么时候该动」。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { statusMeta } from '@/api/schema'
import { effectiveMotion, trackVisibleTile } from '@/utils/iconMotion'

const props = withDefaults(defineProps<{
  status: string
  /** 14 = 退化成色点（徽章里挤不下瓦片）；16 行内 / 20 常规 / 26 泳道头与抽屉。 */
  size?: 14 | 16 | 20 | 26
  /** 旁边已经写着状态名时置 true，读屏就不会把同一个词念两遍。 */
  decorative?: boolean
}>(), { size: 20, decorative: false })

const meta = computed(() => statusMeta(props.status))

/** 这枚瓦片在「活泼」档下到底有没有东西会动。
 *  两种情况不动，也就不该占「同屏几个在动」的额度：
 *  ① 退化成色点的 14px（压根没画瓦片）；② 已作废（既无灯条也无记号动效）。
 *  算错这个的后果很实在：一屏色点会把真正在动的瓦片误降到「微」。 */
const animatable = computed(() => props.size !== 14 && (meta.value.spec || meta.value.mark.includes('class="a-')))

const root = ref<HTMLElement | null>(null)
const inView = ref(false)
let observer: IntersectionObserver | null = null

/** 真正播不播：先要进视口（列表滚过去的那几百个不该在后台空转），再看生效档位。 */
const playing = computed(() => {
  if (!inView.value || !animatable.value) return false
  const mode = effectiveMotion.value
  if (mode === 'off') return false
  return mode === 'calm' ? meta.value.calm : true
})

function setInView(next: boolean) {
  if (inView.value === next) return
  inView.value = next
  if (animatable.value) trackVisibleTile(next)
}

// 状态在原地变了（比如 SSE 推来 施工中 → 已完工），可动性可能跟着变，计数要同步跟上。
watch(animatable, (now, before) => {
  if (!inView.value || now === before) return
  trackVisibleTile(now)
})

onMounted(() => {
  if (!root.value || typeof IntersectionObserver === 'undefined') {
    setInView(true) // 拿不到观察器就当一直可见，宁可多动也不要一片死图。
    return
  }
  observer = new IntersectionObserver(entries => setInView(entries[0]?.isIntersecting === true))
  observer.observe(root.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (inView.value && animatable.value) trackVisibleTile(false)
})
</script>

<template>
  <span
    v-if="size === 14"
    ref="root"
    class="status-dot"
    :class="`tone-${meta.tone}`"
    :title="status"
    :role="decorative ? undefined : 'img'"
    :aria-label="decorative ? undefined : status"
    :aria-hidden="decorative ? 'true' : undefined"
  />
  <span
    v-else
    ref="root"
    class="status-tile"
    :class="[
      `tone-${meta.tone}`, `s${size}`, `st-${meta.key}`,
      { spec: meta.spec, fill: meta.fill, dim: meta.dim, playing, [`sp-${meta.speed}`]: meta.spec, rev: meta.reverse },
    ]"
    :title="status"
    :role="decorative ? undefined : 'img'"
    :aria-label="decorative ? undefined : status"
    :aria-hidden="decorative ? 'true' : undefined"
  >
    <i><svg viewBox="0 0 24 24" aria-hidden="true" v-html="meta.mark" /></i>
  </span>
</template>

<style scoped>
/* 14px 及以下画不清瓦片，退化成一个色点，靠旁边的文字说清是什么状态。 */
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--tone);
  vertical-align: -.05em;
}

.status-tile {
  position: relative;
  display: inline-grid;
  flex: none;
  place-items: center;
  /* 外层这一圈就是「边框」：静止时是 --line，走灯条时换成流动的渐变。 */
  background: var(--line);
  vertical-align: -.25em;
}
.status-tile > i {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  background: var(--tone-bg);
}
.status-tile svg {
  fill: none;
  overflow: visible;
  stroke: var(--tone);
  stroke-linecap: round;
  stroke-linejoin: round;
}
/* 已完工：整块填满，结论不需要再流动。 */
.status-tile.fill > i { background: var(--tone); }
.status-tile.fill svg { stroke: var(--bg); }
/* 已作废：压到半透明，一眼看出「不再算数」。 */
.status-tile.dim { opacity: .5; }

.s16 { width: 16px; height: 16px; padding: 1px; border-radius: 5px; }
.s16 > i { border-radius: 4px; }
.s16 svg { width: 11px; height: 11px; stroke-width: 2.4; }
.s20 { width: 20px; height: 20px; padding: 1.5px; border-radius: 6px; }
.s20 > i { border-radius: 4.5px; }
.s20 svg { width: 14px; height: 14px; stroke-width: 2.2; }
.s26 { width: 26px; height: 26px; padding: 1.75px; border-radius: 7px; }
.s26 > i { border-radius: 5.5px; }
.s26 svg { width: 18px; height: 18px; stroke-width: 2.2; }

.tone-n { --tone: var(--n); --tone-bg: var(--n-bg); --tone-spec: var(--spec-tile-n); }
.tone-info { --tone: var(--info); --tone-bg: var(--info-bg); --tone-spec: var(--spec-tile-info); }
.tone-warn { --tone: var(--warn); --tone-bg: var(--warn-bg); --tone-spec: var(--spec-tile-warn); }
.tone-ok { --tone: var(--ok); --tone-bg: var(--ok-bg); --tone-spec: var(--spec-tile-ok); }
.tone-bad { --tone: var(--bad); --tone-bg: var(--bad-bg); --tone-spec: var(--spec-tile-bad); }

/* 灯条：铺成两倍宽再推走整整一张图，和全站流光同一套无缝算法（keyframes slide 在 base.css）。
   四档速度对应「这事有多急」：待拍板最急、暂缓最慢。 */
.status-tile.spec.playing {
  background-image: linear-gradient(90deg, var(--tone-spec));
  background-size: 200% 100%;
  animation: slide 3.4s linear infinite;
}
.status-tile.spec.playing.sp-fast { animation-duration: 2.4s; }
.status-tile.spec.playing.sp-slow { animation-duration: 5s; }
.status-tile.spec.playing.sp-ember { animation-duration: 6.4s; }
/* 可复工：光倒着流，像把进度往回推给你接手。 */
.status-tile.spec.playing.rev { animation-direction: reverse; }
/* 灰谱平时不流（未开工 / 已作废本来就没人碰），只在鼠标停上去时走一圈，算个「还活着」的回应。 */
.status-tile.tone-n.playing:hover {
  background-image: linear-gradient(90deg, var(--tone-spec));
  background-size: 200% 100%;
  animation: slide 3.4s linear;
}
</style>

<style>
/* 记号动效：非 scoped，因为要作用到 v-html 塞进来的 SVG 子节点。
   全部挂在 .status-tile.playing 之下，选择器天然被本组件的根 class 圈住，不会外溢。
   只动 transform / opacity，配 transform-box: fill-box 让 SVG 片段绕自己的中心变换。 */
.status-tile.playing .a-ring,
.status-tile.playing .a-pulse,
.status-tile.playing .a-b1,
.status-tile.playing .a-b2,
.status-tile.playing .a-b3,
.status-tile.playing .a-spin,
.status-tile.playing .a-twinkle,
.status-tile.playing .a-wave { transform-box: fill-box; transform-origin: center; }

/* 未开工：虚线环极慢地转，闲置但没死。 */
.status-tile.playing .a-ring { animation: tile-ring 12s linear infinite; }
@keyframes tile-ring { to { transform: rotate(360deg); } }

/* 待开工：三点依次起伏，像排着队。 */
.status-tile.playing .a-dot1 { animation: tile-dots 1.6s ease-in-out infinite; }
.status-tile.playing .a-dot2 { animation: tile-dots 1.6s ease-in-out .2s infinite; }
.status-tile.playing .a-dot3 { animation: tile-dots 1.6s ease-in-out .4s infinite; }
@keyframes tile-dots {
  0%, 100% { opacity: .3; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-1.6px); }
}

/* 待拍板：问号呼吸，等你出手。 */
.status-tile.playing .a-pulse { animation: tile-pulse 2.4s ease-in-out infinite; }
@keyframes tile-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .45; transform: scale(.9); }
}

/* 已拍板 / 已完工：勾反复画一笔。 */
.status-tile.playing .a-draw { stroke-dasharray: 26; animation: tile-draw 3s ease-out infinite; }
@keyframes tile-draw {
  0% { stroke-dashoffset: 26; }
  40%, 100% { stroke-dashoffset: 0; }
}

/* 施工中：三根柱子错开着长，正在发生。 */
.status-tile.playing .a-b1,
.status-tile.playing .a-b2,
.status-tile.playing .a-b3 { transform-origin: bottom center; animation: tile-build 2.4s ease-in-out infinite; }
.status-tile.playing .a-b2 { animation-delay: .25s; }
.status-tile.playing .a-b3 { animation-delay: .5s; }
@keyframes tile-build {
  0%, 15% { transform: scaleY(.25); }
  55%, 75% { transform: scaleY(1); }
  100% { transform: scaleY(.25); }
}

/* 可复工：回旋箭头转一圈，可以接着做了。 */
.status-tile.playing .a-spin { animation: tile-spin 3.2s cubic-bezier(.45, 0, .2, 1) infinite; }
@keyframes tile-spin {
  0%, 15% { transform: rotate(0); }
  60%, 100% { transform: rotate(-360deg); }
}

/* 收官：旗子轻摆。 */
.status-tile.playing .a-wave { transform-origin: left center; animation: tile-wave 2.6s ease-in-out infinite; }
@keyframes tile-wave {
  0%, 100% { transform: skewY(0); }
  50% { transform: skewY(-7deg); }
}

/* 暂缓：暂停条慢呼吸——压着的火，不是灭了的火。 */
.status-tile.playing .a-breathe { animation: tile-breathe 4s ease-in-out infinite; }
@keyframes tile-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: .4; }
}

/* 压轴：星星闪一下，留到最后先别急。 */
.status-tile.playing .a-twinkle { animation: tile-twinkle 2.8s ease-in-out infinite; }
@keyframes tile-twinkle {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.2); opacity: .7; }
}
</style>
