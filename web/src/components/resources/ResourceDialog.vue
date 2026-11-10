<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
})
const emit = defineEmits(['close'])

const box = ref<HTMLElement | null>(null)

function onKeydown(event: KeyboardEvent) {
  if (props.open && event.key === 'Escape') emit('close')
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

watch(() => props.open, async (open) => {
  if (!open) return
  await nextTick()
  box.value?.focus()
})
</script>

<template>
  <div v-if="open" class="res-overlay" @click.self="emit('close')">
    <div ref="box" class="res-dialog card" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
      <h2 class="res-dialog-title">{{ title }}</h2>
      <div class="res-dialog-body"><slot /></div>
      <div class="res-dialog-actions"><slot name="actions" /></div>
    </div>
  </div>
</template>

<style scoped>
.res-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--s4);
  background: var(--overlay);
}
.res-dialog {
  display: grid;
  gap: var(--s3);
  width: min(440px, 100%);
  max-height: 90vh;
  overflow-y: auto;
  background: var(--surface);
}
.res-dialog-title { margin: 0; font-size: var(--fs-lg); }
.res-dialog-body { display: grid; gap: var(--s3); }
.res-dialog-actions { display: flex; gap: var(--s2); justify-content: flex-end; flex-wrap: wrap; }
</style>
