<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/components/Icon.vue'
import { cssVar, useEchart } from '@/charts/useEcharts'
import { authFetch, onSessionExpired, responseJson } from '@/collaboration/http'
import { actionLabel, contributionsPath, doneSplit, memberColor } from '@/collaboration/contrib'
import type { Contributions, ContributionWeeks, ContributionWeek } from '@/collaboration/contrib'

const props = defineProps<{ projectId: string; projectName: string }>()
const weeks = ref<ContributionWeeks>(8)
const weekOptions: ContributionWeeks[] = [4, 8, 12]
const data = ref<Contributions | null>(null)
const loading = ref(true)
const error = ref('')
const metric = ref<'completed' | 'messages' | 'ops'>('completed')
const metrics = [{ key: 'completed', label: '完成' }, { key: 'messages', label: '留言' }, { key: 'ops', label: '全部操作' }] as const
const full = computed(() => data.value?.scope === 'full' ? data.value : null)
const maxCompleted = computed(() => Math.max(0, ...full.value?.members.map(m => m.completedAsOwner + m.completedAsCollaborator) ?? []))
const hasActivity = computed(() => data.value?.weekly.some(w => w.ops || w.completed || w.messages))
let requestId = 0
let controller: AbortController | null = null

async function load() {
  const id = ++requestId
  controller?.abort()
  controller = new AbortController()
  data.value = null
  error.value = ''
  loading.value = true
  try {
    const response = await authFetch(contributionsPath(props.projectId, weeks.value), { signal: controller.signal, cache: 'no-store' })
    const result = await responseJson<Contributions>(response)
    if (id === requestId) data.value = result
  } catch (e) {
    if (id === requestId) error.value = e instanceof Error ? e.message : '暂时无法读取成员贡献'
  } finally {
    if (id === requestId) loading.value = false
  }
}
watch([() => props.projectId, weeks], load, { immediate: true })
const removeExpiryListener = onSessionExpired(() => {
  ++requestId
  controller?.abort()
  data.value = null
  loading.value = false
  error.value = '登录已过期，请重新登录'
})
onBeforeUnmount(() => { ++requestId; controller?.abort(); removeExpiryListener() })

function timestamp(value: string | number | null): string {
  if (value === null) return '—'
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
}
function spark(weekly: ContributionWeek[]): string {
  const max = Math.max(1, ...weekly.map(w => w.ops))
  return weekly.map((w, i) => `${2 + i * 92 / Math.max(1, weekly.length - 1)},${22 - w.ops / max * 20}`).join(' ')
}
function color(index: number) { return { '--member-color': `var(${memberColor(index)})` } }
function personIndex(userId: string) { return full.value?.members.findIndex(m => m.userId === userId) ?? -1 }
function buildTrend() {
  const current = data.value
  const series = current?.scope === 'full'
    ? [...current.membersWeekly.map((m, i) => ({
      id: m.userId, name: current.members.find(p => p.userId === m.userId)?.name || '成员', weekly: m.weekly, color: memberColor(i),
    })), { id: 'unsigned', name: '未署名', weekly: current.unattributed.weekly, color: memberColor(-1) }]
    : [{ id: 'summary', name: '合计', weekly: current?.weekly ?? [], color: memberColor(0) }]
  const axis = { color: cssVar('--text-3'), fontSize: Number.parseFloat(cssVar('--fs-xs')) }
  return {
    animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    animationDuration: 220, animationDurationUpdate: 220,
    grid: { left: 40, right: 16, top: 20, bottom: 30 },
    tooltip: { trigger: 'axis', renderMode: 'richText', backgroundColor: cssVar('--surface'), borderColor: cssVar('--line-strong'), textStyle: { color: cssVar('--text') } },
    xAxis: { type: 'category', data: current?.weekly.map(w => w.weekStart.slice(5, 10)) ?? [], axisLabel: axis, axisLine: { lineStyle: { color: cssVar('--line-strong') } } },
    yAxis: { type: 'value', minInterval: 1, axisLabel: axis, splitLine: { lineStyle: { color: cssVar('--line') } } },
    series: series.map(s => ({ id: s.id, name: s.name, type: 'bar', stack: 'contributions', barMaxWidth: 30,
      data: s.weekly.map(w => w[metric.value]), itemStyle: { color: cssVar(s.color) } })),
  }
}
// Keep the chart element mounted while loading; useEchart initializes on mount.
const { el: trendEl, chart, update } = useEchart(buildTrend)
watch([data, metric, loading], async () => { await nextTick(); update(); chart.value?.resize() })
</script>

