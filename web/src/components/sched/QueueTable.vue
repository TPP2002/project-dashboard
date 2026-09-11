<script setup lang="ts">
import type { QueueEntry, TicketDetail } from '@/api/sched'
import { duration } from './format'
defineProps<{ queue: QueueEntry[]; locks: { machine: string; byTicketId: string }[]; details: Record<string, TicketDetail>; errors: Record<string, string>; now: number; busy: boolean }>()
const emit = defineEmits<{ open: [id: string]; jump: [id: string]; cancel: [id: string] }>()
</script>

<template>
  <section class="sched-card">
    <h2>排队 <span class="sched-sub">{{ queue.length ? `共 ${queue.length} 单在等` : '队伍是空的' }}</span></h2>
    <div class="sched-table-wrap">
      <table class="sched-table"><thead><tr><th>名次</th><th>项目</th><th>活</th><th class="r">要几核</th><th>去哪</th><th class="r">已等</th><th>操作</th></tr></thead>
        <tbody><tr v-for="ticket in queue" :key="ticket.ticketId">
          <td class="sched-id">{{ ticket.position }}</td><td>{{ details[ticket.ticketId]?.request.project || '读取中' }}</td>
          <td><button class="sched-link" @click="emit('open', ticket.ticketId)">{{ details[ticket.ticketId]?.request.title || ticket.ticketId }}</button>
            <div class="sched-id">{{ details[ticket.ticketId]?.request.submitter }} · {{ ticket.ticketId }}</div>
            <p v-if="errors[ticket.ticketId]" class="bad">单子信息读取失败：{{ errors[ticket.ticketId] }}</p>
            <span v-if="ticket.band === 0" class="sched-tag info">优先队列</span>
            <span v-for="lock in locks.filter(item => item.byTicketId === ticket.ticketId)" :key="lock.machine" class="sched-tag warn">排头保护：{{ lock.machine }} 停插空</span>
            <p v-if="ticket.state === 'unsatisfiable'" class="bad">无法满足：{{ ticket.reason }}</p>
          </td><td class="r">{{ ticket.requestedCores }}</td><td>{{ ticket.allowedMachines.join('、') }}</td>
          <td class="r">{{ duration(Math.max(0, now - Date.parse(ticket.queuedAt))) }}</td>
          <td class="queue-actions"><button class="sched-btn small" :disabled="busy" @click="emit('jump', ticket.ticketId)">插队</button>
            <button class="sched-btn small bad" :disabled="busy" @click="emit('cancel', ticket.ticketId)">撤单</button></td>
        </tr><tr v-if="!queue.length"><td colspan="7" class="sched-empty">没有在排队的单子</td></tr></tbody>
      </table>
    </div>
    <details class="sched-note"><summary>排队与排头保护规则</summary>
      <p>先来后到；排头的大单凑不齐核数时，后面的小单可以先插空。排头等满 10 分钟后，只在它能去的机器上停止插空，别的机器照常派。需求无法满足的单子不挡别人。名次与保护状态以派单员本拍记录为准。</p>
    </details>
  </section>
</template>

<style scoped>
.queue-actions { white-space: nowrap; }
.queue-actions button + button { margin-left: var(--s1); }
</style>
