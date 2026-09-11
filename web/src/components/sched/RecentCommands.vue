<script setup lang="ts">
import { computed } from 'vue'
import type { Receipt } from '@/api/sched'
import type { SubmittedCommand } from './preferences'
import { commandLabel, stamp, tone } from './format'
const props = defineProps<{ receipts: Receipt[]; submitted: SubmittedCommand[]; now: number; busy: boolean }>()
const emit = defineEmits<{ retry: [id: string] }>()
const rows = computed(() => {
  const byId = new Map<string, { id: string; label: string; at: string; status: string; reason?: string; command?: SubmittedCommand }>()
  for (const receipt of props.receipts) byId.set(receipt.commandId, { id: receipt.commandId, label: '调度指令', at: receipt.at, status: receipt.status, reason: receipt.reason })
  for (const command of props.submitted) {
    const receipt = props.receipts.find(item => item.commandId === command.commandId) || command.receipt
    byId.set(command.commandId, { id: command.commandId, label: commandLabel(command.input), at: receipt?.at || command.createdAt,
      status: receipt?.status || (props.now > Date.parse(command.expiresAt) ? 'expired' : 'submitted'), reason: receipt?.reason, command })
  }
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 20)
})
const labels: Record<string, string> = { executed: '已执行', rejected: '已拒绝', expired: '超时未执行', submitted: '已提交' }
</script>
<template>
  <section class="sched-card" aria-live="polite">
    <h2>最近指令 <span class="sched-sub">看板上点的操作，派单员执行后回执</span></h2>
    <ul class="receipt-list"><li v-for="row in rows" :key="row.id">
      <div class="receipt-main"><span>{{ row.label }}</span><strong :class="tone(row.status)">{{ labels[row.status] }}</strong></div>
      <p v-if="row.reason" class="bad">{{ row.reason }}</p>
      <div class="sched-id" :title="stamp(row.at)">{{ row.id }} · {{ stamp(row.at) }}</div>
      <div v-if="row.command?.legacy?.ok === false" class="legacy-error bad">
        <span>旧账本同步失败：{{ row.command.legacy.error }}</span>
        <button class="sched-btn small" :disabled="busy" @click="emit('retry', row.id)">重试同步</button>
      </div>
      <div v-else-if="row.command?.legacy?.ok" class="sched-note">旧账本已同步</div>
    </li></ul>
    <p v-if="!rows.length" class="sched-empty">还没有指令</p>
  </section>
</template>
<style scoped>
.receipt-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s2); }
.receipt-list li { padding-bottom: var(--s2); border-bottom: 1px solid var(--line); }
.receipt-list li:last-child { border-bottom: 0; }
.receipt-list p { margin: var(--s1) 0; font-size: var(--fs-xs); }
.receipt-main { display: flex; align-items: baseline; gap: 6px; justify-content: space-between; font-size: var(--fs-sm); overflow-wrap: anywhere; }
.receipt-main strong { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 500; }
.legacy-error { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: var(--fs-xs); }
</style>
