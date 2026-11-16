<script setup lang="ts">
import type { TicketEstimate } from '@/api/sched'
import { describeEstimate } from './format'
type EstimateContext = { ciHeadroom?: number; slowdown?: number; slowdownEstimated?: boolean }
const props = defineProps<{ estimate?: TicketEstimate & EstimateContext }>()
const text = () => describeEstimate(props.estimate)
</script>

<template>
  <span>
    <span v-if="!estimate" class="sched-note">算不出（读不到预估数据）</span>
    <span v-else-if="estimate.kind === 'unavailable'" class="sched-note">算不出（{{ estimate.reason }}）</span>
    <span v-else :title="text().title">
      <span v-if="text().warn" class="warn">{{ text().headline }}</span>
      <template v-else>{{ text().headline }}</template>
      <span class="sched-note">{{ text().detail }}</span>
    </span>
    <span v-if="estimate?.ciHeadroom !== undefined" class="sched-note"> · CI 留了 {{ estimate.ciHeadroom }} 核</span>
  </span>
</template>
