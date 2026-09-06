<script lang="ts">
import { defineComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import ConnDot from './ConnDot.vue'
import Icon from './Icon.vue'
// 图标动效三档（关 / 微 / 活泼）也归外观面板管，和灯条配色并排。
import IconMotionSettings from './IconMotionSettings.vue'
// 灯条配色（全站 + 分部位）整块搬进 SpectrumSettings，它 import 时会自动还原上次的配色。
import SpectrumSettings from './SpectrumSettings.vue'

type ThemeChoice = 'light' | 'dark' | 'system'

const THEME_KEY = 'board-theme'
const THEMES: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key) }
  catch (_) { return null }
}

function writeStorage(key: string, value: string) {
  try { localStorage.setItem(key, value) }
  catch (_) { /* 禁用站点存储时仍可在当前页面切换。 */ }
}

function readTheme(): ThemeChoice {
  const value = readStorage(THEME_KEY)
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

function applyTheme(value: ThemeChoice, persist = true) {
  const root = document.documentElement
  if (value === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', value)
  if (persist) writeStorage(THEME_KEY, value)
}

// 模块一加载就先还原主题，再由 Vue 挂载界面，避免首屏使用错误主题。
if (typeof document !== 'undefined') applyTheme(readTheme())

export default defineComponent({
  components: { ConnDot, Icon, IconMotionSettings, SpectrumSettings },
  setup() {
    const store = useBoardStore()
    const appearanceOpen = ref(false)
    const appearanceRoot = ref<HTMLElement | null>(null)
    const theme = ref<ThemeChoice>(readTheme())

    function onProject(event: Event) {
      store.selectProject((event.target as HTMLSelectElement).value)
    }

    function chooseTheme(value: ThemeChoice) {
      theme.value = value
      applyTheme(value)
    }

    function onDocumentPointerDown(event: PointerEvent) {
      if (!appearanceRoot.value?.contains(event.target as Node)) appearanceOpen.value = false
    }

    function onDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') appearanceOpen.value = false
    }

    onMounted(() => {
      document.addEventListener('pointerdown', onDocumentPointerDown)
      document.addEventListener('keydown', onDocumentKeyDown)
    })
    onBeforeUnmount(() => {
      document.removeEventListener('pointerdown', onDocumentPointerDown)
      document.removeEventListener('keydown', onDocumentKeyDown)
    })

    return {
      store, appearanceOpen, appearanceRoot, theme, themes: THEMES,
      onProject, chooseTheme,
    }
  },
})
</script>

<template>
  <header class="topbar">
    <div class="brand"><Icon name="kanban" :size="20" /><b>项目看板</b></div>
    <div v-if="store.projectList.length" class="proj">
      <label class="sr-only" for="project-select">当前项目</label>
      <select id="project-select" :value="store.currentProjectId ?? ''" @change="onProject">
        <option v-for="project in store.projectList" :key="project.id" :value="project.id">{{ project.name }}</option>
      </select>
    </div>
    <span class="spacer" />
    <ConnDot :state="store.conn" />
    <button class="btn btn-sm quiet refresh" type="button" title="刷新全部" aria-label="刷新全部" @click="store.refresh()"><Icon name="refresh" :size="16" /></button>

    <div ref="appearanceRoot" class="appearance">
      <button
        class="btn btn-sm quiet appearance-trigger"
        type="button"
        aria-haspopup="dialog"
        :aria-expanded="appearanceOpen"
        aria-controls="appearance-panel"
        @click.stop="appearanceOpen = !appearanceOpen"
      >
        <Icon name="settings" :size="16" /><span>外观</span>
      </button>
      <section v-if="appearanceOpen" id="appearance-panel" class="appearance-panel" role="dialog" aria-label="外观设置">
        <div class="appearance-group">
          <div class="appearance-label">主题</div>
          <div class="theme-options">
            <button
              v-for="option in themes"
              :key="option.value"
              class="appearance-choice"
              type="button"
              :aria-pressed="theme === option.value"
              @click="chooseTheme(option.value)"
            >{{ option.label }}</button>
          </div>
        </div>
        <SpectrumSettings />
        <IconMotionSettings />
      </section>
    </div>

    <router-link
      to="/approvals"
      class="bell"
      :class="{ hot: store.pendingCount > 0 }"
      title="待拍板中心（全部项目）"
      aria-label="待拍板中心"
      @click="store.centerScopeAll = true"
    >
      <Icon name="bell" :size="20" />
      <span v-if="store.pendingCount" class="badge warn dot">{{ store.pendingCount }}</span>
    </router-link>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: 0 var(--s4);
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: var(--s2); color: var(--text); font-size: var(--fs-md); white-space: nowrap; }
.proj { min-width: 0; }
.proj select {
  max-width: 240px;
  padding: var(--s1) var(--s2);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface-2);
  color: var(--text);
  cursor: pointer;
  font-size: var(--fs-sm);
}
.refresh { padding-inline: var(--s2); }
.appearance { position: relative; }
.appearance-trigger { white-space: nowrap; }
.appearance-panel {
  position: absolute;
  z-index: 40;
  top: calc(100% + var(--s2));
  right: 0;
  width: min(320px, calc(100vw - var(--s4)));
  max-height: min(72vh, 560px);
  overflow-y: auto;
  padding: var(--s4);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow);
}
.theme-options { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s1); }
.appearance-choice {
  padding: var(--s1) var(--s2);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface-2);
  color: var(--text-2);
  cursor: pointer;
  font-size: var(--fs-sm);
  transition: background .14s ease, border-color .14s ease, color .14s ease;
}
.appearance-choice:hover,
.appearance-choice[aria-pressed="true"] { background: var(--surface-3); border-color: var(--line-strong); color: var(--text); }
.bell {
  position: relative;
  display: inline-flex;
  padding: var(--s1) var(--s2);
  border-radius: var(--r);
  color: var(--text);
}
.bell:hover { background: var(--surface-2); text-decoration: none; }
.bell.hot { color: var(--warn); }
.dot { position: absolute; top: calc(-1 * var(--s2)); right: calc(-1 * var(--s2)); min-width: var(--s4); padding: 0 var(--s1); text-align: center; }

@media (max-width: 700px) {
  .brand b, .appearance-trigger span:last-child { display: none; }
  .proj select { max-width: 140px; }
}
</style>
