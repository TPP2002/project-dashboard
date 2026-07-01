<script setup lang="ts">
// 单项目 Kanban：按 STATUS 泳道（只显示非空泳道），横向滚动。
import { computed } from 'vue'
import { useBoardStore } from '@/stores/board'
import * as derive from '@/utils/derive'
import { statusColor, emojiFor } from '@/api/schema'
import TaskCard from '@/components/TaskCard.vue'

const store = useBoardStore()
const board = computed(() => store.currentBoard)
const pid = computed(() => store.currentProjectId || '')
const columns = computed(() => derive.groupByStatus(board.value).filter((c) => c.tasks.length > 0))
const prog = computed(() => derive.progress(board.value))
</script>

<template>
  <div class="kanban">
    <div v-if="board" class="head">
      <h2>{{ board.project.name }}</h2>
      <span class="pill">{{ prog.done }}/{{ prog.total }} 完工 · {{ prog.percent }}%</span>
      <span class="spacer" />
    </div>

    <div v-if="!board && !store.loading" class="empty card">
      <div class="big">📋</div>
      <div>请选择一个项目。</div>
    </div>
    <div v-else-if="board && !columns.length" class="empty card">
      <div class="big">🗂️</div>
      <div>该项目还没有任务。</div>
    </div>

    <div v-else class="board">
      <div v-for="col in columns" :key="col.status" class="col">
        <div class="col-head" :style="{ borderTopColor: statusColor(col.status) }">
          <span>{{ emojiFor(col.status) }} {{ col.status }}</span>
          <span class="n">{{ col.tasks.length }}</span>
        </div>
        <div class="col-body">
          <TaskCard v-for="t in col.tasks" :key="t.id" :task="t" :project-id="pid" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kanban { display: flex; flex-direction: column; height: 100%; }
.head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.head h2 { font-size: 18px; }
.board { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 10px; align-items: flex-start; flex: 1; }
.col { flex: 0 0 244px; display: flex; flex-direction: column; gap: 8px; background: var(--bg-soft); border: 1px solid var(--border-soft); border-radius: var(--radius); padding: 8px; max-height: 100%; }
.col-head { display: flex; align-items: center; justify-content: space-between; font-size: 13px; font-weight: 600; padding: 4px 6px 8px; border-top: 2px solid var(--border); }
.col-head .n { background: var(--panel-2); color: var(--muted); border-radius: 999px; padding: 0 8px; font-size: 11px; }
.col-body { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
</style>
