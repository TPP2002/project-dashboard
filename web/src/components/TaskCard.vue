<script setup lang="ts">
import type { Task } from '@/types'
import { useBoardStore } from '@/stores/board'
import { statusColor } from '@/api/schema'

const props = defineProps<{ task: Task; projectId: string }>()
const store = useBoardStore()
const pending = () => (props.task.decisions ?? []).filter((d) => d.answer == null).length
</script>

<template>
  <div
    class="tcard card"
    :class="{ pulsing: store.isPulsing(projectId, task.id) }"
    :style="{ borderLeft: '3px solid ' + statusColor(task.status) }"
    @click="store.openTask(task.id, projectId)"
  >
    <div class="row gap-2 head">
      <span class="tid mono">{{ task.id }}</span>
      <span class="spacer" />
      <span v-if="pending()" class="badge pend" :title="pending() + ' 条待拍板'">❓{{ pending() }}</span>
    </div>
    <div class="ttitle">{{ task.title }}</div>
    <div class="progress" v-if="(task.percent ?? 0) > 0">
      <i :style="{ width: (task.percent || 0) + '%' }" />
    </div>
    <div class="row gap-2 wrap meta" v-if="(task.gitBranch?.length || task.prNumbers?.length || task.wave)">
      <span v-for="b in task.gitBranch || []" :key="b" class="pill">🌿 {{ b }}</span>
      <span v-for="p in task.prNumbers || []" :key="p" class="pill">PR #{{ p }}</span>
      <span v-if="task.wave" class="pill">W{{ task.wave }}</span>
    </div>
  </div>
</template>

<style scoped>
.tcard { padding: 9px 11px; cursor: pointer; display: flex; flex-direction: column; gap: 7px; transition: transform 0.1s, border-color 0.15s; }
.tcard:hover { transform: translateY(-1px); border-color: var(--accent); }
.head { font-size: 12px; }
.tid { color: var(--muted); font-weight: 600; }
.ttitle { font-size: 13px; line-height: 1.35; }
.meta { margin-top: 1px; }
.pend { background: rgba(245, 166, 35, 0.16); color: var(--warn); border: 1px solid rgba(245, 166, 35, 0.4); }
</style>
