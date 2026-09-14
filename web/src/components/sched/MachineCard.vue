<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { MachineSnapshot, TicketSummary, TicketEstimate } from '@/api/sched'
import { fetchCiJobs, type CiJobsSnapshot } from '@/api/schedCiJobs'
import EstimateText from './EstimateText.vue'
import { age, ciJobLabel, ciRunnersDiffer, duration, freshness, stamp, ticketLabel, tone } from './format'
import { machineCapacity } from '../../../../core/schedMachineDisplay.mjs'
const props = defineProps<{ machine: MachineSnapshot; host: string; tickets: TicketSummary[]; estimates: Record<string, TicketEstimate>; now: number; busy: boolean }>()
const emit = defineEmits<{ open: [id: string]; cancel: [id: string] }>()
const fresh = computed(() => freshness(props.machine, props.now))
const capacity = computed(() => machineCapacity(props.machine, fresh.value.stale))
const jobs = computed(() => props.tickets.filter(ticket => !ticket.registerOnly && ticket.machine === props.machine.name))
const ciSnapshot = ref<CiJobsSnapshot | null>(null), ciFailed = ref(false)
const ciData = computed(() => ciSnapshot.value && !('unavailable' in ciSnapshot.value) ? ciSnapshot.value : null)
const ciUnavailable = computed(() => ciSnapshot.value && 'unavailable' in ciSnapshot.value ? ciSnapshot.value.unavailable : null)
const ownCiJobs = computed(() => ciData.value?.machines.find(group => group.machine === props.machine.name)?.jobs ?? [])
// 未知 runner 不猜归属；在主机卡里单列一次，避免每张机器卡重复展示。
const unknownCiJobs = computed(() => props.machine.name === props.host
  ? ciData.value?.machines.find(group => group.machine === null)?.jobs ?? [] : [])
const ciCount = computed(() => ownCiJobs.value.length + unknownCiJobs.value.length)
const ciMismatch = computed(() => !!ciData.value?.updatedAt && ciRunnersDiffer(props.machine.ciRunners, ownCiJobs.value))
const ciAge = computed(() => age(ciData.value?.updatedAt ?? null, props.now))
const ciStale = computed(() => ciFailed.value || !!ciData.value?.staleSince || (ciAge.value !== null && ciAge.value > 60_000))
let ciTimer: number | undefined, ciRequest: AbortController | null = null, mounted = false
async function refreshCiJobs() {
  if (ciRequest) return
  const request = new AbortController()
  ciRequest = request
  const timeout = window.setTimeout(() => request.abort(), 10_000)
  try {
    const snapshot = await fetchCiJobs(request.signal)
    if (mounted) { ciSnapshot.value = snapshot; ciFailed.value = false }
  } catch {
    if (mounted) ciFailed.value = true
  } finally {
    window.clearTimeout(timeout)
    ciRequest = null
  }
}
onMounted(() => {
  mounted = true
  void refreshCiJobs()
  ciTimer = window.setInterval(() => { void refreshCiJobs() }, 30_000)
})
onUnmounted(() => {
  mounted = false
  window.clearInterval(ciTimer)
  ciRequest?.abort()
})
</script>

