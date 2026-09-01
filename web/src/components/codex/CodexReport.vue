<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { CodexReport, QuotaSnapshot } from '@/types/codex'

const props = defineProps<{ refreshKey: number }>()
const emit = defineEmits<{ openJob: [slug: string] }>()
const days = ref<1 | 7>(1)
const report = ref<CodexReport | null>(null)
const quota = ref<QuotaSnapshot | null>(null)
const loading = ref(false)
const error = ref('')

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
        <button :class="{ on: days === 1 }" @click="selectDays(1)">24 小时</button>
        <button :class="{ on: days === 7 }" @click="selectDays(7)">7 天</button>
      </div>
    </header>
    <p v-if="error" class="err">⚠️ {{ error }}</p>
    <div v-if="report" class="numbers">
      <div><strong>{{ report.dispatched }}</strong><span>派出</span></div>
      <div><strong>{{ report.passed }}</strong><span>通过</span></div>
      <div><strong>{{ report.rejected }}</strong><span>驳回</span></div>
      <div><strong>{{ report.running }}</strong><span>还在跑</span></div>
      <div><strong>{{ fmt(report.tokensUsed) }}</strong><span>token</span></div>
      <div><strong :class="`quota-${report.quotaBand}`">{{ report.quotaUsedPercent == null ? '—' : report.quotaUsedPercent + '%' }}</strong><span>额度已用</span></div>
    </div>
    <div v-else-if="loading" class="muted">整理昨夜战况…</div>

    <div class="rejected">
      <h3>需要处理的驳回</h3>
      <p v-if="report && !report.rejectedJobs.length" class="ok">✅ 没有需要处理的</p>
      <button v-for="job in report?.rejectedJobs || []" :key="job.slug" @click="emit('openJob', job.slug)">
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
.report { padding: 14px; box-shadow: none; }
.report-head { display: flex; align-items: center; gap: 12px; }
.report-head > div:first-child { flex: 1; }
h2 { font-size: 15px; } .report-head p { margin: 2px 0 0; color: var(--muted); font-size: 11px; }
.seg { display: flex; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.seg button { border: 0; padding: 5px 10px; background: var(--panel); color: var(--muted); cursor: pointer; }
.seg button.on { background: var(--accent-soft); color: var(--text); font-weight: 600; }
.numbers { display: grid; grid-template-columns: repeat(6, minmax(85px, 1fr)); gap: 8px; margin-top: 12px; }
.numbers > div { padding: 9px; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); background: var(--bg-soft); }
.numbers strong, .numbers span { display: block; } .numbers strong { font: 700 18px var(--mono); }
.numbers span { margin-top: 3px; color: var(--muted); font-size: 10px; }
.quota-green { color: var(--ok); } .quota-yellow { color: var(--warn); } .quota-red { color: var(--danger); }
.rejected { margin-top: 12px; } .rejected h3 { margin-bottom: 6px; color: var(--muted); font-size: 12px; }
.rejected button { width: 100%; display: flex; gap: 10px; padding: 7px 9px; border: 1px solid var(--danger); border-radius: var(--radius-sm); background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.rejected button span { color: var(--muted); } .ok { margin: 0; color: var(--ok); font-size: 12px; }
.quota-note { margin-top: 10px; color: var(--muted-2); font-size: 10px; line-height: 1.5; }
.quota-note p { margin: 2px 0; } code { font-family: var(--mono); } .err { color: var(--danger); }
@media (max-width: 900px) { .numbers { grid-template-columns: repeat(3, 1fr); } }
</style>
