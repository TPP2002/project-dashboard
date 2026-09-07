<script setup lang="ts">
import { appearance, CONFETTI_COUNTS, setAppearance } from '@/utils/appearance'
import Icon from './Icon.vue'
</script>

<template>
  <h3 class="ac-h">完工彩带</h3>
  <p class="ac-p">某张卡完工的那一刻，卡片上撒 1.2 秒彩带。纯手画（canvas 逐帧绘制），不引任何库，撒完自己收摊。</p>
  <div class="ac-line">
    <div class="ac-text"><b id="appearance-confetti">完工时撒彩带</b><span>只在你正看着那张卡的时候撒；后台完工的卡不会补放</span></div>
    <label class="ac-switch"><input type="checkbox" aria-labelledby="appearance-confetti" :checked="appearance.confetti"
      @change="setAppearance('confetti', ($event.target as HTMLInputElement).checked)"><span class="ac-track" /></label>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b>浓度</b><span>少一点更克制，多一点更过瘾</span></div>
    <div class="ac-options count-options">
      <button v-for="option in CONFETTI_COUNTS" :key="option.value" class="appearance-choice" type="button"
        :aria-pressed="appearance.confettiCount === option.value" @click="setAppearance('confettiCount', option.value)">{{ option.label }}</button>
    </div>
  </div>
  <p class="ac-hint">彩带用的就是你选的那套灯条配色——选了极光就撒极光色，选了单色就撒灰白纸屑。</p>

  <h3 class="ac-h">连击火焰</h3>
  <p class="ac-p">「每日成果」页那个连续产出天数，连到 3 天以上时给它点上火。今天已经有一枚静止的火焰图标，这里让它烧起来。</p>
  <div class="ac-line">
    <div class="ac-text"><b id="appearance-streak-fire">连击 ≥3 天时火焰动起来</b><span>用现有的 flame 图标，不是 emoji；关掉就退回今天那枚静止图标</span></div>
    <label class="ac-switch"><input type="checkbox" aria-labelledby="appearance-streak-fire" :checked="appearance.streakFire"
      @change="setAppearance('streakFire', ($event.target as HTMLInputElement).checked)"><span class="ac-track" /></label>
  </div>
  <div class="ac-line">
    <div class="ac-text"><b id="appearance-streak-grace">断连宽限一天</b><span>中间空一天不算断，空两天才归零</span></div>
    <label class="ac-switch"><input type="checkbox" aria-labelledby="appearance-streak-grace" :checked="appearance.streakGrace"
      @change="setAppearance('streakGrace', ($event.target as HTMLInputElement).checked)"><span class="ac-track" /></label>
  </div>
  <p class="ac-hint">宽限的那一天也算进连击天数。</p>
  <p class="ac-hint">彩带、火焰动效与宽限规则将在后续接入；这里先保存你的设置。</p>

  <div class="ac-live">
    <div class="ac-live-title">试一下</div>
    <div class="ac-demo-card">
      <div class="ac-demo-id">AUD-UI-KANBAN-FLOW</div>
      <div class="ac-demo-title">看板看不出谁拖了多久；依赖图成毛线团</div>
      <div class="ac-demo-foot"><Icon name="checks" :size="16" />完工 · 刚刚</div>
    </div>
    <button class="btn preview-button" type="button" disabled title="彩带效果将在后续接入"><Icon name="sparkles" :size="16" />放一次彩带</button>
  </div>
</template>

<style scoped>
.count-options { width: 200px; }
.preview-button { margin-top: var(--s3); }
</style>
