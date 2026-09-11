<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AuditionBatch, AuditionNote } from '@/types/audition'
import { useAuditionStore } from '@/stores/audition'

const props = defineProps<{ batch: AuditionBatch; scene: string; group: string; labels: Record<string, string> }>()
const store = useAuditionStore(), text = ref(''), target = ref('clip'), busy = ref(false), message = ref('')
const buckets = computed(() => {
  const result = new Map<string, { id: string; title: string; notes: AuditionNote[] }>()
  for (const note of store.state?.notes || []) {
    const key = JSON.stringify([note.scene, note.group])
    if (!result.has(key)) result.set(key, {
      id: key,
      title: `${note.scene ? props.batch.scenes.find(s => s.id === note.scene)?.name || '原场景已移出清单' : '整批'} · ${note.group ? props.labels[note.group] || '原组已移出清单' : '全部'}`,
      notes: [],
    })
    result.get(key)!.notes.push(note)
  }
  return [...result.values()]
})
async function action(run: () => Promise<string>) {
  if (busy.value) return
  busy.value = true; message.value = ''
  try { message.value = await run() }
  catch (e) { message.value = e instanceof Error ? e.message : '保存失败，请稍后重试' }
  finally { busy.value = false }
}
function add() {
  void action(async () => {
    const result = await store.mutate('note', {
      text: text.value, scene: target.value === 'clip' ? props.scene : null,
      group: target.value !== 'batch' ? props.group : null,
    })
    text.value = ''
    return result.mirrored ? '批注已保存，并同步到看板。' : `批注已保存；同步看板未成功：${result.mirrorError || '请稍后检查'}`
  })
}
function remove(id: string) { void action(async () => { await store.mutate('note/delete', { id }); return '这条批注已删除。' }) }
function review() {
  void action(async () => {
    const state = store.state?.review ? '未审阅' : '已审阅'
    await store.mutate('review', { state })
    return `本批次已标为${state}。`
  })
}
function exportNotes() { void action(async () => { await store.exportNotes(); return '批注已导出到项目仓库，由派单方收取。' }) }
</script>
<template>
  <section class="notes">
    <div class="actions">
      <button class="btn" :disabled="busy" @click="exportNotes">导出批注到仓库</button>
      <button class="btn" :disabled="busy" @click="review">{{ store.state?.review ? '改为未审阅' : '标为已审阅' }}</button>
    </div>
    <p v-if="store.state?.review" class="hint">已审阅 · {{ store.state.review.at.replace('T', ' ').slice(0, 16) }}</p>
    <form @submit.prevent="add">
      <label>这条批注写给谁<select v-model="target">
        <option value="clip">当前场景与当前{{ batch.groupNoun }}</option><option value="group">当前整组</option><option value="batch">整批</option>
      </select></label>
      <p class="hint">{{ target === 'clip' ? batch.scenes.find(s => s.id === scene)?.name || '尚未选场景' : '整批' }} · {{ target === 'batch' ? '全部' : labels[group] || '尚未选组' }}</p>
      <label>听完的感觉<textarea v-model="text" rows="4" maxlength="4000" placeholder="哪里好听，哪里不合适，都可以直接写。" /></label>
      <button class="btn primary" :disabled="busy || !text.trim() || (target !== 'batch' && !group) || (target === 'clip' && !scene)">保存批注</button>
    </form>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="!buckets.length" class="hint">还没有批注。先听一听，再留下你的感觉。</p>
    <section v-for="bucket in buckets" :key="bucket.id" class="bucket">
      <h3>{{ bucket.title }}</h3>
      <article v-for="note in bucket.notes" :key="note.id">
        <p class="text">{{ note.text }}</p>
        <p v-if="note.editedAt" class="hint">已修改 · {{ note.editedAt.replace('T', ' ').slice(0, 16) }}</p>
        <footer><span>{{ note.by }} · {{ note.at.replace('T', ' ').slice(0, 16) }}</span><button class="btn btn-sm" :disabled="busy" @click="remove(note.id)">删除</button></footer>
      </article>
    </section>
  </section>
</template>
<style scoped>
.notes, form, label { display: grid; gap: var(--s3); }
.actions, footer { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s2); }
p, h3 { margin: 0; }
h3 { font-size: var(--fs-base); }
.hint, footer { font-size: var(--fs-sm); color: var(--text-2); }
.bucket article { margin-top: var(--s2); padding: var(--s3); border: 1px solid var(--line); border-radius: var(--r); }
.text { white-space: pre-wrap; overflow-wrap: anywhere; margin-bottom: var(--s2); }
footer { justify-content: space-between; }
textarea, select { width: 100%; min-width: 0; }
</style>
