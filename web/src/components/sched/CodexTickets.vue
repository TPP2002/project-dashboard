<script setup lang="ts">
import type { TicketSummary, TicketEstimate } from '@/api/sched'
import EstimateText from './EstimateText.vue'
import { duration } from './format'
defineProps<{ tickets: TicketSummary[]; estimates: Record<string, TicketEstimate>; now: number }>()
const emit = defineEmits<{ open: [id: string] }>()
</script>
<template>
  <section class="sched-card">
    <h2>施工中的 Codex 单 <span class="sched-sub">只登记、不占核；规矩已写进单子</span></h2>
    <ul class="codex-list"><li v-for="ticket in tickets" :key="ticket.ticketId">
      <button class="sched-link" @click="emit('open', ticket.ticketId)">{{ ticket.title }}</button>
      <span class="sched-tag info">{{ ticket.project }}</span><span class="sched-tag muted">不占核</span>
      <span class="sched-muted">已开工 {{ duration(Math.max(0, now - Date.parse(ticket.createdAt))) }}</span>
      <EstimateText :estimate="estimates[ticket.ticketId]" />
    </li></ul>
    <p v-if="!tickets.length" class="sched-empty">没有施工中的 Codex 单</p>
  </section>
</template>
<style scoped>
.codex-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; font-size: var(--fs-sm); }
.codex-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 5px 8px; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r); }
.codex-list .sched-link { text-align: left; }
.codex-list .sched-muted { font-size: var(--fs-xs); }
</style>
