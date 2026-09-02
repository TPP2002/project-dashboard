<script setup lang="ts">
import { computed } from 'vue'
import type { CodexUsage, CombinedUsage, QuotaSnapshot } from '@/types/codex'

const props = defineProps<{
  codex: CodexUsage
  combined: CombinedUsage
  quota: QuotaSnapshot
  days: number
}>()

function fmt(value: number) {
  if (value >= 1e8) return (value / 1e8).toFixed(2) + ' 亿'
  if (value >= 1e4) return (value / 1e4).toFixed(1) + ' 万'
  return value.toLocaleString()
}

function money(value: number | null) {
  return value == null ? '数据不足' : '$' + value.toFixed(2)
}

const projectRows = computed(() => {
  const sorted = [...props.codex.byProject].sort((a, b) => b.tokens - a.tokens)
  const visible = sorted.slice(0, 5)
  const rest = sorted.slice(5)
  if (rest.length) {
    visible.push({
      project: '其它',
      tokens: rest.reduce((sum, row) => sum + row.tokens, 0),
      sessions: rest.reduce((sum, row) => sum + row.sessions, 0),
    })
  }
  return visible
})
const maxProjectTokens = computed(() => Math.max(1, ...projectRows.value.map((row) => row.tokens)))
const quotaPercent = computed(() => props.quota.usedPercent == null
  ? 0
  : Math.max(0, Math.min(100, props.quota.usedPercent)))
</script>

<template>
  <section class="cost-summary">
    <div class="section-head">
      <h2>近 {{ days }} 天摘要</h2>
      <span class="badge n">token 口径</span>
    </div>

    <div class="summary-cards">
      <div class="card"><div class="v">{{ fmt(combined.claudeTokens) }}</div><div class="l">Claude 消耗</div></div>
      <div class="card"><div class="v">{{ fmt(combined.codexTokens) }}</div><div class="l">Codex 消耗</div></div>
      <div class="card"><div class="v">{{ fmt(combined.totalTokens) }}</div><div class="l">两者合计</div></div>
      <div class="card rough"><div class="v">{{ money(combined.savingsEstimateUsd) }}</div><div class="l">用 Codex 省下的 Claude 额度（粗估）</div></div>
    </div>

    <div class="card quota-card">
      <div class="quota-head">
        <div>
          <strong>Codex 额度</strong>
          <span>上一次活动时的快照</span>
        </div>
        <span class="quota-value">{{ quota.usedPercent == null ? '数据不足' : quota.usedPercent + '%' }}</span>
      </div>
      <div class="glow-rail" role="progressbar" aria-label="Codex 额度已用" :aria-valuenow="quota.usedPercent ?? undefined" aria-valuemin="0" aria-valuemax="100">
        <i :style="{ width: quotaPercent + '%' }" />
      </div>
    </div>

    <p class="fine">
      “省下”不是真实测量：同一件活若交给 Claude 会花多少并未发生，无法得知。粗估口径 = Codex token 数 × Claude 同期平均 API 等价单价；Claude 同期没有有效成本数据时不显示数字。
    </p>
    <p class="fine">Codex 按 session_meta 的 cwd 归项目；同日会话取尾部累计 token，跨日会话流式读取 token_count 并按累计值增量拆到各自然日，扫描时不会把整份 JSONL 装进内存。</p>

    <section class="project-section">
      <div class="section-head">
        <div>
          <h2>Codex 消耗按项目</h2>
          <p>最多列出前 5 个项目，其余合并为“其它”。</p>
        </div>
        <span class="badge n">{{ codex.byProject.length }} 个项目</span>
      </div>
      <div v-if="!projectRows.length" class="empty card">
        <span class="ic">📊</span>
        期间没有可归属的 Codex 会话<br>
        <span class="empty-help">会话带有可识别的工作目录后，就能在这里比较各项目消耗。</span>
      </div>
      <div v-else class="project-bars">
        <div v-for="row in projectRows" :key="row.project" class="project-row">
          <span class="project-name" :title="row.project">{{ row.project }}</span>
          <div class="project-track" aria-hidden="true">
            <i :style="{ width: (row.tokens / maxProjectTokens) * 100 + '%' }" />
          </div>
          <span class="project-value">{{ fmt(row.tokens) }}</span>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.cost-summary { min-width: 0; display: flex; flex-direction: column; gap: var(--s3); }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); }
.section-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-sm); }
.summary-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s2); }
.summary-cards .card { min-width: 0; background: var(--surface-2); }
.rough .v { overflow-wrap: anywhere; }
.quota-card { display: flex; flex-direction: column; gap: var(--s3); background: var(--surface); }
.quota-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--s3); }
.quota-head strong, .quota-head span { display: block; }
.quota-head strong { font-size: var(--fs-md); }
.quota-head div > span { color: var(--text-2); font-size: var(--fs-sm); }
.quota-value { flex: none; font-family: var(--mono); font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
.fine { margin: 0; color: var(--text-2); font-size: var(--fs-sm); line-height: 1.6; }
.project-section { min-width: 0; display: flex; flex-direction: column; gap: var(--s3); margin-top: var(--s5); }
.project-bars { display: flex; flex-direction: column; gap: var(--s2); }
.project-row { display: grid; grid-template-columns: minmax(110px, 180px) minmax(120px, 1fr) minmax(76px, auto); align-items: center; gap: var(--s3); font-size: var(--fs-base); }
.project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-track { height: var(--s2); overflow: hidden; border-radius: var(--r-sm); background: var(--surface-3); }
.project-track i { display: block; height: 100%; border-radius: var(--r-sm); background: var(--text-2); }
.project-value { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.empty-help { font-size: var(--fs-sm); }

@media (max-width: 820px) {
  .summary-cards { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 560px) {
  .project-row { grid-template-columns: minmax(88px, 1fr) minmax(72px, 2fr) auto; gap: var(--s2); }
}
</style>
