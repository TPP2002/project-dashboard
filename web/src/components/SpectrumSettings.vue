<script setup lang="ts">
// 灯条配色设置：外观面板里的「全站一套 + 分部位覆盖」两段式选色。
// 颜色本身不在这里写死——预设走 base.css 的色站变量，自定义色由取色器产生并交给 utils/spectrum 落地。
import { computed, ref } from 'vue'
import {
  MAX_COLORS, MIN_COLORS, PARTS, PRESETS,
  editableColors, setGlobal, setPart, spectrum, spectrumRevision,
  type PartId, type PresetId, type SpectrumChoice,
} from '@/utils/spectrum'

type Target = 'global' | PartId

const partsOpen = ref(false)

/** 分部位那几行的下拉：跟随全站 / 四套预设 / 自定义。全站那一行没有「跟随」。 */
const partOptions = computed(() => [
  { value: '', label: '跟随全站' },
  ...PRESETS.map(preset => ({ value: preset.id as string, label: preset.label })),
  { value: 'custom', label: '自定义…' },
])

function choiceOf(target: Target): SpectrumChoice | null {
  return target === 'global' ? spectrum.global : spectrum.parts[target] ?? null
}

function selectValue(target: Target): string {
  const choice = choiceOf(target)
  if (!choice) return ''
  return choice.kind === 'preset' ? choice.preset : 'custom'
}

function customColors(target: Target): string[] {
  const choice = choiceOf(target)
  return choice?.kind === 'custom' ? choice.colors : []
}

function commit(target: Target, choice: SpectrumChoice | null) {
  if (target === 'global') { if (choice) setGlobal(choice) }
  else setPart(target, choice)
}

/** 切到「自定义」时，用该部位此刻的实际颜色打底，用户在看得见的基础上改。 */
function seedColors(target: Target): string[] | null {
  const seeded = editableColors(target === 'global' ? null : target)
  return seeded.length >= MIN_COLORS ? seeded.slice(0, MAX_COLORS) : null
}

function chooseValue(target: Target, value: string) {
  if (!value) return commit(target, null)
  if (value === 'custom') {
    const seeded = seedColors(target)
    if (seeded) commit(target, { kind: 'custom', colors: seeded })
    return
  }
  commit(target, { kind: 'preset', preset: value as PresetId })
}

function onSelect(target: Target, event: Event) {
  chooseValue(target, (event.target as HTMLSelectElement).value)
}

function setColor(target: Target, index: number, event: Event) {
  const colors = customColors(target).slice()
  if (!colors.length) return
  colors[index] = (event.target as HTMLInputElement).value
  commit(target, { kind: 'custom', colors })
}

function addColor(target: Target) {
  const colors = customColors(target).slice()
  if (colors.length >= MAX_COLORS) return
  colors.push(colors[colors.length - 1] ?? colors[0])
  commit(target, { kind: 'custom', colors })
}

function removeColor(target: Target, index: number) {
  const colors = customColors(target).slice()
  if (colors.length <= MIN_COLORS) return
  colors.splice(index, 1)
  commit(target, { kind: 'custom', colors })
}

/** 预览条读的是该部位最终生效的色站变量，跟真灯条同一个数据源、同一套动画。 */
function previewStyle(target: Target) {
  void spectrumRevision.value // 配色一改就重算，别让预览停在旧色上
  const cssVar = target === 'global' ? '--spec-active' : `--spec-${target}`
  return { backgroundImage: `linear-gradient(90deg, var(${cssVar}))` }
}
</script>

