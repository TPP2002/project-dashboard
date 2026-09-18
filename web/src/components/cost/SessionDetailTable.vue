<script setup lang="ts">
/**
 * 对话明细(每个会话一行)—— COST-UI-SESSION-DETAIL。
 *
 * 【为什么筛选不发到组件里算】core/costSessionDetail.cjs 的筛选是纯函数,但浏览器
 * 不能直接加载 .cjs(vite 虚拟模块只圈了现有几个),所以筛选在 server 侧
 * (GET /api/cost/session-detail)调纯函数完成,这里只收表单、发请求、摆表格。
 * 候选项(options)由 server 从「未筛的全集」取,筛完下拉不至于缩没。
 *
 * 行与合计同一时间窗口口径,四类 token 明细相加 === 顶层合计(core 侧有对账单测焊死)。
 */
import { onMounted, ref, watch } from 'vue'
import { useBoardStore } from '@/stores/board'

interface SessionRow {
  sessionId: string
  models: string[]
  card: string | null
  startedAt: string | null
  endedAt: string | null
  turns: number
  peakContext: number
  avgContext: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  compactions: number
  usd: number
}
interface SessionTotals {
  sessions: number; turns: number; input: number; output: number
  cacheRead: number; cacheWrite: number; compactions: number
  usd: number; contextSum: number; avgContext: number
}
interface DetailBody {
  ok: boolean; error?: string
  rows: SessionRow[]; totals: SessionTotals
  options: { models: string[]; cards: string[] }
}

const props = defineProps<{ projectId: string | null; days: number }>()
const store = useBoardStore()
const rows = ref<SessionRow[]>([])
const totals = ref<SessionTotals | null>(null)
const options = ref<{ models: string[]; cards: string[] }>({ models: [], cards: [] })
const loading = ref(false)
const error = ref('')
const filters = ref({ fromDate: '', toDate: '', model: '', card: '' })

/** 请求序号:只认最后一次发出的结果,先发的慢响应作废(照 CostMonitor 的守卫)。 */
let reqSeq = 0

async function load() {
  if (!props.projectId) return
  const seq = ++reqSeq
  loading.value = true
  const query = new URLSearchParams({ project: props.projectId, days: String(props.days) })
  for (const [key, value] of Object.entries(filters.value)) if (value) query.set(key, value)
  try {
    const res = await fetch(`/api/cost/session-detail?${query.toString()}`)
    const body = await res.json() as DetailBody
    if (seq !== reqSeq) return
    if (!body.ok) throw new Error(body.error || '读取失败')
    rows.value = body.rows
    totals.value = body.totals
    options.value = body.options
    error.value = ''
  } catch (e) {
    if (seq !== reqSeq) return
    rows.value = []
    totals.value = null
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (seq === reqSeq) loading.value = false
  }
}

onMounted(load)
watch(() => [props.projectId, props.days], () => { void load() })
watch(() => [filters.value.fromDate, filters.value.toDate], () => { void load() })

