<script setup lang="ts">
// 灯条配色设置：外观面板里的「全站一套 + 分部位覆盖 + 状态灯条五档谱」三段式选色。
// 颜色本身不在这里写死——预设走 base.css 的色站变量，自定义色由取色器产生并交给 utils/spectrum 落地。
// 每一行的下拉 / 预览 / 取色器都由 SpectrumChoiceRow 画，这里只负责「有哪几行、选项是什么、改完存哪」。
import { computed, ref } from 'vue'
import {
  MAX_COLORS, MIN_COLORS, PARTS, PRESETS, TILE_SPECS,
  cssVarOf, editableColors, setGlobal, setPart, setTileSpec, spectrum, spectrumRevision,
  type PartId, type PresetId, type SpectrumChoice, type TileSpecId,
} from '@/utils/spectrum'
import Icon from './Icon.vue'
import SpectrumChoiceRow from './SpectrumChoiceRow.vue'

// compact 只展示下拉的八套常用配色；原有自定义和细调完整保留在大面板。
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })
const partsOpen = ref(false)
const tilesOpen = ref(false)

const presetOptions = PRESETS.map(preset => ({ value: preset.id as string, label: preset.label }))
const customOption = { value: 'custom', label: '自定义…' }
const followOption = { value: 'active', label: '跟随全站流光' }

/** 部位那几行：默认项的文案随部位而定，默认已经是「跟随全站」的就不再重复给这一项。 */
function partOptions(part: (typeof PARTS)[number]) {
  return [
    { value: '', label: part.defaultLabel },
    ...(part.defaultIsGlobal ? [] : [followOption]),
    ...presetOptions,
    customOption,
  ]
}

/** 状态谱那几行保留三种选择，语义色仍是默认。 */
const tileOptions = [
  { value: '', label: '按语义色（默认）' },
  followOption,
  customOption,
]

const globalSelected = computed(() => spectrum.global.kind === 'preset' ? spectrum.global.preset : 'custom')

/** 全站预览条：和分部位那几行一样读最终生效的色站变量。 */
const globalPreview = computed(() => {
  void spectrumRevision.value
  return { backgroundImage: `linear-gradient(90deg, var(${cssVarOf('global')}))` }
})

const globalColors = computed(() => spectrum.global.kind === 'custom' ? spectrum.global.colors : [])

function chooseGlobalPreset(preset: PresetId) {
  setGlobal({ kind: 'preset', preset })
}

function chooseGlobalCustom() {
  const seeded = editableColors('global')
  if (seeded.length >= MIN_COLORS) setGlobal({ kind: 'custom', colors: seeded.slice(0, MAX_COLORS) })
}

function setGlobalColor(index: number, event: Event) {
  const colors = globalColors.value.slice()
  if (!colors.length) return
  colors[index] = (event.target as HTMLInputElement).value
  setGlobal({ kind: 'custom', colors })
}

function addGlobalColor() {
  const colors = globalColors.value.slice()
  if (colors.length >= MAX_COLORS) return
  colors.push(colors[colors.length - 1] ?? colors[0])
  setGlobal({ kind: 'custom', colors })
}

function removeGlobalColor(index: number) {
  const colors = globalColors.value.slice()
  if (colors.length <= MIN_COLORS) return
  colors.splice(index, 1)
  setGlobal({ kind: 'custom', colors })
}

function onPartChange(part: PartId, choice: SpectrumChoice | null) {
  setPart(part, choice)
}

function onTileChange(spec: TileSpecId, choice: SpectrumChoice | null) {
  setTileSpec(spec, choice)
}
</script>

