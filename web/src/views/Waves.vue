<script setup lang="ts">
// 波次视图：当前项目按 wave 分组，每波进度 + 任务列表。点任务开抽屉。
import { computed, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import * as derive from '@/utils/derive'
import { statusColor, emojiFor, DONE_STATUSES } from '@/api/schema'
import DoneToggle from '@/components/DoneToggle.vue'
import type { Task } from '@/types'

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')
// 默认折叠已完工:每波只显示活跃任务,整波全完工则该波不显示;
// 但进度 done/total 仍按全量算(不因折叠而失真)。
const showDone = ref(false)
const doneCount = computed(() => (store.currentBoard?.tasks ?? []).filter((t) => DONE_STATUSES.has(t.status)).length)
const waves = computed(() => derive.groupByWave(store.currentBoard)
  .map((w) => ({ ...w, visible: showDone.value ? w.tasks : w.tasks.filter((t) => !DONE_STATUSES.has(t.status)) }))
  .filter((w) => w.visible.length > 0))
function prog(tasks: Task[]) {
  const done = tasks.filter((t) => t.status === '已完工').length
  return { done, total: tasks.length, percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0 }
}
</script>

<template>
  <div>
    <div class="head">
      <h2>🌊 波次视图</h2>
      <span class="pill" v-if="store.currentBoard">{{ store.currentBoard.project.name }}</span>
      <DoneToggle v-if="doneCount" v-model="showDone" :count="doneCount" />
    </div>

    <div v-if="!waves.length" class="empty card"><div class="big">🌊</div><div>暂无任务。</div></div>

    <div class="waves">
      <section v-for="w in waves" :key="w.wave" class="wave card">
        <div class="w-head">
          <div class="w-title">第 {{ w.wave }} 波</div>
          <span class="pill">{{ prog(w.tasks).done }}/{{ prog(w.tasks).total }}</span>
          <span class="spacer" />
          <span class="w-pct mono">{{ prog(w.tasks).percent }}%</span>
        </div>
        <div class="progress"><i :style="{ width: prog(w.tasks).percent + '%' }" /></div>
        <div class="w-tasks">
          <div
            v-for="t in w.visible" :key="t.id" class="wt"
            :style="{ borderLeft: '3px solid ' + statusColor(t.status) }"
            @click="store.openTask(t.id, pid)"
          >
            <span class="e">{{ emojiFor(t.status) }}</span>
            <span class="tid mono">{{ t.id }}</span>
            <span class="tt">{{ t.title }}</span>
            <span class="pc mono">{{ t.percent || 0 }}%</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.head h2 { font-size: 18px; }
.waves { display: flex; flex-direction: column; gap: 14px; max-width: 900px; }
.wave { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.w-head { display: flex; align-items: center; gap: 10px; }
.w-title { font-size: 15px; font-weight: 600; }
.w-pct { color: var(--muted); font-size: 13px; }
.w-tasks { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.wt { display: flex; align-items: center; gap: 9px; padding: 7px 10px; background: var(--panel-2); border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; }
.wt:hover { background: #2a3444; }
.wt .tid { color: var(--muted); font-weight: 600; }
.wt .tt { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt .pc { color: var(--muted); font-size: 12px; }
</style>
