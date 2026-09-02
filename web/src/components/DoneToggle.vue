<script setup lang="ts">
// 「已完工默认折叠 + 一键调出」开关——甘特/看板/波次/依赖图共用,统一交互与样式。
// v-model=是否显示已完工(默认外部传 false);count=被折叠的已完工数量,让用户知道没丢。
defineProps<{ count: number }>()
const model = defineModel<boolean>({ required: true })
</script>

<template>
  <label class="done-toggle" :class="{ on: model }">
    <input type="checkbox" v-model="model" />
    <span v-if="!model">🗂️ 显示已完工（{{ count }} 个已折叠）</span>
    <span v-else>✅ 已显示全部（{{ count }} 个已完工）· 点此收起</span>
  </label>
</template>

<style scoped>
.done-toggle { display: inline-flex; align-items: center; gap: var(--s1); padding: var(--s1) var(--s2); border: 1px solid var(--line); border-radius: var(--r); color: var(--text-2); cursor: pointer; font-size: var(--fs-sm); user-select: none; }
.done-toggle:hover { border-color: var(--line-strong); color: var(--text); }
.done-toggle.on { border-color: var(--ok); background: var(--ok-bg); color: var(--ok); }
.done-toggle input { margin: 0; cursor: pointer; }
</style>
