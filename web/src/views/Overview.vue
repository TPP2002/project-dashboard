<script setup lang="ts">
// 多项目总览：先给结论和待处理事项，再展示项目统计与最近动态。
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useBoardStore } from '@/stores/board'
import * as derive from '@/utils/derive'
import { relTime } from '@/utils/format'
import { emojiFor } from '@/api/schema'
import ProgressRing from '@/components/ProgressRing.vue'
import type { Board, Task } from '@/types'
import type { CodexReport } from '@/types/codex'

interface BlockedItem {
  projectId: string
  projectName: string
  task: Task
}

const store = useBoardStore()
const router = useRouter()
const boards = computed(() => store.allBoards)

// 当前项目近 30 天成本摘要与全局 Codex 驳回项；接口失败不遮挡看板主数据。
const costSum = ref<{ output: number; actual: number; saved: number } | null>(null)
const codexReport = ref<CodexReport | null>(null)
const contextLoading = ref(false)

async function loadContext() {
  const pid = store.currentProjectId
  if (!pid) return
  contextLoading.value = true
  const [costResult, reportResult] = await Promise.allSettled([
    fetch(`/api/cost?project=${encodeURIComponent(pid)}&days=30`).then(async (response) => {
      const body = await response.json()
      if (!response.ok || !body.ok) throw new Error(body.error || '读取成本失败')
      return body
    }),
    fetch('/api/codex/report?days=7').then(async (response) => {
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || '读取 Codex 战报失败')
      return body as CodexReport
    }),
  ])
  if (store.currentProjectId === pid) {
    costSum.value = costResult.status === 'fulfilled'
      ? {
          output: costResult.value.usage.totals.output,
          actual: costResult.value.usage.usd.actual,
          saved: costResult.value.usage.usd.saved,
        }
      : null
    codexReport.value = reportResult.status === 'fulfilled' ? reportResult.value : null
    contextLoading.value = false
  }
}

onMounted(loadContext)
watch(() => store.currentProjectId, loadContext)

const totals = computed(() => {
  let total = 0
  let done = 0
  for (const board of boards.value) {
    const progress = derive.progress(board)
    total += progress.total
    done += progress.done
  }
  return { projects: boards.value.length, total, done, today: store.todayDoneCount }
})

const pendingItems = computed(() => store.pendingDecisions)
const blockedItems = computed<BlockedItem[]>(() => {
  const items: BlockedItem[] = []
  for (const board of boards.value) {
    for (const task of board.tasks ?? []) {
      if (task.status === '暂缓' || task.blockReason || (task.deps?.blockedBy?.length ?? 0) > 0) {
        items.push({ projectId: board.project.id, projectName: board.project.name, task })
      }
    }
  }
  return items.sort((left, right) => {
    const leftHard = left.task.blockReason || left.task.deps?.blockedBy?.length ? 1 : 0
    const rightHard = right.task.blockReason || right.task.deps?.blockedBy?.length ? 1 : 0
    return rightHard - leftHard || left.projectName.localeCompare(right.projectName)
  })
})
const rejectedJobs = computed(() => codexReport.value?.rejectedJobs ?? [])
const actionTotal = computed(() => pendingItems.value.length + blockedItems.value.length + rejectedJobs.value.length)

