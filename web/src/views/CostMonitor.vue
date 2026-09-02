<script setup lang="ts">
/**
 * 成本监管 —— 本机对话流水的真实 token 消耗(BOARD-COST-MONITOR,0901 负责人拍板)。
 *
 * 【数据从哪来】Claude Code 把每个对话的完整流水存在本机 ~/.claude/projects 下,
 * 每条回复都带 token 用量。订阅套餐看不到美元,但 token 数是真的——server 端按
 * 当前项目(含它的全部 worktree 会话)聚合,按天/按模型/主对话·子agent 分桶。
 *
 * 【卡级登记】施工对话用 CLI `cost <卡> --agents "sonnet:3,opus:1"` 自报每张卡
 * 用了哪些 agent;本页明细汇总展示,点卡号可打开详情抽屉。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { Task } from '@/types'
import CodexCostSummary from '@/components/codex/CodexCostSummary.vue'
import type { CodexUsage, CombinedUsage, QuotaSnapshot } from '@/types/codex'

interface Tally { input: number; output: number; cacheRead: number; cacheWrite: number; msgs: number }
interface UsdRow { actual: number; noCache: number; saved: number }
interface DayRow { date: string; models: Record<string, Tally>; side: Tally; main: Tally; usdActual?: number }
interface Usage {
  byDay: DayRow[]
  totals: Tally & { sideOutput: number; mainOutput: number; cacheHitRate: number }
  models: Record<string, Tally>
  usd: UsdRow & { byModel: Record<string, UsdRow> }
  dirs: string[]
  scanned: number
  cachedFiles: number
  sessions: number
}

const store = useBoardStore()
const usage = ref<Usage | null>(null)
const codex = ref<CodexUsage | null>(null)
const quota = ref<QuotaSnapshot | null>(null)
const combined = ref<CombinedUsage | null>(null)
const days = ref(30)
const loading = ref(false)
const detailsOpen = ref(false)
const error = ref('')

const DAY_OPTS = [7, 30, 90]

async function load() {
  const pid = store.currentProjectId
  if (!pid) return
  loading.value = true
  try {
    const res = await fetch(`/api/cost?project=${encodeURIComponent(pid)}&days=${days.value}`)
    const body = await res.json()
    if (!body.ok) throw new Error(body.error || '读取失败')
    usage.value = body.usage
    codex.value = body.codex
    quota.value = body.quota
    combined.value = body.combined
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => store.currentProjectId, () => { detailsOpen.value = false; void load() })
watch(days, () => { detailsOpen.value = false; void load() })

/** token 数中文缩写:亿/万,小于一万给千分位 */
function fmt(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万'
  return n.toLocaleString()
}
/** 美元取整千分位(数额大,分位无意义) */
function usd0(n: number): string {
  return Math.round(n).toLocaleString()
}
function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

const dailyRows = computed(() => {
  const claudeByDate = new Map((usage.value?.byDay ?? []).map((row) => [row.date, row]))
  const codexByDate = new Map((codex.value?.byDay ?? []).map((row) => [row.date, row]))
  const dates = new Set([...claudeByDate.keys(), ...codexByDate.keys()])
  return [...dates].sort().reverse().map((date) => {
    const claude = claudeByDate.get(date)
    const codexRow = codexByDate.get(date)
    const claudeMain = claude?.main.output ?? 0
    const claudeSide = claude?.side.output ?? 0
    const codexTokens = codexRow?.tokens ?? 0
    return {
      date,
      claudeMain,
      claudeSide,
      codexTokens,
      total: claudeMain + claudeSide + codexTokens,
      usdActual: claude?.usdActual,
    }
  })
})

