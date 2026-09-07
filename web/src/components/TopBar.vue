<script lang="ts">
import { defineComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import ConnDot from './ConnDot.vue'
import Icon from './Icon.vue'
import { setTheme, theme, THEMES } from '@/utils/theme'
import IconMotionSettings from './IconMotionSettings.vue'
import SpectrumSettings from './SpectrumSettings.vue'
import AppearanceDensity from './AppearanceDensity.vue'
import AppearanceCenter from './AppearanceCenter.vue'

export default defineComponent({
  components: { ConnDot, Icon, IconMotionSettings, SpectrumSettings, AppearanceDensity, AppearanceCenter },
  setup() {
    const store = useBoardStore()
    const appearanceOpen = ref(false)
    const centerOpen = ref(false)
    const appearanceRoot = ref<HTMLElement | null>(null)

    function onProject(event: Event) {
      store.selectProject((event.target as HTMLSelectElement).value)
    }

    function openCenter() {
      appearanceOpen.value = false
      // 关闭下拉后把回焦点留在持久存在的入口上。
      appearanceRoot.value?.querySelector<HTMLButtonElement>('.appearance-trigger')?.focus()
      centerOpen.value = true
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
      store, appearanceOpen, appearanceRoot, centerOpen, theme, themes: THEMES,
      onProject, chooseTheme: setTheme, openCenter,
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
        <SpectrumSettings compact />
        <IconMotionSettings compact />
        <AppearanceDensity compact />
        <div class="appearance-group all-settings">
          <button class="btn quiet all-settings-trigger" type="button" @click="openCenter">
            <span><Icon name="settings" :size="14" />全部外观设置</span>
            <Icon name="chevron" :size="14" :rotate="270" />
          </button>
        </div>
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
    <AppearanceCenter :open="centerOpen" :projects="store.projectList" @close="centerOpen = false" />
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
.all-settings { border-top: 1px solid var(--line); padding-top: var(--s3); }
.all-settings-trigger { width: 100%; justify-content: space-between; }
.all-settings-trigger > span { display: inline-flex; align-items: center; gap: var(--s2); }
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
