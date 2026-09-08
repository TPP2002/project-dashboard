<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ProjectSummary } from '@/types'
import { resetAppearance } from '@/utils/appearance'
import { reducedMotion, setIconMotion } from '@/utils/iconMotion'
import { resetSpectrum } from '@/utils/spectrum'
import { setTheme, theme, THEMES } from '@/utils/theme'
import Icon from './Icon.vue'
import SpectrumSettings from './SpectrumSettings.vue'
import AppearanceGlow from './AppearanceGlow.vue'
import AppearanceDensity from './AppearanceDensity.vue'
import AppearanceCelebrate from './AppearanceCelebrate.vue'
import AppearanceProjects from './AppearanceProjects.vue'
import AppearanceSound from './AppearanceSound.vue'
import AppearanceWire from './AppearanceWire.vue'
import AppearanceWorkfloor from './AppearanceWorkfloor.vue'

const props = defineProps<{ open: boolean; projects: ProjectSummary[] }>()
const emit = defineEmits<{ close: [] }>()
const categories = [
  { id: 'color', label: '主题与配色' }, { id: 'glow', label: '灯条与动效' },
  { id: 'celebrate', label: '完工庆祝' }, { id: 'projects', label: '项目颜色' },
  { id: 'density', label: '密度与字号' }, { id: 'sound', label: '提示音与通知' },
  { id: 'wire', label: '灯带与推送' }, { id: 'workfloor', label: '施工现场' },
] as const
const active = ref<(typeof categories)[number]['id']>('color')
const panel = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null

function restoreAll() {
  resetAppearance()
  resetSpectrum()
  setTheme('system')
  setIconMotion('lively')
}

function selectCategory(event: KeyboardEvent, index: number) {
  let next = index
  if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = categories.length - 1
  else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % categories.length
  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + categories.length - 1) % categories.length
  else return
  event.preventDefault()
  active.value = categories[next].id
  document.getElementById(`appearance-tab-${active.value}`)?.focus()
}

function onKeydown(event: KeyboardEvent) {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  } else if (event.key === 'Tab' && panel.value) {
    const focusable = Array.from(panel.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
    )).filter(element => element.getClientRects().length > 0)
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) return
    if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement as HTMLElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement as HTMLElement))) {
      event.preventDefault()
      first.focus()
    }
  }
}

watch(() => props.open, async open => {
  if (open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    if (props.open) panel.value?.focus()
  } else {
    if (returnFocus?.isConnected) returnFocus.focus()
    returnFocus = null
  }
}, { immediate: true })

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (props.open && returnFocus?.isConnected) returnFocus.focus()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="settings-layer" @click.self="emit('close')">
      <section ref="panel" class="settings-panel appearance-center" role="dialog" aria-modal="true"
        aria-labelledby="appearance-center-title" tabindex="-1">
        <header class="settings-head">
          <div>
            <h2 id="appearance-center-title">外观中心</h2>
            <p>设置保存在这台机器的浏览器中，修改立即保存。</p>
            <p v-if="reducedMotion" class="motion-warning">系统开了「减少动效」，现在一律静止；设置保留但动效不生效。</p>
          </div>
          <button class="btn btn-sm quiet" type="button" aria-label="关闭外观中心" @click="emit('close')"><Icon name="x" :size="16" /></button>
        </header>
        <div class="appearance-layout">
          <nav class="ac-nav" aria-label="外观分类">
            <div class="appearance-label">外观</div>
            <div class="ac-tabs" role="tablist" aria-label="外观设置分类" aria-orientation="vertical">
              <button v-for="(category, index) in categories" :id="`appearance-tab-${category.id}`" :key="category.id"
                class="ac-tab" type="button" role="tab" :aria-selected="active === category.id"
                :aria-controls="`appearance-page-${category.id}`" :tabindex="active === category.id ? 0 : -1"
                @click="active = category.id" @keydown="selectCategory($event, index)">{{ category.label }}</button>
            </div>
          </nav>
          <div :id="`appearance-page-${active}`" :key="active" class="ac-body" role="tabpanel"
            :aria-labelledby="`appearance-tab-${active}`" tabindex="0">
            <template v-if="active === 'color'">
              <h3 class="ac-h">主题</h3>
              <div class="ac-options theme-options">
                <button v-for="option in THEMES" :key="option.value" class="appearance-choice" type="button"
                  :aria-pressed="theme === option.value" @click="setTheme(option.value)">{{ option.label }}</button>
              </div>
              <SpectrumSettings />
            </template>
            <AppearanceGlow v-else-if="active === 'glow'" />
            <AppearanceCelebrate v-else-if="active === 'celebrate'" />
            <AppearanceProjects v-else-if="active === 'projects'" :projects="projects" />
            <AppearanceDensity v-else-if="active === 'density'" />
            <AppearanceSound v-else-if="active === 'sound'" />
            <AppearanceWire v-else-if="active === 'wire'" />
            <AppearanceWorkfloor v-else-if="active === 'workfloor'" />
          </div>
        </div>
        <footer class="settings-actions">
          <button class="btn quiet" type="button" @click="restoreAll">全部恢复默认</button>
          <button class="btn primary" type="button" @click="emit('close')">完成</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-layer { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: var(--s4); background: color-mix(in srgb, var(--text) 18%, transparent); }
.settings-panel { display: flex; flex-direction: column; width: min(640px, calc(100vw - var(--s6))); max-height: calc(100vh - var(--s6)); overflow: hidden; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow); }
.settings-head { display: flex; align-items: flex-start; gap: var(--s3); padding: var(--s4) var(--s5); border-bottom: 1px solid var(--line); }
.settings-head > div { flex: 1; min-width: 0; }
.settings-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-sm); }
.settings-head .motion-warning { color: var(--warn); }
.appearance-layout { display: grid; grid-template-columns: 172px minmax(0, 1fr); height: 520px; min-height: 0; }
.ac-nav { padding: var(--s3); background: var(--surface-2); border-right: 1px solid var(--line); overflow-y: auto; }
.ac-tabs { display: flex; flex-direction: column; gap: 2px; }
.ac-tab { padding: var(--s2) var(--s3); border: 1px solid transparent; border-radius: var(--r); background: transparent; color: var(--text-2); cursor: pointer; font-size: var(--fs-base); text-align: left; transition: background .14s ease, color .14s ease; }
.ac-tab:hover { background: var(--surface-3); color: var(--text); }
.ac-tab[aria-selected="true"] { background: var(--surface); border-color: var(--line); color: var(--text); font-weight: 500; }
.ac-body { padding: var(--s5); min-width: 0; overflow-y: auto; }
.theme-options { margin-bottom: var(--s5); }
.settings-actions { display: flex; flex: none; justify-content: space-between; gap: var(--s2); padding: var(--s3) var(--s5); border-top: 1px solid var(--line); }
@media (max-width: 700px) {
  .settings-panel { width: calc(100vw - var(--s4)); max-height: calc(100vh - var(--s4)); }
  .settings-head, .settings-actions { padding: var(--s3) var(--s4); }
  .appearance-layout { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .ac-nav { border-right: 0; border-bottom: 1px solid var(--line); }
  .ac-tabs { flex-direction: row; flex-wrap: wrap; }
  .ac-tab { padding: var(--s1) var(--s2); font-size: var(--fs-sm); }
  .ac-body { padding: var(--s4); }
}
</style>
