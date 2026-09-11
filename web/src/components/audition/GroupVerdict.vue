<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAuditionStore } from '@/stores/audition'
import type { AuditionVerdict } from '@/types/audition'

const props = defineProps<{ group: string; label: string }>()
const store = useAuditionStore()
const reason = ref(''), busy = ref(false), message = ref(''), failed = ref(false)
const selected = computed(() => store.state?.verdicts[props.group] ?? null)
const savedReason = computed(() => store.state?.verdictReasons[props.group]?.text || '')
const choices: { value: Exclude<AuditionVerdict, null>; label: string }[] = [
  { value: 'like', label: '喜欢' }, { value: 'meh', label: '一般' }, { value: 'dislike', label: '不喜欢' },
]
watch(savedReason, value => { reason.value = value }, { immediate: true })
async function save(value: AuditionVerdict) {
  if (busy.value || !props.group) return
  busy.value = true; message.value = ''; failed.value = false
  try {
    const result = await store.mutate('verdict', { group: props.group, value, reason: value === null ? null : reason.value })
    reason.value = result.state.verdictReasons[props.group]?.text || ''
    message.value = value === null ? '整组倾向和原因已清除。' : result.mirrored
      ? '整组倾向和原因已保存，并同步到看板。'
      : `整组倾向和原因已保存；同步看板未成功：${result.mirrorError || '请稍后检查'}`
  } catch (e) { failed.value = true; message.value = e instanceof Error ? e.message : '整组倾向和原因未能保存，请稍后重试。' }
  finally { busy.value = false }
}
</script>

<template>
  <section class="verdict" aria-label="整组倾向">
    <span>对这一组的感觉 · {{ label || '尚未选组' }}</span>
    <div class="actions">
      <button v-for="choice in choices" :key="choice.value" class="btn btn-sm" :disabled="busy || !group"
        :aria-pressed="selected === choice.value" @click="save(selected === choice.value ? null : choice.value)">{{ choice.label }}</button>
    </div>
    <form @submit.prevent="save(selected)">
      <label>原因（可不填）<textarea v-model="reason" rows="3" maxlength="2000" :disabled="busy || !group" placeholder="说说对这一组的感觉，也可以留空。" /></label>
      <p v-if="savedReason" class="saved">已保存的原因：{{ savedReason }}</p>
      <p v-if="!selected" class="hint">先选喜欢、一般或不喜欢，就能保存原因。</p>
      <button class="btn btn-sm" :disabled="busy || !group || !selected">保存原因</button>
    </form>
    <p v-if="message" :role="failed ? 'alert' : 'status'" :data-failed="failed" class="feedback">{{ message }}</p>
  </section>
</template>

<style scoped>
.verdict, form, label { display: grid; gap: var(--s2); min-width: 0; }
.actions { display: flex; flex-wrap: wrap; gap: var(--s2); }
p { margin: 0; }
.hint, .saved { font-size: var(--fs-sm); color: var(--text-2); }
.saved { white-space: pre-wrap; overflow-wrap: anywhere; }
.feedback { font-size: var(--fs-sm); color: var(--info); overflow-wrap: anywhere; }
.feedback[data-failed="true"] { color: var(--bad); }
.btn[aria-pressed="true"] { color: var(--info); border-color: var(--info); background: var(--info-bg); }
textarea { width: 100%; min-width: 0; resize: vertical; }
form > button { justify-self: start; }
</style>
