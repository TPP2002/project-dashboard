<script setup lang="ts">
import type { TicketEstimate } from '@/api/sched'
import { duration, stamp } from './format'
type EstimateContext = { ciHeadroom?: number; slowdown?: number; slowdownEstimated?: boolean }
defineProps<{ estimate?: TicketEstimate & EstimateContext }>()
</script>

<template>
  <span>
    <span v-if="!estimate" class="sched-note">算不出（读不到预估数据）</span>
    <span v-else-if="estimate.kind === 'unavailable'" class="sched-note">算不出（{{ estimate.reason }}）</span>
    <span v-else :title="`同类最近 ${estimate.sampleCount} 次执行的中位耗时：${duration(estimate.medianMs)}`">
      <template v-if="estimate.kind === 'wait'">预计等待 {{ duration(estimate.waitMs) }}<span class="sched-note"> · {{ stamp(estimate.startAt) }} 开跑</span></template>
      <template v-else><span v-if="estimate.overdue" class="warn">已超出预计耗时</span><span v-else>预计完成 {{ stamp(estimate.finishAt) }}</span></template>
      <span class="sched-note"> · 预计跑 {{ duration(estimate.medianMs * (estimate.slowdown ?? 1)) }}</span>
      <span v-if="estimate.slowdown !== undefined" class="sched-note"> · 低优先级耗时 {{ Number(estimate.slowdown.toFixed(2)) }} 倍（{{ estimate.slowdownEstimated === false ? '实测' : '估' }}）</span>
    </span>
    <span v-if="estimate?.ciHeadroom !== undefined" class="sched-note"> · CI 留了 {{ estimate.ciHeadroom }} 核</span>
  </span>
</template>
