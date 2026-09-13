<script setup lang="ts">
import type { TicketSummary, TicketEstimate } from '@/api/sched'
import EstimateText from './EstimateText.vue'
import { duration } from './format'
defineProps<{ engine?: string | null; tickets: TicketSummary[]; estimates: Record<string, TicketEstimate>; now: number }>()
const emit = defineEmits<{ open: [id: string] }>()
</script>

<template>
  <section class="engine-window">
    <h3><span>{{ engine || '外派单 · 未标注' }}</span><span class="engine-count">{{ tickets.length }} 单</span></h3>
    <div class="engine-body sched-scroll-region" tabindex="0" role="region"
      :aria-label="`${engine || '未标注'}外派单列表`" title="内容超出时，可在框内上下滚动">
      <ul class="external-list"><li v-for="ticket in tickets" :key="ticket.ticketId">
        <button class="sched-link" @click="emit('open', ticket.ticketId)">{{ ticket.title }}</button>
        <div class="external-meta"><span>{{ ticket.project }}</span><span>不占核</span></div>
        <div class="external-meta">已开工 {{ duration(Math.max(0, now - Date.parse(ticket.createdAt))) }}</div>
        <EstimateText :estimate="estimates[ticket.ticketId]" />
      </li></ul>
      <p v-if="!tickets.length" class="sched-empty">暂无在跑的单</p>
    </div>
  </section>
</template>

<style scoped>
.engine-window { min-width: 0; border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); overflow-wrap: anywhere; }
.engine-window h3 { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s2); margin: 0; padding: var(--s2) var(--s3); font-size: var(--fs-sm); border-bottom: 1px solid var(--line); border-radius: var(--r) var(--r) 0 0; background: var(--engine-bg, var(--surface-2)); color: var(--engine-accent, var(--text-2)); }
.engine-count { white-space: nowrap; font-size: var(--fs-xs); font-weight: 400; }
.engine-body { padding: var(--s2) var(--s3); }
.external-list { list-style: none; margin: 0; padding: 0; font-size: var(--fs-sm); }
.external-list li { padding: 6px 0; border-bottom: 1px dashed var(--line); }
.external-list li:last-child { border-bottom: 0; }
.external-meta { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s2); margin-top: var(--s1); font-size: var(--fs-xs); color: var(--text-3); }
.engine-body > .sched-empty { text-align: center; }
</style>
