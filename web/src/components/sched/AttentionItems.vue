<script setup lang="ts">
import { computed } from 'vue'
import type { SchedSnapshot } from '@/api/sched'
import { freshness } from './format'
const props = defineProps<{ snapshot: SchedSnapshot; now: number }>()
const emit = defineEmits<{ open: [id: string] }>()
const items = computed(() => {
  const result: { text: string; tone: 'bad' | 'warn'; ticketId?: string }[] = []
  for (const machine of props.snapshot.machines) {
    if (!machine.online) result.push({ tone: 'warn', text: `${machine.name} 离线，不参与派单` })
    else if (freshness(machine, props.now).stale) result.push({ tone: 'bad', text: `${machine.name} 数据过期，请检查机器心跳与负载采样` })
    if (machine.ci === 'unknown') result.push({ tone: 'warn', text: `${machine.name} CI 状态未知` })
    if (machine.overCommitted) result.push({ tone: 'bad', text: `${machine.name} 超额中，派单员已标记；在跑的活不打断` })
    if (machine.ownerHold) result.push({ tone: 'warn', text: '主机已按你的要求全部暂停（在「我要用电脑」里点恢复）' })
    const reserve = machine.reservation
    if (reserve && reserve.fulfilledCores < reserve.requestedCores) result.push({ tone: 'warn',
      text: `你申请主机留 ${reserve.requestedCores} 核，已兑现 ${reserve.fulfilledCores} 核：在跑的活不打断，跑完一单腾一单` })
  }
  for (const ticket of props.snapshot.queue) if (ticket.state === 'unsatisfiable') result.push({ tone: 'bad',
    text: `${ticket.ticketId} 无法满足：${ticket.reason}；可以撤单，或让派单方调整申请`, ticketId: ticket.ticketId })
  for (const ticket of props.snapshot.running) {
    if (ticket.cancelRequested) result.push({ tone: 'warn', text: `${ticket.title} 撤单处理中，等待执行端确认退出`, ticketId: ticket.ticketId })
    else if (ticket.pauseReasons.includes('manual')) result.push({ tone: 'warn', text: `${ticket.title} 手动暂停中`, ticketId: ticket.ticketId })
  }
  return result
})
</script>

<template>
  <section class="sched-attention" aria-labelledby="sched-attention-title">
    <h2 id="sched-attention-title">需要你处理</h2>
    <p v-if="!items.length" class="sched-muted">没有需要你处理的事</p>
    <div v-for="(item, index) in items" :key="index" class="sched-attention-row">
      <span class="sched-tag" :class="item.tone">{{ item.tone === 'bad' ? '异常' : '留意' }}</span>
      <button v-if="item.ticketId" class="sched-link" @click="item.ticketId && emit('open', item.ticketId)">{{ item.text }}</button>
      <span v-else>{{ item.text }}</span>
    </div>
  </section>
</template>
