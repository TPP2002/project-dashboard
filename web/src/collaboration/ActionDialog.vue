<script setup lang="ts">
import { computed, ref } from 'vue'
import { drawerActions, reasonProblem, titleProblem } from './board'
import { progressBody } from './flow'
import type { Collaborator, MemberTask, TaskAction } from './types'
import ModalShell from './ModalShell.vue'
const props = defineProps<{ action: TaskAction | 'create'; task?: MemberTask; person?: Collaborator; submit: (body: unknown) => Promise<void> }>()
defineEmits<{ close: [] }>()
const title = ref('')
const description = ref('')
const reason = ref('')
const percent = ref(props.task?.percent ?? 0)
const note = ref('')
const error = ref('')
const busy = ref(false)
// Labels and input kind come from the same ordered action definitions as the drawer.
const entry = computed(() => props.action === 'create' || props.action === 'removeCollaborator' ? null : drawerActions({ actions: [props.action] })[0])
const heading = computed(() => props.action === 'create' ? '新建卡片' : props.action === 'removeCollaborator' ? `把${props.person?.name ?? '此成员'}移出协作？` : `${entry.value?.label ?? ''}${entry.value?.needs === 'confirm' ? '这张卡？' : ''}`)
const danger = computed(() => props.action === 'cancel' || props.action === 'removeCollaborator')
async function submitForm() {
  if (busy.value) return
  error.value = ''
  let body: unknown = {}
  if (props.action === 'create') {
    error.value = titleProblem(title.value) || (description.value.trim().length > 4000 ? '说明最多 4000 字' : '')
    body = { title: title.value.trim(), description: description.value.trim() }
  } else if (entry.value?.needs === 'reason') {
    error.value = reasonProblem(reason.value); body = { reason: reason.value.trim() }
  } else if (props.action === 'progress') {
    try { body = progressBody(percent.value, note.value) }
    catch (cause) { error.value = cause instanceof Error ? cause.message : '进度填写有误' }
  } else if (props.action === 'removeCollaborator') {
    if (!props.person) { error.value = '未指定协作人'; return }
    body = { userId: props.person.userId }
  }
  if (error.value) return
  busy.value = true
  try { await props.submit(body) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '操作失败，请重试' }
  finally { busy.value = false }
}
</script>
<template>
  <ModalShell :title="heading" @close="$emit('close')">
    <form class="collab-form" @submit.prevent="submitForm">
      <p v-if="task" class="muted">{{ task.id }} · {{ task.plainTitle || task.title }}</p>
      <template v-if="action === 'create'"><label>标题（必填）<input v-model="title" required maxlength="200" :disabled="busy" /></label><label>说明（选填）<textarea v-model="description" maxlength="4000" rows="4" :disabled="busy" /></label><small>卡号自动生成，新卡进待开工。建好后任何成员都能领取。</small></template>
      <label v-else-if="entry?.needs === 'reason'">理由（必填，写进卡片历史）<textarea v-model="reason" required maxlength="500" rows="4" :disabled="busy" /></label>
      <template v-else-if="action === 'progress'"><label>完成进度<input v-model.number="percent" type="range" min="0" max="100" step="1" :disabled="busy" /></label><label>进度百分比<input v-model.number="percent" type="number" required min="0" max="100" step="1" :disabled="busy" /></label><label>下一步（选填）<input v-model="note" maxlength="500" :disabled="busy" /></label><small>做完了点“收官”，卡直接进“已完工”，不用等负责人审批。</small></template>
      <p v-if="action === 'cancel'">作废不是删除：卡还在，之后可以重开。</p>
      <p v-if="action === 'done'">确认收官？卡片将进入已完工，进度设为 100%。</p>
      <p v-if="action === 'leave'">确认退出协作？你做过的进度和留言都会保留。</p>
      <p v-if="action === 'removeCollaborator'">他做过的进度和留言都还在，贡献照算；移出后他可以再自己加入。</p>
      <p v-if="error" class="collab-error" role="alert">{{ error }}</p>
      <footer class="collab-dialog-foot"><button type="button" class="btn quiet" @click="$emit('close')">取消</button><button class="btn" :class="danger ? 'danger' : 'primary'" :disabled="busy" data-initial-focus>{{ busy ? '提交中…' : action === 'create' ? '建卡' : action === 'progress' ? '保存' : action === 'removeCollaborator' ? '确认移出' : `确认${entry?.label ?? ''}` }}</button></footer>
    </form>
  </ModalShell>
</template>
