<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import CollabIcon from './CollabIcon.vue'
defineProps<{ title: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
let previous: HTMLElement | null = null
onMounted(() => { previous = document.activeElement as HTMLElement | null; dialog.value?.showModal(); dialog.value?.querySelector<HTMLElement>('input,textarea,select,[data-initial-focus]')?.focus() })
onBeforeUnmount(() => { dialog.value?.close(); if (previous?.isConnected) previous.focus() })
</script>
<template>
  <Teleport to="body"><dialog ref="dialog" class="collab collab-modal" :aria-label="title" @cancel.prevent="emit('close')" @keydown.esc.stop>
    <header class="modal-heading"><h2>{{ title }}</h2><button type="button" class="btn quiet" aria-label="关闭弹窗" @click="emit('close')"><CollabIcon name="close" /></button></header>
    <slot />
  </dialog></Teleport>
</template>
<style scoped>
.collab-modal { margin: auto; width: min(460px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: var(--s4); background: var(--surface); color: var(--text); border: 1px solid var(--line-strong); border-radius: var(--r-lg); box-shadow: 0 8px 30px var(--drawer-shadow); }
.collab-modal::backdrop { background: var(--overlay); }.modal-heading { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s3); }.modal-heading h2 { margin: 0; flex: 1; font-size: var(--fs-lg); }
</style>
