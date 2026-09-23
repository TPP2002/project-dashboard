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
import Icon from '@/components/Icon.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { Task } from '@/types'
import CodexCostSummary from '@/components/codex/CodexCostSummary.vue'
import DeepseekCostSummary from '@/components/codex/DeepseekCostSummary.vue'
import SessionDetailTable from '@/components/cost/SessionDetailTable.vue'
import JobDetailTable from '@/components/cost/JobDetailTable.vue'
import type { CodexUsage, DeepseekBalance, DeepseekUsage, QuotaSnapshot } from '@/types/codex'

interface Tally { input: number; output: number; cacheRead: number; cacheWrite: number; msgs: number }
interface UsdRow { actual: number; noCache: number; saved: number }
interface DayRow { date: string; models: Record<string, Tally>; side: Tally; main: Tally; usdActual?: number }
interface ContextStats { turns: number; avgContext: number; load: number; heavyTurns: number; heavyRatio: number }
interface Usage {
  byDay: DayRow[]
  totals: Tally & { sideOutput: number; mainOutput: number; cacheHitRate: number }
  claudeTotals: Tally
  glmTotals: Tally
  unpricedModels: string[]
  models: Record<string, Tally>
  usd: UsdRow & { byModel: Record<string, UsdRow> }
  context: ContextStats
  dirs: string[]
  scanned: number
  cachedFiles: number
  sessions: number
}
interface GlmTally { jobs: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; credits: number; creditJobs: number; uncertainCredits: number; missingUsageJobs: number }
interface GlmUsage { totals: GlmTally; byModel: Record<string, GlmTally>; byDay: Array<GlmTally & { date: string }> }
interface PortfolioRow { id: string; name: string; claudeTokens: number; claudeUsd: number; claudeOutput: number; unpricedModels: string[]; sharedDirs: string[]; codexTokens: number; deepseekRmb: number; glm: GlmTally | null; sharedCodeRepo: boolean; duplicateName: boolean }
interface Portfolio { rows: PortfolioRow[]; unassignedCodexTokens: number; totals: { claudeTokens: number; claudeUsd: number; claudeOutput: number; unpricedModels: string[]; codexTokens: number; codexBuckets: { input: number; output: number; cachedInput: number }; codexBucketedTokens: number; deepseekRmb: number; glmCredits: number; glmCreditJobs: number; glmUncertainCredits: number; glmTokens: number } }

const store = useBoardStore()
const usage = ref<Usage | null>(null)
const codex = ref<CodexUsage | null>(null)
const deepseek = ref<DeepseekUsage | null>(null)
const deepseekBalance = ref<DeepseekBalance | null>(null)
const glm = ref<GlmUsage | null>(null)
const portfolio = ref<Portfolio | null>(null)
const scope = ref<'all' | 'project'>('all')
const quota = ref<QuotaSnapshot | null>(null)
const days = ref(30)
const loading = ref(false)
const error = ref('')

const DAY_OPTS = [7, 30, 90]

/**
 * 请求序号:切天数/切项目时会并发几个请求,**先发的未必先回**。
 * 只认最后一次发出的那个结果,否则界面显示的可能是上一个区间的数字
 * (0902 实测:点了近30天却显示近7天的数,还叠出重复行)。
 */
let reqSeq = 0

async function load() {
  const pid = store.currentProjectId
  if (scope.value === 'project' && !pid) return
  const seq = ++reqSeq
  const wantDays = days.value
  loading.value = true
  try {
    const res = await fetch(`/api/cost?project=${scope.value === 'all' ? 'all' : encodeURIComponent(pid!)}&days=${wantDays}`)
    const body = await res.json()
    if (seq !== reqSeq) return // 已经有更新的请求发出,这份结果作废
    if (!body.ok) throw new Error(body.error || '读取失败')
    if (scope.value === 'all') {
      portfolio.value = body as Portfolio
      usage.value = null
      error.value = ''
      return
    }
    portfolio.value = null
    usage.value = body.usage
    codex.value = body.codex
    deepseek.value = body.deepseek ?? null
    deepseekBalance.value = body.deepseekBalance ?? null
    glm.value = body.glm ?? null
    quota.value = body.quota
    error.value = ''
  } catch (e) {
    if (seq !== reqSeq) return
    // 失败时清空旧数据:留着会让人以为看到的是当前区间的数,其实是上一次的
    usage.value = null
    portfolio.value = null
    codex.value = null
    deepseek.value = null
    deepseekBalance.value = null
    glm.value = null
    quota.value = null
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (seq === reqSeq) loading.value = false
  }
}

