<script setup lang="ts">
import { LABELS, type Priority } from '../utils/taskPriority'
defineProps<{ priority?: Priority }>()
</script>
<template>
  <span v-if="priority && priority !== 'medium'" class="priority-badge" :data-priority="priority">
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <template v-if="priority === 'urgent'"><circle class="ring" cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.2" /><circle cx="6" cy="6" r="3" fill="currentColor" /></template>
      <path v-else-if="priority === 'high'" class="chev" d="M2.5 7.5 6 4l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      <path v-else-if="priority === 'low'" d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <circle v-else cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.6" />
    </svg>{{ LABELS[priority] }}
  </span>
</template>
<style scoped>
.priority-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 18px; padding: 0 7px 0 5px; border-radius: 9px; color: var(--priority-color); background: color-mix(in srgb,var(--priority-color) 12%,transparent); white-space: nowrap; }
svg { width: 12px; height: 12px; flex: none; }
[data-priority="optional"] { background: transparent; box-shadow: inset 0 0 0 1px var(--line-strong); }
.ring { transform-origin: 6px 6px; animation: priority-ping 1.6s ease-out infinite; }.chev { animation: priority-rise 1.8s ease-in-out infinite; }
@keyframes priority-ping { from { transform: scale(.6); opacity: .9; } to { transform: scale(1.25); opacity: 0; } }
@keyframes priority-rise { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }
@media (prefers-reduced-motion: reduce) { .ring,.chev { animation: none; } }
</style>
