<script setup lang="ts">
import { computed } from 'vue'
import type { AuditionEntry, AuditionSummary } from '@/types/audition'
const props = defineProps<{ entries: AuditionEntry[]; summaries: Record<string, AuditionSummary>; selected: string; loading: boolean; collapsed: boolean }>()
defineEmits<{ select: [key: string]; refresh: []; toggle: [] }>()
const currentTitle = computed(() => props.entries.find(entry => entry.key === props.selected)?.title || '尚未选批次')
const shortTitle = computed(() => Array.from(currentTitle.value).slice(0, 8).join(''))
</script>
<template>
  <aside class="shelf" :data-collapsed="collapsed" aria-label="批次架">
    <header>
      <h2 v-show="!collapsed">批次架</h2>
      <button v-if="!collapsed" class="btn btn-sm" :disabled="loading" @click="$emit('refresh')">刷新</button>
      <button key="toggle" class="btn btn-sm shelf-toggle" :aria-expanded="!collapsed" :aria-label="collapsed ? '展开批次架' : '收起批次架'" @click="$emit('toggle')">{{ collapsed ? '展开' : '收起' }}</button>
    </header>
    <strong v-if="collapsed" class="short-title" :title="currentTitle" :aria-label="`当前批次：${currentTitle}`">{{ shortTitle }}</strong>
    <template v-else>
      <p v-if="!entries.length">还没有可试听的批次。</p>
      <button v-for="entry in entries" :key="entry.key" class="batch" :data-selected="selected === entry.key"
        :aria-pressed="selected === entry.key" @click="$emit('select', entry.key)">
        <strong>{{ entry.title }}</strong>
        <span>{{ entry.addedAt }} · {{ summaries[entry.key]?.review ? '已审阅' : entry.status || '未审阅' }}</span>
        <span>批注 {{ summaries[entry.key]?.notes || 0 }} · 好 {{ summaries[entry.key]?.up || 0 }} · 不好 {{ summaries[entry.key]?.down || 0 }}</span>
      </button>
    </template>
  </aside>
</template>
<style scoped>
.shelf { min-width: 0; min-height: 0; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); overflow: auto; padding: var(--s3); }
header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s1); margin-bottom: var(--s3); }
h2 { margin: 0; font-size: var(--fs-md); flex: 1; }
.batch { display: grid; gap: var(--s2); width: 100%; text-align: left; padding: var(--s3); margin-bottom: var(--s2); background: var(--surface-2); color: var(--text); border: 1px solid var(--line); border-radius: var(--r); cursor: pointer; }
.batch[data-selected="true"] { border-color: var(--info); background: var(--info-bg); }
.batch span, p { color: var(--text-2); font-size: var(--fs-sm); }
.batch { overflow-wrap: anywhere; }
.shelf[data-collapsed="true"] { display: flex; flex-direction: column; align-items: center; padding: var(--s2); }
.shelf[data-collapsed="true"] header { justify-content: center; }
.shelf-toggle { flex: none; }
.short-title { writing-mode: vertical-rl; text-orientation: upright; font-size: var(--fs-sm); color: var(--text-2); letter-spacing: .1em; }
@media (max-width: 750px) {
  .shelf[data-collapsed="true"] { flex-direction: row; gap: var(--s3); }
  .shelf[data-collapsed="true"] header { margin: 0; }
  .short-title { writing-mode: horizontal-tb; }
}
</style>