onMounted(load)
watch(() => store.currentProjectId, () => { void load() })
watch(days, () => { void load() })
watch(scope, () => { void load() })

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
  const glmByDate = new Map((glm.value?.byDay ?? []).map((row) => [row.date, row]))
  const dates = new Set([...claudeByDate.keys(), ...codexByDate.keys(), ...glmByDate.keys()])
  return [...dates].sort().reverse().map((date) => {
    const claude = claudeByDate.get(date)
    const codexRow = codexByDate.get(date)
    const modelEntries = Object.entries(claude?.models ?? {})
    const claudeOutput = modelEntries.filter(([model]) => model.startsWith('claude-'))
      .reduce((sum, [, value]) => sum + value.output, 0)
    const claudeInput = modelEntries.filter(([model]) => model.startsWith('claude-'))
      .reduce((sum, [, value]) => sum + value.input + value.cacheWrite + value.cacheRead, 0)
    const glmTokens = glmByDate.get(date)?.tokens ?? 0
    const codexTokens = codexRow?.tokens ?? 0
    return {
      date,
      claudeInput,
      claudeOutput,
      glmTokens,
      codexTokens,
      usdActual: claude?.usdActual,
    }
  })
})

const deepseekDailyRows = computed(() => [...(deepseek.value?.byDay ?? [])].reverse())

/** 花销结构:写出来的最贵、重复利用的几乎不花钱。 */
const spendBreakdown = computed(() => {
  const t = usage.value?.claudeTotals
  const u = usage.value?.usd
  if (!t || !u) return null
  return {
    output: t.output,
    inputNew: t.input + t.cacheWrite,
    reused: t.cacheRead,
    hitRate: (t.input + t.cacheRead + t.cacheWrite) > 0
      ? t.cacheRead / (t.input + t.cacheRead + t.cacheWrite) : 0,
    savedUsd: u.saved,
  }
})

/** 写出来的字占总量多少 —— 用来点明「量大不等于花得多」。 */
const outputShare = computed(() => {
  const s = spendBreakdown.value
  if (!s) return '—'
  const all = s.output + s.inputNew + s.reused
  if (all <= 0) return '—'
  const pct = (s.output / all) * 100
  return pct < 0.1 ? '不到 0.1%' : `${pct.toFixed(1)}%`
})

/**
 * 这段区间一条记录都没有时,要说清"为什么是 0"。
 * 光摆一排 0 会让人以为页面坏了(0902 负责人就这么误判过一次:
 * 「为什么近7天和近30天没有数据?但是近90天有?」——其实那个项目最后一次活动在 54 天前)。
 */
