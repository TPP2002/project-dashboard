<script setup lang="ts">
// 中心/聚合视图的「当前项目 / 全部项目」范围开关（共享 store.centerScopeAll）。
// 只有多项目时才显示——单项目下切换无意义。
import { computed } from 'vue'
import { useBoardStore } from '@/stores/board'

const store = useBoardStore()
const curName = computed(
  () => store.projectList.find((p) => p.id === store.currentProjectId)?.name ?? '当前项目',
)
</script>

<template>
  <div v-if="store.projectList.length > 1" class="scope" role="group" aria-label="项目范围">
    <button class="seg" type="button" :class="{ on: !store.centerScopeAll }" :aria-pressed="!store.centerScopeAll" @click="store.centerScopeAll = false">
      {{ curName }}
    </button>
    <button class="seg" type="button" :class="{ on: store.centerScopeAll }" :aria-pressed="store.centerScopeAll" @click="store.centerScopeAll = true">
      全部项目
    </button>
  </div>
</template>

<style scoped>
.scope { display: inline-flex; overflow: hidden; border: 1px solid var(--line); border-radius: var(--r); }
.seg { padding: var(--s1) var(--s3); border: 0; background: var(--surface-2); color: var(--text-2); cursor: pointer; font-size: var(--fs-sm); }
.seg + .seg { border-left: 1px solid var(--line); }
.seg:hover { color: var(--text); }
.seg.on { background: var(--info-bg); color: var(--info); font-weight: 600; }
</style>
