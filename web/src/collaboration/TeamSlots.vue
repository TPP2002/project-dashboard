<script setup lang="ts">
import { slots, type TeamTask } from './board'
defineProps<{ task: TeamTask }>()
</script>
<template><span class="team-slots" role="img" :aria-label="`协作名额 ${slots(task)}/5`" :title="`协作名额 ${slots(task)}/5`"><i v-for="n in 5" :key="n" :class="{ occupied: n <= slots(task) }" /></span></template>
<style scoped>
.team-slots { display: inline-flex; gap: 3px; align-items: center; }
.team-slots i { width: 10px; height: 4px; border-radius: 2px; background: var(--surface-3); }.team-slots .occupied { background: var(--info); }
</style>
