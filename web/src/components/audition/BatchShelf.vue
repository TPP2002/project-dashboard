<script setup lang="ts">
import type { AuditionEntry, AuditionSummary } from '@/types/audition'
defineProps<{ entries: AuditionEntry[]; summaries: Record<string, AuditionSummary>; selected: string; loading: boolean }>()
defineEmits<{ select: [key: string]; refresh: [] }>()
</script>
<template>
  <aside class="shelf">
    <header><h2>批次架</h2><button class="btn btn-sm" :disabled="loading" @click="$emit('refresh')">刷新</button></header>
    <p v-if="!entries.length">还没有可试听的批次。</p>
    <button v-for="entry in entries" :key="entry.key" class="batch" :data-selected="selected === entry.key"
      :aria-pressed="selected === entry.key" @click="$emit('select', entry.key)">
      <strong>{{ entry.title }}</strong>
      <span>{{ entry.addedAt }} · {{ summaries[entry.key]?.review ? '已审阅' : entry.status || '未审阅' }}</span>
      <span>批注 {{ summaries[entry.key]?.notes || 0 }} · 好 {{ summaries[entry.key]?.up || 0 }} · 不好 {{ summaries[entry.key]?.down || 0 }}</span>
    </button>
  </aside>
</template>
<style scoped>
.shelf { border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); overflow: auto; padding: var(--s3); }
header { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); margin-bottom: var(--s3); }
h2 { margin: 0; font-size: var(--fs-md); }
.batch { display: grid; gap: var(--s2); width: 100%; text-align: left; padding: var(--s3); margin-bottom: var(--s2); background: var(--surface-2); color: var(--text); border: 1px solid var(--line); border-radius: var(--r); cursor: pointer; }
.batch[data-selected="true"] { border-color: var(--info); background: var(--info-bg); }
.batch span, p { color: var(--text-2); font-size: var(--fs-sm); }
</style>
