<script setup lang="ts">
import { appearance, GLOW_SIZES, setAppearance, SPEEDS } from '@/utils/appearance'
import IconMotionSettings from './IconMotionSettings.vue'
import StatusTile from './StatusTile.vue'
</script>

<template>
  <h3 class="ac-h">流动速度</h3>
  <p class="ac-p">一个全局倍率，同时作用在全站流光和状态灯条上。
    状态灯条内部那四档快慢（急 / 常 / 慢 / 余烬）是状态语言，相对关系不会被打乱——整体一起变快或一起变慢而已。</p>
  <div class="ac-options">
    <button v-for="option in SPEEDS" :key="option.value" class="appearance-choice" type="button"
      :aria-pressed="appearance.speed === option.value" @click="setAppearance('speed', option.value)">{{ option.label }}</button>
  </div>

  <h3 class="ac-h">灯条粗细</h3>
  <p class="ac-p">卡片顶边、进度条、施工中竖条一起变。细档同时压暗一点，粗档提亮一点，免得粗了就显脏。</p>
  <div class="ac-options">
    <button v-for="option in GLOW_SIZES" :key="option.value" class="appearance-choice" type="button"
      :aria-pressed="appearance.glow === option.value" @click="setAppearance('glow', option.value)">{{ option.label }}</button>
  </div>

  <h3 class="ac-h">施工中的卡片</h3>
  <div class="ac-line">
    <div class="ac-text"><b id="appearance-breathe">左边那条竖光改成「呼吸」</b><span>不再上下流动，而是整条一明一暗地起伏；只影响卡片左侧竖条，状态瓦片不受影响</span></div>
    <label class="ac-switch"><input type="checkbox" aria-labelledby="appearance-breathe" :checked="appearance.breathe"
      @change="setAppearance('breathe', ($event.target as HTMLInputElement).checked)"><span class="ac-track" /></label>
  </div>
  <p class="ac-hint">流动像「有东西在跑」，呼吸像「有人在里面干活」。两种都不吵，看你喜欢哪种隐喻。</p>

  <div class="motion-section"><IconMotionSettings /></div>
  <p class="ac-hint">这一档今天就有，只是从下拉搬到了这里，规则一字未改。</p>

  <div class="ac-live">
    <div class="ac-live-title">当前效果</div>
    <div class="glow glow-top preview-top" />
    <div class="ac-demo-card">
      <span class="glow-edge" />
      <div class="ac-demo-id">AUD-FUN-PERSONALIZATION</div>
      <div class="ac-demo-title">外观设置只有主题和灯条配色，再加几样好玩又有用的</div>
      <div class="progress"><i class="preview-progress" /></div>
      <div class="ac-demo-foot"><StatusTile status="施工中" decorative />施工中 62%</div>
    </div>
    <div class="ac-demo-foot">
      <StatusTile status="待拍板" decorative /><span>待拍板（急）</span>
      <StatusTile status="施工中" decorative /><span>施工中（常）</span>
      <StatusTile status="已拍板" decorative /><span>已拍板（慢）</span>
      <StatusTile status="暂缓" decorative /><span>暂缓（余烬）</span>
    </div>
  </div>
</template>

<style scoped>
.motion-section { margin-top: var(--s5); padding-top: var(--s4); border-top: 1px solid var(--line); }
.preview-top { margin-bottom: var(--s3); }
.preview-progress { width: 62%; }
</style>
