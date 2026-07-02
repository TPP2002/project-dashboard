<script setup lang="ts">
// 风险面板：跨项目的 暂缓 / 阻塞 / 待拍板 任务，三分组。点卡开抽屉。
import { computed } from 'vue'
import { useBoardStore } from '@/stores/board'
import StatusBadge from '@/components/StatusBadge.vue'
import ScopeToggle from '@/components/ScopeToggle.vue'
import type { Board, Task } from '@/types'

const store = useBoardStore()

interface Row { pid: string; pname: string; task: Task }
const groups = computed(() => {
  const parked: Row[] = []
  const blocked: Row[] = []
  const pending: Row[] = []
  for (const b of store.allBoards as Board[]) {
    // 默认只看当前项目（跟随顶栏项目切换）；「全部项目」开关可跨项目聚合。
    if (!store.centerScopeAll && b.project.id !== store.currentProjectId) continue
    for (const t of b.tasks) {
      const row = { pid: b.project.id, pname: b.project.name, task: t }
      if (t.status === '暂缓') parked.push(row)
      else if ((t.deps?.blockedBy?.length ?? 0) > 0 || t.blockReason) blocked.push(row)
      if ((t.decisions ?? []).some((d) => d.answer == null)) pending.push(row)
    }
  }
  return { parked, blocked, pending }
})
function open(r: Row) { store.openTask(r.task.id, r.pid) }
</script>

<template>
  <div>
    <div class="head"><h2>⚠️ 风险面板</h2><span class="spacer" /><ScopeToggle /></div>

    <div class="cols">
      <section class="col">
        <div class="col-t">🚫 暂缓 <span class="n">{{ groups.parked.length }}</span></div>
        <div v-if="!groups.parked.length" class="muted small">无</div>
        <div v-for="r in groups.parked" :key="r.pid + r.task.id" class="rcard card" @click="open(r)">
          <div class="rtop"><span class="pill">{{ r.pname }}</span><span class="mono tid">{{ r.task.id }}</span></div>
          <div class="rtitle">{{ r.task.title }}</div>
          <div v-if="r.task.blockReason" class="reason">🚧 {{ r.task.blockReason }}</div>
          <div v-if="r.task.parkedNote" class="reason note">🅿️ {{ r.task.parkedNote }}</div>
        </div>
      </section>

      <section class="col">
        <div class="col-t">⛔ 阻塞 <span class="n">{{ groups.blocked.length }}</span></div>
        <div v-if="!groups.blocked.length" class="muted small">无</div>
        <div v-for="r in groups.blocked" :key="r.pid + r.task.id" class="rcard card" @click="open(r)">
          <div class="rtop"><span class="pill">{{ r.pname }}</span><span class="mono tid">{{ r.task.id }}</span><StatusBadge :status="r.task.status" small /></div>
          <div class="rtitle">{{ r.task.title }}</div>
          <div v-if="r.task.deps?.blockedBy?.length" class="reason">被 {{ r.task.deps.blockedBy.join(', ') }} 阻塞</div>
          <div v-if="r.task.blockReason" class="reason">🚧 {{ r.task.blockReason }}</div>
        </div>
      </section>

      <section class="col">
        <div class="col-t">❓ 待拍板 <span class="n">{{ groups.pending.length }}</span></div>
        <div v-if="!groups.pending.length" class="muted small">无</div>
        <div v-for="r in groups.pending" :key="r.pid + r.task.id" class="rcard card" @click="open(r)">
          <div class="rtop"><span class="pill">{{ r.pname }}</span><span class="mono tid">{{ r.task.id }}</span></div>
          <div class="rtitle">{{ r.task.title }}</div>
          <div class="reason warn">{{ (r.task.decisions || []).filter((d) => d.answer == null).length }} 条决策待拍板</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.head { margin-bottom: 16px; display: flex; align-items: center; gap: 12px; }
.head h2 { font-size: 18px; }
.spacer { flex: 1; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 10px; }
.col-t { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.col-t .n { background: var(--panel-2); color: var(--muted); border-radius: 999px; padding: 0 8px; font-size: 12px; }
.rcard { padding: 11px 13px; cursor: pointer; display: flex; flex-direction: column; gap: 6px; }
.rcard:hover { border-color: var(--accent); }
.rtop { display: flex; align-items: center; gap: 8px; }
.rtop .tid { color: var(--muted); font-weight: 600; font-size: 12px; }
.rtitle { font-size: 13px; }
.reason { font-size: 12px; color: var(--muted); }
.reason.warn { color: var(--warn); }
.reason.note { color: var(--muted-2); }
.small { font-size: 12px; }
</style>
