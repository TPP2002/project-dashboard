<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import { computed } from 'vue'
import type { CodexUsage, QuotaSnapshot } from '@/types/codex'

const props = defineProps<{
  codex: CodexUsage
  quota: QuotaSnapshot
  days: number
}>()

function fmt(value: number) {
  if (value >= 1e8) return (value / 1e8).toFixed(2) + ' 亿'
  if (value >= 1e4) return (value / 1e4).toFixed(1) + ' 万'
  return value.toLocaleString()
}

function cacheRate(input: number, cachedInput: number) {
  return Number.isFinite(input) && Number.isFinite(cachedInput)
    && input > 0 && cachedInput >= 0 && cachedInput <= input
    ? `${(cachedInput / input * 100).toFixed(1)}%` : '无法计算'
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
      <span class="badge n">订阅用量 · 非实付金额</span>
    </div>
    <p class="fine">上方四项是当前项目近 {{ days }} 天的用量；下方项目分布列全机可识别的 Codex 会话。</p>

    <div class="summary-cards">
      <div class="card"><div class="v">{{ codex.selected.bucketedTokens ? fmt(codex.selected.buckets?.input ?? 0) : '—' }}</div><div class="l">输入 token · 含缓存</div></div>
      <div class="card"><div class="v">{{ codex.selected.bucketedTokens ? fmt(codex.selected.buckets?.cachedInput ?? 0) : '—' }}</div><div class="l">其中缓存读取</div></div>
      <div class="card"><div class="v">{{ codex.selected.bucketedTokens ? fmt(codex.selected.buckets?.output ?? 0) : '—' }}</div><div class="l">输出 token</div></div>
      <div class="card"><div class="v">{{ fmt(codex.selected.tokens) }}</div><div class="l">总 token · 仅供核对</div></div>
    </div>

    <section class="model-section">
      <h3>当前项目 · 按模型缓存命中率</h3>
      <div v-if="codex.selected.byModel.length" class="project-scroll">
        <table class="model-table">
          <thead><tr><th>模型</th><th>输入（含缓存）</th><th>缓存读取</th><th>缓存命中率</th></tr></thead>
          <tbody>
            <tr v-for="row in codex.selected.byModel" :key="row.model">
              <td class="project-name">{{ row.model }}</td>
              <td class="num">{{ row.bucketedTokens ? fmt(row.buckets.input) : '—' }}</td>
              <td class="num">{{ row.bucketedTokens ? fmt(row.buckets.cachedInput) : '—' }}</td>
              <td class="num">{{ cacheRate(row.buckets.input, row.buckets.cachedInput) }}<span v-if="row.bucketedTokens < row.tokens" class="partial"> · 部分记录</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="fine">当前项目近 {{ days }} 天没有 Codex 模型记录。</p>
    </section>

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

    <p class="fine">输入包含缓存读取；两者是包含关系，不能再相加。订阅套餐没有按单实付金额，此处不把总 token 乘别家均价冒充账单。</p>
    <p v-if="(codex.selected.bucketedTokens ?? 0) < codex.selected.tokens" class="fine">部分旧会话只有总 token，没有输入/输出分桶；上方分桶是已识别部分，不能当完整账。</p>
    <p class="fine">按会话中识别到的模型归组；同一会话切换模型时，无法把每段用量精确拆给不同模型。</p>
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
.model-section { min-width: 0; display: flex; flex-direction: column; gap: var(--s2); }
.model-section h3 { margin: 0; font-size: var(--fs-md); }
.partial { color: var(--text-2); white-space: nowrap; }
.project-scroll { max-width: 100%; max-height: 180px; overflow-x: auto; overflow-y: auto; }
.model-table { min-width: 540px; }
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