/** token 数中文缩写:亿/万,小于一万给千分位(与 CostMonitor 同一版式)。 */
function fmt(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万'
  return n.toLocaleString()
}
function usd2(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2)
}
function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}
function when(ts: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
/** 会话 id 太长,列表里只露头一段,完整值放 title。 */
function shortSid(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id
}
</script>

<template>
  <section class="session-detail">
    <h3>对话明细 <span class="sub">每个会话一行;按会话看才分得清钱花在哪次对话</span></h3>
    <form class="filters" @submit.prevent="load">
      <label>从<input v-model="filters.fromDate" type="date"></label>
      <label>到<input v-model="filters.toDate" type="date"></label>
      <label>模型<select v-model="filters.model" @change="load">
        <option value="">全部模型</option>
        <option v-for="value in options.models" :key="value" :value="value">{{ shortModel(value) }}</option>
      </select></label>
      <label>卡<select v-model="filters.card" @change="load">
        <option value="">全部卡</option>
        <option v-for="value in options.cards" :key="value" :value="value">{{ value }}</option>
      </select></label>
      <button class="btn btn-sm" type="submit" :disabled="loading">{{ loading ? '读取中…' : '刷新' }}</button>
    </form>
    <p v-if="error" class="bad" role="alert">{{ error }}</p>
    <div v-else-if="!rows.length && !loading" class="empty-line">
      没有符合筛选的对话记录;清掉筛选条件或换更长时间段再试。
    </div>
    <div v-if="rows.length" class="table-scroll" :aria-busy="loading" role="region" aria-label="对话明细" tabindex="0">
      <table class="session-table">
        <thead>
          <tr>
            <th>会话</th><th>卡</th><th>模型</th><th>开始</th><th>结束</th>
            <th class="r">轮次</th><th class="r">峰值上下文</th><th class="r">平均上下文</th>
            <th class="r">输入</th><th class="r">输出</th><th class="r">缓存读</th><th class="r">缓存写</th>
            <th class="r">压缩</th><th class="r">API 等价</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.sessionId">
            <td class="mono" :title="row.sessionId">{{ shortSid(row.sessionId) }}</td>
            <td>
              <button v-if="row.card" class="btn quiet btn-sm mono" type="button" @click="store.openTask(row.card)">{{ row.card }}</button>
              <span v-else class="muted">未判定</span>
            </td>
            <td class="models">{{ row.models.map(shortModel).join(' + ') || '—' }}</td>
            <td class="mono">{{ when(row.startedAt) }}</td>
            <td class="mono">{{ when(row.endedAt) }}</td>
            <td class="num">{{ row.turns.toLocaleString() }}</td>
            <td class="num">{{ fmt(row.peakContext) }}</td>
            <td class="num">{{ fmt(row.avgContext) }}</td>
            <td class="num">{{ fmt(row.input) }}</td>
            <td class="num">{{ fmt(row.output) }}</td>
            <td class="num">{{ fmt(row.cacheRead) }}</td>
            <td class="num">{{ fmt(row.cacheWrite) }}</td>
            <td class="num">{{ row.compactions || '—' }}</td>
            <td class="num">${{ usd2(row.usd) }}</td>
          </tr>
        </tbody>
        <tfoot v-if="totals">
          <tr>
            <td colspan="5">合计 · {{ totals.sessions }} 个会话</td>
            <td class="num">{{ totals.turns.toLocaleString() }}</td>
            <td class="num muted">—</td>
            <td class="num">{{ fmt(totals.avgContext) }}</td>
            <td class="num">{{ fmt(totals.input) }}</td>
            <td class="num">{{ fmt(totals.output) }}</td>
            <td class="num">{{ fmt(totals.cacheRead) }}</td>
            <td class="num">{{ fmt(totals.cacheWrite) }}</td>
            <td class="num">{{ totals.compactions || '—' }}</td>
            <td class="num">${{ usd2(totals.usd) }}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  </section>
</template>

<style scoped>
.session-detail { min-width: 0; display: grid; gap: var(--s2); }
h3 { font-size: var(--fs-md); }
.sub { color: var(--text-3); font-size: var(--fs-sm); font-weight: 400; margin-left: var(--s2); }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
.filters label { display: flex; gap: var(--s1); align-items: center; color: var(--text-3); font-size: var(--fs-xs); }
.filters select, .filters input { padding: 2px 6px; min-width: 0; max-width: 170px; background: var(--surface-2); border: 1px solid var(--line-strong); border-radius: var(--r-sm); color: var(--text-2); font: inherit; }
.bad { color: var(--bad); }
.empty-line { color: var(--text-2); font-size: var(--fs-sm); }
.muted { color: var(--text-3); }
.models { overflow-wrap: anywhere; }
.table-scroll { max-width: 100%; max-height: 320px; overflow: auto; }
.session-table { min-width: 980px; }
.r { text-align: right; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tfoot td { border-top: 1px solid var(--line-strong); font-weight: 600; }
</style>
