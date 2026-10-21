<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { Task } from '../types'
import type { TaskAction } from './types'
import { apiJson, collaborationOwnerUser } from './http'
import { actionPath, type DrawerAction } from './board'
import { ownerCardAction, ownerDrawerActions } from './ownerActions'
import { toChineseError } from './errorText'
import ActionDialog from './ActionDialog.vue'

const props = defineProps<{ task: Task; projectId: string; refresh: () => Promise<unknown>; variant: 'card' | 'drawer' }>()
const user = computed(() => collaborationOwnerUser())
const entries = computed(() => {
  const all = ownerDrawerActions(props.task, user.value)
  return props.variant === 'drawer' ? all : all.filter(entry => entry.action === ownerCardAction(props.task, user.value))
})
const selected = ref<TaskAction | null>(null)
const busy = ref(false)
const error = ref('')
const controller = new AbortController()
async function perform(action: TaskAction, body: unknown) {
  if (busy.value || !collaborationOwnerUser()) return
  busy.value = true
  error.value = ''
  try {
    await apiJson(actionPath(props.projectId, props.task.id, action), body, controller.signal)
    if (!controller.signal.aborted) {
      selected.value = null
      await props.refresh()
    }
  } catch (cause) {
    if (!controller.signal.aborted) error.value = toChineseError(0, cause instanceof Error ? cause.message : '操作失败，请重试')
  } finally { busy.value = false }
}
function activate(entry: DrawerAction) {
  if (busy.value) return
  error.value = ''
  if (entry.needs === 'none') void perform(entry.action, {})
  else selected.value = entry.action
}
async function submit(body: unknown) {
  if (selected.value) await perform(selected.value, body)
  if (error.value) throw new Error(error.value)
}
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <div v-if="user && (entries.length || error)" class="collab owner-task-actions" :class="variant" @click.stop @keydown.stop>
    <div class="owner-action-buttons">
      <button v-for="entry in entries" :key="entry.action" type="button" class="btn btn-sm" :class="entry.kind" :disabled="busy" @click.stop="activate(entry)">{{ entry.label }}</button>
    </div>
    <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
    <ActionDialog v-if="selected" :action="selected" :task="task" :submit="submit" @close="selected = null" />
  </div>
</template>

<style scoped>
.owner-task-actions.card { margin-left: auto; padding: 0; border: 0; box-shadow: none; background: none; }
.owner-action-buttons { display: flex; flex-wrap: wrap; gap: var(--s2); }
.owner-task-actions.card .owner-action-buttons { justify-content: flex-end; }
.collab-error { margin: var(--s1) 0 0; }
</style>
