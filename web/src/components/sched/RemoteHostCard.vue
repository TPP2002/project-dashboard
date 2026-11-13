<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { RemoteHost } from '@/api/remoteHosts'
import { cardConclusion, freshnessText, fmtGb, fmtRate, fmtRss, cardTaskMeta, sparkPath, sparkArea } from './remoteHostFormat'
const props = defineProps<{ host: RemoteHost }>()
const router = useRouter()
const conclusion = computed(() => cardConclusion(props.host))
const outdated = computed(() => props.host.status !== 'online' || props.host.stale)
</script>
<template>
  <section class="sched-card machine-card" :data-capacity="conclusion.capacity" :class="{ stale: conclusion.tone === 'bad' }">
    <header class="machine-head"><h2>{{ host.label }}</h2><span v-if="host.host?.logicalCores != null && host.host?.memTotalMb != null" class="sched-muted machine-name">{{ host.host.logicalCores }} 核 · {{ Math.round(host.host.memTotalMb / 1024) }} GB</span><span class="freshness" :class="{ bad: host.stale }">{{ freshnessText(host.ageMs, host.stale) }}</span></header>
    <p v-if="conclusion.text" class="machine-conclusion" :class="conclusion.tone">{{ conclusion.text }}</p>
    <p v-if="host.status !== 'online' && host.error" class="sched-note bad">{{ host.error }}</p>
    <div class="machine-status"><span class="sched-tag" :class="host.status === 'online' ? 'ok' : 'muted'">{{ host.status === 'online' ? '在线' : host.status === 'connecting' ? '连接中' : '离线' }}</span><span class="sched-tag muted">不参与派单</span></div>
    <template v-if="host.latest">
      <div class="remote-cpu"><div v-if="host.latest.cpu != null" class="remote-cpu-num">{{ Math.round(host.latest.cpu) }}%<small>CPU · 最近 60 秒</small></div><svg v-if="host.spark?.cpu" class="spark" viewBox="0 0 120 40" preserveAspectRatio="none" role="img" aria-label="最近 60 秒 CPU 利用率"><path :d="sparkArea(host.spark.cpu, 120, 40, 100)" :fill="outdated ? 'var(--n)' : 'var(--chart-1)'" fill-opacity=".14"/><path :d="sparkPath(host.spark.cpu, 120, 40, 100)" fill="none" :stroke="outdated ? 'var(--n)' : 'var(--chart-1)'" vector-effect="non-scaling-stroke"/></svg></div>
      <div v-if="host.capacity?.cpuPct != null" class="machine-bar" :class="outdated ? 'muted' : conclusion.tone"><span :style="{ width: `${host.capacity.cpuPct}%` }" /></div>
      <div class="machine-metrics"><span v-if="host.capacity?.busyCores != null && host.capacity.logicalCores != null">整机在用 <b>{{ host.capacity.busyCores.toFixed(1) }}</b> / {{ host.capacity.logicalCores }} 核</span><span v-if="host.capacity?.memUsedMb != null && host.capacity.memTotalMb != null">内存 <b>{{ fmtGb(host.capacity.memUsedMb).replace(' GB', '') }}</b> / {{ fmtGb(host.capacity.memTotalMb) }}</span><span v-if="host.disk?.availMb != null">磁盘剩 <b>{{ Math.round(host.disk.availMb / 1024) }}</b> GB</span><span v-if="host.latest.net?.rxBps != null && host.latest.net.txBps != null">网络 收 <b>{{ fmtRate(host.latest.net.rxBps) }}</b> 发 <b>{{ fmtRate(host.latest.net.txBps) }}</b></span><span v-if="host.latest.load?.[0] != null">负载 <b>{{ host.latest.load[0] }}</b></span></div>
    </template>
    <details v-if="host.taskCount" class="machine-details" open><summary>在跑的任务({{ host.taskCount }})</summary><ul class="machine-jobs"><li v-for="task in host.tasks" :key="task.id" class="machine-job" :class="{ 'job-system': task.kind === 'system' }"><div class="job-title"><b v-if="task.kind !== 'system'">{{ task.label }}</b><span v-else>系统与后台</span><span class="job-cores">{{ task.cores.toFixed(1) }} 核</span></div><div class="job-meta"><span v-if="task.cwd && task.kind !== 'system'" class="job-dir">{{ task.cwd }}</span><span v-else /><span>{{ task.kind === 'system' ? `内存 ${fmtRss(task.rssMb)} · ${task.pids} 个进程` : cardTaskMeta(task, Date.now()) }}</span></div></li></ul></details>
    <p v-else-if="host.latest" class="sched-empty">没有在跑的任务</p>
    <div class="remote-foot"><button class="sched-btn" @click="router.push(`/sched/remote/${encodeURIComponent(host.name)}`)">性能详情</button></div>
  </section>
