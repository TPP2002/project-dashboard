<script setup lang="ts">
import type { TicketEstimate } from '@/api/sched'
import { duration, stamp } from './format'
defineProps<{ estimate?: TicketEstimate }>()
</script>

<template>
  <span v-if="!estimate" class="sched-note">暂无法预估（预估数据不可读）</span>
  <span v-else-if="estimate.kind === 'unavailable'" class="sched-note">暂无法预估（{{ estimate.reason }}）</span>
  <span v-else :title="`同类最近 ${estimate.sampleCount} 次执行的中位耗时：${duration(estimate.medianMs)}`">
    <template v-if="estimate.kind === 'wait'">预计等待 {{ duration(estimate.waitMs) }}<span class="sched-note"> · {{ stamp(estimate.startAt) }} 开跑</span></template>
    <template v-else><span v-if="estimate.overdue" class="warn">已超出平均耗时</span><span v-else>预计完成 {{ stamp(estimate.finishAt) }}</span></template>
  </span>
</template>
