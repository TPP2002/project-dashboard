<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useAuditionStore } from '@/stores/audition'
import type { AuditionNote } from '@/types/audition'

const props = defineProps<{ scene: string; group: string; label: string; focusRequest: number }>()
const store = useAuditionStore()
const text = ref(''), editing = ref(''), editText = ref(''), busy = ref(false), message = ref(''), failed = ref(false)
const newInput = ref<HTMLTextAreaElement | null>(null), editInput = ref<HTMLTextAreaElement[]>([])
const notes = computed(() => (store.state?.notes || []).filter(note => note.scene === props.scene && note.group === props.group))
const time = (at: string) => at.replace('T', ' ').slice(0, 16)
watch(() => props.focusRequest, async value => {
  if (value) { await nextTick(); newInput.value?.focus() }
}, { immediate: true, flush: 'post' })
async function action(run: () => Promise<string>) {
  if (busy.value) return
  busy.value = true; message.value = ''; failed.value = false
  try { message.value = await run() }
  catch (e) { failed.value = true; message.value = e instanceof Error ? e.message : '批注未能保存，请稍后重试。' }
  finally { busy.value = false }
}
async function edit(note: AuditionNote) {
  editing.value = note.id; editText.value = note.text; message.value = ''
  await nextTick(); editInput.value[0]?.focus()
}
function save(id?: string) {
  void action(async () => {
    const result = id
      ? await store.mutate('note/update', { id, text: editText.value })
      : await store.mutate('note', { scene: props.scene, group: props.group, text: text.value })
    if (id) editing.value = ''; else text.value = ''
    const saved = id ? '修改已保存' : '批注已保存'
    return result.mirrored ? `${saved}，并同步到看板。` : `${saved}；同步看板未成功：${result.mirrorError || '请稍后检查'}`
  })
}
function remove(id: string) {
  void action(async () => {
    await store.mutate('note/delete', { id })
    if (editing.value === id) editing.value = ''
    return '这条批注已删除。'
  })
}
</script>

<template>
  <section class="inline-notes" :aria-label="`${label}的场景批注`">
    <h4>{{ label }} · 批注</h4>
    <p v-if="!notes.length" class="hint">这一组在这个场景还没有批注。</p>
    <article v-for="note in notes" :key="note.id" class="note">
      <form v-if="editing === note.id" @submit.prevent="save(note.id)">
        <label>修改批注<textarea ref="editInput" v-model="editText" rows="3" maxlength="4000" :disabled="busy" /></label>
        <div class="actions">
          <button class="btn btn-sm primary" :disabled="busy || !editText.trim()">保存</button>
          <button type="button" class="btn btn-sm" :disabled="busy" @click="editing = ''">取消</button>
        </div>
      </form>
      <p v-else class="text">{{ note.text }}</p>
      <p class="hint">{{ note.by }} · {{ time(note.at) }}</p>
      <p v-if="note.editedAt" class="hint">已修改 · {{ time(note.editedAt) }}</p>
      <div class="actions">
        <button v-if="editing !== note.id" class="btn btn-sm" :disabled="busy" @click="edit(note)">编辑</button>
        <button class="btn btn-sm" :disabled="busy" @click="remove(note.id)">删除</button>
      </div>
    </article>
    <form @submit.prevent="save()">
      <label>新批注<textarea ref="newInput" v-model="text" rows="3" maxlength="4000" placeholder="说说为什么（可不填）" :disabled="busy" /></label>
      <button class="btn btn-sm primary" :disabled="busy || !text.trim()">保存</button>
    </form>
    <p v-if="message" :role="failed ? 'alert' : 'status'" :data-failed="failed" class="feedback">{{ message }}</p>
  </section>
</template>

<style scoped>
.inline-notes, .note, form, label { display: grid; gap: var(--s2); min-width: 0; }
.inline-notes { border-top: 1px solid var(--line); padding-top: var(--s3); }
.note { padding: var(--s2); border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); }
.actions { display: flex; flex-wrap: wrap; gap: var(--s2); }
h4, p { margin: 0; }
h4 { font-size: var(--fs-sm); }
.hint { color: var(--text-2); font-size: var(--fs-sm); }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.feedback { color: var(--info); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.feedback[data-failed="true"] { color: var(--bad); }
textarea { width: 100%; min-width: 0; resize: vertical; }
form > button { justify-self: start; }
</style>