function progressOf(board: Board) {
  return derive.progress(board)
}
function countsOf(board: Board) {
  return Object.entries(derive.statusCounts(board)).sort((left, right) => right[1] - left[1])
}
function pendingOf(board: Board) {
  return derive.collectPending([board]).length
}
function todayOf(board: Board) {
  const today = derive.todayLocal()
  return derive.collectDoneRecords([board]).records.filter((record) => record.day === today).length
}
function recentOf(board: Board) {
  return (board.activity ?? [])
    .slice()
    .sort((left, right) => (right.ts || '').localeCompare(left.ts || ''))
    .slice(0, 3)
}
function statusTone(status: string) {
  if (['已完工', '已拍板', '收官'].includes(status)) return 'ok'
  if (status === '待拍板') return 'warn'
  if (['施工中', '可复工', '待开工'].includes(status)) return 'info'
  if (status === '暂缓') return 'bad'
  return 'n'
}
function blockedReason(item: BlockedItem) {
  if (item.task.blockReason) return item.task.blockReason
  const blockers = item.task.deps?.blockedBy ?? []
  if (blockers.length) return `等待 ${blockers.join('、')}`
  return item.task.parkedNote || '任务当前处于暂缓状态'
}
function fmtWan(value: number) {
  if (value >= 1e8) return (value / 1e8).toFixed(1) + '亿'
  if (value >= 1e4) return (value / 1e4).toFixed(0) + '万'
  return value.toLocaleString()
}
function openBoard(board: Board) {
  store.selectProject(board.project.id)
  void router.push('/kanban')
}
function openTask(item: BlockedItem) {
  store.selectProject(item.projectId)
  store.openTask(item.task.id, item.projectId)
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>总览</h1>
        <p>先处理会挡住工作的事情，再看项目统计。</p>
      </div>
      <button class="btn btn-sm" type="button" :disabled="store.loading || contextLoading" @click="store.refresh(); loadContext()">
        {{ store.loading || contextLoading ? '刷新中…' : '刷新' }}
      </button>
    </header>

    <div v-if="store.loading && !boards.length" class="page-loading" aria-label="正在加载总览">
      <div class="kpi-grid">
        <div v-for="index in 5" :key="index" class="card"><div class="skel kpi-skel" /><div class="skel label-skel" /></div>
      </div>
      <div class="card loading-panel"><div class="skel wide" /><div class="skel medium" /><div class="skel wide" /></div>
    </div>

    <template v-else>
      <section class="kpi-grid" aria-label="关键数字">
        <div class="card"><div class="v">{{ totals.projects }}</div><div class="l">项目</div></div>
        <div class="card"><div class="v">{{ totals.total }}</div><div class="l">任务</div></div>
        <div class="card"><div class="v">{{ totals.done }}</div><div class="l">已完工</div></div>
        <button class="card kpi-button" type="button" @click="router.push('/daily')">
          <span class="v">{{ totals.today }}</span><span class="l">今日完成 →</span>
        </button>
        <button class="card kpi-button" type="button" @click="router.push('/approvals')">
          <span class="v">{{ actionTotal }}</span><span class="l">需要你处理 →</span>
        </button>
      </section>

      <!-- 永远排在统计前面。 -->
      <section class="section attention-section">
        <header class="section-head">
          <div>
            <h2>需要你处理</h2>
            <p>待拍板、被驳回和卡住的事情会先放在这里。</p>
          </div>
          <span class="badge" :class="actionTotal ? 'warn' : 'ok'">{{ actionTotal }} 项</span>
        </header>

        <div v-if="actionTotal === 0 && !contextLoading" class="empty card">
          <span class="ic">✨</span>
          现在没有需要立刻处理的事项<br>
          <span class="empty-help">出现待拍板、Codex 工单被驳回或任务被阻塞时，会自动排到这里。</span>
        </div>
        <div v-else class="action-grid">
          <article class="card action-card">
            <span v-if="pendingItems.length" class="glow glow-top attention-glow" />
            <header><h3>待拍板</h3><span class="badge warn">{{ pendingItems.length }}</span></header>
            <div v-if="!pendingItems.length" class="group-empty">当前没有待拍板事项。</div>
            <button
              v-for="item in pendingItems.slice(0, 4)"
              :key="`${item.projectId}:${item.task.id}:${item.decision.id}`"
              class="row action-row"
              type="button"
              @click="router.push('/approvals')"
            >
              <span class="badge warn">待定</span>
              <span class="g">{{ item.decision.question }}</span>
              <span class="rt">{{ item.projectName }}</span>
            </button>
            <button v-if="pendingItems.length > 4" class="btn quiet btn-sm more-button" @click="router.push('/approvals')">查看其余 {{ pendingItems.length - 4 }} 项 →</button>
          </article>

          <article class="card action-card">
            <span v-if="rejectedJobs.length" class="glow glow-top attention-glow" />
            <header><h3>被驳回</h3><span class="badge bad">{{ rejectedJobs.length }}</span></header>
            <div v-if="contextLoading && !codexReport" class="group-loading"><div class="skel wide" /><div class="skel medium" /></div>
            <div v-else-if="!rejectedJobs.length" class="group-empty">近 7 天没有被驳回的 Codex 工单。</div>
            <button
              v-for="job in rejectedJobs.slice(0, 4)"
              :key="job.slug"
              class="row action-row"
              type="button"
              @click="router.push('/codex')"
            >
              <span class="badge bad">驳回</span>
              <span class="g">{{ job.title }}</span>
              <span class="rt">去处理</span>
            </button>
            <button v-if="rejectedJobs.length > 4" class="btn quiet btn-sm more-button" @click="router.push('/codex')">查看其余 {{ rejectedJobs.length - 4 }} 项 →</button>
          </article>

          <article class="card action-card">
            <span v-if="blockedItems.length" class="glow glow-top attention-glow" />
            <header><h3>卡住的任务</h3><span class="badge bad">{{ blockedItems.length }}</span></header>
            <div v-if="!blockedItems.length" class="group-empty">当前没有阻塞或暂缓任务。</div>
            <button
              v-for="item in blockedItems.slice(0, 4)"
              :key="`${item.projectId}:${item.task.id}`"
              class="row action-row"
              type="button"
              :title="blockedReason(item)"
              @click="openTask(item)"
            >
              <span class="badge bad">卡住</span>
              <span class="g">{{ item.task.title }}</span>
              <span class="rt">{{ item.projectName }}</span>
            </button>
            <button v-if="blockedItems.length > 4" class="btn quiet btn-sm more-button" @click="router.push('/risk')">查看其余 {{ blockedItems.length - 4 }} 项 →</button>
          </article>
        </div>
      </section>

      <section class="section stats-section">
        <header class="section-head">
          <div>
            <h2>项目与统计</h2>
            <p>处理完上面的事项后，再看各项目进度、状态和最近动态。</p>
          </div>
        </header>

        <button v-if="costSum" class="card cost-strip" type="button" @click="router.push('/cost')">
          <span><b>{{ fmtWan(costSum.output) }}</b><small>当前项目近 30 天输出</small></span>
          <span><b>${{ Math.round(costSum.actual).toLocaleString() }}</b><small>API 牌价等价</small></span>
          <span><b>${{ Math.round(costSum.saved).toLocaleString() }}</b><small>缓存净省</small></span>
          <span class="cost-link">查看成本 →</span>
        </button>
        <div v-else-if="contextLoading" class="card cost-loading"><div class="skel wide" /><div class="skel medium" /></div>

        <div v-if="!boards.length" class="empty card">
          <span class="ic">🗂️</span>
          暂无项目<br>
          <span class="empty-help">用看板命令注册项目后，项目统计和最近动态会自动出现。</span>
        </div>

        <div v-else class="project-grid">
          <article
            v-for="board in boards"
            :key="board.project.id"
            class="project-card card"
            role="button"
            tabindex="0"
            @click="openBoard(board)"
            @keydown.enter="openBoard(board)"
            @keydown.space.prevent="openBoard(board)"
          >
            <div class="project-top">
              <ProgressRing :percent="progressOf(board).percent" :size="86" :sub="progressOf(board).done + '/' + progressOf(board).total" />
              <div class="project-info">
                <div class="project-name">
                  {{ board.project.name }}
                  <span v-if="todayOf(board)" class="badge ok">今日 +{{ todayOf(board) }}</span>
                </div>
                <div class="project-repo mono">{{ board.project.mainRepo || board.project.id }}</div>
                <div v-if="pendingOf(board)" class="project-alert"><span class="badge warn">{{ pendingOf(board) }} 条待拍板</span></div>
              </div>
            </div>

            <div class="status-list">
              <span v-for="[status, count] in countsOf(board)" :key="status" class="badge" :class="statusTone(status)">
                {{ emojiFor(status) }} {{ status }} {{ count }}
              </span>
            </div>

            <div class="activity-list">
              <div v-for="(activity, index) in recentOf(board)" :key="index" class="activity-row">
                <span class="activity-text">{{ activity.text }}</span>
                <span class="activity-time">{{ relTime(activity.ts) }}</span>
              </div>
              <div v-if="!recentOf(board).length" class="group-empty">还没有动态；任务更新后会显示最近三条。</div>
            </div>
          </article>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page { width: 100%; min-width: 0; display: flex; flex-direction: column; gap: var(--s6); overflow-x: hidden; }
.page-head, .section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s4); }
.page-head p, .section-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-md); }
.kpi-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--s2); }
.kpi-button { display: flex; flex-direction: column; align-items: flex-start; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.kpi-button:hover { border-color: var(--line-strong); background: var(--surface-3); }
.page-loading { display: flex; flex-direction: column; gap: var(--s5); }
.kpi-skel { width: 52%; height: var(--s5); }
.label-skel { width: 72%; margin-top: var(--s2); }
.loading-panel, .cost-loading, .group-loading { display: flex; flex-direction: column; gap: var(--s3); }
.loading-panel { padding: var(--s5); }
.skel.wide { width: 86%; }
.skel.medium { width: 58%; }
.section { min-width: 0; display: flex; flex-direction: column; gap: var(--s4); }
.empty-help { font-size: var(--fs-sm); }
.action-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s3); align-items: start; }
.action-card { display: flex; flex-direction: column; gap: var(--s2); padding-top: var(--s4); background: var(--surface); }
.attention-glow { position: absolute; inset: 0 0 auto; }
.action-card > header { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); margin-bottom: var(--s1); }
.action-row { width: 100%; min-width: 0; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.action-row:hover { background: var(--surface-3); }
.action-row .rt { max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-empty { color: var(--text-3); font-size: var(--fs-sm); line-height: 1.5; }
.more-button { align-self: flex-start; margin-top: var(--s1); }
.cost-strip { width: 100%; display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)) auto; align-items: center; gap: var(--s4); color: var(--text); font: inherit; text-align: left; cursor: pointer; background: var(--surface); }
.cost-strip:hover { border-color: var(--line-strong); }
.cost-strip span { min-width: 0; }
.cost-strip b, .cost-strip small { display: block; }
.cost-strip b { font-family: var(--mono); font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
.cost-strip small { color: var(--text-2); font-size: var(--fs-sm); }
.cost-link { color: var(--text-2); font-size: var(--fs-base); white-space: nowrap; }
.project-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--s3); }
.project-card { min-width: 0; display: flex; flex-direction: column; gap: var(--s3); cursor: pointer; background: var(--surface); transition: border-color .14s ease, transform .14s ease; }
.project-card:hover, .project-card:focus-visible { border-color: var(--line-strong); transform: translateY(-1px); }
.project-top { display: flex; align-items: center; gap: var(--s3); }
.project-info { flex: 1; min-width: 0; }
.project-name { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s2); font-size: var(--fs-lg); font-weight: 600; }
.project-repo { overflow: hidden; margin-top: var(--s1); color: var(--text-2); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.project-alert { margin-top: var(--s2); }
.status-list { display: flex; flex-wrap: wrap; gap: var(--s1); }
.activity-list { display: flex; flex-direction: column; gap: var(--s1); border-top: 1px solid var(--line); padding-top: var(--s2); }
.activity-row { display: flex; align-items: center; gap: var(--s2); min-width: 0; font-size: var(--fs-sm); }
.activity-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-time { flex: none; color: var(--text-3); font-family: var(--mono); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }

@media (max-width: 1000px) {
  .kpi-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .action-grid { grid-template-columns: 1fr; }
}
@media (max-width: 700px) {
  .page-head, .section-head { flex-direction: column; align-items: stretch; }
  .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cost-strip { grid-template-columns: 1fr 1fr; }
  .project-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
