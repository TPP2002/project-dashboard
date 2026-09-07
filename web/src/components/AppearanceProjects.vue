<script setup lang="ts">
import {
  appearance, PROJECT_COLORS, PROJECT_ICONS, PROJECT_RINGS, setAppearance,
  type ProjectColorId, type ProjectIconId,
} from '@/utils/appearance'
import Icon from './Icon.vue'

// 当前清单只保证 id/name；以后返回项目默认色/图标时，面板可直接显示，不能为此另加接口。
interface ProjectPresentation { id: string; name: string; color?: unknown; icon?: unknown }
defineProps<{ projects: ProjectPresentation[] }>()

function colorFor(project: ProjectPresentation): string {
  const override = appearance.projectColors[project.id]
  if (override) return `var(--project-${override})`
  if (typeof project.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(project.color)) return project.color
  // 只用于面板预览的稳定后备色：同一项目 id 在刷新、重排后保持同色。
  let hash = 0
  for (const char of project.id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0
  return `var(--project-${PROJECT_COLORS[hash % PROJECT_COLORS.length].id})`
}

function iconFor(project: ProjectPresentation): ProjectIconId {
  return appearance.projectIcons[project.id] ?? PROJECT_ICONS.find(icon => icon.id === project.icon)?.id ?? 'kanban'
}

function chooseColor(id: string, color: ProjectColorId) {
  setAppearance('projectColors', { ...appearance.projectColors, [id]: color })
}

function chooseIcon(id: string, event: Event) {
  const icon = (event.target as HTMLSelectElement).value as ProjectIconId
  setAppearance('projectIcons', { ...appearance.projectIcons, [id]: icon })
}

function restoreProject(id: string) {
  const colors = { ...appearance.projectColors }
  const icons = { ...appearance.projectIcons }
  delete colors[id]
  delete icons[id]
  setAppearance('projectColors', colors)
  setAppearance('projectIcons', icons)
}
</script>

<template>
  <h3 class="ac-h">每个项目一个颜色</h3>
  <p class="ac-p">同时开着好几个项目时，光看标题分不清哪张卡是哪个项目的。给每个项目一个颜色，
    项目下拉、卡片左边条、总览进度环都按它着色，扫一眼就知道。</p>
  <div class="ac-line">
    <div class="ac-text"><b id="appearance-project-color">按项目着色</b><span>关掉就回到今天：全部统一色</span></div>
    <label class="ac-switch"><input type="checkbox" aria-labelledby="appearance-project-color" :checked="appearance.projectColor"
      @change="setAppearance('projectColor', ($event.target as HTMLInputElement).checked)"><span class="ac-track" /></label>
  </div>
  <div class="project-list">
    <div v-for="project in projects" :key="project.id" class="project-row" :style="{ '--proj': colorFor(project) }">
      <span class="project-chip">
        <Icon v-if="appearance.projectMark === 'icon'" :name="iconFor(project)" :size="16" />
        <span v-else>{{ Array.from(project.name || project.id)[0] }}</span>
      </span>
      <div class="project-text">
        <b>{{ project.name }}</b><span class="mono">{{ project.id }}</span>
        <button v-if="appearance.projectColors[project.id] || appearance.projectIcons[project.id]"
          class="btn btn-sm quiet override" type="button" :aria-label="`还原${project.name}的本机覆盖`" @click="restoreProject(project.id)">本机覆盖</button>
      </div>
      <div class="project-controls">
        <div class="project-swatches">
          <button v-for="color in PROJECT_COLORS" :key="color.id" class="project-swatch" type="button"
            :style="{ background: `var(--project-${color.id})` }" :title="color.label" :aria-label="`${project.name}：${color.label}`"
            :aria-pressed="colorFor(project) === `var(--project-${color.id})`" @click="chooseColor(project.id, color.id)" />
        </div>
        <select v-if="appearance.projectMark === 'icon'" class="field project-icon" :value="iconFor(project)"
          :aria-label="`${project.name}的图标`" @change="chooseIcon(project.id, $event)">
          <option v-for="icon in PROJECT_ICONS" :key="icon.id" :value="icon.id">{{ icon.label }}</option>
        </select>
      </div>
    </div>
    <p v-if="!projects.length" class="ac-hint">暂无项目。</p>
  </div>
  <p class="ac-hint">颜色可以写进 registry.json 跟着项目走（换台机器也一样），也可以只在这台机器上改；
    本地改过的项目会标一个「本机覆盖」，点一下就还原成 registry 里的。</p>

  <h3 class="ac-h">项目标记</h3>
  <p class="ac-p">颜色之外再给个形，色盲友好，也让截图里认得出。两种取法：从现有图标里挑一枚，或者直接用项目名首字。</p>
  <div class="ac-options two">
    <button class="appearance-choice" type="button" :aria-pressed="appearance.projectMark === 'icon'" @click="setAppearance('projectMark', 'icon')">用图标</button>
    <button class="appearance-choice" type="button" :aria-pressed="appearance.projectMark === 'letter'" @click="setAppearance('projectMark', 'letter')">用首字</button>
  </div>
  <p class="ac-hint">图标从看板现有的那套线性图标里挑（看板 / 图表 / 网络 / 日历…），不用 emoji。</p>

  <h3 class="ac-h">项目进度环</h3>
  <div class="ac-options">
    <button v-for="option in PROJECT_RINGS" :key="option.id" class="appearance-choice" type="button"
      :aria-pressed="appearance.projectRing === option.id" @click="setAppearance('projectRing', option.id)">{{ option.label }}</button>
  </div>
  <p class="ac-hint">默认环的底色用项目色，外圈保留跑马灯；也可以只用项目色，或保持原来的流光。</p>
  <p class="ac-hint">本页先保存本机设置，项目下拉、卡片和进度环的着色效果将在后续接入。</p>
</template>

<style scoped>
.project-list { display: grid; gap: var(--s2); margin-top: var(--s3); }
.project-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s3); padding: var(--s2) var(--s3); background: var(--surface-2); border: 1px solid var(--line); border-left: 3px solid var(--proj); border-radius: var(--r); }
.project-chip { display: grid; place-items: center; width: 26px; height: 26px; flex: none; border-radius: 7px; color: var(--proj); background: color-mix(in srgb, var(--proj) 18%, transparent); }
.project-text { flex: 1; min-width: 100px; display: grid; }
.project-text b { font-size: var(--fs-base); font-weight: 500; overflow-wrap: anywhere; }
.project-text > span { font-size: var(--fs-xs); color: var(--text-3); overflow-wrap: anywhere; }
.override { justify-self: start; padding: 0; }
.project-controls { display: grid; gap: var(--s2); }
.project-swatches { display: flex; gap: var(--s1); }
.project-swatch { width: 16px; height: 16px; padding: 0; border: 1px solid var(--line-strong); border-radius: 4px; cursor: pointer; }
.project-swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--surface-2), 0 0 0 3px var(--text); }
.project-icon { padding: var(--s1); font-size: var(--fs-xs); }
</style>
