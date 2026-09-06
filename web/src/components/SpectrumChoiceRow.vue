<script setup lang="ts">
// 一行「可覆盖的灯条配色」：名字 + 下拉 + 预览条 + （选了自定义才出现的）取色器。
// 分部位配色与状态灯条五档谱共用这一行，两边只是选项文案不同，避免同一段界面写两遍。
import { computed } from 'vue'
import Icon from './Icon.vue'
import {
  MAX_COLORS, MIN_COLORS,
  editableColors, spectrumRevision,
  type PartId, type PresetId, type SpectrumChoice, type TileSpecId,
} from '@/utils/spectrum'

/** 下拉里的一项。value 的约定：'' = 用默认、'active' = 跟随全站、预设 id、'custom' = 自定义。 */
interface ChoiceOption { value: string; label: string }

const props = defineProps<{
  target: PartId | TileSpecId
  label: string
  hint: string
  /** 该目标最终生效的 CSS 色站变量名，预览条读它。 */
  cssVar: string
  options: ChoiceOption[]
  /** 当前配色；null = 用默认（下拉里 value 为空的那一项）。 */
  choice: SpectrumChoice | null
}>()

const emit = defineEmits<{ (e: 'change', choice: SpectrumChoice | null): void }>()

const selected = computed(() => {
  if (!props.choice) return ''
  if (props.choice.kind === 'preset') return props.choice.preset
  return props.choice.kind === 'global' ? 'active' : 'custom'
})

const colors = computed(() => props.choice?.kind === 'custom' ? props.choice.colors : [])

/** 预览条读的是最终生效的色站变量，跟真灯条同一个数据源、同一套动画。 */
const previewStyle = computed(() => {
  void spectrumRevision.value // 配色一改就重算，别让预览停在旧色上
  return { backgroundImage: `linear-gradient(90deg, var(${props.cssVar}))` }
})

function onSelect(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (!value) return emit('change', null)
  if (value === 'active') return emit('change', { kind: 'global' })
  if (value === 'custom') {
    // 切到「自定义」时用此刻的实际颜色打底，用户在看得见的基础上改，不用从头挑。
    const seeded = editableColors(props.target)
    if (seeded.length >= MIN_COLORS) emit('change', { kind: 'custom', colors: seeded.slice(0, MAX_COLORS) })
    return
  }
  emit('change', { kind: 'preset', preset: value as PresetId })
}

function replaceColors(next: string[]) {
  emit('change', { kind: 'custom', colors: next })
}

function setColor(index: number, event: Event) {
  const next = colors.value.slice()
  if (!next.length) return
  next[index] = (event.target as HTMLInputElement).value
  replaceColors(next)
}

function addColor() {
  const next = colors.value.slice()
  if (next.length >= MAX_COLORS) return
  next.push(next[next.length - 1] ?? next[0])
  replaceColors(next)
}

function removeColor(index: number) {
  const next = colors.value.slice()
  if (next.length <= MIN_COLORS) return
  next.splice(index, 1)
  replaceColors(next)
}
</script>

<template>
  <div class="part">
    <div class="part-head">
      <span class="part-name" :title="hint">{{ label }}</span>
      <select class="part-select" :value="selected" :aria-label="`${label}的配色`" @change="onSelect">
        <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </div>
    <div class="strip-preview" :style="previewStyle" :title="hint" />

    <div v-if="selected === 'custom'" class="color-row">
      <span v-for="(color, index) in colors" :key="index" class="color-cell">
        <input
          class="color-input"
          type="color"
          :value="color"
          :aria-label="`${label}的第 ${index + 1} 个颜色`"
          @input="setColor(index, $event)"
        >
        <button
          v-if="colors.length > MIN_COLORS"
          class="color-drop"
          type="button"
          aria-label="删掉这个颜色"
          title="删掉这个颜色"
          @click="removeColor(index)"
        >
          <Icon name="x" :size="14" />
        </button>
      </span>
      <button
        v-if="colors.length < MAX_COLORS"
        class="color-add"
        type="button"
        title="再加一个颜色"
        aria-label="再加一个颜色"
        @click="addColor()"
      ><Icon name="plus" :size="14" /></button>
    </div>
  </div>
</template>

<style scoped>
.part-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); }
.part-name { color: var(--text-2); font-size: var(--fs-sm); }
.part-select {
  max-width: 132px;
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
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
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
</style>
