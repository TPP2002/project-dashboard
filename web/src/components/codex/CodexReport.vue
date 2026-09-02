<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { CodexReport, QuotaSnapshot } from '@/types/codex'

const props = defineProps<{ refreshKey: number }>()
const emit = defineEmits<{ openJob: [slug: string] }>()
const days = ref<1 | 7>(1)
const report = ref<CodexReport | null>(null)
const quota = ref<QuotaSnapshot | null>(null)
const loading = ref(false)
const error = ref('')
const quotaPercent = computed(() => report.value?.quotaUsedPercent == null
  ? 0
  : Math.max(0, Math.min(100, report.value.quotaUsedPercent)))

function fmt(value: number) {
  if (value >= 1e8) return (value / 1e8).toFixed(2) + ' 亿'
  if (value >= 1e4) return (value / 1e4).toFixed(1) + ' 万'
  return value.toLocaleString()
}

function formatAt(value?: string | null) {
  if (!value) return '暂无记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

async function load() {
  if (loading.value) return
  loading.value = true
  try {
    const [reportResponse, quotaResponse] = await Promise.all([
      fetch(`/api/codex/report?days=${days.value}`),
      fetch('/api/codex/quota'),
    ])
    const reportBody = await reportResponse.json()
    const quotaBody = await quotaResponse.json()
    if (!reportResponse.ok) throw new Error(reportBody.error || '读取战报失败')
    if (!quotaResponse.ok) throw new Error(quotaBody.error || '读取额度失败')
    report.value = reportBody
    quota.value = quotaBody
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { loading.value = false }
}

function selectDays(value: 1 | 7) {
  if (days.value === value) return
  days.value = value
  load()
}

onMounted(load)
watch(() => props.refreshKey, load)
</script>

<template>
  <section class="report card">
    <header class="report-head">
      <div><h2>昨夜战报</h2><p>{{ days === 1 ? '最近 24 小时' : '最近 7 天' }}</p></div>
      <div class="seg">
        <button class="btn quiet btn-sm" :class="{ on: days === 1 }" @click="selectDays(1)">24 小时</button>
        <button class="btn quiet btn-sm" :class="{ on: days === 7 }" @click="selectDays(7)">7 天</button>
      </div>
    </header>
    <p v-if="error" class="err">⚠️ {{ error }}</p>
    <div v-if="report" class="numbers">
      <div class="card metric-card"><strong>{{ report.dispatched }}</strong><span>派出</span></div>
      <div class="card metric-card"><strong>{{ report.passed }}</strong><span>通过</span></div>
      <div class="card metric-card"><strong>{{ report.rejected }}</strong><span>驳回</span></div>
      <div class="card metric-card"><strong>{{ report.running }}</strong><span>还在跑</span></div>
      <div class="card metric-card"><strong :class="{ 'quota-red': report.stalled > 0 }">{{ report.stalled }}</strong><span>失联</span></div>
      <div class="card metric-card"><strong>{{ fmt(report.tokensUsed) }}</strong><span>token</span></div>
      <div class="card metric-card"><strong :class="`quota-${report.quotaBand}`">{{ report.quotaUsedPercent == null ? '—' : report.quotaUsedPercent + '%' }}</strong><span>额度已用</span></div>
    </div>
    <div v-if="report" class="quota-progress">
      <div class="quota-head"><span>Codex 额度快照</span><span class="mono">{{ report.quotaUsedPercent == null ? '数据不足' : report.quotaUsedPercent + '%' }}</span></div>
      <div class="glow-rail" role="progressbar" aria-label="Codex 额度已用" :aria-valuenow="report.quotaUsedPercent ?? undefined" aria-valuemin="0" aria-valuemax="100">
        <i :style="{ width: quotaPercent + '%' }" />
      </div>
    </div>
    <div v-else-if="loading" class="report-loading" aria-label="正在整理昨夜战况">
      <div class="skel wide" /><div class="skel medium" /><div class="skel wide" />
    </div>
    <div v-else-if="!error" class="empty">
      <span class="ic">📭</span>还没有可汇总的 Codex 活动<br>
      <span class="empty-help">派出工单或产生会话后，战报和额度快照会出现在这里。</span>
    </div>

    <div class="rejected">
      <h3>需要处理</h3>
      <p v-if="report && !report.rejectedJobs.length && !report.stalledJobs.length" class="ok">✅ 没有需要处理的</p>
      <!-- 失联的排在驳回前面:驳回至少是有结论的，失联是「以为还有人在干、其实早没了」，更耽误事。 -->
      <button v-for="job in report?.stalledJobs || []" :key="'stalled-' + job.slug" class="row attention-row stalled" @click="emit('openJob', job.slug)">
        <strong>🚨 {{ job.title }}</strong>
        <span>{{ job.reason }}<template v-if="job.lastActivityAt">（最后一次动静：{{ formatAt(job.lastActivityAt) }}）</template></span>
      </button>
      <button v-for="job in report?.rejectedJobs || []" :key="job.slug" class="row attention-row" @click="emit('openJob', job.slug)">
        <strong>{{ job.title }}</strong><span>{{ job.reason }}</span>
      </button>
    </div>

    <div class="quota-note">
      <p><b>最近一次活动：</b>{{ formatAt(report?.lastActivityAt) }}；<b>额度采样：</b>{{ formatAt(quota?.sampledAt) }}；<b>最晚重置：</b>{{ quota?.resetsAtLocal || '未知' }}</p>
      <p>这个百分比是<strong>上一次 Codex 跑活时的快照</strong>，不是实时值。</p>
      <p><code>resets_at</code> 是<strong>最晚重置时刻</strong>；官方近期常手动为全体用户提前重置，且重置后从重置当日重新计 7 天，所以实际重置往往早于这个时间——但提前不可预测，不能指望。</p>
    </div>
  </section>
</template>

<style scoped>
.report { min-width: 0; padding: var(--s4); background: var(--surface); box-shadow: none; }
.report-head { display: flex; align-items: center; gap: var(--s3); }
.report-head > div:first-child { flex: 1; }
.report-head h2 { font-size: var(--fs-lg); }
.report-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-sm); }
.seg { display: flex; gap: var(--s1); padding: var(--s1); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2); }
.seg .on { background: var(--surface); color: var(--text); border-color: var(--line-strong); font-weight: 600; }
.numbers { display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: var(--s2); margin-top: var(--s3); }
.metric-card { padding: var(--s2) var(--s3); background: var(--surface-2); box-shadow: none; }
.metric-card strong, .metric-card span { display: block; }
.metric-card strong { font-family: var(--mono); font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
.metric-card span { margin-top: var(--s1); color: var(--text-2); font-size: var(--fs-xs); }
.quota-green { color: var(--ok); }
.quota-yellow { color: var(--warn); }
.quota-red { color: var(--bad); }
.quota-progress { display: flex; flex-direction: column; gap: var(--s2); margin-top: var(--s3); }
.quota-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); color: var(--text-2); font-size: var(--fs-sm); }
.report-loading { display: flex; flex-direction: column; gap: var(--s3); margin-top: var(--s4); }
.skel.wide { width: 86%; }
.skel.medium { width: 54%; }
.empty-help { font-size: var(--fs-sm); }
.rejected { display: flex; flex-direction: column; gap: var(--s2); margin-top: var(--s4); }
.rejected h3 { margin-bottom: var(--s1); color: var(--text-2); font-size: var(--fs-md); }
.attention-row { width: 100%; align-items: flex-start; flex-direction: column; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.attention-row strong { font-size: var(--fs-base); }
.attention-row span { color: var(--text-2); font-size: var(--fs-sm); }
.attention-row.stalled { border-color: var(--bad); }
.attention-row.stalled strong { color: var(--bad); }
.ok { margin: 0; color: var(--ok); font-size: var(--fs-sm); }
.quota-note { margin-top: var(--s3); color: var(--text-3); font-size: var(--fs-xs); line-height: 1.55; }
.quota-note p { margin: var(--s1) 0; }
code { font-family: var(--mono); }
.err { color: var(--bad); }
@media (max-width: 900px) { .numbers { grid-template-columns: repeat(3, 1fr); } }
</style>
