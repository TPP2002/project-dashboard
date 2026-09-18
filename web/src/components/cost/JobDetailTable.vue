<script setup lang="ts">
/**
 * 工单明细(每张工单一行)—— COST-UI-SESSION-DETAIL。
 *
 * 【数据从哪来】server 侧读本仓 `.codex/jobs/` 的落盘工单(core/costJobDetail.cjs,
 * jobsRoot 由 server 传入),人民币直接复用 DeepSeek 价目折算;积分没有每单数据源,
 * 不造数——CLI 自报的美元只作展示参考列,不参与任何计价口径。
 * 筛选同样是 server 侧调 core 纯函数(GET /api/cost/job-detail),这里只收表单发请求。
 */
import { onMounted, ref, watch } from 'vue'
import { useBoardStore } from '@/stores/board'

interface JobRow {
  slug: string
  title: string | null
  card: string | null
  engine: string
  model: string | null
  usedModel: string | null
  dispatchedAt: string | null
  running: boolean
  durationMs: number | null
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reportedUsd: number | null
  peak: boolean | null
  chain: boolean | null
  costRmb: number | null
}
interface JobTotals {
  jobs: number; turns: number; input: number; output: number
  cacheRead: number; cacheWrite: number; costRmb: number; costRmbJobs: number
}
interface DetailBody {
  ok: boolean; error?: string
  rows: JobRow[]; totals: JobTotals
  options: { engines: string[]; models: string[]; cards: string[] }
}

const props = defineProps<{ projectId: string | null }>()
const store = useBoardStore()
const rows = ref<JobRow[]>([])
const totals = ref<JobTotals | null>(null)
const options = ref<{ engines: string[]; models: string[]; cards: string[] }>({ engines: [], models: [], cards: [] })
const loading = ref(false)
const error = ref('')
const filters = ref({ fromDate: '', toDate: '', engine: '', model: '', card: '' })

/** 请求序号:只认最后一次发出的结果(照 CostMonitor 的守卫)。 */
let reqSeq = 0

async function load() {
  if (!props.projectId) return
  const seq = ++reqSeq
  loading.value = true
  const query = new URLSearchParams({ project: props.projectId })
  for (const [key, value] of Object.entries(filters.value)) if (value) query.set(key, value)
  try {
    const res = await fetch(`/api/cost/job-detail?${query.toString()}`)
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
watch(() => props.projectId, () => { void load() })
watch(() => [filters.value.fromDate, filters.value.toDate], () => { void load() })

function fmt(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万'
  return n.toLocaleString()
}
function rmb2(n: number): string {
  return n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2)
}
function when(ts: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function duration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 60e3) return Math.round(ms / 1e3) + ' 秒'
  if (ms < 3600e3) return (ms / 60e3).toFixed(1) + ' 分'
  return (ms / 3600e3).toFixed(1) + ' 时'
}
function chainText(chain: boolean | null): string {
  return chain === null ? '—' : chain ? '是' : '否'
}
</script>

<template>
  <section class="job-detail">
    <h3>工单明细 <span class="sub">每张派出的工单一行;人民币只对判得出价目的单显示</span></h3>
    <form class="filters" @submit.prevent="load">
      <label>从<input v-model="filters.fromDate" type="date"></label>
      <label>到<input v-model="filters.toDate" type="date"></label>
      <label>引擎<select v-model="filters.engine" @change="load">
        <option value="">全部引擎</option>
        <option v-for="value in options.engines" :key="value" :value="value">{{ value }}</option>
      </select></label>
      <label>模型<select v-model="filters.model" @change="load">
        <option value="">全部模型</option>
        <option v-for="value in options.models" :key="value" :value="value">{{ value }}</option>
      </select></label>
      <label>卡<select v-model="filters.card" @change="load">
        <option value="">全部卡</option>
        <option v-for="value in options.cards" :key="value" :value="value">{{ value }}</option>
      </select></label>
      <button class="btn btn-sm" type="submit" :disabled="loading">{{ loading ? '读取中…' : '刷新' }}</button>
    </form>
    <p v-if="error" class="bad" role="alert">{{ error }}</p>
    <div v-else-if="!rows.length && !loading" class="empty-line">
      没有符合筛选的工单;工单记录来自本仓派单目录,没有派过单就是空的。
    </div>
    <div v-if="rows.length" class="table-scroll" :aria-busy="loading" role="region" aria-label="工单明细" tabindex="0">
      <table class="job-table">
        <thead>
          <tr>
            <th>工单</th><th>卡</th><th>引擎</th><th>实际模型</th><th>指定档</th>
            <th>派单时间</th><th class="r">时长</th><th class="r">轮次</th>
            <th class="r">输入</th><th class="r">输出</th><th class="r">缓存读</th><th class="r">缓存写</th>
            <th class="r">人民币</th><th class="r">CLI 自报美元</th><th>级联链</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.slug">
            <td class="mono" :title="row.title || row.slug">{{ row.slug }}</td>
            <td>
              <button v-if="row.card" class="btn quiet btn-sm mono" type="button" @click="store.openTask(row.card)">{{ row.card }}</button>
              <span v-else class="muted">无卡</span>
            </td>
            <td>{{ row.engine }}</td>
            <td class="models">{{ row.usedModel || '—' }}</td>
            <td class="models">{{ row.model || '—' }}</td>
            <td class="mono">
              {{ when(row.dispatchedAt) }}<span v-if="row.running" class="badge info">运行中</span>
            </td>
            <td class="r">{{ duration(row.durationMs) }}</td>
            <td class="r">{{ row.turns.toLocaleString() }}</td>
            <td class="r">{{ fmt(row.input) }}</td>
            <td class="r">{{ fmt(row.output) }}</td>
            <td class="r">{{ fmt(row.cacheRead) }}</td>
            <td class="r">{{ fmt(row.cacheWrite) }}</td>
            <td class="r" :title="row.peak === null ? '' : row.peak ? '按高峰价折算' : '按空闲价折算'">
              {{ row.costRmb === null ? '—' : '¥' + rmb2(row.costRmb) }}
            </td>
            <td class="r">{{ row.reportedUsd === null ? '—' : '$' + row.reportedUsd.toFixed(2) }}</td>
            <td>{{ chainText(row.chain) }}</td>
          </tr>
        </tbody>
        <tfoot v-if="totals">
          <tr>
            <td colspan="7">合计 · {{ totals.jobs }} 张工单(人民币只累加 {{ totals.costRmbJobs }} 张判得出价目的)</td>
            <td class="r">{{ totals.turns.toLocaleString() }}</td>
            <td class="r">{{ fmt(totals.input) }}</td>
            <td class="r">{{ fmt(totals.output) }}</td>
            <td class="r">{{ fmt(totals.cacheRead) }}</td>
            <td class="r">{{ fmt(totals.cacheWrite) }}</td>
            <td class="r">¥{{ rmb2(totals.costRmb) }}</td>
            <td class="r">—</td>
            <td>—</td>
          </tr>
        </tfoot>
      </table>
    </div>
  </section>
</template>

<style scoped>
.job-detail { min-width: 0; display: grid; gap: var(--s2); }
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
.job-table { min-width: 1080px; }
.r { text-align: right; }
tfoot td { border-top: 1px solid var(--line-strong); font-weight: 600; }
</style>
