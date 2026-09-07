<script setup lang="ts">
import { appearance, DENSITIES, setAppearance, type AppearanceConfig } from '@/utils/appearance'

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

function setFontSize(event: Event) {
  setAppearance('fontSize', Number((event.target as HTMLInputElement).value) as AppearanceConfig['fontSize'])
}
</script>

<template>
  <div class="appearance-group">
    <component :is="compact ? 'div' : 'h3'" :class="compact ? 'appearance-label' : 'ac-h'">界面松紧</component>
    <p v-if="!compact" class="ac-p">紧凑档把所有间距按 3/4 收一遍，同一屏能多看四五张卡；字号不变，所以不会变得难认。</p>
    <div class="density-options">
      <button v-for="option in DENSITIES" :key="option.value" class="appearance-choice" type="button"
        :aria-pressed="appearance.density === option.value" @click="setAppearance('density', option.value)">
        {{ !compact && option.value === 1 ? '舒适（默认）' : option.label }}
      </button>
    </div>
  </div>
  <template v-if="!compact">
    <h3 id="appearance-font-size" class="ac-h">基础字号</h3>
    <p class="ac-p">拖动就改。其余字号（小字、标题、大数字）按同一比例跟着走，排版比例不会走样。</p>
    <div class="ac-range">
      <input type="range" min="13" max="16" step="1" :value="appearance.fontSize" aria-labelledby="appearance-font-size" @input="setFontSize">
      <output class="ac-value">{{ appearance.fontSize }} px</output>
    </div>
    <p class="ac-hint">13 是「一屏塞更多」，16 是「不眯眼」。默认 14，和今天一样。</p>

    <div class="ac-live">
      <div class="ac-live-title">当前效果</div>
      <div class="ac-demo-card">
        <span class="glow-edge" />
        <div class="ac-demo-id">AUD-PERF-BOARD-API-SLIM</div>
        <div class="ac-demo-title">一改卡就重拉六兆数据，卡多的项目越用越慢</div>
        <div class="progress"><i class="preview-progress" /></div>
        <div class="ac-demo-foot"><span class="badge info">施工中</span><span class="badge n">W0</span>35% · 下一步：分片接口</div>
      </div>
      <div class="ac-demo-card">
        <div class="ac-demo-id">AUD-OSS-READINESS</div>
        <div class="ac-demo-title">要开源了，还没有许可证、英文说明</div>
        <div class="ac-demo-foot"><span class="badge n">未开工</span>等排期</div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.density-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s1); max-width: 340px; }
.preview-progress { width: 35%; }
</style>
