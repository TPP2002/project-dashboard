<script setup lang="ts">
import type { ConnState } from '@/api/sse'
const props = defineProps<{ state: ConnState }>()
const LABEL: Record<ConnState, string> = {
  sse: '实时',
  polling: '轮询',
  connecting: '连接中',
  offline: '离线',
}
</script>

<template>
  <span class="conn" :title="'实时连接：' + LABEL[props.state]">
    <i :class="[props.state, { blink: props.state === 'connecting' }]" />
    <span class="txt">{{ LABEL[props.state] }}</span>
  </span>
</template>

<style scoped>
.conn { display: inline-flex; align-items: center; gap: var(--s2); color: var(--text-2); font-size: var(--fs-sm); }
.conn i { display: inline-block; width: var(--s2); height: var(--s2); border-radius: 50%; background: var(--bad); }
.conn i.sse { background: var(--ok); }
.conn i.polling { background: var(--warn); }
.conn i.connecting { background: var(--info); }
.blink { animation: blink 1s infinite; }
@keyframes blink { 50% { opacity: 0.3; } }
</style>