const modelRows = computed(() =>
  Object.entries(usage.value?.models ?? {})
    .filter(([, value]) => value.output > 0 || value.input > 0 || value.cacheRead > 0)
    .sort((a, b) => b[1].output - a[1].output),
)
/** 有成本登记的卡(当前项目) */
const costTasks = computed<Task[]>(() =>
  store.currentTasks.filter((task) => (task.cost?.entries?.length ?? 0) > 0),
)
const agentsText = (entry: { agents?: Record<string, number> }) =>
  Object.entries(entry.agents || {}).map(([model, count]) => `${model}×${count}`).join(' + ') || '—'
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>💰 成本监管</h1>
        <p class="page-subtitle">
          本机对话流水的真实 token 数；跑在别的机器上的对话不在此账内。
        </p>
      </div>
      <div class="range-picker" role="group" aria-label="成本统计时间范围">
        <button
          v-for="option in DAY_OPTS"
          :key="option"
          class="btn btn-sm range-btn"
          :class="{ active: days === option }"
          :aria-pressed="days === option"
          @click="days = option"
        >近{{ option }}天</button>
      </div>
    </header>

    <div v-if="error" class="card error-state">
      <span class="badge bad">读取失败</span>
      <span>{{ error }}</span>
      <button class="btn btn-sm" type="button" @click="load">重试</button>
    </div>

    <div v-else-if="loading && !usage" class="card loading-state" aria-label="正在加载成本数据">
      <div class="skel wide" />
      <div class="summary-skeleton">
        <div v-for="index in 4" :key="index" class="skel block" />
      </div>
      <div class="skel medium" />
      <div class="skel wide" />
    </div>

    <template v-if="usage">
      <p class="source-note">
        当前项目及其工作副本共 {{ usage.dirs.length }} 个目录、{{ usage.sessions }} 个会话。
        <span v-if="loading" class="badge info">正在刷新</span>
      </p>

      <CodexCostSummary
        v-if="codex && quota && combined"
        :codex="codex"
        :quota="quota"
        :combined="combined"
        :days="days"
      />
      <div v-else class="empty card">
        <span class="ic">📭</span>
        Codex 汇总暂时不可用<br>
        <span class="empty-help">有可归属到当前项目的会话后，这里会出现 Claude、Codex 与合计摘要。</span>
      </div>

      <p class="fine">
        💡 折算口径:你实付的是订阅费——美元是「同样的量若按 API 牌价直购值多少钱」的等价参考
        (无缓存假想 ${{ usd0(usage.usd.noCache) }} − 折后 ${{ usd0(usage.usd.actual) }} = 净省 ${{ usd0(usage.usd.saved) }};牌价缓存于 2026-06,变价改 core/costUsage.cjs 的 PRICE 表)。
      </p>

      <section class="card details-shell">
        <header class="details-head">
          <div>
            <h2>逐日与施工明细</h2>
            <p>默认收起，避免几十行记录把关键结论推到页面底部。</p>
          </div>
          <button class="btn" type="button" :aria-expanded="detailsOpen" @click="detailsOpen = !detailsOpen">
            {{ detailsOpen ? `收起近 ${days} 天逐日明细` : `展开近 ${days} 天逐日明细` }}
          </button>
        </header>

        <!-- v-if 是硬要求：折叠时不创建几十行明细 DOM。 -->
        <div v-if="detailsOpen" class="details-content">
          <section class="detail-section">
            <h3>按天</h3>
            <div v-if="!dailyRows.length" class="empty">
              <span class="ic">📅</span>
              期间没有逐日记录<br>
              <span class="empty-help">本机产生 Claude 或 Codex 会话后，会按自然日列在这里。</span>
            </div>
            <div v-else class="table-scroll">
              <table class="daily-table">
                <thead>
                  <tr><th>日期</th><th>Claude 主对话</th><th>Claude 子 agent</th><th>Codex</th><th>合计</th><th>Claude API 等价</th></tr>
                </thead>
                <tbody>
                  <tr v-for="row in dailyRows" :key="row.date">
                    <td class="mono">{{ row.date }}</td>
                    <td class="num">{{ fmt(row.claudeMain) }}</td>
                    <td class="num">{{ fmt(row.claudeSide) }}</td>
                    <td class="num">{{ fmt(row.codexTokens) }}</td>
                    <td class="num total-cell">{{ fmt(row.total) }}</td>
                    <td class="num">{{ row.usdActual === undefined ? '—' : '$' + usd0(row.usdActual) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="detail-section">
            <h3>Claude 按模型</h3>
            <div v-if="!modelRows.length" class="empty">
              <span class="ic">🧠</span>
              期间没有模型用量<br>
              <span class="empty-help">Claude 对话写入本机流水后，会按模型汇总在这里。</span>
            </div>
            <div v-else class="table-scroll">
              <table class="model-table">
                <thead><tr><th>模型</th><th>输出</th><th>输入(新)</th><th>缓存读</th><th>消息数</th></tr></thead>
                <tbody>
                  <tr v-for="[model, value] in modelRows" :key="model">
                    <td class="mono">{{ shortModel(model) }}</td>
                    <td class="num">{{ fmt(value.output) }}</td>
                    <td class="num">{{ fmt(value.input + value.cacheWrite) }}</td>
                    <td class="num">{{ fmt(value.cacheRead) }}</td>
                    <td class="num">{{ value.msgs.toLocaleString() }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="detail-section">
            <h3>各任务卡施工成本</h3>
            <div v-if="!costTasks.length" class="empty">
              <span class="ic">🧾</span>
              当前项目还没有任务登记施工成本<br>
              <span class="empty-help">施工对话收官时运行 <code>cost &lt;卡号&gt; --project {{ store.currentProjectId }} --agents "sonnet:3,opus:1"</code> 后会出现。</span>
            </div>
            <div v-else class="table-scroll">
              <table class="task-cost-table">
                <thead><tr><th>任务卡</th><th>日期</th><th>投入 agent</th><th>备注</th></tr></thead>
                <tbody>
                  <template v-for="task in costTasks" :key="task.id">
                    <tr v-for="(entry, index) in task.cost!.entries" :key="task.id + index">
                      <td><button v-if="index === 0" class="btn quiet btn-sm mono" @click="store.openTask(task.id)">{{ task.id }}</button></td>
                      <td class="mono">{{ entry.date }}</td>
                      <td>{{ agentsText(entry) }}<span v-if="entry.tokens" class="muted"> · ≈{{ fmt(entry.tokens) }}</span></td>
                      <td>{{ entry.note || '—' }}</td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page { width: 100%; max-width: 1120px; min-width: 0; display: flex; flex-direction: column; gap: var(--s4); overflow-x: hidden; }
.page-head { display: flex; align-items: flex-start; gap: var(--s4); justify-content: space-between; }
.page-subtitle, .source-note, .fine, .details-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-md); }
.source-note { margin: 0; font-size: var(--fs-sm); }
.range-picker { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--s1); }
.range-btn.active { background: var(--surface-3); border-color: var(--line-strong); font-weight: 600; }
.error-state { display: flex; align-items: center; gap: var(--s3); color: var(--bad); }
.error-state > :nth-child(2) { flex: 1; }
.loading-state { display: flex; flex-direction: column; gap: var(--s4); padding: var(--s5); }
.summary-skeleton { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s2); }
.skel.block { height: 76px; }
.skel.wide { width: 88%; }
.skel.medium { width: 56%; }
.fine { margin: 0; font-size: var(--fs-sm); line-height: 1.6; }
.details-shell { padding: 0; background: var(--surface); }
.details-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s4); padding: var(--s4); }
.details-head p { font-size: var(--fs-sm); }
.details-content { display: flex; flex-direction: column; gap: var(--s5); border-top: 1px solid var(--line); padding: var(--s4); }
.detail-section { min-width: 0; }
.detail-section h3 { margin-bottom: var(--s2); font-size: var(--fs-md); }
.table-scroll { max-width: 100%; overflow-x: auto; }
.daily-table { min-width: 780px; }
.model-table { min-width: 620px; }
.task-cost-table { min-width: 720px; }
.total-cell { font-weight: 600; }
.empty-help { font-size: var(--fs-sm); }
code { padding: 1px var(--s1); border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface-2); color: var(--text-2); font-family: var(--mono); font-size: var(--fs-sm); }

@media (max-width: 760px) {
  .page-head, .details-head { flex-direction: column; align-items: stretch; }
  .range-picker { justify-content: flex-start; }
  .summary-skeleton { grid-template-columns: 1fr 1fr; }
  .error-state { align-items: flex-start; flex-wrap: wrap; }
}
</style>
