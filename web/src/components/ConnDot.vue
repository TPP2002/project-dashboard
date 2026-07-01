<script setup lang="ts">
import type { ConnState } from '@/api/sse'
const props = defineProps<{ state: ConnState }>()
const MAP: Record<ConnState, [string, string]> = {
  sse: ['#2ea043', '实时'],
  polling: ['#f5a623', '轮询'],
  connecting: ['#4c8dff', '连接中'],
  offline: ['#5f6b7a', '离线'],
}
</script>

<template>
  <span class="conn" :title="'实时连接：' + MAP[props.state][1]">
    <i :style="{ background: MAP[props.state][0] }" :class="{ blink: props.state === 'connecting' }" />
    <span class="txt">{{ MAP[props.state][1] }}</span>
  </span>
</template>

<style scoped>
.conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.conn i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.blink { animation: blink 1s infinite; }
@keyframes blink { 50% { opacity: 0.3; } }
</style>
