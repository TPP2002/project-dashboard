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
  <div v-if="store.projectList.length > 1" class="scope">
    <button class="seg" :class="{ on: !store.centerScopeAll }" @click="store.centerScopeAll = false">
      {{ curName }}
    </button>
    <button class="seg" :class="{ on: store.centerScopeAll }" @click="store.centerScopeAll = true">
      全部项目
    </button>
  </div>
</template>

<style scoped>
.scope { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.seg { background: var(--panel-2); color: var(--muted); border: none; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.seg + .seg { border-left: 1px solid var(--border); }
.seg:hover { color: var(--text); }
.seg.on { background: var(--accent-soft); color: var(--text); font-weight: 600; }
</style>