<template>
  <div class="appearance-group">
    <div class="appearance-label">灯条配色 · 全站</div>
    <div class="spectrum-options">
      <button
        v-for="preset in PRESETS"
        :key="preset.id"
        class="spectrum-swatch"
        type="button"
        :data-spectrum-choice="preset.id"
        :aria-label="preset.label"
        :title="preset.label"
        :aria-pressed="selectValue('global') === preset.id"
        @click="chooseValue('global', preset.id)"
      />
      <button
        class="spectrum-swatch"
        type="button"
        :style="previewStyle('global')"
        aria-label="自定义配色"
        title="自定义：以当前配色为起点自己挑颜色"
        :aria-pressed="selectValue('global') === 'custom'"
        @click="chooseValue('global', 'custom')"
      >✎</button>
    </div>

    <div v-if="selectValue('global') === 'custom'" class="color-row">
      <span v-for="(color, index) in customColors('global')" :key="index" class="color-cell">
        <input
          class="color-input"
          type="color"
          :value="color"
          :aria-label="`第 ${index + 1} 个颜色`"
          @input="setColor('global', index, $event)"
        >
        <button
          v-if="customColors('global').length > MIN_COLORS"
          class="color-drop"
          type="button"
          aria-label="删掉这个颜色"
          title="删掉这个颜色"
          @click="removeColor('global', index)"
        >×</button>
      </span>
      <button
        v-if="customColors('global').length < MAX_COLORS"
        class="color-add"
        type="button"
        title="再加一个颜色"
        aria-label="再加一个颜色"
        @click="addColor('global')"
      >＋</button>
    </div>
  </div>

  <div class="appearance-group">
    <button
      class="parts-toggle"
      type="button"
      :aria-expanded="partsOpen"
      @click="partsOpen = !partsOpen"
    >
      <span>分部位单独配色</span>
      <span aria-hidden="true">{{ partsOpen ? '▴' : '▾' }}</span>
    </button>

    <div v-if="partsOpen" class="parts">
      <div v-for="part in PARTS" :key="part.id" class="part">
        <div class="part-head">
          <span class="part-name" :title="part.hint">{{ part.label }}</span>
          <select
            class="part-select"
            :value="selectValue(part.id)"
            :aria-label="`${part.label}的配色`"
            @change="onSelect(part.id, $event)"
          >
            <option v-for="option in partOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </div>
        <div class="strip-preview" :style="previewStyle(part.id)" :title="part.hint" />

        <div v-if="selectValue(part.id) === 'custom'" class="color-row">
          <span v-for="(color, index) in customColors(part.id)" :key="index" class="color-cell">
            <input
              class="color-input"
              type="color"
              :value="color"
              :aria-label="`${part.label}的第 ${index + 1} 个颜色`"
              @input="setColor(part.id, index, $event)"
            >
            <button
              v-if="customColors(part.id).length > MIN_COLORS"
              class="color-drop"
              type="button"
              aria-label="删掉这个颜色"
              title="删掉这个颜色"
              @click="removeColor(part.id, index)"
            >×</button>
          </span>
          <button
            v-if="customColors(part.id).length < MAX_COLORS"
            class="color-add"
            type="button"
            title="再加一个颜色"
            aria-label="再加一个颜色"
            @click="addColor(part.id)"
          >＋</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.spectrum-options { flex-wrap: wrap; }
.spectrum-swatch { color: var(--text); font-size: var(--fs-xs); line-height: 1; }

.color-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin-top: var(--s2); }
.color-cell { position: relative; display: inline-flex; }
.color-input {
  width: 34px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  cursor: pointer;
}
.color-drop {
  position: absolute;
  top: calc(-1 * var(--s1));
  right: calc(-1 * var(--s1));
  width: 14px;
  height: 14px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
}
.color-drop:hover { color: var(--bad); border-color: var(--bad); }
.color-add {
  width: 34px;
  height: 22px;
  padding: 0;
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text-2);
  cursor: pointer;
  font-size: var(--fs-xs);
}
.color-add:hover { color: var(--text); border-color: var(--text-3); }

.parts-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: var(--s1) 0;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  font-family: var(--mono);
  font-size: var(--fs-xs);
  letter-spacing: .12em;
  text-transform: uppercase;
}
.parts-toggle:hover { color: var(--text-2); }

.parts { display: grid; gap: var(--s3); margin-top: var(--s2); }
.part-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); }
.part-name { color: var(--text-2); font-size: var(--fs-sm); }
.part-select {
  max-width: 118px;
  padding: 2px var(--s1);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text);
  cursor: pointer;
  font-size: var(--fs-xs);
}
/* 预览条与真灯条同款：同一套 slide 动画、同样的 200% 铺法，所见即所得。 */
.strip-preview {
  height: 8px;
  margin-top: var(--s1);
  border-radius: 4px;
  background-size: 200% 100%;
  animation: slide 3.4s linear infinite;
}
</style>
