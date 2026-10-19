<script setup lang="ts">
import { computed } from 'vue'
import { avatarStack, relationLabel, type TeamTask } from './board'
const props = withDefaults(defineProps<{ task: TeamTask; userId?: string }>(), { userId: '' })
const stack = computed(() => avatarStack(props.task))
</script>
<template>
  <span class="team-avatars">
    <span class="avatar-stack">
      <span v-if="stack.lead" class="team-avatar lead" :class="{ ai: stack.lead.ai }" :title="stack.lead.ai ? 'AI 施工 · 主负责人' : `${stack.lead.name} · 主负责人`">
        <span>{{ stack.lead.ai ? 'AI' : stack.lead.name.slice(0, 1) }}</span>
      </span>
      <span v-for="(person, index) in stack.shown" :key="person.userId" class="team-avatar co" :class="'tone-' + index" :title="`${person.name} · 协作人`">{{ person.name.slice(0, 1) }}</span>
      <span v-if="stack.more" class="team-avatar more" :title="`还有 ${stack.more} 位协作人`">+{{ stack.more }}</span>
    </span>
    <span class="team-relation">{{ relationLabel(task, userId) }}</span>
  </span>
</template>
<style scoped>
.team-avatars { display: inline-flex; align-items: center; gap: 7px; min-width: 0; padding: 4px 0; }
.avatar-stack { display: inline-flex; align-items: center; padding-left: 3px; flex: none; }
.team-avatar { width: 22px; height: 22px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 11px; font-weight: 600; background: var(--chart-1); color: var(--chart-on-series); line-height: 1; flex: none; box-shadow: 0 0 0 2px var(--surface); margin-left: -6px; transition: margin .22s ease; }
.team-avatar:first-child { margin-left: 0; }
.avatar-stack:hover .team-avatar { margin-left: 3px; }
.avatar-stack:hover .team-avatar:first-child { margin-left: 0; }
.team-avatar.lead { position: relative; z-index: 2; isolation: isolate; }
.lead::before { content: ''; position: absolute; inset: -3px; border-radius: 50%; background: conic-gradient(var(--spec-active)); animation: team-ring 6s linear infinite; z-index: -2; }
.lead::after { content: ''; position: absolute; inset: -1px; border-radius: 50%; background: var(--surface); z-index: -1; }
.lead > span { display: grid; place-items: center; width: 100%; height: 100%; border-radius: inherit; background: var(--chart-1); }
.lead.ai > span { background: var(--text-2); color: var(--bg); }
.co.tone-0 { background: var(--chart-6); z-index: 1; }.co.tone-1 { background: var(--chart-2); }.co.tone-2 { background: var(--chart-4); }
.more { background: var(--surface-3); color: var(--text-2); border: 1px solid var(--line-strong); font-family: var(--mono); font-size: 10px; }
.team-relation { font-size: var(--fs-xs); color: var(--text-2); overflow-wrap: anywhere; }
@keyframes team-ring { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .team-avatar, .lead::before { animation: none; transition: none; } }
</style>