const emptyReason = computed(() => {
  if (!usage.value) return null
  const hasClaude = (usage.value.byDay?.length ?? 0) > 0
  const hasCodex = (codex.value?.byDay?.length ?? 0) > 0
  const hasDeepseek = (deepseek.value?.totals.jobs ?? 0) > 0
  const hasGlm = (glm.value?.totals.jobs ?? 0) > 0
  if (hasClaude || hasCodex || hasDeepseek || hasGlm) return null
  return `这个项目近 ${days.value} 天没有任何对话记录,所以下面都是 0。换更长的区间看看,或者确认最近是不是没在这个项目上干活。`
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
        <h1><Icon name="coins" class="head-ic" :size="20" />成本监管</h1>
        <p class="page-subtitle">
          本机流水：Claude 显示 API 直购等价估算，DeepSeek 显示按价目折算的人民币，
          GLM 显示套餐积分，Codex 显示输入/输出用量。不同单位不相加，异机记录不在本账。
        </p>
      </div>
      <div class="range-picker" role="group" aria-label="成本范围与时间">
        <button class="btn btn-sm range-btn" :class="{ active: scope === 'all' }" :aria-pressed="scope === 'all'" @click="scope = 'all'">全部项目</button>
        <button class="btn btn-sm range-btn" :class="{ active: scope === 'project' }" :aria-pressed="scope === 'project'" @click="scope = 'project'">当前项目</button>
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

    <div v-else-if="loading && !usage && !portfolio" class="card loading-state" aria-label="正在加载成本数据">
      <div class="skel wide" />
      <div class="summary-skeleton">
        <div v-for="index in 5" :key="index" class="skel block" />
      </div>
      <div class="skel medium" />
      <div class="skel wide" />
    </div>

    <template v-if="scope === 'all' && portfolio">
      <section class="overview">
        <h2>全部项目 · 近 {{ days }} 天</h2>
        <p class="fine">订阅制的 API 等价金额不是实付账单；GLM 积分在多单并行时只作参考。以下各类单位分别列示。</p>
        <div class="summary-cards portfolio-cards">
          <div class="card"><div class="v">${{ portfolio.totals.claudeUsd.toFixed(2) }}</div><div class="l">Claude API 等价估算</div></div>
          <div class="card"><div class="v">¥{{ portfolio.totals.deepseekRmb.toFixed(2) }}</div><div class="l">DeepSeek 按价目折算</div></div>
          <div class="card"><div class="v">{{ portfolio.totals.glmCreditJobs ? fmt(portfolio.totals.glmCredits) : '—' }}</div><div class="l">GLM 周窗积分差合计 · 参考</div></div>
          <div class="card"><div class="v">{{ portfolio.totals.codexBucketedTokens ? fmt(portfolio.totals.codexBuckets.output) : '—' }}</div><div class="l">Codex 输出 token</div></div>
        </div>
        <p v-if="portfolio.totals.glmUncertainCredits > 0 || portfolio.totals.unpricedModels.length" class="source-note">
          {{ portfolio.totals.glmUncertainCredits > 0 ? `其中 ${fmt(portfolio.totals.glmUncertainCredits)} GLM 积分无法精确归单；` : '' }}
          {{ portfolio.totals.unpricedModels.length ? `${portfolio.totals.unpricedModels.length} 个 Claude 模型暂无牌价，未计入美元。` : '' }}
        </p>
        <p v-if="portfolio.unassignedCodexTokens" class="source-note">另有 {{ fmt(portfolio.unassignedCodexTokens) }} Codex token 未归属到登记项目，已计入总量但未硬塞给某个项目。</p>
      </section>
      <section class="card portfolio-section">
        <h2>按项目对账</h2>
        <p class="fine">点项目名切入它的逐日、会话和工单明细。共用代码仓的工单成本只归第一项，避免合计重复。</p>
        <div class="table-scroll portfolio-scroll">
          <table class="portfolio-table">
            <thead><tr><th>项目</th><th>Claude API 等价</th><th>DeepSeek 人民币</th><th>GLM 积分</th><th>Codex token</th><th>口径提示</th></tr></thead>
            <tbody><tr v-for="row in portfolio.rows" :key="row.id">
              <td><button class="btn quiet btn-sm" @click="store.selectProject(row.id); scope = 'project'">{{ row.name }}</button></td>
              <td class="num">${{ row.claudeUsd.toFixed(2) }}</td>
              <td class="num">¥{{ row.deepseekRmb.toFixed(2) }}</td>
              <td class="num">{{ row.glm?.creditJobs ? fmt(row.glm.credits) : '—' }}</td>
              <td class="num">{{ fmt(row.codexTokens) }}</td>
              <td>{{ row.sharedDirs.length ? '共享对话目录；' : '' }}{{ row.sharedCodeRepo ? '共用代码仓；' : '' }}{{ row.duplicateName ? '项目同名，Codex 无法区分；' : '' }}{{ row.unpricedModels.length ? '有未计价模型' : '' }}</td>
            </tr></tbody>
          </table>
        </div>
      </section>
    </template>

    <template v-if="scope === 'project' && usage">
      <section class="overview">
        <h2>当前项目 · 近 {{ days }} 天</h2>
        <div class="summary-cards">
          <div class="card">
            <div class="v">${{ usage.usd.actual.toFixed(2) }}</div>
            <div class="l">Claude API 等价估算</div>
          </div>
          <div class="card">
            <div class="v">{{ glm?.totals.creditJobs ? fmt(glm.totals.credits) : '—' }}</div>
            <div class="l">GLM 周窗积分差 · 参考</div>
          </div>
          <div class="card">
            <div class="v">{{ codex?.selected.bucketedTokens ? fmt(codex.selected.buckets?.output ?? 0) : '—' }}</div>
            <div class="l">Codex 输出 token</div>
          </div>
          <div class="card">
            <div class="v">${{ usage.usd.saved.toFixed(2) }}</div>
            <div class="l">Claude 缓存折价省下 · 估算</div>
          </div>
          <div class="card">
            <div class="v">{{ fmt(usage.claudeTotals.output) }}</div>
            <div class="l">Claude 输出 token</div>
          </div>
          <div class="card">
            <div class="v">{{ usage.unpricedModels.length }}</div>
            <div class="l">未计价模型数 · 需留意</div>
          </div>
        </div>
      </section>

      <p class="source-note">
        当前项目及其工作副本共 {{ usage.dirs.length }} 个目录、{{ usage.sessions }} 个会话。
        <span v-if="glm?.totals.uncertainCredits">GLM 有 {{ fmt(glm.totals.uncertainCredits) }} 积分无法精确归单。</span>
        <span v-if="loading" class="badge info">正在刷新</span>
      </p>

      <!-- 区间内没有任何记录时说清原因,别让一排 0 看起来像页面坏了 -->
      <div v-if="emptyReason" class="card quiet-notice">
        <span class="badge n">这段时间没有记录</span>
        <span>{{ emptyReason }}</span>
      </div>

      <div class="cost-layout">
        <div class="cost-left">
          <section v-if="spendBreakdown" class="card claude-spend">
            <h2>Claude · 花销结构</h2>
            <p class="fine spend-note">
              用量与花销的单价差得很远:写出来的字最贵,读进去的新内容次之,
              重复用到的旧内容几乎不要钱。<b>所以总量大不等于花得多。</b>
            </p>
            <table class="spend-table">
              <thead><tr><th scope="col">类别</th><th scope="col">数值</th></tr></thead>
              <tbody>
                <tr><td>写出来的(最贵) · 占总量 {{ outputShare }}</td><td class="num">{{ fmt(spendBreakdown.output) }}</td></tr>
                <tr><td>读进去的新内容</td><td class="num">{{ fmt(spendBreakdown.inputNew) }}</td></tr>
                <tr><td>重复用到的旧内容(几乎不花钱)</td><td class="num">{{ fmt(spendBreakdown.reused) }}</td></tr>
                <tr><td>重复利用命中率 —— 越高越省</td><td class="num">{{ (spendBreakdown.hitRate * 100).toFixed(1) }}%</td></tr>
                <tr><td>靠重复利用省下的钱</td><td class="num saved-value">${{ usd0(spendBreakdown.savedUsd) }}</td></tr>
              </tbody>
            </table>
            <p class="fine">
              <Icon name="zap" :size="14" /> 折算口径:你实付的是订阅费——美元是「同样的量若按 API 牌价直购值多少钱」的等价参考
              (无缓存假想 ${{ usd0(usage.usd.noCache) }} − 折后 ${{ usd0(usage.usd.actual) }} = 净省 ${{ usd0(usage.usd.saved) }};牌价于 2026-09-23 对照官方表,后续变价需更新)。
            </p>
          </section>

          <section class="card glm-spend">
            <h2>GLM · 编程套餐额度</h2>
            <p class="fine">GLM 按套餐积分消耗，不把 token 乘 API 牌价冒充实际付款。积分取已落盘工单的周窗差值；并行时差值可能包含别的任务。</p>
            <div v-if="glm" class="glm-grid">
              <div><strong>{{ glm.totals.creditJobs ? fmt(glm.totals.credits) : '—' }}</strong><span>积分差 · {{ glm.totals.creditJobs }}/{{ glm.totals.jobs }} 单有读数</span></div>
              <div><strong>{{ fmt(glm.totals.input + glm.totals.cacheWrite) }}</strong><span>新输入与缓存写入</span></div>
              <div><strong>{{ fmt(glm.totals.output) }}</strong><span>输出</span></div>
              <div><strong>{{ fmt(glm.totals.cacheRead) }}</strong><span>缓存读取</span></div>
            </div>
            <p v-if="glm?.totals.uncertainCredits" class="fine">其中 {{ fmt(glm.totals.uncertainCredits) }} 积分无法精确归单，不能据此比较单卡效率。</p>
            <p v-if="glm?.totals.missingUsageJobs" class="fine">{{ glm.totals.missingUsageJobs }} 个首轮或续聊缺用量，token 小计不完整。</p>
          </section>

          <CodexCostSummary
            v-if="codex && quota"
            :codex="codex"
            :quota="quota"
            :days="days"
          />
          <div v-else class="empty card">
            <span class="ic"><Icon name="inbox" :size="36" animated /></span>
            Codex 汇总暂时不可用<br>
            <span class="empty-help">有可归属到当前项目的会话后，这里会出现 Claude、Codex 与合计摘要。</span>
          </div>

          <section class="card details-shell">
            <header class="details-head">
              <div>
                <h2>逐日与施工明细</h2>
                <p>近 {{ days }} 天的记录默认全部显示，各张长表可在面板内滚动查看。</p>
              </div>
            </header>

            <div class="details-content">
              <section v-if="deepseek && deepseek.totals.jobs > 0" class="detail-section">
                <h3>DeepSeek 按天</h3>
                <div class="table-scroll">
                  <table class="deepseek-daily-table">
                    <thead><tr><th scope="col">日期</th><th scope="col">消耗 token</th><th scope="col">按价目折算 · 人民币</th></tr></thead>
                    <tbody>
                      <tr v-for="row in deepseekDailyRows" :key="row.date">
                        <td class="mono">{{ row.date }}</td>
                        <td class="num">{{ row.tokens.toLocaleString() }}</td>
                        <td class="num">¥{{ row.costRmb.toFixed(2) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
              <section class="detail-section">
                <h3>按天</h3>
                <div v-if="!dailyRows.length" class="empty">
                  <span class="ic"><Icon name="calendar" :size="36" /></span>
                  期间没有逐日记录<br>
                  <span class="empty-help">本机产生 Claude 或 Codex 会话后，会按自然日列在这里。</span>
                </div>
                <div v-else class="table-scroll">
                  <table class="daily-table">
                    <thead>
                      <tr><th>日期</th><th>Claude 输入含缓存</th><th>Claude 输出</th><th>GLM 工单 token</th><th>Codex token</th><th>Claude API 等价</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in dailyRows" :key="row.date">
                        <td class="mono">{{ row.date }}</td>
                        <td class="num">{{ fmt(row.claudeInput) }}</td>
                        <td class="num">{{ fmt(row.claudeOutput) }}</td>
                        <td class="num">{{ fmt(row.glmTokens) }}</td>
                        <td class="num">{{ fmt(row.codexTokens) }}</td>
                        <td class="num">{{ row.usdActual === undefined ? '—' : '$' + usd0(row.usdActual) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <section class="detail-section">
                <h3>本机对话按模型（Claude / GLM / 未识别）</h3>
                <div v-if="!modelRows.length" class="empty">
                  <span class="ic"><Icon name="bot" :size="36" /></span>
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
                  <span class="ic"><Icon name="file" :size="36" /></span>
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

              <!-- COST-UI-SESSION-DETAIL:两张按行明细,各自拉自己的接口、带筛选与筛后合计 -->
              <SessionDetailTable :project-id="store.currentProjectId" :days="days" />
              <JobDetailTable :project-id="store.currentProjectId" :days="days" />
            </div>
          </section>
        </div>

        <DeepseekCostSummary
          :deepseek="deepseek"
          :balance="deepseekBalance"
          :days="days"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.page { width: 100%; min-width: 0; display: flex; flex-direction: column; gap: var(--s4); }
.page-head { display: flex; align-items: flex-start; gap: var(--s4); justify-content: space-between; }
.page-subtitle, .source-note, .fine, .details-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-md); }
.source-note { margin: 0; font-size: var(--fs-sm); }
.quiet-notice { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; padding: var(--s3) var(--s4); color: var(--text-2); font-size: var(--fs-base); }
.range-picker { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--s1); }
.range-btn.active { background: var(--surface-3); border-color: var(--line-strong); font-weight: 600; }
.error-state { display: flex; align-items: center; gap: var(--s3); color: var(--bad); }
.error-state > :nth-child(2) { flex: 1; }
.loading-state { display: flex; flex-direction: column; gap: var(--s4); padding: var(--s5); }
.overview { display: grid; gap: var(--s2); }
.summary-cards, .summary-skeleton { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--s2); }
.portfolio-cards { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.summary-cards .card { min-width: 0; padding: var(--s3); }
.summary-cards .v, .summary-reason { overflow-wrap: anywhere; }
.summary-reason { color: var(--text-2); font-size: var(--fs-base); }
.saved-value { color: var(--ok); }
.cost-layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); align-items: start; gap: var(--s4); }
.cost-left { display: grid; gap: var(--s4); min-width: 0; }
.portfolio-section { display: grid; gap: var(--s3); }
.portfolio-scroll { max-height: 460px; }
.portfolio-table { min-width: 960px; }
.portfolio-table th:not(:first-child), .portfolio-table td.num { text-align: right; }
.glm-spend { display: grid; gap: var(--s3); }
.glm-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s2); }
.glm-grid > div { display: flex; flex-direction: column; gap: var(--s1); min-width: 0; }
.glm-grid strong { font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
.glm-grid span { color: var(--text-2); font-size: var(--fs-sm); }
.claude-spend { display: grid; gap: var(--s3); background: var(--surface); }
.spend-note b { color: var(--text); font-weight: 600; }
.spend-table th:last-child { text-align: right; }
.spend-table td { overflow-wrap: anywhere; }
.skel.block { height: 76px; }
.skel.wide { width: 88%; }
.skel.medium { width: 56%; }
.fine { margin: 0; font-size: var(--fs-sm); line-height: 1.6; }
.details-shell { padding: 0; background: var(--surface); }
.details-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s4); padding: var(--s4); }
.details-head p { font-size: var(--fs-sm); }
.details-content { display: flex; flex-direction: column; gap: var(--s4); border-top: 1px solid var(--line); padding: var(--s4); }
.detail-section { min-width: 0; }
.detail-section h3 { margin-bottom: var(--s2); font-size: var(--fs-md); }
.table-scroll { max-width: 100%; max-height: 180px; overflow-x: auto; overflow-y: auto; }
.daily-table { min-width: 780px; }
.deepseek-daily-table { min-width: 420px; }
.model-table { min-width: 620px; }
.task-cost-table { min-width: 720px; }
.total-cell { font-weight: 600; }
.empty-help { font-size: var(--fs-sm); }
code { padding: var(--s1); border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface-2); color: var(--text-2); font-family: var(--mono); font-size: var(--fs-sm); }


@media (max-width: 1150px) { .cost-layout { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 700px) { .glm-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 900px) { .summary-cards, .portfolio-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 1150px) {
  .page-head, .details-head { flex-direction: column; align-items: stretch; }
  .range-picker { justify-content: flex-start; }
  .error-state { align-items: flex-start; flex-wrap: wrap; }
}
</style>
