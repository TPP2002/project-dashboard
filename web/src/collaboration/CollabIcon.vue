<script setup lang="ts">
defineProps<{ name: 'eye' | 'crown' | 'close' | 'plus' | 'users' | 'lock' | 'out' }>()
</script>
<template>
  <svg class="collab-icon" viewBox="0 0 16 16" aria-hidden="true">
    <template v-if="name === 'eye'"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></template>
    <template v-else-if="name === 'crown'"><path class="tint" d="M2.5 11.5 1.8 5l3.6 2.6L8 3l2.6 4.6L14.2 5l-.7 6.5z" /><path d="M2.5 11.5 1.8 5l3.6 2.6L8 3l2.6 4.6L14.2 5l-.7 6.5zM3 13.5h10" /></template>
    <path v-else-if="name === 'close'" d="m4.5 4.5 7 7m0-7-7 7" />
    <path v-else-if="name === 'plus'" d="M8 3v10M3 8h10" />
    <template v-else-if="name === 'users'"><circle cx="6" cy="5.5" r="2.4" /><path d="M1.8 13.5c.5-2.5 2.2-3.8 4.2-3.8s3.7 1.3 4.2 3.8M10.4 3.4a2.3 2.3 0 0 1 0 4.3M12 9.9c1.3.5 2 1.7 2.3 3.6" /></template>
    <template v-else-if="name === 'lock'"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></template>
    <path v-else d="M6 2.5H3v11h3M10 5l3 3-3 3M13 8H6.5" />
  </svg>
</template>
<style scoped>
.collab-icon { width: 16px; height: 16px; flex: none; vertical-align: -.2em; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.tint { fill: currentColor; stroke: none; opacity: .18; }
</style>
