<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Collaborator, MemberTask, TaskAction, User } from './types'
import { drawerActions, messageProblem } from './board'
import CollabIcon from './CollabIcon.vue'
import CollaboratorList from './CollaboratorList.vue'
import PrioritySegment from '../components/PrioritySegment.vue'
import type { Priority } from '../utils/taskPriority'
const props = defineProps<{ task: MemberTask; user: User; busy: boolean; send: (text: string) => Promise<void>; setPriority?: (priority: Priority) => Promise<unknown> }>()
async function submitPriority(priority: Priority) {
  if (!props.setPriority) throw new Error('优先级操作不可用')
  await props.setPriority(priority)
}
defineEmits<{ close: []; action: [action: TaskAction]; remove: [person: Collaborator] }>()
const closeButton = ref<HTMLButtonElement | null>(null)
const message = ref('')
const error = ref('')
const sending = ref(false)
const actions = computed(() => drawerActions(props.task))
const viewer = computed(() => props.user.role === 'viewer')
const creator = computed(() => {
  const id = props.task.createdByUserId
  if (!id) return '未署名'
  if (id === props.user.id) return props.user.displayName || props.user.username
  if (id === props.task.assigneeUserId) return props.task.assigneeName || id
  return props.task.collaborators?.find(person => person.userId === id)?.name || props.task.messages?.find(item => item.userId === id)?.author || id
})
async function sendMessage() {
  if (props.busy || sending.value || !props.task.actions?.includes('note')) return
  error.value = messageProblem(message.value)
  if (error.value) return
  sending.value = true
  try { await props.send(message.value.trim()); message.value = '' }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '发送失败' }
  finally { sending.value = false }
}
onMounted(() => closeButton.value?.focus())
</script>
<template>
  <aside class="member-drawer" aria-label="任务详情" @keydown.esc.stop="$emit('close')">
    <header class="member-drawer-head">
      <div class="drawer-top"><span class="mono">{{ task.id }}</span><button ref="closeButton" type="button" class="btn quiet" aria-label="关闭任务详情" @click="$emit('close')"><CollabIcon name="close" /></button></div>
      <h2>{{ task.plainTitle || task.title }}</h2><span>{{ task.status }} · {{ task.percent ?? 0 }}%</span>
      <small>建卡人：{{ creator }}</small>
      <small v-if="task.dates?.design">设计：{{ task.dates.design }}</small><small v-if="task.dates?.start">开工：{{ task.dates.start }}</small><small v-if="task.dates?.done">完工：{{ task.dates.done }}</small>
    </header>
    <div v-if="actions.length" class="drawer-actions"><button v-for="entry in actions" :key="entry.action" type="button" class="btn btn-sm" :class="entry.kind" :disabled="busy" @click="$emit('action', entry.action)">{{ entry.label }}</button></div>
    <section class="drawer-actions" aria-label="操作"><PrioritySegment :priority="task.priority" :readonly="!task.actions?.includes('priority')" :disabled="busy" :submit="submitPriority" /></section>
    <div class="member-thread">
      <CollaboratorList :task="task" :user-id="user.id" :show-slots="!viewer" :can-remove="task.actions?.includes('removeCollaborator')" :busy="busy" @remove="$emit('remove', $event)" />
      <section class="member-description"><h3>说明</h3><p v-if="task.plainTitle && task.plainTitle !== task.title">{{ task.title }}</p><p>{{ task.description || '暂无说明' }}</p><p v-if="task.blockReason">阻碍：{{ task.blockReason }}</p><p v-if="task.cancelReason">作废理由：{{ task.cancelReason }}</p></section>
      <section class="member-messages" aria-label="留言"><h3>留言</h3><p v-if="!task.messages?.length" class="muted">还没有留言。</p><article v-for="(item, index) in task.messages ?? []" :key="`${item.ts}:${index}`" class="member-message"><div><b>{{ item.author || '未署名' }}</b><time :datetime="item.ts || undefined">{{ item.ts ? new Date(item.ts).toLocaleString() : '' }}</time></div><p>{{ item.text }}</p></article></section>
    </div>
    <form v-if="task.actions?.includes('note')" class="member-compose" @submit.prevent="sendMessage"><label>写留言<textarea v-model="message" rows="2" maxlength="2000" required :disabled="busy || sending" placeholder="所有能看这张卡的人都看得到" /></label><div><small>{{ message.length }}/2000</small><button class="btn primary" :disabled="busy || sending || !!messageProblem(message)">发送</button></div><p v-if="error" role="alert" class="collab-error">{{ error }}</p></form>
    <p v-else-if="viewer" class="member-readonly"><CollabIcon name="eye" />你是只读访客：可以看卡片和留言，不能留言或改动卡片</p>
  </aside>
</template>
<style scoped>
.member-drawer { display: flex; flex-direction: column; width: 360px; flex: none; max-width: 100vw; min-height: 0; background: var(--bg); border-left: 1px solid var(--line); overflow: hidden; }
.member-drawer-head { display: grid; gap: 4px; padding: var(--s3); border-bottom: 1px solid var(--line); font-size: var(--fs-xs); color: var(--text-2); overflow-wrap: anywhere; max-height: 35%; overflow-y: auto; flex: none; }.member-drawer-head h2 { margin: 0; font-size: var(--fs-md); line-height: 1.45; }.drawer-top { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); }
.drawer-actions { padding: var(--s2) var(--s3); display: flex; gap: 6px; flex-wrap: wrap; border-bottom: 1px solid var(--line); flex: none; }
.member-thread { min-height: 0; flex: 1; overflow-y: auto; }.member-description, .member-messages { padding: var(--s3); }.member-description { border-bottom: 1px dashed var(--line); }.member-description p, .member-message p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--fs-sm); }.member-thread h3 { font-size: var(--fs-sm); margin: 0; }.member-message { padding: var(--s2) 0; }.member-message > div { display: flex; flex-wrap: wrap; gap: var(--s2); font-size: var(--fs-xs); }.member-message time { color: var(--text-3); }
.member-compose { padding: var(--s2) var(--s3); border-top: 1px solid var(--line); flex: none; }.member-compose > div { display: flex; justify-content: space-between; align-items: center; margin-top: var(--s2); }.member-compose textarea { resize: vertical; max-height: 160px; }.member-readonly { margin: 0; padding: var(--s3); border-top: 1px solid var(--line); color: var(--text-2); font-size: var(--fs-xs); }
@media (max-width: 760px) { .member-drawer { position: absolute; right: 0; top: 0; bottom: 0; width: min(420px, 100%); z-index: 10; box-shadow: -8px 0 24px var(--drawer-shadow); } }
</style>
