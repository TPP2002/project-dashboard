<script setup lang="ts">
import { ref } from 'vue'
import { PRIORITIES, LABELS, type Priority } from '../utils/taskPriority'
const props = defineProps<{ priority?: Priority; readonly?: boolean; disabled?: boolean; submit: (priority: Priority) => Promise<unknown> }>()
const busy = ref(false), error = ref('')
async function select(priority: Priority) {
  if (props.readonly || props.disabled || busy.value || priority === (props.priority ?? 'medium')) return
  busy.value = true; error.value = ''
  try { await props.submit(priority) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '优先级修改失败' }
  finally { busy.value = false }
}
</script>
<template>
  <div class="priority-row" @click.stop @keydown.stop><span>优先级</span>
    <span v-if="readonly">{{ LABELS[priority ?? 'medium'] }}</span>
    <div v-else class="priority-segment" role="group" aria-label="优先级">
      <button v-for="p in PRIORITIES" :key="p" type="button" :aria-pressed="p === (priority ?? 'medium')" :disabled="disabled || busy" @click="select(p)">{{ LABELS[p] }}</button>
    </div><span v-if="error" role="alert" class="priority-error">{{ error }}</span>
  </div>
</template>
<style scoped>
.priority-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; padding: 6px 0; }.priority-segment { display: inline-flex; border: 1px solid var(--line-strong); border-radius: var(--r); overflow: hidden; }
button { padding: 3px 10px; border: 0; border-right: 1px solid var(--line); background: var(--surface); color: var(--text); font: inherit; cursor: pointer; }button:last-child { border-right: 0; }button[aria-pressed="true"] { background: var(--text); color: var(--bg); }button:disabled { cursor: default; opacity: .6; }.priority-error { color: var(--bad); width: 100%; }
</style>
