<script setup lang="ts">
import { computed } from 'vue'
import type { Receipt } from '@/api/sched'
import type { SubmittedCommand } from './preferences'
import { commandLabel, stamp, tone } from './format'
const props = defineProps<{ receipts: Receipt[]; submitted: SubmittedCommand[]; now: number }>()
const rows = computed(() => {
  const byId = new Map<string, { id: string; label: string; at: string; status: string; reason?: string }>()
  for (const receipt of props.receipts) byId.set(receipt.commandId, { id: receipt.commandId, label: '调度指令', at: receipt.at, status: receipt.status, reason: receipt.reason })
  for (const command of props.submitted) {
    const receipt = props.receipts.find(item => item.commandId === command.commandId) || command.receipt
    byId.set(command.commandId, { id: command.commandId, label: commandLabel(command.input), at: receipt?.at || command.createdAt,
      status: receipt?.status || (props.now > Date.parse(command.expiresAt) ? 'expired' : 'submitted'), reason: receipt?.reason })
  }
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 20)
})
const labels: Record<string, string> = { executed: '已执行', rejected: '已拒绝', expired: '超时未执行', submitted: '已提交' }
</script>
<template>
  <section class="sched-card" aria-live="polite">
    <h2>最近指令 <span class="sched-sub">看板上点的操作，派单员执行后回执</span></h2>
    <div class="receipt-scroll sched-scroll-region" tabindex="0" role="region"
      aria-label="最近指令列表" title="内容超出时，可在框内上下滚动">
      <ul class="receipt-list"><li v-for="row in rows" :key="row.id">
        <div class="receipt-main"><span>{{ row.label }}</span><strong :class="tone(row.status)">{{ labels[row.status] }}</strong></div>
        <p v-if="row.reason" class="bad">{{ row.reason }}</p>
        <div class="sched-id" :title="stamp(row.at)">{{ row.id }} · {{ stamp(row.at) }}</div>
      </li></ul>
      <p v-if="!rows.length" class="sched-empty">还没有指令</p>
    </div>
  </section>
</template>
<style scoped>
.receipt-scroll { max-height: 30vh; padding: var(--s2); }
.receipt-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s2); }
.receipt-list li { padding-bottom: var(--s2); border-bottom: 1px solid var(--line); }
.receipt-list li:last-child { border-bottom: 0; }
.receipt-list p { margin: var(--s1) 0; font-size: var(--fs-xs); }
.receipt-main { display: flex; align-items: baseline; gap: 6px; justify-content: space-between; font-size: var(--fs-sm); overflow-wrap: anywhere; }
.receipt-main strong { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 500; }
</style>
