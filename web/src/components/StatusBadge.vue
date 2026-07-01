<script setup lang="ts">
import { emojiFor, statusColor } from '@/api/schema'
const props = defineProps<{ status: string; small?: boolean }>()
</script>

<template>
  <span
    class="badge"
    :class="{ sm: props.small }"
    :style="{
      background: statusColor(status) + '22',
      color: statusColor(status),
      border: '1px solid ' + statusColor(status) + '55',
    }"
  >
    <span>{{ emojiFor(status) }}</span><span>{{ status }}</span>
  </span>
</template>

<style scoped>
.badge.sm { font-size: 11px; padding: 1px 6px; }
</style>