<template>
  <section class="sched-card machine-card" :data-capacity="capacity.kind" :class="{ stale: capacity.kind === 'stale' }">
    <header class="machine-head">
      <h2>{{ machine.name === host ? '主机' : '副机' }}</h2><span class="sched-muted machine-name">{{ machine.name }}</span>
      <span class="freshness" :class="{ bad: fresh.stale }" :title="`机器心跳：${stamp(machine.heartbeatAt)}；负载采样：${stamp(machine.loadSampledAt)}`">
        {{ fresh.ageMs === null ? '数据更新时间未知' : `数据更新于 ${Math.floor(fresh.ageMs / 1000)} 秒前` }}
        <b v-if="fresh.stale"> · 数据过期</b>
      </span>
    </header>
    <p class="machine-conclusion" :class="capacity.tone" role="status">{{ capacity.label }}</p>
    <div class="machine-status">
      <span class="sched-tag" :class="machine.online ? 'ok' : 'muted'">{{ machine.online ? '在线' : '离线' }}</span>
      <span class="sched-tag" :class="machine.ci === 'active' ? 'warn' : machine.ci === 'unknown' ? 'bad' : 'muted'">
        {{ machine.ci === 'active' ? 'CI 在跑' : machine.ci === 'idle' ? 'CI 空闲' : 'CI 状态未知' }}
      </span>
      <span v-if="machine.overCommitted" class="sched-tag bad">超额中</span>
      <span v-if="machine.ownerHold" class="sched-tag info">你在用电脑 · 已暂停</span>
    </div>
    <div class="machine-ci-window">
      <p v-if="ciUnavailable" class="sched-note">{{ ciUnavailable }}</p>
      <template v-else>
        <p v-if="ciStale" class="sched-note warn" role="status">
          {{ ciAge === null ? '暂时读不到检查作业' : `数据 ${Math.floor(ciAge / 1000)} 秒前` }}
        </p>
        <small v-if="ciMismatch" class="sched-muted">与派单员观测不一致</small>
        <details v-if="ciCount" class="machine-ci-details">
          <summary>CI 在跑什么（{{ ciCount }}）</summary>
          <ul class="machine-ci-jobs" tabindex="0" :aria-label="`${machine.name} 的检查作业，超出三行可滚动`">
            <li v-for="job in ownCiJobs" :key="job.id" :title="ciJobLabel(job, now)">{{ ciJobLabel(job, now) }}</li>
            <li v-if="unknownCiJobs.length" class="machine-ci-unknown">未知机器</li>
            <li v-for="job in unknownCiJobs" :key="`unknown-${job.id}`" :title="ciJobLabel(job, now)">
              {{ ciJobLabel(job, now) }}
            </li>
          </ul>
        </details>
        <p v-else-if="ciData?.updatedAt" class="sched-note">{{ ciStale ? '上次没有查到正在跑的检查' : '没有查到正在跑的检查' }}</p>
        <p v-else-if="!ciStale" class="sched-note">正在读取检查作业…</p>
      </template>
    </div>
    <div class="machine-bar" :class="capacity.tone" :title="capacity.barLabel" role="img" :aria-label="capacity.barLabel">
      <span :style="{ width: `${capacity.barPercent ?? 0}%` }" />
    </div>
    <div class="machine-metrics">
      <span>配额 <b>{{ machine.quotaCores }}</b> 核</span>
      <span>已派任务 <b>{{ machine.grantedCores }}</b> 核</span>
      <span>未接入调度的占用 <b>{{ machine.externalLoadCores }}</b> 核</span>
      <span v-if="machine.reservation">预留 已兑现 <b>{{ machine.reservation.fulfilledCores }}</b> / 申请 <b>{{ machine.reservation.requestedCores }}</b></span>
      <span>可用核（派单依据）<b>{{ machine.availableCores }}</b> 核</span>
    </div>
    <p class="sched-note capacity-explanation">{{ capacity.detail }}</p>
    <details v-if="jobs.length" class="machine-details">
      <summary>调度中的单子（{{ jobs.length }}）</summary>
      <ul class="machine-jobs">
        <li v-for="ticket in jobs" :key="ticket.ticketId" class="machine-job">
          <div class="job-title"><span class="sched-tag info">{{ ticket.project }}</span>
            <button class="sched-link" @click="emit('open', ticket.ticketId)">{{ ticket.title }}</button><span class="job-cores">{{ ticket.grantedCores }} 核</span>
          </div>
          <div class="job-meta"><span>{{ ticket.submitter }}</span><span :class="tone(ticket.state)">{{ ticketLabel(ticket) }}</span></div>
          <div class="job-meta"><EstimateText :estimate="estimates[ticket.ticketId]" /></div>
          <div class="job-meta"><span>执行 {{ duration(ticket.runningMs) }} · 暂停 {{ duration(ticket.pausedMs) }} · 低速 {{ duration(ticket.slowMs) }}</span>
            <button class="sched-btn small bad" :disabled="busy || ticket.cancelRequested" @click="emit('cancel', ticket.ticketId)">撤单</button>
          </div>
          <div class="sched-id">{{ ticket.ticketId }}</div>
        </li>
      </ul>
    </details>
    <p v-if="!jobs.length" class="sched-empty">{{ machine.online ? '这台机器没有调度中的单子' : '离线，不参与派单' }}</p>
  </section>
</template>

<style scoped>
.machine-card.stale { border-color: var(--bad); }
.machine-card[data-capacity="full"] { --spec-top: var(--spec-warn); }
.machine-card[data-capacity="available"] { --spec-top: var(--spec-ok); }
.machine-card[data-capacity="offline"], .machine-card[data-capacity="stale"], .machine-card[data-capacity="unknown"] { --spec-top: var(--spec-n); }
.machine-head, .machine-status { display: flex; gap: var(--s2); flex-wrap: wrap; align-items: center; }
.machine-head h2 { margin: 0; }
.machine-name, .freshness { font-size: var(--fs-xs); min-width: 0; overflow-wrap: anywhere; }
.freshness { margin-left: auto; color: var(--text-3); }
.freshness.bad { color: var(--bad); }
.machine-conclusion { margin: var(--s2) 0 0; font-size: var(--fs-md); font-weight: 600; overflow-wrap: anywhere; }
.capacity-explanation { overflow-wrap: anywhere; }
.machine-status { margin-top: var(--s2); font-size: var(--fs-sm); }
.machine-bar { height: 6px; margin-top: var(--s2); border-radius: var(--r-sm); background: var(--surface-3); overflow: hidden; }
.machine-bar > span { display: block; height: 100%; }
.machine-bar.warn > span { background: var(--warn); }
.machine-bar.ok > span { background: var(--ok); }
.machine-bar.muted { background: var(--n-bg); }
.machine-bar.muted > span { background: var(--n); }
.machine-metrics { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s3); margin-top: var(--s1); color: var(--text-3); font-size: var(--fs-xs); }
.machine-metrics b { color: var(--text-2); font-weight: 500; }
.machine-details { margin-top: var(--s2); font-size: var(--fs-xs); }
.machine-details summary { cursor: pointer; color: var(--text-2); }
.machine-jobs { list-style: none; display: grid; gap: 6px; padding: 0; margin: var(--s2) 0 0; }
.machine-job { padding: 6px 8px; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r); }
.job-title, .job-meta { display: flex; gap: 6px; align-items: center; }
.job-title { font-size: var(--fs-sm); flex-wrap: wrap; }
.job-title .sched-tag { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.job-title .sched-link { text-align: left; min-width: 0; overflow-wrap: anywhere; }
.job-cores { margin-left: auto; white-space: nowrap; }
.job-meta { justify-content: space-between; flex-wrap: wrap; font-size: var(--fs-xs); color: var(--text-3); margin-top: var(--s1); overflow-wrap: anywhere; }
</style>
