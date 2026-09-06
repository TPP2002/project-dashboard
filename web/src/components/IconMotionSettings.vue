<script setup lang="ts">
// 图标动效三档：关 / 微 / 活泼。档位与降级规则都在 utils/iconMotion，这里只是它的开关面板。
import { computed } from 'vue'
import { MOTION_MODES, effectiveMotion, iconMotion, reducedMotion, setIconMotion } from '@/utils/iconMotion'

// 系统开了「减少动效」时按钮仍显示用户自己选的档，但下面明说此刻被强制静止了，免得以为设置坏了。
const forcedOff = computed(() => reducedMotion.value && iconMotion.value !== 'off')
const crowded = computed(() => !reducedMotion.value && iconMotion.value === 'lively' && effectiveMotion.value === 'calm')
</script>

<template>
  <div class="appearance-group">
    <div class="appearance-label">图标动效</div>
    <div class="motion-options">
      <button
        v-for="mode in MOTION_MODES"
        :key="mode.id"
        class="appearance-choice"
        type="button"
        :title="mode.hint"
        :aria-pressed="iconMotion === mode.id"
        @click="setIconMotion(mode.id)"
      >{{ mode.label }}</button>
    </div>
    <p class="motion-hint">关：全部静止 · 微：只有待拍板 / 施工中 / 暂缓 循环 · 活泼：全部循环（默认）。</p>
    <p v-if="forcedOff" class="motion-hint warned">系统开了「减少动效」，现在一律静止；关掉系统那个开关，这里的选择才会生效。</p>
    <p v-else-if="crowded" class="motion-hint warned">这一屏的状态瓦片太多，已临时降到「微」，滚动到瓦片少的地方会自动恢复。</p>
  </div>
</template>

<style scoped>
.motion-options { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s1); }
.motion-hint { margin: var(--s2) 0 0; color: var(--text-3); font-size: var(--fs-xs); line-height: 1.5; }
.motion-hint.warned { color: var(--warn); }
</style>