<template>
  <section class="contributions card" aria-label="成员贡献" :aria-busy="loading">
    <header class="contrib-head">
      <h3><Icon name="network" :size="20" />成员贡献</h3>
      <span class="muted">{{ projectName }} · 最近 {{ weeks }} 周</span>
      <div class="segments" role="group" aria-label="贡献趋势时间范围">
        <button v-for="w in weekOptions" :key="w" :aria-pressed="weeks === w" :class="{ on: weeks === w }" @click="weeks = w">{{ w }} 周</button>
      </div>
    </header>
    <div v-if="loading" class="state" role="status"><Icon name="history" :size="24" /><span>正在整理成员贡献…</span><div class="skeleton" /></div>
    <div v-else-if="error" class="state error" role="alert"><Icon name="alert" :size="24" /><strong>暂时无法读取成员贡献</strong><span>{{ error }}</span><button @click="load">重新加载</button></div>
    <template v-if="data">
      <p v-if="data.scope === 'summary'" class="notice">你是只读访客,只能看到汇总</p>
      <div class="kpis">
        <div class="kpi"><span>完成卡数</span><strong>{{ data.totals.completed }}</strong><small>其中有协作人的 {{ data.totals.completedWithCollaborators }} 张</small></div>
        <div class="kpi"><span>进行中</span><strong>{{ data.totals.inProgress }}</strong><small>{{ data.totals.activeMembers }} 人在推进</small></div>
        <div class="kpi"><span>成员建卡</span><strong>{{ data.totals.createdByMembers }}</strong><small>另有 {{ data.totals.createdOther }} 张未署名建卡</small></div>
        <div class="kpi"><span>留言</span><strong>{{ data.totals.messages }}</strong><small>看板全部留言</small></div>
        <div class="kpi"><span>经 AI 的操作</span><strong>{{ data.totals.aiOps }}</strong><small>已署名操作共 {{ data.totals.attributedOps }} 次</small></div>
      </div>
      <p class="muted caption">卡数按当前看板统计；周数切换只影响趋势。主负责与协作分别计贡献，同一张卡可计入多人的完成数。</p>
      <div v-if="full" class="panel">
        <div class="panel-title"><h4>按人看</h4><span class="muted">实色 = 主负责完成 · 斜纹 = 协作完成</span></div>
        <div class="table-scroll" tabindex="0" aria-label="成员贡献明细，可横向滚动">
          <table>
            <thead><tr><th scope="col">成员</th><th scope="col">完成（主负责 + 协作）</th><th scope="col">进行中</th><th scope="col">建卡</th><th scope="col">留言</th><th scope="col">进度更新</th><th scope="col">经 AI</th><th scope="col">最近活跃</th><th scope="col">{{ weeks }} 周操作趋势</th></tr></thead>
            <tbody>
              <tr v-for="(m, i) in full.members" :key="m.userId" :style="color(i)">
                <th scope="row"><div class="person"><span class="avatar">{{ m.name.slice(0, 1) || '?' }}</span><span>{{ m.name }}</span><small class="role">{{ m.role === 'owner' ? '负责人' : m.role === 'viewer' ? '访客' : m.role === 'member' ? '成员' : '历史成员' }}</small></div></th>
                <td><div class="done"><span>{{ m.completedAsOwner }} + {{ m.completedAsCollaborator }}</span><span class="done-track" aria-hidden="true"><i :style="{ width: doneSplit(m, maxCompleted).owner + '%' }" /><i class="collaborator" :style="{ width: doneSplit(m, maxCompleted).collaborator + '%' }" /></span></div></td>
                <td>{{ m.inProgressAsOwner }} + {{ m.inProgressAsCollaborator }}</td><td>{{ m.created }}</td><td>{{ m.messages }}</td><td>{{ m.progressUpdates }}</td><td>{{ m.aiOps }}</td><td class="date">{{ timestamp(m.lastActiveAt) }}</td>
                <td><svg v-if="m.weekly.some(w => w.ops)" class="spark" viewBox="0 0 96 24" role="img" :aria-label="m.name + '近' + weeks + '周操作：' + m.weekly.map(w => w.ops).join('、')"><polyline :points="spark(m.weekly)" /></svg><span v-else class="muted">没有活动</span></td>
              </tr>
              <tr class="unsigned" :style="color(-1)"><th scope="row"><div class="person"><span class="avatar">?</span>未署名(命令行 / 本机 AI)</div></th><td>{{ full.unattributed.completedWithoutMember }} 张完工卡没有领取人</td><td>—</td><td>{{ data.totals.createdOther }}</td><td>{{ full.unattributed.messages }}</td><td>—</td><td>—</td><td>—</td><td><svg class="spark" viewBox="0 0 96 24" role="img" :aria-label="'未署名各周操作：' + full.unattributed.weekly.map(w => w.ops).join('、')"><polyline :points="spark(full.unattributed.weekly)" /></svg></td></tr>
            </tbody>
          </table>
        </div>
        <p v-if="full.skipped" class="muted caption">{{ full.skipped }} 条活动时间无效，未计入按人活动数与周趋势。</p>
      </div>
    </template>
    <div v-show="data && !loading && !error" class="bottom" :class="{ summary: !full }">
      <div class="panel">
        <div class="panel-title"><h4>按周趋势<span class="muted"> · {{ full ? '按人分色' : '合计' }}</span></h4><div class="segments" role="group" aria-label="趋势指标"><button v-for="m in metrics" :key="m.key" :class="{ on: metric === m.key }" :aria-pressed="metric === m.key" @click="metric = m.key">{{ m.label }}</button></div></div>
        <p v-if="data && !hasActivity" class="empty" role="status">这段时间还没有活动，新的推进会显示在这里。</p>
        <div ref="trendEl" class="trend" role="img" :aria-label="'按周' + metrics.find(m => m.key === metric)?.label + '趋势'" />
        <div class="legend"><template v-if="full"><span v-for="(m, i) in full.members" :key="m.userId" :style="color(i)"><i />{{ m.name }}</span><span :style="color(-1)"><i />未署名</span></template><span v-else :style="color(0)"><i />合计</span></div>
        <details v-if="data" class="trend-values"><summary>查看每周合计</summary><ul><li v-for="w in data.weekly" :key="w.weekStart">{{ w.weekStart.slice(0, 10) }}：{{ w[metric] }}</li></ul></details>
      </div>
      <div v-if="full" class="panel">
        <div class="panel-title"><h4>最近推进</h4><span class="muted">最近 {{ full.recent.length }} 条已署名活动</span></div>
        <p v-if="!full.recent.length" class="empty">还没有已署名的推进记录。</p>
        <ol v-else class="feed"><li v-for="(entry, i) in full.recent" :key="i" :style="color(personIndex(entry.userId))"><span class="avatar" aria-hidden="true">{{ entry.name.slice(0, 1) || '?' }}</span><span class="feed-content">{{ entry.name }} {{ actionLabel(entry.action) }} <b>{{ entry.taskTitle || entry.taskId || '任务' }}</b><span v-if="entry.viaAi" class="via"><Icon name="bot" :size="14" />经 AI</span></span><time class="date">{{ timestamp(entry.ts) }}</time></li></ol>
      </div>
    </div>
  </section>
