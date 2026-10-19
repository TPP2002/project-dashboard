<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Task } from '../types'
import type { Collaborator } from './types'
import { apiJson, isCollaborationOwner } from './http'
import { actionPath } from './board'
import CollaboratorList from './CollaboratorList.vue'
import ActionDialog from './ActionDialog.vue'
const props = defineProps<{ task: Task; projectId: string; refresh: () => Promise<unknown> }>()
const mode = computed(() => isCollaborationOwner())
const team = computed(() => ({ ...props.task, aiWork: props.task.aiWork ?? !!(props.task.builder || props.task.gitBranch?.length || props.task.prNumbers?.length || props.task.commitShas?.length) }))
const person = ref<Collaborator | null>(null)
const busy = ref(false)
const error = ref('')
const controller = new AbortController()
watch(() => `${props.projectId}:${props.task.id}`, () => { person.value = null; error.value = '' })
async function remove(body: unknown) {
  if (busy.value || !isCollaborationOwner()) throw new Error('此刻不能移出协作人')
  const pid = props.projectId; const tid = props.task.id
  busy.value = true; error.value = ''
  try {
    await apiJson(actionPath(pid, tid, 'removeCollaborator'), body, controller.signal)
    person.value = null
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '移出失败'
    throw cause
  } finally {
    try { if (!controller.signal.aborted) await props.refresh() }
    catch (cause) { if (!controller.signal.aborted) error.value = `${error.value ? error.value + '；' : ''}刷新失败：${cause instanceof Error ? cause.message : '请重新读取看板'}` }
    finally { busy.value = false }
  }
}
onBeforeUnmount(() => controller.abort())
</script>
<template>
  <div class="collab"><CollaboratorList :task="team" :can-remove="mode" :show-slots="mode" :busy="busy" @remove="person = $event" /><p v-if="error" role="alert" class="collab-error">{{ error }}</p><ActionDialog v-if="person" action="removeCollaborator" :task="team" :person="person" :submit="remove" @close="person = null" /></div>
</template>
