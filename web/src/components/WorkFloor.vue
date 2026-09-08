<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Board } from '@/types'
import { useBoardStore } from '@/stores/board'
import { appearance } from '@/utils/appearance'
import { onBoardEvent } from '@/utils/boardEvents'
import { theme } from '@/utils/theme'
import { readStops, spectrumRevision } from '@/utils/spectrum'
import { projectColorCss } from '@/utils/projectPresentation'
import { createWorkfloor, type SoundCue, type SoundPlayer, type WorkfloorHandle, type WorkfloorOptions } from '@/workfloor'
import { deriveSceneState, mapBoardEvent } from '@/workfloor/bridge'
import { loadCollapsed, saveCollapsed } from '@/workfloor/presentation'
import { resolveDayNight } from '@/workfloor/daynight'
import Icon from './Icon.vue'

const props = defineProps<{ board: Board; projectId: string }>()
const store = useBoardStore()
const host = ref<SVGSVGElement | null>(null)
const stage = ref<HTMLDivElement | null>(null)
const panPx = ref(0)
const collapsed = ref(loadCollapsed())
const error = ref(false)
const hour = ref(new Date().getHours())
const dark = window.matchMedia('(prefers-color-scheme: dark)')
const systemDark = ref(dark.matches)
const enabled = computed(() => Boolean(props.projectId) && appearance.workfloor.world !== 'off')
const state = computed(() => deriveSceneState(props.board, props.projectId))
const worldName = computed(() => appearance.workfloor.world === 'mech' ? '机甲装配' : '发射场')
const action = ref('施工现场已就绪')
// glob 无匹配时生成空映射，构建不解析一个尚未存在的模块。
const soundModules = import.meta.glob<SoundPlayer>('../utils/sound.ts')
let disposed = false
async function playCue(cue: SoundCue) {
  if (disposed || !appearance.workfloor.soundLink || !appearance.sound) return
  const load = soundModules['../utils/sound.ts']
  if (!load) return
  const projectId = props.projectId, world = appearance.workfloor.world
  try {
    const player = await load()
    if (!disposed && projectId === props.projectId && world === appearance.workfloor.world
      && appearance.workfloor.soundLink && appearance.sound) await player.playSound(cue)
  } catch (_) { /* 可选声音加载或播放失败时保持静默，画面和看板继续工作。 */ }
}
const summary = computed(() => `${worldName.value} · ${state.value.queued.length} 项排队 · ${state.value.active.length} 项施工 · ${state.value.pending.length} 项待拍板 · ${state.value.blocked.length} 项暂缓 · ${state.value.done.length}/${state.value.total} 项完工 · ${state.value.percent}%`)
const aria = computed(() => `${props.board.project.name}，${summary.value}，${action.value}`)
const color = computed(() => {
  void spectrumRevision.value
  return projectColorCss(props.projectId) || readStops('--spec-active')[0] || 'var(--info)'
})
const options = computed<WorkfloorOptions>(() => ({
  state: state.value, world: appearance.workfloor.world === 'mech' ? 'mech' : 'launch',
  dayNight: resolveDayNight(appearance.workfloor.dayNight, theme.value === 'system' ? (systemDark.value ? 'dark' : 'light') : theme.value, hour.value),
  detail: appearance.workfloor.detail, height: appearance.workfloor.height, collapsed: collapsed.value,
  sound: appearance.workfloor.soundLink && appearance.sound ? cue => { void playCue(cue) } : undefined,
  onError(reason) { error.value = true; action.value = '场景加载失败'; console.error('施工现场加载失败', reason) },
}))
let handle: WorkfloorHandle | null = null
let unsubscribe: (() => void) | undefined
let clockTimer: number | undefined
const clockChanged = () => { hour.value = new Date().getHours() }
const themeChanged = () => { systemDark.value = dark.matches }
let stageObserver: ResizeObserver | undefined
let viewBoxObserver: MutationObserver | undefined

function updatePan() {
  if (collapsed.value || !stage.value || !host.value) return
  const { width, height } = stage.value.getBoundingClientRect()
  const parsedHeight = Number(host.value.getAttribute('viewBox')?.trim().split(/[\s,]+/)[3])
  const viewBoxHeight = Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : 520
  const renderedWidth = Math.min(width, height * 1400 / viewBoxHeight)
  // translateX 在 scale 左侧，位移单位是屏幕 CSS 像素，不再除以缩放倍率。
  panPx.value = Math.max(0, (renderedWidth * appearance.workfloor.zoom - width) / 2)
}

watch([stage, host, collapsed], () => {
  stageObserver?.disconnect()
  viewBoxObserver?.disconnect()
  if (collapsed.value || !stage.value || !host.value) return
  stageObserver ??= new ResizeObserver(updatePan)
  stageObserver.observe(stage.value)
  // 世界异步加载后才设置 viewBox；只跟随该属性，场景内容与逐帧动画不触发重算。
  viewBoxObserver ??= new MutationObserver(updatePan)
  viewBoxObserver.observe(host.value, { attributes: true, attributeFilter: ['viewBox'] })
  updatePan()
}, { flush: 'post' })
watch(() => [appearance.workfloor.zoom, appearance.workfloor.height], updatePan, { flush: 'post' })

