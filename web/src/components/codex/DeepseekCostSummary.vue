<script setup lang="ts">
import { computed } from 'vue'
import type { DeepseekBalance, DeepseekUsage } from '@/types/codex'

const props = defineProps<{ deepseek: DeepseekUsage; days: number; balance?: DeepseekBalance | null }>()
const modelRows = computed(() => Object.entries(props.deepseek.byModel)
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
  <section class="deepseek-summary">
    <div class="section-head">
      <h2>DeepSeek · 近 {{ days }} 天</h2>
      <span class="badge n">{{ deepseek.totals.jobs }} 个工单</span>
    </div>
    <div class="summary-cards">
      <div class="card">
        <div class="v" :title="deepseek.totals.tokens.toLocaleString() + ' token'">{{ fmt(deepseek.totals.tokens) }}</div>
        <div class="l">DeepSeek 消耗 token</div>
      </div>
      <div class="card">
        <div class="v">{{ money(deepseek.totals.costRmb) }}</div>
        <div class="l">真实花费 · 人民币</div>
      </div>
      <div class="card balance-card">
        <div class="l">实时余额 · 人民币</div>
        <template v-if="balance?.available && balance.balance !== null">
          <div class="v">{{ money(balance.balance) }}</div>
          <p class="fine">查询于 <time :datetime="balance.sampledAt">{{ sampledTime(balance.sampledAt) }}</time></p>
        </template>
        <p v-else class="fine balance-unavailable" role="status">{{ balance?.reason || '余额暂不可用' }}</p>
        <p class="fine">当前账户余额，不受项目和天数筛选影响。</p>
      </div>
    </div>
    <p v-if="deepseek.totals.jobs === 0" class="fine">近 {{ days }} 天没有 DeepSeek 工单</p>
    <div v-if="modelRows.length" class="card model-card">
      <h3>按模型花费</h3>
      <dl class="model-list">
        <div v-for="[model, row] in modelRows" :key="model" class="model-row">
          <dt>{{ model }}</dt>
          <dd>{{ money(row.costRmb) }}</dd>
        </div>
      </dl>
    </div>
    <div class="usage-structure">
      <h3>用量结构</h3>
      <div class="summary-cards spend-cards">
        <div class="card">
          <div class="v" :title="deepseek.totals.input.toLocaleString() + ' token'">{{ fmt(deepseek.totals.input) }}</div>
          <div class="l">输入（缓存未命中）</div>
        </div>
        <div class="card">
          <div class="v" :title="deepseek.totals.output.toLocaleString() + ' token'">{{ fmt(deepseek.totals.output) }}</div>
          <div class="l">输出</div>
        </div>
        <div class="card">
          <div class="v" :title="deepseek.totals.cacheRead.toLocaleString() + ' token'">{{ fmt(deepseek.totals.cacheRead) }}</div>
          <div class="l">缓存读取（命中）</div>
        </div>
        <div class="card">
          <div class="v" :title="deepseek.totals.cacheWrite.toLocaleString() + ' token'">{{ fmt(deepseek.totals.cacheWrite) }}</div>
          <div class="l">缓存写入</div>
        </div>
        <div class="card">
          <div class="v">{{ (deepseek.totals.cacheHitRate * 100).toFixed(1) }}%</div>
          <div class="l">缓存命中率</div>
        </div>
      </div>
      <p class="fine">缓存读取按命中价计费；输入和缓存写入按未命中价计费。命中率只统计输入与缓存，不计输出。</p>
    </div>
    <p class="fine">
      按实际用量与官方人民币价目计算，区分缓存命中和未命中。
      北京时间周一至周五 9:00–12:00、14:00–18:00 为高峰，其余时段半价；以工单开始时刻近似整单计费时段。
      每日明细按本地日期归集，可在下方“逐日与施工明细”展开查看。
    </p>
  </section>
</template>

<style scoped>
.deepseek-summary { min-width: 0; display: flex; flex-direction: column; gap: var(--s3); }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); flex-wrap: wrap; }
.summary-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s2); }
.summary-cards .card { min-width: 0; background: var(--surface-2); }
.summary-cards .v { overflow-wrap: anywhere; }
.balance-card { display: flex; flex-direction: column; gap: var(--s1); }
.balance-unavailable { padding: var(--s2); border: 1px solid var(--line); border-radius: var(--r-sm); overflow-wrap: anywhere; }
.model-card h3, .usage-structure h3 { margin: 0 0 var(--s2); font-size: var(--fs-md); }
.usage-structure { display: flex; flex-direction: column; gap: var(--s2); }
.spend-cards { grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); }
.spend-cards .v { font-size: var(--fs-lg); }
.model-list { margin: 0; display: flex; flex-direction: column; gap: var(--s2); }
.model-row { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: var(--s2); }
.model-row dt { overflow-wrap: anywhere; }
.model-row dd { margin: 0; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.fine { margin: 0; color: var(--text-2); font-size: var(--fs-sm); line-height: 1.6; }
@media (max-width: 560px) {
  .summary-cards { grid-template-columns: 1fr; }
}
</style>
