<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { AuditionScreen } from '@/types/audition'
import { auditionFileUrl } from '@/api/audition'
import { createScreenReceiver } from '@/utils/audition/messages'

const props = defineProps<{ project: string; screen: AuditionScreen | null }>()
const emit = defineEmits<{ trigger: [scene: string]; gesture: [] }>()
const viewport = ref<HTMLElement | null>(null), frame = ref<HTMLIFrameElement | null>(null)
const width = ref(0), height = ref(0), ready = ref(false), failed = ref(false)
let observer: ResizeObserver | null = null, listening: Window | null = null
const src = computed(() => props.screen?.path ? auditionFileUrl(props.project, props.screen.path) : '')
const scale = computed(() => props.screen ? Math.max(0, Math.min(width.value / props.screen.width, height.value / props.screen.height)) : 0)
const style = computed(() => ({
  '--screen-width': `${props.screen?.width || 1920}px`, '--screen-height': `${props.screen?.height || 1080}px`,
  '--screen-scale': scale.value,
  '--scaled-width': `${(props.screen?.width || 1920) * scale.value}px`,
  '--scaled-height': `${(props.screen?.height || 1080) * scale.value}px`,
}))
const receiver = createScreenReceiver(scene => emit('trigger', scene), () => { ready.value = true })
function message(event: MessageEvent) { receiver.receive(event, frame.value?.contentWindow ?? null, location.origin) }
function gesture() { emit('gesture') }
function detach() {
  listening?.removeEventListener('pointerdown', gesture, true)
  listening?.removeEventListener('keydown', gesture, true)
  listening = null
}
function loaded() {
  detach()
  const content = frame.value?.contentWindow
  if (!content) return
  // 只监听手势，不改画面结构、样式或原有交互。
  try {
    const type = frame.value?.contentDocument?.contentType
    failed.value = type !== 'text/html'
    if (failed.value) return
    listening = content
    content.addEventListener('pointerdown', gesture, true)
    content.addEventListener('keydown', gesture, true)
    content.postMessage({ source: 'audition-desk', type: 'hello' }, location.origin)
  } catch { failed.value = true }
}
watch(src, () => { detach(); receiver.reset(); ready.value = false; failed.value = false })
onMounted(() => {
  window.addEventListener('message', message)
  observer = new ResizeObserver(entries => {
    const box = entries[0]?.contentRect
    if (box) { width.value = box.width; height.value = box.height }
  })
  if (viewport.value) observer.observe(viewport.value)
})
onUnmounted(() => { detach(); observer?.disconnect(); window.removeEventListener('message', message) })
</script>

<template>
  <section class="stage">
    <header><h2>舞台</h2><span>{{ screen?.title || '尚未选择画面' }}</span></header>
    <div ref="viewport" class="viewport">
      <p v-if="!src">这个场景还没有配好游戏画面。</p>
      <p v-else-if="failed" role="alert">游戏画面暂时无法读取，请检查清单里的画面文件。</p>
      <div v-show="src && !failed" class="scaled" :style="style">
        <iframe v-if="src" :key="src" ref="frame" :src="src" :title="screen?.title || '游戏试听画面'"
          sandbox="allow-scripts allow-same-origin" @load="loaded" @error="failed = true" />
      </div>
    </div>
    <footer>{{ ready ? '画面已连接，可以在画面上点着听。' : '可直接点画面里的按钮，也可用右侧场景列表试听。' }}</footer>
  </section>
</template>

<style scoped>
.stage { display: flex; flex-direction: column; min-width: 0; min-height: 420px; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-lg); }
header { display: flex; align-items: baseline; gap: var(--s3); padding: var(--s3); border-bottom: 1px solid var(--line); }
h2 { margin: 0; font-size: var(--fs-md); }
header span, footer, .viewport > p { color: var(--text-2); font-size: var(--fs-sm); }
.viewport { display: flex; flex: 1; align-items: center; justify-content: center; min-height: 320px; overflow: hidden; }
.scaled { position: relative; width: var(--scaled-width); height: var(--scaled-height); flex: none; }
iframe { position: absolute; top: 0; left: 0; width: var(--screen-width); height: var(--screen-height); border: 0; transform: scale(var(--screen-scale)); transform-origin: top left; }
footer { padding: var(--s2) var(--s3); border-top: 1px solid var(--line); }
</style>
