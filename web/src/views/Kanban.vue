<script setup lang="ts">
// 单项目 Kanban：按 STATUS 泳道（只显示非空泳道），宽内容只在泳道容器内横向滚动。
import { computed, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import * as derive from '@/utils/derive'
import { emojiFor, DONE_STATUSES } from '@/api/schema'
import TaskCard from '@/components/TaskCard.vue'
import DoneToggle from '@/components/DoneToggle.vue'

const store = useBoardStore()
const board = computed(() => store.currentBoard)
const pid = computed(() => store.currentProjectId || '')
// 默认折叠"已完工"泳道,只显示活跃泳道;doneCount 供开关显示折叠数。
const showDone = ref(false)
const doneCount = computed(() => (board.value?.tasks ?? []).filter((task) => DONE_STATUSES.has(task.status)).length)
const columns = computed(() => derive.groupByStatus(board.value)
  .filter((column) => column.tasks.length > 0 && (showDone.value || !DONE_STATUSES.has(column.status)))
  // 完工泳道按完工日倒序（最新完工在最上面），找"最近干完的那张"不用翻全列（体检 U2）。
  .map((column) => DONE_STATUSES.has(column.status)
    ? { ...column, tasks: [...column.tasks].sort((left, right) => (right.dates?.done || '').localeCompare(left.dates?.done || '')) }
    : column))
const progress = computed(() => derive.progress(board.value))

function statusTone(status: string) {
  if (['已完工', '已拍板', '收官'].includes(status)) return 'ok'
  if (status === '待拍板') return 'warn'
  if (['施工中', '可复工', '待开工'].includes(status)) return 'info'
  if (status === '暂缓') return 'bad'
  return 'n'
}
</script>

<template>
  <div class="page">
    <header v-if="board" class="page-head">
      <div class="title-group">
        <h1>{{ board.project.name }}</h1>
        <p>按状态查看任务；已完工泳道默认收起，避免活跃工作被淹没。</p>
      </div>
      <div class="head-actions">
        <span class="badge info">{{ progress.done }}/{{ progress.total }} 完工</span>
        <span class="progress-value">{{ progress.percent }}%</span>
        <DoneToggle v-if="doneCount" v-model="showDone" :count="doneCount" />
      </div>
      <div class="glow-rail board-progress" role="progressbar" aria-label="项目完工进度" :aria-valuenow="progress.percent" aria-valuemin="0" aria-valuemax="100">
        <i :style="{ width: progress.percent + '%' }" />
      </div>
    </header>

    <div v-if="store.loading && !board" class="loading-board" aria-label="正在加载看板">
      <div v-for="index in 3" :key="index" class="card loading-column">
        <div class="skel medium" />
        <div class="skel task-skel" />
        <div class="skel task-skel" />
      </div>
    </div>

    <div v-else-if="!board" class="empty card">
      <span class="ic">📋</span>
      还没有可展示的项目<br>
      <span class="empty-help">在顶栏选择一个已注册项目后，这里会按状态生成泳道。</span>
    </div>
    <div v-else-if="!columns.length" class="empty card">
      <span class="ic">🗂️</span>
      该项目当前没有可见任务<br>
      <span class="empty-help">新增任务，或打开“显示已完工”后，对应状态泳道会出现在这里。</span>
    </div>

    <div v-else class="board-scroll" aria-label="任务状态泳道">
      <section v-for="column in columns" :key="column.status" class="column card">
        <header class="column-head">
          <span class="badge" :class="statusTone(column.status)">{{ emojiFor(column.status) }} {{ column.status }}</span>
          <span class="badge n count-badge">{{ column.tasks.length }}</span>
        </header>
        <div class="column-body stagger-list">
          <!-- TaskCard 属第 4 批，本批只提供规范化容器。 -->
          <TaskCard v-for="task in column.tasks" :key="task.id" :task="task" :project-id="pid" />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page { width: 100%; height: 100%; min-width: 0; display: flex; flex-direction: column; gap: var(--s4); overflow-x: hidden; }
.page-head { position: relative; display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: var(--s3); padding-bottom: var(--s3); }
.title-group p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-md); }
.head-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: var(--s2); }
.progress-value { font-family: var(--mono); font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
.board-progress { flex-basis: 100%; }
.loading-board { min-width: 0; display: grid; grid-template-columns: repeat(3, minmax(220px, 1fr)); gap: var(--s3); overflow: hidden; }
.loading-column { display: flex; flex-direction: column; gap: var(--s3); padding: var(--s4); }
.skel.medium { width: 48%; }
.skel.task-skel { height: 92px; }
.empty-help { font-size: var(--fs-sm); }
.board-scroll { min-width: 0; display: flex; align-items: flex-start; flex: 1; gap: var(--s3); overflow-x: auto; overflow-y: hidden; padding-bottom: var(--s2); }
.column { flex: 0 0 260px; max-height: 100%; display: flex; flex-direction: column; gap: var(--s2); padding: var(--s2); background: var(--surface); }
.column-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); padding: var(--s1); }
.count-badge { font-variant-numeric: tabular-nums; }
.column-body { min-height: 0; display: flex; flex-direction: column; gap: var(--s2); overflow-y: auto; padding: 0 var(--s1) var(--s1); }

@media (max-width: 760px) {
  .page-head { flex-direction: column; }
  .head-actions { justify-content: flex-start; }
  .loading-board { grid-template-columns: 1fr; }
}
</style>
