<script setup lang="ts">
import type { CodexUsage, CombinedUsage, QuotaSnapshot } from '@/types/codex'

defineProps<{
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
</script>

<template>
  <section class="codex-cost">
    <div class="section-title">Claude + Codex · 近 {{ days }} 天</div>
    <div class="summary-cards">
      <div class="summary-card">
        <strong>{{ fmt(combined.claudeTokens) }}</strong>
        <span>Claude 消耗 token</span>
      </div>
      <div class="summary-card">
        <strong>{{ fmt(combined.codexTokens) }}</strong>
        <span>Codex 消耗 token（当前项目）</span>
        <small>额度快照：{{ quota.usedPercent == null ? '未知' : quota.usedPercent + '%' }}</small>
      </div>
      <div class="summary-card">
        <strong>{{ fmt(combined.totalTokens) }}</strong>
        <span>两者合计 token</span>
      </div>
      <div class="summary-card rough">
        <strong>{{ money(combined.savingsEstimateUsd) }}</strong>
        <span>用 Codex 省下的 Claude 额度（粗估）</span>
      </div>
    </div>
    <p class="fine">
      “省下”不是真实测量：同一件活若交给 Claude 会花多少并未发生，无法得知。粗估口径 = Codex token 数 × Claude 同期平均 API 等价单价；Claude 同期没有有效成本数据时不显示数字。
    </p>
    <p class="fine">Codex 按 session_meta 的 cwd 归项目；同日会话取尾部累计 token，跨日会话流式读取 token_count 并按累计值增量拆到各自然日，扫描时不会把整份 JSONL 装进内存。</p>

    <div class="usage-grid">
      <div>
        <h3>Codex 按项目</h3>
        <div v-if="!codex.byProject.length" class="muted">期间没有 Codex 会话</div>
        <div v-for="row in codex.byProject" :key="row.project" class="usage-row">
          <span>{{ row.project }}</span><b class="mono">{{ fmt(row.tokens) }}</b>
        </div>
      </div>
      <div>
        <h3>Codex 按天 / 项目</h3>
        <div v-if="!codex.byDay.length" class="muted">期间没有 Codex 会话</div>
        <div v-for="row in [...codex.byDay].reverse()" :key="row.date" class="day-row">
          <div><span class="mono">{{ row.date }}</span><b class="mono">{{ fmt(row.tokens) }}</b></div>
          <p>
            <span v-for="(tokens, project) in row.projects" :key="project">{{ project }} {{ fmt(tokens) }}</span>
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.codex-cost { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); }
.section-title { color: var(--muted-2); font-size: 12px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; }
.summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.summary-card { display: flex; min-width: 0; flex-direction: column; gap: 3px; padding: 10px; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); background: var(--bg-soft); }
.summary-card strong { font: 700 19px var(--mono); }
.summary-card span { color: var(--muted); font-size: 11px; }
.summary-card small { color: var(--accent); font-size: 10px; }
.summary-card.rough strong { color: var(--ok); }
.fine { margin: 0; color: var(--muted-2); font-size: 11px; line-height: 1.55; }
.usage-grid { display: grid; grid-template-columns: 1fr 1.4fr; gap: 16px; border-top: 1px solid var(--border-soft); padding-top: 10px; }
h3 { margin-bottom: 6px; color: var(--muted); font-size: 12px; }
.usage-row, .day-row > div { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--border-soft); font-size: 12px; }
.day-row p { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 3px 0 7px; color: var(--muted-2); font-size: 10px; }
.muted { color: var(--muted); font-size: 12px; }
@media (max-width: 760px) { .usage-grid { grid-template-columns: 1fr; } }
</style>
