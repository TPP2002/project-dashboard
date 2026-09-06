<script setup lang="ts">
// 多项目总览：先给结论和待处理事项，再展示项目统计与最近动态。
//
// 【0907 审计 B1 的治法】这页的数字此前有三处失真，负责人第一眼看到的「需要你处理 307」几乎全是假的：
//   ① 恒扫全部项目的板，站在某个项目底下也不跟着切范围 → 现在整页跟随 ScopeToggle（与风险面板同一个开关）；
//   ② 「暂缓」被算成「卡住」——那是负责人自己按下的暂停键，不是有人挡他 → 拆成独立的「搁置中」，不进"需要你处理"；
//   ③ 已完工卡上残留的 blockReason / blockedBy 照样计数、上游早完工的也照样算被挡
//      → 判据统一走 core/taskSignal.cjs（前端经 virtual:task-signal 吃同一份，三个视图不许各写各的）。
// 另加两块 KPI：「施工中」和「最久没动」——前者答"现在有几摊活在动"，后者答"哪摊卡住了没人管"。
import StatusTile from '@/components/StatusTile.vue'
import Icon from '@/components/Icon.vue'
import ScopeToggle from '@/components/ScopeToggle.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useBoardStore } from '@/stores/board'
import { statusTone } from '@/api/schema'
import { overviewSignal } from 'virtual:task-signal'
import * as derive from '@/utils/derive'
import { relTime } from '@/utils/format'

import ProgressRing from '@/components/ProgressRing.vue'
import type { Board } from '@/types'
import type { CodexReport } from '@/types/codex'

const store = useBoardStore()
const router = useRouter()
// 项目卡列表恒列全部项目（那是"看看各家进度"，不是待办）；
// 需要你处理的那几组数字才跟随范围开关——这是 B1 的核心：数字必须跟你眼下关心的范围一致。
const boards = computed(() => store.allBoards)
const scopedBoards = computed<Board[]>(() =>
  store.centerScopeAll ? boards.value : boards.value.filter((b) => b.project.id === store.currentProjectId),
)

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
  for (const board of scopedBoards.value) {
    const progress = derive.progress(board)
    total += progress.total
    done += progress.done
  }
  const today = derive.todayLocal()
  const todayDone = derive.collectDoneRecords(scopedBoards.value).records.filter((r) => r.day === today).length
  return { projects: scopedBoards.value.length, total, done, today: todayDone }
})

