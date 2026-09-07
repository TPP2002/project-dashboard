<script setup lang="ts">
// 波次视图：当前项目按 wave 分组，每波进度 + 任务列表。点任务开抽屉。
import StatusTile from '@/components/StatusTile.vue'
import Icon from '@/components/Icon.vue'
import { computed, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import * as derive from '@/utils/derive'
import { DONE_STATUSES } from '@/api/schema'
import DoneToggle from '@/components/DoneToggle.vue'
import { humanTitle } from '@/utils/taskTitle'
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
  <div class="page">
    <header class="page-head">
      <div>
        <h1><Icon name="layers" class="head-ic" :size="20" />波次视图</h1>
        <p>按批次看进度：每一波做完多少、还剩谁没动。</p>
      </div>
      <div class="head-actions">
        <span class="pill" v-if="store.currentBoard">{{ store.currentBoard.project.name }}</span>
        <DoneToggle v-if="doneCount" v-model="showDone" :count="doneCount" />
      </div>
    </header>

    <div v-if="!waves.length" class="empty card"><div class="big"><Icon name="layers" :size="36" /></div><div>暂无任务。</div></div>

    <div class="waves">
      <section v-for="w in waves" :key="w.wave" class="wave card">
        <div class="w-head">
          <div class="w-title">第 {{ w.wave }} 波</div>
          <span class="pill">{{ prog(w.tasks).done }}/{{ prog(w.tasks).total }}</span>
          <span class="spacer" />
          <span class="w-pct mono">{{ prog(w.tasks).percent }}%</span>
        </div>
        <div class="glow-rail"><i :style="{ width: prog(w.tasks).percent + '%' }" /></div>
        <div class="w-tasks">
          <div
            v-for="t in w.visible" :key="t.id" class="wt row"
            @click="store.openTask(t.id, pid)"
          >
            <span v-if="t.status === '施工中'" class="glow-edge" />
            <StatusTile class="e" :status="t.status" :size="16" />
            <span class="tid mono">{{ t.id }}</span>
            <span class="tt">{{ humanTitle(t) }}</span>
            <span class="pc mono">{{ t.percent || 0 }}%</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page { width: 100%; min-width: 0; display: flex; flex-direction: column; gap: var(--s4); }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s5); }
.page-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-md); }
.head-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--s2); }
/* 波次卡自动分栏：每列不窄于 620，宽屏塞得下几列就是几列（1920 两列 / 2560 三列）。
   align-items: start 让高矮不一的波次卡各自保持自然高度，不被同行最高的那张撑开。 */
.waves { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(620px, 100%), 1fr)); align-items: start; gap: var(--s3); }
.wave { display: flex; flex-direction: column; gap: var(--s3); padding: var(--s3) var(--s4); }
.w-head { display: flex; align-items: center; gap: var(--s3); }
.w-title { font-size: var(--fs-md); font-weight: 600; }
.w-pct { color: var(--text-2); font-size: var(--fs-base); }
.w-tasks { display: flex; flex-direction: column; gap: var(--s2); margin-top: var(--s1); }
.wt { cursor: pointer; }
.wt .tid { color: var(--text-2); font-weight: 600; }
.wt .tt { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt .pc { color: var(--text-2); font-size: var(--fs-sm); }

@media (max-width: 760px) {
  .page-head { flex-direction: column; }
  .head-actions { justify-content: flex-start; }
}
</style>