<template>
  <div class="appearance-group">
    <component :is="compact ? 'div' : 'h3'" :class="compact ? 'appearance-label' : 'ac-h'">灯条配色 · 全站</component>
    <p v-if="!compact" class="ac-p">前四套是现在就有的，后四套是新增的。鼠标放上去能看到它在真流动。</p>
    <div class="spectrum-options">
      <span v-for="preset in PRESETS" :key="preset.id" class="swatch-cell">
        <button
          class="spectrum-swatch"
          type="button"
          :data-spectrum-choice="preset.id"
          :aria-label="preset.label"
          :title="preset.label"
          :aria-pressed="globalSelected === preset.id"
          @click="chooseGlobalPreset(preset.id)"
        />
        <span>{{ preset.label }}</span>
      </span>
      <span v-if="!compact" class="swatch-cell">
        <button
          class="spectrum-swatch pencil"
          type="button"
          :style="globalPreview"
          aria-label="自定义配色"
          title="自定义：以当前配色为起点自己挑颜色"
          :aria-pressed="globalSelected === 'custom'"
          @click="chooseGlobalCustom()"
        ><Icon name="pencil" :size="14" /></button>
        <span>自定义</span>
      </span>
    </div>

    <div v-if="!compact && globalSelected === 'custom'" class="color-row">
      <span v-for="(color, index) in globalColors" :key="index" class="color-cell">
        <input
          class="color-input"
          type="color"
          :value="color"
          :aria-label="`第 ${index + 1} 个颜色`"
          @input="setGlobalColor(index, $event)"
        >
        <button
          v-if="globalColors.length > MIN_COLORS"
          class="color-drop"
          type="button"
          aria-label="删掉这个颜色"
          title="删掉这个颜色"
          @click="removeGlobalColor(index)"
        >
          <Icon name="x" :size="14" />
        </button>
      </span>
      <button
        v-if="globalColors.length < MAX_COLORS"
        class="color-add"
        type="button"
        title="再加一个颜色"
        aria-label="再加一个颜色"
        @click="addGlobalColor()"
      ><Icon name="plus" :size="14" /></button>
    </div>
    <p v-if="!compact" class="ac-hint">单色不是一个固定的灰——它直接借用当前主题的文字色与描边色，
      所以浅色下是浅灰、深色下是深灰，永远跟界面同一个调子。想彻底安静又不想关掉动效，选它。</p>
  </div>

  <h3 v-if="!compact" class="ac-h">细调</h3>
  <div v-if="!compact" class="appearance-group">
    <button class="parts-toggle" type="button" :aria-expanded="partsOpen" @click="partsOpen = !partsOpen">
      <span>分部位单独配色</span>
      <Icon name="chevron" :size="14" :rotate="partsOpen ? 180 : 0" class="toggle-mark" />
    </button>
    <p class="ac-hint">进度条 / 进度环 / 卡片顶边 / 施工中竖条 / 额度条，各自可以不跟全站</p>
    <div v-if="partsOpen" class="parts">
      <SpectrumChoiceRow
        v-for="part in PARTS"
        :key="part.id"
        :target="part.id"
        :label="part.label"
        :hint="part.hint"
        :css-var="cssVarOf(part.id)"
        :options="partOptions(part)"
        :choice="spectrum.parts[part.id] ?? null"
        @change="onPartChange(part.id, $event)"
      />
    </div>
  </div>

  <div v-if="!compact" class="appearance-group">
    <button class="parts-toggle" type="button" :aria-expanded="tilesOpen" @click="tilesOpen = !tilesOpen">
      <span>状态灯条配色</span>
      <Icon name="chevron" :size="14" :rotate="tilesOpen ? 180 : 0" class="toggle-mark" />
    </button>
    <p class="ac-hint">状态瓦片那圈光的五档语义色（蓝 / 琥珀 / 绿 / 余烬 / 灰）</p>
    <div v-if="tilesOpen" class="parts">
      <p class="tiles-hint">状态瓦片边框那圈流光，按「这事处在什么状态」分五档各走一条，默认就是语义色。</p>
      <SpectrumChoiceRow
        v-for="spec in TILE_SPECS"
        :key="spec.id"
        :target="spec.id"
        :label="spec.label"
        :hint="spec.hint"
        :css-var="cssVarOf(spec.id)"
        :options="tileOptions"
        :choice="spectrum.tiles[spec.id] ?? null"
        @change="onTileChange(spec.id, $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.spectrum-options { display: grid; grid-template-columns: repeat(4, 44px); gap: var(--s2) var(--s3); }
.swatch-cell { display: grid; gap: 3px; justify-items: start; color: var(--text-3); font-family: var(--mono); font-size: var(--fs-xs); }
.spectrum-swatch { color: var(--text); line-height: 1; }
.spectrum-swatch.pencil { display: grid; place-items: center; }

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
.toggle-mark { opacity: .7; }
.parts { display: grid; gap: var(--s3); margin-top: var(--s2); }
.tiles-hint { margin: 0; color: var(--text-3); font-size: var(--fs-xs); line-height: 1.5; }
</style>
