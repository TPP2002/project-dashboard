<script setup lang="ts">
// 功能图标（B 双色）：线条 + 18% 浅填，颜色一律继承 currentColor，所以放到哪就跟哪的文字同色。
// path 数据在 icons/paths.ts（正本是 v3 定稿设计稿），本组件只负责「按名字取出来、按尺寸画出来」。
import { computed } from 'vue'
import { ICON_PATHS, type IconName } from '@/icons/paths'

const props = withDefaults(defineProps<{
  name: IconName
  /** 14 徽章内 / 16 常规行内 / 20 页头与侧栏 / 24 中号 / 36 空态大图 */
  size?: 14 | 16 | 20 | 24 | 36
  /** 空态大图才开：把图标里预留的动效钩子（收件箱盖子）点亮。 */
  animated?: boolean
  /** 顺时针旋转多少度。折叠箭头就靠它一枚图标转出上下左右四向，不必画四份。 */
  rotate?: 0 | 90 | 180 | 270
  /** 读屏用的名字；不给就当纯装饰，读屏直接跳过（图标旁边已有文字时用这种）。 */
  label?: string
}>(), { size: 16, animated: false, label: '', rotate: 0 })

// 浅填画在描边之下，所以 tint 在前、line 在后。
const markup = computed(() => {
  const def = ICON_PATHS[props.name]
  const body = def.tint + def.line
  return props.animated ? body.replace('class="lid"', 'class="lid lid-open"') : body
})
</script>

<template>
  <svg
    class="icon"
    :class="`s${size}`"
    :style="{ transform: `rotate(${rotate}deg)` }"
    viewBox="0 0 24 24"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
    v-html="markup"
  />
</template>

<style scoped>
.icon {
  display: inline-block;
  flex: none;
  overflow: visible;
  vertical-align: -.15em;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
  /* 折叠箭头靠 rotate 转向，转的时候给一点过渡，别硬跳。 */
  transition: transform .14s ease;
}
.s14 { width: 14px; height: 14px; }
.s16 { width: 16px; height: 16px; }
.s20 { width: 20px; height: 20px; }
.s24 { width: 24px; height: 24px; }
/* 大图标按比例收细描边，不然 36px 上看着比 16px 粗一圈。 */
.s36 { width: 36px; height: 36px; stroke-width: 1.5; }
/* 浅填：同一个 currentColor 压到 18%，深浅两套主题都不用另配颜色。 */
.icon :deep(.tint) { fill: currentColor; stroke: none; opacity: .18; }
</style>

<style>
/* 空态大图上的收件箱盖子：非 scoped，因为要作用到 v-html 塞进来的节点。
   前缀 .icon.s36 保证只有空态那一处会动，其余地方的同名图标依旧静止；
   [data-icon-motion] 由 utils/iconMotion 写在根节点上，「关」档与系统减少动效时这条不生效。 */
:root:not([data-icon-motion="off"]) .icon.s36 .lid-open {
  transform-box: fill-box;
  transform-origin: left bottom;
  animation: icon-lid 3s ease-in-out infinite;
}
@keyframes icon-lid {
  0%, 60%, 100% { transform: rotate(0); }
  75%, 85% { transform: rotate(-14deg); }
}
</style>
