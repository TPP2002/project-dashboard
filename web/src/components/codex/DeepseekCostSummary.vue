<script setup lang="ts">
import { computed } from 'vue'
import type { DeepseekUsage } from '@/types/codex'

const props = defineProps<{ deepseek: DeepseekUsage; days: number }>()
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
    </div>
    <div class="card model-card">
      <h3>按模型花费</h3>
      <dl class="model-list">
        <div v-for="[model, row] in modelRows" :key="model" class="model-row">
          <dt>{{ model }}</dt>
          <dd>{{ money(row.costRmb) }}</dd>
        </div>
      </dl>
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
.summary-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s2); }
.summary-cards .card { min-width: 0; background: var(--surface-2); }
.summary-cards .v { overflow-wrap: anywhere; }
.model-card h3 { margin: 0 0 var(--s2); font-size: var(--fs-md); }
.model-list { margin: 0; display: flex; flex-direction: column; gap: var(--s2); }
.model-row { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: var(--s2); }
.model-row dt { overflow-wrap: anywhere; }
.model-row dd { margin: 0; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.fine { margin: 0; color: var(--text-2); font-size: var(--fs-sm); line-height: 1.6; }
@media (max-width: 560px) {
  .summary-cards { grid-template-columns: 1fr; }
}
</style>
