<script setup lang="ts">
import { computed } from 'vue'
import type { DeepseekBalance, DeepseekUsage } from '@/types/codex'

const props = defineProps<{ deepseek: DeepseekUsage | null; days: number; balance?: DeepseekBalance | null }>()
const modelRows = computed(() => Object.entries(props.deepseek?.byModel ?? {})
  .sort((a, b) => b[1].costRmb - a[1].costRmb))

function fmt(value: number) {
  if (value >= 1e8) return (value / 1e8).toFixed(2) + ' 亿'
  if (value >= 1e4) return (value / 1e4).toFixed(1) + ' 万'
  return value.toLocaleString()
}

function money(value: number) {
  return '¥' + value.toFixed(2)
}

function sampledTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <section class="card deepseek-summary">
    <div class="section-head">
      <h2>DeepSeek · 实时监控</h2>
    </div>
    <div class="balance-card">
      <div class="fine">实时余额 · 人民币</div>
      <div v-if="balance?.available && balance.balance !== null" class="balance-value">{{ money(balance.balance) }}</div>
      <p v-else class="fine balance-unavailable" role="status">{{ balance?.reason || '余额暂不可用' }}</p>
      <p v-if="balance?.sampledAt" class="fine">查询于 <time :datetime="balance.sampledAt">{{ sampledTime(balance.sampledAt) }}</time></p>
    </div>
    <dl v-if="deepseek" class="metric-list">
      <div class="metric-row"><dt>近 {{ days }} 天已花 · 人民币</dt><dd>{{ money(deepseek.totals.costRmb) }}</dd></div>
      <div class="metric-row"><dt>缓存命中率</dt><dd>{{ (deepseek.totals.cacheHitRate * 100).toFixed(1) }}%</dd></div>
      <div class="metric-row"><dt>DeepSeek 消耗 token</dt><dd :title="deepseek.totals.tokens.toLocaleString() + ' token'">{{ fmt(deepseek.totals.tokens) }}</dd></div>
      <div class="metric-row"><dt>工单数</dt><dd>{{ deepseek.totals.jobs }}</dd></div>
    </dl>
    <p v-if="!deepseek || deepseek.totals.jobs === 0" class="fine">近 {{ days }} 天没有 DeepSeek 工单</p>
    <div v-if="deepseek" class="usage-structure">
      <h3>用量结构</h3>
      <dl class="metric-list">
        <div class="metric-row"><dt>输入（缓存未命中）</dt><dd :title="deepseek.totals.input.toLocaleString() + ' token'">{{ fmt(deepseek.totals.input) }}</dd></div>
        <div class="metric-row"><dt>输出</dt><dd :title="deepseek.totals.output.toLocaleString() + ' token'">{{ fmt(deepseek.totals.output) }}</dd></div>
        <div class="metric-row"><dt>缓存读取（命中）</dt><dd :title="deepseek.totals.cacheRead.toLocaleString() + ' token'">{{ fmt(deepseek.totals.cacheRead) }}</dd></div>
        <div class="metric-row"><dt>缓存写入</dt><dd :title="deepseek.totals.cacheWrite.toLocaleString() + ' token'">{{ fmt(deepseek.totals.cacheWrite) }}</dd></div>
      </dl>
    </div>
    <div v-if="modelRows.length" class="model-card">
      <h3>按模型花费</h3>
      <dl class="model-list">
        <div v-for="[model, row] in modelRows" :key="model" class="model-row">
          <dt>{{ model }}</dt>
          <dd>{{ money(row.costRmb) }}</dd>
        </div>
      </dl>
    </div>
    <div class="summary-notes">
      <p class="fine">当前账户余额，不受项目和天数筛选影响。</p>
      <p class="fine">缓存读取按命中价计费；输入和缓存写入按未命中价计费。命中率只统计输入与缓存，不计输出。</p>
      <p class="fine">
        按实际用量与官方人民币价目计算，区分缓存命中和未命中。
        北京时间周一至周五 9:00–12:00、14:00–18:00 为高峰，其余时段半价；以工单开始时刻近似整单计费时段。
        每日明细按本地日期归集，可在“逐日与施工明细”查看。
      </p>
    </div>
  </section>
</template>

<style scoped>
.deepseek-summary { position: sticky; top: var(--s4); min-width: 0; max-height: calc(100vh - var(--s4) * 2); overflow-y: auto; display: flex; flex-direction: column; gap: var(--s3); padding: var(--s4); background: var(--ok-bg); }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); flex-wrap: wrap; }
.section-head h2, .balance-value { color: var(--ok); }
.balance-card { display: flex; flex-direction: column; gap: var(--s1); }
.balance-value { font-family: var(--mono); font-size: var(--fs-2xl); font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; overflow-wrap: anywhere; }
.balance-unavailable { padding: var(--s2); border: 1px solid var(--line); border-radius: var(--r-sm); overflow-wrap: anywhere; }
.model-card h3, .usage-structure h3 { margin: 0 0 var(--s2); font-size: var(--fs-md); }
.usage-structure, .model-card, .summary-notes { border-top: 1px solid var(--line); padding-top: var(--s3); }
.summary-notes { display: grid; gap: var(--s2); }
.model-list, .metric-list { margin: 0; display: flex; flex-direction: column; gap: var(--s2); font-size: var(--fs-sm); }
.model-row, .metric-row { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: var(--s2); }
.model-row dt, .metric-row dt { color: var(--text-2); overflow-wrap: anywhere; }
.model-row dd, .metric-row dd { margin: 0; font-family: var(--mono); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.fine { margin: 0; color: var(--text-2); font-size: var(--fs-sm); line-height: 1.6; }
</style>