function toggle() { collapsed.value = !collapsed.value; saveCollapsed(collapsed.value) }
watch(host, value => {
  handle?.destroy()
  handle = null
  if (value && enabled.value) {
    error.value = false
    handle = createWorkfloor(value, options.value)
  }
}, { flush: 'post' })
watch(options, next => { if (enabled.value) handle?.update(next) }, { flush: 'sync' })
watch(() => [props.projectId, appearance.workfloor.world], () => { action.value = '施工现场已就绪'; error.value = false })
watch(() => appearance.workfloor.dayNight, mode => {
  window.clearInterval(clockTimer)
  clockTimer = undefined
  if (mode === 'clock') {
    clockChanged()
    clockTimer = window.setInterval(clockChanged, 60000)
  }
}, { immediate: true })
onMounted(() => {
  dark.addEventListener('change', themeChanged)
  document.addEventListener('visibilitychange', clockChanged)
  unsubscribe = onBoardEvent(event => {
    if (!enabled.value || event.projectId !== props.projectId || !handle) return
    // store 在同步发事件之前已替换 board；直接读取 store 可避开父组件 props 的下一轮刷新。
    const current = store.currentProjectId === props.projectId ? store.currentBoard : props.board
    if (!current) return
    const snapshot = deriveSceneState(current, props.projectId)
    const mapped = mapBoardEvent(event, props.projectId, snapshot)
    if (!mapped) return
    // 完工先保留旧工位的动画对象；其它事件先取得其新分组与进度。
    if (mapped.kind === 'done') handle.handleEvent(mapped)
    handle.update({ ...options.value, state: snapshot })
    if (mapped.kind !== 'done') handle.handleEvent(mapped)
    const labels = { claim: '认领任务', progress: '更新进度', hold: '等待拍板', go: '已拍板继续施工', block: '任务阻塞', park: '任务暂缓', done: '任务完工', complete: '项目全部完工' }
    action.value = `${labels[mapped.kind]}${mapped.kind === 'progress' ? ` ${mapped.percent}%` : ''}`
  })
})
onBeforeUnmount(() => {
  disposed = true
  stageObserver?.disconnect()
  viewBoxObserver?.disconnect()
  unsubscribe?.()
  handle?.destroy()
  window.clearInterval(clockTimer)
  dark.removeEventListener('change', themeChanged)
  document.removeEventListener('visibilitychange', clockChanged)
})
</script>

<template>
  <section v-if="enabled" class="workfloor" :data-height="appearance.workfloor.height" :data-collapsed="collapsed"
    :style="{ '--wf-project': color }" aria-label="施工现场">
    <p v-if="collapsed" class="workfloor-summary">{{ summary }}</p>
    <div v-show="!collapsed" ref="stage" class="workfloor-stage" :data-camera="appearance.workfloor.camera"
      :style="{ '--wf-zoom': appearance.workfloor.zoom, '--wf-pan': panPx + 'px' }">
      <svg ref="host" class="workfloor-canvas" xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 1400 520" preserveAspectRatio="xMidYMid meet" role="img" :aria-label="aria" />
    </div>
    <p v-if="error" class="workfloor-error" role="status">施工现场暂时无法加载。</p>
    <button class="btn btn-sm quiet workfloor-toggle" type="button" :aria-expanded="!collapsed"
      :aria-label="collapsed ? '展开施工现场' : '折叠施工现场'" @click="toggle">
      <Icon name="chevron" :size="16" :rotate="collapsed ? 0 : 180" />
    </button>
  </section>
</template>

<style scoped>
.workfloor { position: relative; flex: none; width: 100%; min-width: 0; overflow: hidden; contain: content; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--wf-stage); }
.workfloor-stage { position: relative; width: 100%; aspect-ratio: 1400 / 520; max-height: min(32vh, 380px); overflow: hidden; }
.workfloor[data-height="compact"] .workfloor-stage { aspect-ratio: 1400 / 360; max-height: min(24vh, 280px); }
.workfloor-canvas { display: block; width: 100%; height: 100%; transform-origin: 50% 100%; transform: scale(var(--wf-zoom, 1)); }
.workfloor-stage[data-camera="pan"] .workfloor-canvas { animation: wf-pan 24s ease-in-out infinite alternate; }
@keyframes wf-pan {
  from { transform: translateX(var(--wf-pan)) scale(var(--wf-zoom, 1)); }
  to { transform: translateX(calc(-1 * var(--wf-pan))) scale(var(--wf-zoom, 1)); }
}
.workfloor[data-collapsed="true"] { height: 36px; background: var(--surface); }
.workfloor-summary { margin: 0; padding: 0 var(--s3); padding-right: var(--s7); line-height: 34px; font-size: var(--fs-sm); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workfloor-toggle { position: absolute; top: var(--s1); right: var(--s1); padding: var(--s1); color: var(--wf-text); background: var(--wf-floor); border-color: var(--wf-line); }
.workfloor[data-collapsed="true"] .workfloor-toggle { color: var(--text-2); background: var(--surface); border-color: var(--line); }
.workfloor-error { position: absolute; left: var(--s3); bottom: var(--s2); margin: 0; color: var(--wf-text); font-size: var(--fs-sm); }
@media (prefers-reduced-motion: reduce) {
  .workfloor :deep(*) { animation: none !important; transition: none !important; }
}
</style>
