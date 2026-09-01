<script setup lang="ts">
/**
 * 成本监管 —— 本机对话流水的真实 token 消耗(BOARD-COST-MONITOR,0901 负责人拍板)。
 *
 * 【数据从哪来】Claude Code 把每个对话的完整流水存在本机 ~/.claude/projects 下,
 * 每条回复都带 token 用量。订阅套餐看不到美元,但 token 数是真的——server 端按
 * 当前项目(含它的全部 worktree 会话)聚合,按天/按模型/主对话·子agent 分桶。
 *
 * 【卡级登记】施工对话用 CLI `cost <卡> --agents "sonnet:3,opus:1"` 自报每张卡
 * 用了哪些 agent;本页底部汇总展示,点卡号可打开详情抽屉。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { Task } from '@/types'

interface Tally { input: number; output: number; cacheRead: number; cacheWrite: number; msgs: number }
interface DayRow { date: string; models: Record<string, Tally>; side: Tally; main: Tally }
interface Usage {
  byDay: DayRow[]
  totals: Tally & { sideOutput: number; mainOutput: number; cacheHitRate: number }
  models: Record<string, Tally>
  dirs: string[]
  scanned: number
  cachedFiles: number
  sessions: number
}

const store = useBoardStore()
const usage = ref<Usage | null>(null)
const days = ref(30)
const loading = ref(false)
const error = ref('')

const DAY_OPTS = [7, 30, 90]

async function load() {
  const pid = store.currentProjectId
  if (!pid) return
  loading.value = true
  try {
    const res = await fetch(`/api/cost?project=${encodeURIComponent(pid)}&days=${days.value}`)
    const body = await res.json()
    if (!body.ok) throw new Error(body.error || '读取失败')
    usage.value = body.usage
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => store.currentProjectId, load)
watch(days, load)

/** token 数中文缩写:亿/万,小于一万给千分位 */
function fmt(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万'
  return n.toLocaleString()
}
function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

const todayStr = computed(() => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})
const todayOutput = computed(() => {
  const t = usage.value?.byDay.find((d) => d.date === todayStr.value)
  return t ? t.main.output + t.side.output : 0
})
const sidePct = computed(() => {
  const t = usage.value?.totals
  if (!t || t.output === 0) return 0
  return Math.round((t.sideOutput / t.output) * 100)
})
const maxDayOutput = computed(() =>
  Math.max(1, ...(usage.value?.byDay ?? []).map((d) => d.main.output + d.side.output)),
)
/** 倒序展示(最近的在最上面) */
const daysDesc = computed(() => [...(usage.value?.byDay ?? [])].reverse())
const modelRows = computed(() =>
  Object.entries(usage.value?.models ?? {})
    .filter(([, v]) => v.output > 0 || v.input > 0 || v.cacheRead > 0)
    .sort((a, b) => b[1].output - a[1].output),
)
/** 有成本登记的卡(当前项目) */
const costTasks = computed<Task[]>(() =>
  store.currentTasks.filter((t) => (t.cost?.entries?.length ?? 0) > 0),
)
const agentsText = (e: { agents?: Record<string, number> }) =>
  Object.entries(e.agents || {}).map(([m, n]) => `${m}×${n}`).join(' + ') || '—'
</script>

