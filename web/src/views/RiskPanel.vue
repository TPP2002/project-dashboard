<script setup lang="ts">
// 风险面板：跨项目的 暂缓 / 阻塞 / 待拍板 任务，三分组。点卡开抽屉。
//
// 「阻塞」只列**真的还被挡着**的卡（判据 = core/taskSignal.cjs 的 isBlocked）：完工卡上残留的
// blockReason / blockedBy 不算（0907 审计 B2：这一列此前把已完工卡也列进来），上游全做完的也不算
// ——那种卡已经可以开工了，不是风险。上游做完而卡上还挂着 blockedBy 的，单独报一句数，
// 免得负责人以为自己的卡凭空消失了。
import Icon from '@/components/Icon.vue'
import { computed } from 'vue'
import { useBoardStore } from '@/stores/board'
import StatusBadge from '@/components/StatusBadge.vue'
import ScopeToggle from '@/components/ScopeToggle.vue'
import { indexBoard, isBlocked, isParked, isUnblocked, unfinishedBlockers } from 'virtual:task-signal'
import { humanTitle } from '@/utils/taskTitle'
import type { Board, Task } from '@/types'

const store = useBoardStore()

interface Row { pid: string; pname: string; task: Task; blockers: string[] }
const groups = computed(() => {
  const parked: Row[] = []
  const blocked: Row[] = []
  const pending: Row[] = []
  let cleared = 0
  for (const b of store.allBoards as Board[]) {
    // 默认只看当前项目（跟随顶栏项目切换）；「全部项目」开关可跨项目聚合。
    if (!store.centerScopeAll && b.project.id !== store.currentProjectId) continue
    const index = indexBoard(b)
    for (const t of b.tasks) {
      const row = { pid: b.project.id, pname: b.project.name, task: t, blockers: [] as string[] }
      if (isParked(t)) parked.push(row)
      else if (isBlocked(t, index)) blocked.push({ ...row, blockers: unfinishedBlockers(t, index) })
      else if (isUnblocked(t, index)) cleared++
      if ((t.decisions ?? []).some((d) => d.answer == null)) pending.push(row)
    }
  }
  return { parked, blocked, pending, cleared }
})
function open(r: Row) { store.openTask(r.task.id, r.pid) }
</script>

<template>
  <div>
    <div class="head"><h2><Icon name="alertTri" class="head-ic" :size="20" />风险面板</h2><span class="spacer" /><ScopeToggle /></div>

    <div class="cols">
      <section class="col">
        <div class="col-t"><Icon name="parkingNote" :size="16" />暂缓 <span class="badge n">{{ groups.parked.length }}</span></div>
        <div v-if="!groups.parked.length" class="muted small">无</div>
        <div v-for="r in groups.parked" :key="r.pid + r.task.id" class="rcard card" @click="open(r)">
          <div class="rtop"><span class="pill">{{ r.pname }}</span><span class="mono tid">{{ r.task.id }}</span></div>
          <div class="rtitle">{{ humanTitle(r.task) }}</div>
          <div v-if="r.task.blockReason" class="reason"><Icon name="alertTri" :size="14" />{{ r.task.blockReason }}</div>
          <div v-if="r.task.parkedNote" class="reason note"><Icon name="parkingNote" :size="14" />{{ r.task.parkedNote }}</div>
        </div>
      </section>

      <section class="col">
        <div class="col-t"><Icon name="ban" :size="16" />阻塞 <span class="badge n">{{ groups.blocked.length }}</span></div>
        <div v-if="!groups.blocked.length" class="muted small">无</div>
        <div v-for="r in groups.blocked" :key="r.pid + r.task.id" class="rcard card" @click="open(r)">
          <div class="rtop"><span class="pill">{{ r.pname }}</span><span class="mono tid">{{ r.task.id }}</span><StatusBadge :status="r.task.status" small /></div>
          <div class="rtitle">{{ humanTitle(r.task) }}</div>
          <div v-if="r.blockers.length" class="reason">被 {{ r.blockers.join('、') }} 阻塞</div>
          <div v-if="r.task.blockReason" class="reason"><Icon name="alertTri" :size="14" />{{ r.task.blockReason }}</div>
        </div>
        <!-- 上游做完了、卡上却还挂着 blockedBy 的，从这一列消失是对的；不说一声会像数据丢了。 -->
        <div v-if="groups.cleared" class="muted small cleared">
          另有 {{ groups.cleared }} 张卡的上游已完工，阻塞已自动解除，可以开工了。
        </div>
      </section>

      <section class="col">
        <div class="col-t"><Icon name="bell" :size="16" />待拍板 <span class="badge n">{{ groups.pending.length }}</span></div>
        <div v-if="!groups.pending.length" class="muted small">无</div>
        <div v-for="r in groups.pending" :key="r.pid + r.task.id" class="rcard card" @click="open(r)">
          <div class="rtop"><span class="pill">{{ r.pname }}</span><span class="mono tid">{{ r.task.id }}</span></div>
          <div class="rtitle">{{ humanTitle(r.task) }}</div>
          <div class="reason warn">{{ (r.task.decisions || []).filter((d) => d.answer == null).length }} 条决策待拍板</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s4); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--s4); align-items: start; }
.col { display: flex; flex-direction: column; gap: var(--s2); }
.col-t { display: flex; align-items: center; gap: var(--s2); font-size: var(--fs-base); font-weight: 600; }
.rcard { display: flex; flex-direction: column; gap: var(--s2); cursor: pointer; }
.rcard:hover { border-color: var(--line-strong); }
.rtop { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
.rtop .tid { color: var(--text-2); font-weight: 600; font-size: var(--fs-sm); }
.rtitle { font-size: var(--fs-base); }
.reason { display: flex; align-items: flex-start; gap: var(--s1); color: var(--text-2); font-size: var(--fs-sm); }
/* 图标是行首标记，文字换行时不该跟着缩，所以钉在第一行的行高上。 */
.reason > .icon { margin-top: 2px; }
.reason.warn { color: var(--warn); }
.reason.note { color: var(--text-3); }
.cleared { padding: var(--s2) var(--s1); line-height: 1.5; }
.small { font-size: var(--fs-sm); }
</style>
