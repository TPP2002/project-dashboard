<script setup lang="ts">
import { computed, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import type { Decision } from '@/types'
import type { AuditionBatch } from '@/types/audition'

const props = defineProps<{ project: string; batch: AuditionBatch; hidden: boolean }>()
const emit = defineEmits<{ listen: [group: string] }>()
const board = useBoardStore()
const picked = ref<Record<string, string>>({}), custom = ref<Record<string, string>>({})
const busy = ref<Record<string, boolean>>({}), errors = ref<Record<string, string>>({})
const CUSTOM = '__audition_custom__'
const rows = computed(() => props.batch.decisions.map(reference => ({
  reference, key: JSON.stringify([reference.task, reference.did]),
  decision: board.boards[props.project]?.tasks.find(task => task.id === reference.task)?.decisions?.find(d => d.id === reference.did),
})))
function answer(key: string, d: Decision) { return picked.value[key] === CUSTOM ? (custom.value[key] || '').trim() : picked.value[key] ?? d.recommended }
function canCustomize(d: Decision) { return (d as Decision & { allowCustom?: boolean }).allowCustom !== false }
function mappedGroup(mapping: Record<string, string>, option: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(mapping, option) ? mapping[option] : undefined
}
async function decide(key: string, task: string, d: Decision) {
  const value = answer(key, d), pid = props.project
  if (!value || busy.value[key]) return
  busy.value[key] = true; errors.value[key] = ''
  try {
    const result = await board.decide(pid, task, d.id, value)
    if (!result.ok) throw new Error('拍板没有保存成功，请稍后重试')
  } catch (e) { errors.value[key] = e instanceof Error ? e.message : '拍板暂时未能保存' }
  finally { busy.value[key] = false }
}
</script>
<template>
  <section class="decisions">
    <p v-if="hidden">先盲听，揭晓后再看拍板选项，避免选项名称提前透露声音方向。</p>
    <template v-else>
      <p v-if="!rows.length">这一批没有挂拍板题，可以先试听和留批注。</p>
      <article v-for="(row, index) in rows" :key="row.key" class="decision">
        <p v-if="!row.decision" role="status">第 {{ index + 1 }} 道拍板题尚未在当前项目看板中找到。</p>
        <template v-else>
          <h3>{{ row.decision.question }}</h3>
          <p v-if="row.decision.background" class="prose">{{ row.decision.background }}</p>
          <section v-if="row.decision.answer !== null && row.decision.answer !== undefined" class="answered">
            <b>已拍板</b><p class="prose">{{ row.decision.answer }}</p>
            <span v-if="row.decision.decidedAt">{{ row.decision.decidedAt.replace('T', ' ').slice(0, 16) }}</span>
          </section>
          <div v-for="option in row.decision.options" :key="option" class="option">
            <label>
              <input v-if="row.decision.answer == null" type="radio" :name="row.key" :value="option"
                :checked="(picked[row.key] ?? row.decision.recommended) === option" :disabled="busy[row.key]" @change="picked[row.key] = option">
              <strong>{{ option }}</strong>
            </label>
            <p v-if="row.decision.optionPros?.[option]" class="prose">{{ row.decision.optionPros[option] }}</p>
            <button v-if="mappedGroup(row.reference.optionGroups, option)" class="btn btn-sm"
              :disabled="!batch.groups.some(g => g.id === mappedGroup(row.reference.optionGroups, option))"
              @click="emit('listen', mappedGroup(row.reference.optionGroups, option)!)">听这一组</button>
          </div>
          <p v-if="row.decision.recommended">推荐：{{ row.decision.recommended }}</p>
          <p v-if="row.decision.recommendReason" class="prose">推荐理由：{{ row.decision.recommendReason }}</p>
          <template v-if="row.decision.answer == null">
            <label v-if="canCustomize(row.decision)"><input v-model="picked[row.key]" type="radio" :name="row.key" :value="CUSTOM" :disabled="busy[row.key]"> 我另有想法</label>
            <textarea v-if="picked[row.key] === CUSTOM" v-model="custom[row.key]" rows="3" :disabled="busy[row.key]" aria-label="自定义拍板答案" placeholder="直接写下你的决定" />
            <button class="btn primary" :disabled="busy[row.key] || !answer(row.key, row.decision)" @click="decide(row.key, row.reference.task, row.decision)">{{ busy[row.key] ? '正在保存…' : '确认拍板' }}</button>
          </template>
          <p v-if="errors[row.key]" role="alert">{{ errors[row.key] }}</p>
        </template>
      </article>
    </template>
  </section>
</template>
<style scoped>
.decisions, .decision, .option { display: grid; gap: var(--s3); }
.decision { border: 1px solid var(--line); border-radius: var(--r); padding: var(--s3); }
h3, p { margin: 0; } h3 { font-size: var(--fs-md); }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-2); }
.option { border-top: 1px solid var(--line); padding-top: var(--s3); }
.option label { display: flex; align-items: baseline; gap: var(--s2); }
.answered { display: grid; gap: var(--s2); padding: var(--s3); background: var(--ok-bg); border-radius: var(--r); }
.answered b { color: var(--ok); } .answered span { color: var(--text-2); font-size: var(--fs-sm); }
textarea { width: 100%; }
</style>