<template>
  <div class="page">
    <header class="head">
      <h1>💰 成本监管</h1>
      <div class="seg">
        <button v-for="d in DAY_OPTS" :key="d" class="seg-btn" :class="{ on: days === d }" @click="days = d">近{{ d }}天</button>
      </div>
    </header>
    <p class="sub">
      数据 = 本机对话流水的真实 token 数(当前项目 + 它的 worktree 会话,共 {{ usage?.dirs.length ?? 0 }} 个目录
      / {{ usage?.sessions ?? 0 }} 个会话);跑在别的机器上的对话不在此账内。
    </p>

    <div v-if="error" class="err">⚠️ {{ error }}</div>
    <div v-else-if="loading && !usage" class="muted">扫描对话流水中…(首次约几秒)</div>

    <template v-if="usage">
      <!-- 统计卡 -->
      <div class="cards">
        <div class="card"><div class="c-num">{{ fmt(usage.totals.output) }}</div><div class="c-lbl">期间输出 token(最贵的那类)</div></div>
        <div class="card"><div class="c-num">{{ fmt(todayOutput) }}</div><div class="c-lbl">今日输出</div></div>
        <div class="card"><div class="c-num">{{ fmt(usage.totals.cacheRead) }}</div><div class="c-lbl">缓存读(省钱的部分)</div></div>
        <div class="card"><div class="c-num">{{ (usage.totals.cacheHitRate * 100).toFixed(1) }}%</div><div class="c-lbl">缓存命中率</div></div>
        <div class="card"><div class="c-num">{{ sidePct }}%</div><div class="c-lbl">子 agent 输出占比</div></div>
      </div>

      <!-- 按天条形 -->
      <section class="sec">
        <div class="sec-t">按天输出(<i class="sw main-sw" /> 主对话 / <i class="sw side-sw" /> 子 agent)</div>
        <div v-if="!daysDesc.length" class="muted">期间没有对话记录</div>
        <div v-for="d in daysDesc" :key="d.date" class="bar-row">
          <span class="mono b-date">{{ d.date.slice(5) }}</span>
          <div class="b-track">
            <div class="b-main" :style="{ width: (d.main.output / maxDayOutput) * 100 + '%' }" />
            <div class="b-side" :style="{ width: (d.side.output / maxDayOutput) * 100 + '%' }" />
          </div>
          <span class="mono b-num">{{ fmt(d.main.output + d.side.output) }}</span>
        </div>
      </section>

      <!-- 按模型 -->
      <section class="sec">
        <div class="sec-t">按模型</div>
        <table class="tbl">
          <thead><tr><th>模型</th><th>输出</th><th>输入(新)</th><th>缓存读</th><th>消息数</th></tr></thead>
          <tbody>
            <tr v-for="[m, v] in modelRows" :key="m">
              <td class="mono">{{ shortModel(m) }}</td>
              <td>{{ fmt(v.output) }}</td>
              <td>{{ fmt(v.input + v.cacheWrite) }}</td>
              <td class="muted">{{ fmt(v.cacheRead) }}</td>
              <td class="muted">{{ v.msgs.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <!-- 卡级施工成本登记 -->
    <section class="sec">
      <div class="sec-t">各任务卡施工成本(CLI `cost` 登记)</div>
      <div v-if="!costTasks.length" class="muted">
        当前项目还没有卡登记过施工成本。施工对话收官时跑:<code>cost &lt;卡号&gt; --project {{ store.currentProjectId }} --agents "sonnet:3,opus:1"</code>
      </div>
      <table v-else class="tbl">
        <thead><tr><th>任务卡</th><th>日期</th><th>投入 agent</th><th>备注</th></tr></thead>
        <tbody>
          <template v-for="t in costTasks" :key="t.id">
            <tr v-for="(e, i) in t.cost!.entries" :key="t.id + i">
              <td><button v-if="i === 0" class="link mono" @click="store.openTask(t.id)">{{ t.id }}</button></td>
              <td class="mono muted">{{ e.date }}</td>
              <td>{{ agentsText(e) }}<span v-if="e.tokens" class="muted"> · ≈{{ fmt(e.tokens) }}</span></td>
              <td class="muted small">{{ e.note || '' }}</td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.page { padding: 20px 24px; max-width: 980px; display: flex; flex-direction: column; gap: 16px; }
.head { display: flex; align-items: center; gap: 16px; }
.head h1 { font-size: 20px; }
.sub { color: var(--muted); font-size: 12px; margin: -6px 0 0; }
.seg { display: flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.seg-btn { background: var(--panel); border: none; color: var(--muted); padding: 5px 12px; font-size: 12px; cursor: pointer; }
.seg-btn.on { background: var(--accent-soft); color: var(--text); font-weight: 600; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; }
.c-num { font-size: 20px; font-weight: 700; font-family: var(--mono); }
.c-lbl { font-size: 11px; color: var(--muted); margin-top: 4px; }
.sec { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border-soft); padding-top: 14px; }
.sec-t { font-size: 12px; color: var(--muted-2); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; }
.main-sw { background: var(--accent); }
.side-sw { background: #7fd3c4; }
.bar-row { display: flex; align-items: center; gap: 10px; }
.b-date { width: 44px; font-size: 12px; color: var(--muted); }
.b-track { flex: 1; display: flex; height: 14px; background: var(--panel); border-radius: 3px; overflow: hidden; }
.b-main { background: var(--accent); }
.b-side { background: #7fd3c4; }
.b-num { width: 76px; text-align: right; font-size: 12px; }
.tbl { border-collapse: collapse; font-size: 13px; width: 100%; }
.tbl th { text-align: left; font-size: 11px; color: var(--muted-2); font-weight: 600; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--border-soft); }
.tbl td { padding: 5px 10px 5px 0; border-bottom: 1px solid var(--border-soft); }
.link { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 13px; padding: 0; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.err { color: var(--danger); }
code { font-family: var(--mono); font-size: 12px; background: var(--panel); padding: 1px 5px; border-radius: 3px; }
</style>
