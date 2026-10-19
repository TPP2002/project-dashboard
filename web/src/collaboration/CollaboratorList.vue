<script setup lang="ts">
import { computed } from 'vue'
import { avatarStack, type TeamTask } from './board'
import type { Collaborator } from './types'
import CollabIcon from './CollabIcon.vue'
import TeamSlots from './TeamSlots.vue'
const props = defineProps<{ task: TeamTask; canRemove?: boolean; showSlots?: boolean; busy?: boolean; userId?: string }>()
defineEmits<{ remove: [person: Collaborator] }>()
const lead = computed(() => avatarStack(props.task).lead)
</script>
<template>
  <section class="collab-team" aria-label="一起做的人">
    <div class="team-heading"><CollabIcon name="users" />一起做的人 <span class="mono">{{ lead ? 1 : 0 }} + {{ task.collaborators?.length ?? 0 }}</span><TeamSlots v-if="showSlots" :task="task" /></div>
    <div v-if="lead" class="team-person lead"><span class="person-avatar">{{ lead.ai ? 'AI' : lead.name.slice(0, 1) }}</span><b>{{ lead.ai ? 'AI 施工' : lead.name }}</b><span class="identity"><CollabIcon name="crown" />主负责人</span><time>{{ task.dates?.start?.slice(5) }}</time></div>
    <p v-else class="team-empty">尚未领取</p>
    <div v-for="person in task.collaborators ?? []" :key="person.userId" class="team-person">
      <span class="person-avatar co">{{ person.name.slice(0, 1) }}</span><b>{{ person.name }}</b><span v-if="person.userId === userId" class="badge info compact">我</span><span class="identity">协作</span>
      <time :datetime="person.joinedAt" :title="person.joinedAt">{{ person.joinedAt.slice(5, 10) }}</time>
      <button v-if="canRemove" type="button" class="remove-person" :disabled="busy" :aria-label="`把${person.name}移出协作`" :title="`把${person.name}移出协作`" @click="$emit('remove', person)"><CollabIcon name="close" /></button>
    </div>
  </section>
</template>
<style scoped>
.collab-team { padding: var(--s3); border-bottom: 1px solid var(--line); display: grid; gap: 6px; }
.team-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--text-2); font-size: var(--fs-xs); }.team-heading > :last-child { margin-left: auto; }
.team-person { display: flex; align-items: center; gap: 7px; padding: 4px 6px; border-radius: var(--r); font-size: var(--fs-sm); }.team-person:hover { background: var(--surface-2); }.team-person b { font-weight: 500; overflow-wrap: anywhere; }
.person-avatar { width: 22px; height: 22px; display: inline-grid; place-items: center; flex: none; border-radius: 50%; background: var(--chart-1); color: var(--chart-on-series); font-size: 11px; }.person-avatar.co { background: var(--chart-4); }
.identity { display: inline-flex; align-items: center; gap: 3px; color: var(--text-3); font-size: var(--fs-xs); white-space: nowrap; }.lead .identity { color: var(--warn); }
.team-person time { margin-left: auto; color: var(--text-3); font-size: var(--fs-xs); font-family: var(--mono); white-space: nowrap; }
.remove-person { display: inline-flex; align-items: center; padding: 2px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-3); opacity: 0; cursor: pointer; transition: opacity .14s; }
.team-person:hover .remove-person, .team-person:focus-within .remove-person { opacity: 1; }.remove-person:hover { background: var(--bad-bg); color: var(--bad); }.remove-person:disabled { cursor: not-allowed; }
.team-empty { color: var(--text-3); font-size: var(--fs-sm); margin: 0; }
@media (hover: none) { .remove-person { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .remove-person { transition: none; } }
</style>
