<script setup lang="ts">
import Icon from '@/components/Icon.vue'
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

const OTHER = '其它'

/**
 * 后端已经把匹配不上任何项目的会话合并成一条叫「其它」的记录,
 * 这里再按 top5 收拢时**必须并进那一条**,不能另起一条同名的 ——
 * 两条同名会让列表 key 撞车,页面上就会冒出重复的「其它」(0902 实测踩到)。
 */
const projectRows = computed(() => {
  const sorted = [...props.codex.byProject].sort((a, b) => b.tokens - a.tokens)
  const named = sorted.filter((row) => row.project !== OTHER)
  const others = sorted.filter((row) => row.project === OTHER)

  const visible = named.slice(0, 5)
  const rest = [...named.slice(5), ...others]
  if (rest.length) {
    visible.push({
      project: OTHER,
      tokens: rest.reduce((sum, row) => sum + row.tokens, 0),
      sessions: rest.reduce((sum, row) => sum + row.sessions, 0),
    })
  }
  return visible
})
const quotaPercent = computed(() => props.quota.usedPercent == null
  ? 0
  : Math.max(0, Math.min(100, props.quota.usedPercent)))
</script>

<template>
  <section class="card cost-summary">
    <div class="section-head">
      <h2>Codex · 消耗按项目</h2>
      <span class="badge n">token 口径</span>
    </div>
    <p class="fine">近 {{ days }} 天的用量摘要与项目分布。</p>

    <div class="summary-cards">
      <div class="card"><div class="v">{{ fmt(combined.claudeTokens) }}</div><div class="l">Claude 消耗</div></div>
      <div class="card"><div class="v">{{ fmt(combined.codexTokens) }}</div><div class="l">Codex 消耗</div></div>
      <div class="card"><div class="v">{{ fmt(combined.totalTokens) }}</div><div class="l">两者合计</div></div>
      <div class="card rough"><div class="v">{{ money(combined.savingsEstimateUsd) }}</div><div class="l">用 Codex 省下的 Claude 额度（粗估）</div></div>
    </div>

    <div class="wide-pair">
      <div class="card quota-card">
        <div class="quota-head">
          <div>
            <strong>Codex 额度</strong>
            <span>上一次活动时的快照</span>
          </div>
          <span class="quota-value">{{ quota.usedPercent == null ? '数据不足' : quota.usedPercent + '%' }}</span>
        </div>
        <div class="glow-rail quota-rail" role="progressbar" aria-label="Codex 额度已用" :aria-valuenow="quota.usedPercent ?? undefined" aria-valuemin="0" aria-valuemax="100">
          <i :style="{ width: quotaPercent + '%' }" />
        </div>
      </div>

      <section class="project-section">
        <div class="section-head">
          <div>
            <p>最多列出前 5 个项目，其余合并为“其它”。</p>
          </div>
          <span class="badge n">{{ codex.byProject.length }} 个项目</span>
        </div>
        <div v-if="!projectRows.length" class="empty card">
          <span class="ic"><Icon name="chart" :size="36" /></span>
          期间没有可归属的 Codex 会话<br>
          <span class="empty-help">会话带有可识别的工作目录后，就能在这里比较各项目消耗。</span>
        </div>
        <div v-else class="project-scroll">
          <table class="project-table">
            <thead><tr><th scope="col">项目名</th><th scope="col">token 数</th></tr></thead>
            <tbody>
              <tr v-for="row in projectRows" :key="row.project">
                <td class="project-name" :title="row.project">{{ row.project }}</td>
                <td class="num project-value" :title="row.tokens.toLocaleString() + ' token'">{{ fmt(row.tokens) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <p class="fine">
      “省下”不是真实测量：同一件活若交给 Claude 会花多少并未发生，无法得知。粗估口径 = Codex token 数 × Claude 同期平均 API 等价单价；Claude 同期没有有效成本数据时不显示数字。
    </p>
    <p class="fine">Codex 按 session_meta 的 cwd 归项目；同日会话取尾部累计 token，跨日会话流式读取 token_count 并按累计值增量拆到各自然日，扫描时不会把整份 JSONL 装进内存。</p>

  </section>
</template>

<style scoped>
.cost-summary { min-width: 0; display: flex; flex-direction: column; gap: var(--s3); background: var(--surface); }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); }
.section-head p { margin: var(--s1) 0 0; color: var(--text-2); font-size: var(--fs-sm); }
.summary-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s2); }
.summary-cards .card { min-width: 0; background: var(--surface-2); }
.summary-cards .v { overflow-wrap: anywhere; }
.quota-card { display: flex; flex-direction: column; gap: var(--s3); background: var(--surface); }
.quota-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--s3); }
.quota-head strong, .quota-head span { display: block; }
.quota-head strong { font-size: var(--fs-md); }
.quota-head div > span { color: var(--text-2); font-size: var(--fs-sm); }
.quota-value { flex: none; font-family: var(--mono); font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
.fine { margin: 0; color: var(--text-2); font-size: var(--fs-sm); line-height: 1.6; }
/* 额度条与「按项目消耗」并排，每列不窄于 520；窄屏自动落回上下堆叠。 */
.wide-pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(520px, 100%), 1fr)); align-items: start; gap: var(--s3); }
.project-section { min-width: 0; display: flex; flex-direction: column; gap: var(--s3); }
.project-scroll { max-width: 100%; max-height: 180px; overflow-x: auto; overflow-y: auto; }
.project-table { table-layout: fixed; }
.project-table th:first-child { width: 65%; }
.project-table th:last-child { text-align: right; }
.project-name { overflow-wrap: anywhere; }
.project-value { white-space: nowrap; }
.empty-help { font-size: var(--fs-sm); }

@media (max-width: 1150px) {
  .summary-cards { grid-template-columns: 1fr 1fr; }
}
</style>