</template>

<style scoped>
.contributions { padding: var(--s4); margin-top: var(--s4); color: var(--text); }
.contrib-head, .panel-title, h3, .person, .legend, .legend span { display: flex; align-items: center; gap: var(--s2); }
.contrib-head { flex-wrap: wrap; margin-bottom: var(--s4); font-size: var(--fs-sm); }
h3, h4 { margin: 0; font-size: var(--fs-base); }
h3 { font-size: var(--fs-lg); }
.segments { display: flex; gap: var(--s1); margin-left: auto; flex-wrap: wrap; }
button { background: var(--surface-2); border: 1px solid var(--line); color: var(--text-2); padding: var(--s1) var(--s2); border-radius: var(--r); cursor: pointer; font: inherit; transition: border-color .14s, background .14s; }
button:hover { border-color: var(--line-strong); color: var(--text); }
button.on { background: var(--info-bg); color: var(--info); border-color: var(--info); }
button:focus-visible, .table-scroll:focus-visible { outline: 2px solid var(--info); outline-offset: 3px; }
.kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--s3); }
.kpi { border: 1px solid var(--line); border-radius: var(--r); padding: var(--s3); display: flex; flex-direction: column; gap: var(--s2); background: var(--surface-2); }
.kpi > span, .kpi small, .caption, .notice { color: var(--text-2); font-size: var(--fs-sm); }
.kpi strong { font-size: var(--fs-2xl, 28px); font-variant-numeric: tabular-nums; }
.caption { line-height: 1.6; margin: var(--s3) 0; }
.notice { padding: var(--s3); background: var(--info-bg); border-radius: var(--r); }
.panel { border: 1px solid var(--line); border-radius: var(--r); min-width: 0; overflow: hidden; }
.panel-title { flex-wrap: wrap; padding: var(--s3); border-bottom: 1px solid var(--line); font-size: var(--fs-xs); }
.panel > .caption { padding: 0 var(--s3); }
.table-scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); white-space: nowrap; font-variant-numeric: tabular-nums; }
th, td { padding: var(--s3); text-align: left; border-bottom: 1px solid var(--line); }
thead { background: var(--surface-2); color: var(--text-2); }
tbody th { font-weight: 500; }
tbody tr:last-child > * { border-bottom: 0; }
.avatar { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 26px; height: 26px; border-radius: 50%; color: var(--member-color); background: var(--surface-2); border: 1px solid var(--member-color); font-size: var(--fs-xs); }
.role, .via { color: var(--text-2); background: var(--surface-2); border: 1px solid var(--line); padding: 1px var(--s1); border-radius: var(--r); font-size: var(--fs-xs); }
.done { display: flex; align-items: center; gap: var(--s2); }
.done > span:first-child { min-width: 42px; }
.done-track { display: flex; width: 100px; height: 8px; background: var(--surface-2); border-radius: 3px; overflow: hidden; }
.done-track i { background: var(--member-color); height: 100%; }
.done-track .collaborator { background: repeating-linear-gradient(135deg, var(--member-color) 0 2px, var(--surface) 2px 4px); }
.spark { width: 96px; height: 24px; color: var(--member-color); }
.spark polyline { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linejoin: round; }
.unsigned { color: var(--text-2); background: var(--surface-2); }
.date { color: var(--text-3); font-size: var(--fs-xs); white-space: nowrap; }
.bottom { display: grid; grid-template-columns: 1.1fr 1fr; gap: var(--s3); margin-top: var(--s3); }
.bottom.summary { grid-template-columns: 1fr; }
.trend { height: 250px; width: 100%; }
.legend { padding: var(--s2) var(--s3); flex-wrap: wrap; font-size: var(--fs-xs); color: var(--text-2); }
.legend i { width: 9px; height: 9px; border-radius: 2px; background: var(--member-color); }
.trend-values { color: var(--text-2); font-size: var(--fs-xs); padding: var(--s3); }
.feed { margin: 0; padding: 0 var(--s3); list-style: none; max-height: 360px; overflow-y: auto; }
.feed li { display: flex; align-items: flex-start; gap: var(--s2); padding: var(--s3) 0; border-bottom: 1px solid var(--line); font-size: var(--fs-sm); }
.feed li:last-child { border: 0; }
.feed-content { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.7; }
.via { display: inline-flex; align-items: center; gap: var(--s1); margin-left: var(--s2); }
.empty, .state { color: var(--text-2); padding: var(--s4); text-align: center; font-size: var(--fs-sm); }
.state { display: flex; align-items: center; flex-direction: column; gap: var(--s3); min-height: 160px; justify-content: center; }
.state.error { color: var(--danger, var(--text)); }
.skeleton { width: 70%; height: 12px; border-radius: var(--r); background: var(--surface-2); animation: breathe 1.4s ease-in-out infinite alternate; }
@keyframes breathe { to { opacity: .4; } }
@media (max-width: 1000px) { .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } .bottom { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .contributions { padding: var(--s3); } .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .feed li { flex-wrap: wrap; } .contrib-head > .segments { margin-left: 0; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