// 卡住 / 搁置 / 施工中 / 最久没动，一次算完（判据在 core，前端只负责摆出来）。
const signal = computed(() => overviewSignal(scopedBoards.value))
const blockedItems = computed(() => signal.value.blocked)
const parkedItems = computed(() => signal.value.parked)
const buildingCount = computed(() => signal.value.building)
const stalest = computed(() => signal.value.stalest)
const pendingItems = computed(() => derive.collectPending(scopedBoards.value))
const rejectedJobs = computed(() => codexReport.value?.rejectedJobs ?? [])
// 「搁置中」刻意不进这个和：暂缓是你自己按的暂停键，天天摆在"需要你处理"里只会让这个数字失去意义。
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
function blockedReason(item: { task: { blockReason?: string }; blockers: string[] }) {
  if (item.task.blockReason) return item.task.blockReason
  return `等待 ${item.blockers.join('、')}`
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
function openTask(item: { projectId: string; task: { id: string } }) {
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
      <div class="head-tools">
        <ScopeToggle />
        <button class="btn btn-sm" type="button" :disabled="store.loading || contextLoading" @click="store.refresh(); loadContext()">
          {{ store.loading || contextLoading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>

    <div v-if="store.loading && !boards.length" class="page-loading" aria-label="正在加载总览">
      <div class="kpi-grid">
        <div v-for="index in 6" :key="index" class="card"><div class="skel kpi-skel" /><div class="skel label-skel" /></div>
      </div>
      <div class="card loading-panel"><div class="skel wide" /><div class="skel medium" /><div class="skel wide" /></div>
    </div>

    <template v-else>
      <section class="kpi-grid" aria-label="关键数字">
        <div class="card"><div class="v">{{ totals.projects }}</div><div class="l">项目</div></div>
        <div class="card"><div class="v">{{ totals.total }}</div><div class="l">任务</div></div>
        <div class="card"><div class="v">{{ totals.done }}</div><div class="l">已完工</div></div>
        <div class="card">
          <div class="v">{{ buildingCount }}</div>
          <div class="l tiled"><StatusTile status="施工中" :size="14" decorative />施工中</div>
        </div>
        <button class="card kpi-button" type="button" @click="router.push('/daily')">
          <span class="v">{{ totals.today }}</span><span class="l">今日完成 →</span>
        </button>
        <button class="card kpi-button" type="button" @click="router.push('/approvals')">
          <span class="v">{{ actionTotal }}</span><span class="l">需要你处理 →</span>
        </button>
        <!-- 「最久没动」问的是"哪摊活卡住了没人管"：只看施工中的卡，取进度戳/活动流/开工日里最新的那个再比谁最旧。 -->
        <button
          v-if="stalest"
          class="card kpi-button kpi-wide"
          type="button"
          :title="`${stalest.task.title}（${stalest.projectName}）`"
          @click="openTask(stalest)"
        >
          <span class="v stale-id mono">{{ stalest.task.id }}</span>
          <span class="l tiled"><Icon name="history" :size="14" />最久没动 · {{ relTime(stalest.since) }} →</span>
        </button>
        <div v-else class="card kpi-wide">
          <div class="v quiet">—</div>
          <div class="l tiled"><Icon name="history" :size="14" />最久没动（当前没有施工中的卡）</div>
        </div>
      </section>

      <!-- 永远排在统计前面。 -->
      <section class="section attention-section">
        <header class="section-head">
          <div>
            <h2>需要你处理</h2>
            <p>待拍板、被驳回和真被挡住的事情会先放在这里；自己按了暂停的「搁置中」单列在下面。</p>
          </div>
          <span class="badge" :class="actionTotal ? 'warn' : 'ok'">{{ actionTotal }} 项</span>
        </header>

        <div v-if="actionTotal === 0 && !contextLoading" class="empty card">
          <span class="ic"><Icon name="sparkles" :size="36" /></span>
          现在没有需要立刻处理的事项<br>
          <span class="empty-help">出现待拍板、Codex 工单被驳回或任务真被挡住时，会自动排到这里。</span>
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
            <header>
              <h3>被驳回</h3>
              <span class="scope-note">全部项目</span>
              <span class="spacer" />
              <span class="badge bad">{{ rejectedJobs.length }}</span>
            </header>
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
            <div v-if="!blockedItems.length" class="group-empty">没有任务被挡住。</div>
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

        <!-- 搁置中：你自己按的暂停键。摆出来是为了别忘了，不是为了催你——所以压在"需要你处理"外面、样式也压低。 -->
        <div v-if="parkedItems.length" class="card parked-strip">
          <div class="parked-head">
            <span class="tiled"><StatusTile status="暂缓" :size="16" decorative /><b>搁置中 {{ parkedItems.length }}</b></span>
            <span class="parked-note">你自己按的暂停键，不计入「需要你处理」</span>
            <span class="spacer" />
            <button class="btn quiet btn-sm" type="button" @click="router.push('/risk')">去风险面板 →</button>
          </div>
          <div class="parked-list">
            <button
              v-for="item in parkedItems.slice(0, 6)"
              :key="`${item.projectId}:${item.task.id}`"
              class="pill parked-pill"
              type="button"
              :title="item.task.parkedNote || item.task.title"
              @click="openTask(item)"
            >{{ item.task.id }}</button>
            <span v-if="parkedItems.length > 6" class="parked-note">…另有 {{ parkedItems.length - 6 }} 张</span>
          </div>
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
          <span class="ic"><Icon name="archive" :size="36" /></span>
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
              <span v-for="[status, count] in countsOf(board)" :key="status" class="badge tiled" :class="statusTone(status)">
                <StatusTile :status="status" :size="14" decorative />{{ status }} {{ count }}
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
.head-tools { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
/* 八列格：六块普通 KPI 各占一列，「最久没动」要写得下卡号，占两列。 */
.kpi-grid { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: var(--s2); }
.kpi-wide { grid-column: span 2; }
.kpi-button { display: flex; flex-direction: column; align-items: flex-start; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.kpi-button:hover { border-color: var(--line-strong); background: var(--surface-3); }
.kpi-grid .card { min-width: 0; }
.kpi-grid .l { display: flex; align-items: center; gap: 5px; min-width: 0; }
/* 卡号比数字长得多，用小一号字并允许省略，免得撑破格子。 */
.stale-id { max-width: 100%; overflow: hidden; font-size: var(--fs-md); text-overflow: ellipsis; white-space: nowrap; }
.quiet { color: var(--text-3); }
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
.scope-note { color: var(--text-3); font-size: var(--fs-xs); }
.action-row { width: 100%; min-width: 0; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.action-row:hover { background: var(--surface-3); }
.action-row .rt { max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-empty { color: var(--text-3); font-size: var(--fs-sm); line-height: 1.5; }
.more-button { align-self: flex-start; margin-top: var(--s1); }
/* 搁置中：压低存在感——它不催人，只是"别忘了还有这些"。 */
.parked-strip { display: flex; flex-direction: column; gap: var(--s2); background: var(--surface-2); }
.parked-head { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
.parked-note { color: var(--text-3); font-size: var(--fs-sm); }
.parked-list { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1); }
.parked-pill { cursor: pointer; }
.parked-pill:hover { border-color: var(--line-strong); color: var(--text); }
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
/* 徽章基类是 inline-block，装了色点就得换 flex。 */
.tiled { display: inline-flex; align-items: center; gap: 5px; }
.status-list { display: flex; flex-wrap: wrap; gap: var(--s1); }
.activity-list { display: flex; flex-direction: column; gap: var(--s1); border-top: 1px solid var(--line); padding-top: var(--s2); }
.activity-row { display: flex; align-items: center; gap: var(--s2); min-width: 0; font-size: var(--fs-sm); }
.activity-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-time { flex: none; color: var(--text-3); font-family: var(--mono); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }

@media (max-width: 1400px) {
  .kpi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
@media (max-width: 1000px) {
  .kpi-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .kpi-wide { grid-column: span 3; }
  .action-grid { grid-template-columns: 1fr; }
}
@media (max-width: 700px) {
  .page-head, .section-head { flex-direction: column; align-items: stretch; }
  .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kpi-wide { grid-column: span 2; }
  .cost-strip { grid-template-columns: 1fr 1fr; }
  .project-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