</template>
<style scoped>
.machine-card.stale { border-color: var(--bad); }
.machine-card[data-capacity="full"] { --spec-top: var(--spec-warn); }.machine-card[data-capacity="available"] { --spec-top: var(--spec-ok); }.machine-card[data-capacity="offline"] { --spec-top: var(--spec-n); }
.machine-head, .machine-status { display:flex; gap:var(--s2); flex-wrap:wrap; align-items:center; }.machine-head h2 { margin:0; }.machine-name, .freshness { font-size:var(--fs-xs); min-width:0; overflow-wrap:anywhere; }.freshness { margin-left:auto; color:var(--text-3); }.freshness.bad { color:var(--bad); }
.machine-conclusion { margin:var(--s2) 0 0; font-size:var(--fs-md); font-weight:600; overflow-wrap:anywhere; }.machine-status { margin-top:var(--s2); font-size:var(--fs-sm); }
.machine-bar { height:6px; margin-top:var(--s2); border-radius:var(--r-sm); background:var(--surface-3); overflow:hidden; }.machine-bar > span { display:block; height:100%; }.machine-bar.warn > span { background:var(--warn); }.machine-bar.ok > span { background:var(--ok); }.machine-bar.muted > span { background:var(--n); }
.machine-metrics { display:flex; flex-wrap:wrap; gap:var(--s2) var(--s3); margin-top:var(--s1); color:var(--text-3); font-size:var(--fs-xs); }.machine-metrics b { color:var(--text-2); font-weight:500; font-family:var(--mono); }
.machine-details { margin-top:var(--s2); font-size:var(--fs-xs); }.machine-details summary { cursor:pointer; color:var(--text-2); }.machine-jobs { list-style:none; display:grid; gap:6px; padding:0; margin:var(--s2) 0 0; }.machine-job { padding:6px 8px; background:var(--surface-2); border:1px solid var(--line); border-radius:var(--r); }.job-title,.job-meta { display:flex; gap:6px; align-items:center; }.job-title { font-size:var(--fs-sm); flex-wrap:wrap; }.job-cores { margin-left:auto; white-space:nowrap; font-family:var(--mono); }.job-meta { justify-content:space-between; flex-wrap:wrap; font-size:var(--fs-xs); color:var(--text-3); margin-top:var(--s1); overflow-wrap:anywhere; }
.remote-cpu { display:grid; grid-template-columns:auto 1fr; gap:var(--s3); align-items:center; margin-top:var(--s2); }.remote-cpu-num { font-family:var(--mono); font-size:var(--fs-xl); line-height:1.1; font-variant-numeric:tabular-nums; }.remote-cpu-num small { display:block; font-family:var(--cn); font-size:var(--fs-xs); color:var(--text-3); }.spark { width:100%; height:40px; display:block; }.remote-foot { display:flex; justify-content:flex-end; margin-top:var(--s2); }.job-dir { font-family:var(--mono); }.job-system { color:var(--text-3); background:transparent; border-style:dashed; }
@media (pointer: coarse) { .remote-foot button, .machine-details summary { min-height:44px; } }
</style>
