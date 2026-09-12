<script setup lang="ts">
import { computed } from 'vue'
import type { MachineSnapshot, TicketSummary, TicketEstimate } from '@/api/sched'
import EstimateText from './EstimateText.vue'
import { duration, freshness, stamp, ticketLabel, tone } from './format'
const props = defineProps<{ machine: MachineSnapshot; host: string; tickets: TicketSummary[]; estimates: Record<string, TicketEstimate>; now: number; busy: boolean }>()
const emit = defineEmits<{ open: [id: string]; cancel: [id: string] }>()
const fresh = computed(() => freshness(props.machine, props.now))
const jobs = computed(() => props.tickets.filter(ticket => !ticket.registerOnly && ticket.machine === props.machine.name))
// 仅把派单员的授予值画成配额条，不把授予当成实测利用率，也不重算可派核数。
const grantWidth = computed(() => `${props.machine.quotaCores ? Math.min(100, props.machine.grantedCores / props.machine.quotaCores * 100) : 0}%`)
</script>

<template>
  <section class="sched-card machine-card" :class="{ stale: fresh.stale, 'ci-active': machine.ci === 'active' }">
    <header class="machine-head">
      <h2>{{ machine.name === host ? '主机' : '副机' }}</h2><span class="sched-muted machine-name">{{ machine.name }}</span>
      <span class="freshness" :class="{ bad: fresh.stale }" :title="`机器心跳：${stamp(machine.heartbeatAt)}；负载采样：${stamp(machine.loadSampledAt)}`">
        {{ fresh.ageMs === null ? '数据更新时间未知' : `数据更新于 ${Math.floor(fresh.ageMs / 1000)} 秒前` }}
        <b v-if="fresh.stale"> · 数据过期</b>
      </span>
    </header>
    <div class="machine-status">
      <span class="sched-tag" :class="machine.online ? 'ok' : 'muted'">{{ machine.online ? '在线' : '离线' }}</span>
      <span class="sched-tag" :class="machine.ci === 'active' ? 'warn' : machine.ci === 'unknown' ? 'bad' : 'muted'">
        {{ machine.ci === 'active' ? 'CI 在跑' : machine.ci === 'idle' ? 'CI 空闲' : 'CI 状态未知' }}
      </span>
      <span v-if="machine.overCommitted" class="sched-tag bad">超额中</span>
      <span v-if="machine.ownerHold" class="sched-tag info">你在用电脑 · 已暂停</span>
      <span class="sched-muted">配额 {{ machine.quotaCores }} 核</span>
    </div>
    <div class="machine-bar" :title="`已授予 ${machine.grantedCores} / 配额 ${machine.quotaCores} 核`"><span :style="{ width: grantWidth }" /></div>
    <div class="machine-metrics">
      <span>已授予 <b>{{ machine.grantedCores }}</b> 核</span>
      <span>未接入调度的负载：<b>{{ machine.externalLoadCores }}</b> 核</span>
      <span v-if="machine.reservation">预留 已兑现 <b>{{ machine.reservation.fulfilledCores }}</b> / 申请 <b>{{ machine.reservation.requestedCores }}</b></span>
      <span>可再派 <b>{{ machine.availableCores }}</b> 核</span>
    </div>
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
    <p v-if="!jobs.length" class="sched-empty">{{ machine.online ? '这台机器没有调度中的单子' : '离线，不参与派单' }}</p>
  </section>
</template>

<style scoped>
.machine-card.stale { border-color: var(--bad); }
.machine-card.ci-active { --spec-top: var(--spec-warn); }
.machine-head, .machine-status { display: flex; gap: var(--s2); flex-wrap: wrap; align-items: center; }
.machine-head h2 { margin: 0; }
.machine-name, .freshness { font-size: var(--fs-xs); }
.freshness { margin-left: auto; color: var(--text-3); }
.freshness.bad { color: var(--bad); }
.machine-status { margin-top: var(--s2); font-size: var(--fs-sm); }
.machine-bar { height: 14px; margin-top: var(--s3); border-radius: var(--r-sm); background: var(--surface-3); overflow: hidden; }
.machine-bar > span { display: block; height: 100%; background: var(--info); }
.machine-metrics { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s3); margin-top: var(--s1); color: var(--text-3); font-size: var(--fs-xs); }
.machine-metrics b { color: var(--text-2); font-weight: 500; }
.machine-jobs { list-style: none; display: grid; gap: 6px; padding: 0; margin: var(--s2) 0 0; }
.machine-job { padding: 6px 8px; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r); }
.job-title, .job-meta { display: flex; gap: 6px; align-items: center; }
.job-title { font-size: var(--fs-sm); }
.job-title .sched-link { text-align: left; min-width: 0; overflow-wrap: anywhere; }
.job-cores { margin-left: auto; white-space: nowrap; }
.job-meta { justify-content: space-between; flex-wrap: wrap; font-size: var(--fs-xs); color: var(--text-3); margin-top: var(--s1); }
</style>
