<script setup lang="ts">
import type { AuditionBatch, AuditionGroup, AuditionState, AuditionMark, AuditionVerdict } from '@/types/audition'
import { markKey } from '@/utils/audition/manifest'
import type { AuditionPreferences } from '@/utils/audition/preferences'

const props = defineProps<{
  batch: AuditionBatch; groups: AuditionGroup[]; group: string; scene: string; labels: Record<string, string>
  hidden: boolean; preferences: AuditionPreferences; state: AuditionState | null; playing: boolean; status: string
}>()
const emit = defineEmits<{
  group: [id: string]; scene: [id: string]; selectScene: [id: string]; compare: []; playlist: []; fatigue: []; stop: []
  volume: [value: number]; seed: [value: string]; blind: [value: boolean]; reveal: []
  mark: [scene: string, value: AuditionMark]; verdict: [value: AuditionVerdict]
}>()
const levels = ['未说明', '最轻', '轻', '中', '重', '最重']
function mark(scene: string, value: 'up' | 'down') {
  emit('mark', scene, props.state?.marks[markKey(props.group, scene)] === value ? null : value)
}
function verdict(value: Exclude<AuditionVerdict, null>) { emit('verdict', props.state?.verdicts[props.group] === value ? null : value) }
function seedChanged(event: Event) {
  const input = event.target as HTMLInputElement
  emit('seed', input.value)
  input.value = String(props.preferences.seed)
}
</script>
<template>
  <div class="listening">
    <label class="volume">主音量 {{ preferences.volume }}<input type="range" min="0" max="100" :value="preferences.volume" @input="emit('volume', Number(($event.target as HTMLInputElement).value))"></label>
    <div class="blind">
      <label><input type="checkbox" :checked="preferences.blind" @change="emit('blind', ($event.target as HTMLInputElement).checked)"> 盲听</label>
      <label>顺序种子<input class="seed" type="number" step="1" min="-2147483648" max="2147483647" :value="preferences.seed" @change="seedChanged"></label>
      <button v-if="hidden" class="btn btn-sm" @click="emit('reveal')">揭晓</button>
    </div>
    <p class="hint">改整数种子会换顺序。同一种子可以重听同一轮。</p>
    <label class="choose">选择{{ batch.groupNoun }}
      <select :value="group" @change="emit('group', ($event.target as HTMLSelectElement).value)">
        <option v-for="(item, index) in groups" :key="`${item.id}-${index}`" :value="item.id">{{ labels[item.id] }}</option>
      </select>
    </label>
    <p v-if="hidden" class="hint">揭晓前隐藏真实名称、说明和来源。</p>
    <section v-else class="description">
      <template v-for="item in groups.filter(g => g.id === group)" :key="item.id">
        <p v-if="item.pitch">{{ item.pitch }}</p><p v-if="item.refs">参照：{{ item.refs }}</p><p v-if="item.risk">需要留意：{{ item.risk }}</p>
      </template>
    </section>
    <div class="actions">
      <button class="btn" :disabled="!scene" @click="emit('compare')">同场景对比</button>
      <button class="btn" :disabled="!group" @click="emit('playlist')">连播本组</button>
      <button class="btn" :disabled="!playing" @click="emit('stop')">停止</button>
    </div>
    <div class="fatigue">
      <label>测听腻的场景<select :value="scene" @change="emit('selectScene', ($event.target as HTMLSelectElement).value)">
        <option v-for="(item, index) in batch.scenes" :key="`${item.id}-${index}`" :value="item.id">{{ item.name }}</option>
      </select></label>
      <button class="btn" :disabled="!group || !scene" @click="emit('fatigue')">连播 20 次</button>
    </div>
    <p class="progress" role="status">{{ status || '点一个场景开始试听。' }}</p>
    <section class="verdict" aria-label="整组倾向">
      <span>对这一组的感觉</span>
      <div class="actions">
        <button class="btn btn-sm" :disabled="!group" :aria-pressed="state?.verdicts[group] === 'like'" @click="verdict('like')">喜欢</button>
        <button class="btn btn-sm" :disabled="!group" :aria-pressed="state?.verdicts[group] === 'meh'" @click="verdict('meh')">一般</button>
        <button class="btn btn-sm" :disabled="!group" :aria-pressed="state?.verdicts[group] === 'dislike'" @click="verdict('dislike')">不喜欢</button>
      </div>
    </section>
    <h3>场景</h3>
    <p v-if="!batch.scenes.length">本批次还没有场景。</p>
    <article v-for="(item, index) in batch.scenes" :key="`${item.id}-${index}`" class="scene" :data-selected="scene === item.id">
      <div class="scene-heading"><button class="scene-name" @click="emit('scene', item.id)">{{ item.name }}</button><span class="badge n">{{ levels[item.level] || '未说明' }}</span></div>
      <p>{{ item.when || '还没有说明什么时候响' }}</p>
      <div class="actions">
        <button class="btn btn-sm" :disabled="!group" @click="emit('scene', item.id)">播放</button>
        <button class="btn btn-sm" :disabled="!group" :aria-pressed="state?.marks[markKey(group, item.id)] === 'up'" @click="mark(item.id, 'up')">好</button>
        <button class="btn btn-sm" :disabled="!group" :aria-pressed="state?.marks[markKey(group, item.id)] === 'down'" @click="mark(item.id, 'down')">不好</button>
        <span class="hint">批注 {{ state?.notes.filter(note => note.scene === item.id).length || 0 }}</span>
      </div>
    </article>
  </div>
</template>
<style scoped>
.listening { display: grid; gap: var(--s3); }
.volume, .choose, .fatigue label { display: grid; gap: var(--s2); }
.blind, .actions, .scene-heading { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s2); }
.blind label { display: flex; align-items: center; gap: var(--s2); }
.seed { width: 115px; }
.hint, .scene p, .description { font-size: var(--fs-sm); color: var(--text-2); }
p, h3 { margin: 0; }
.description { display: grid; gap: var(--s2); }
.fatigue { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: var(--s2); }
.progress { padding: var(--s2); background: var(--surface-2); border-radius: var(--r); }
.verdict { display: grid; gap: var(--s2); }
.scene { display: grid; gap: var(--s2); padding: var(--s3); border: 1px solid var(--line); border-radius: var(--r); }
.scene[data-selected="true"] { border-color: var(--info); }
.scene-name { font: inherit; font-weight: 600; color: var(--text); background: var(--surface); border: 0; padding: 0; text-align: left; cursor: pointer; }
.btn[aria-pressed="true"] { color: var(--info); border-color: var(--info); background: var(--info-bg); }
select { width: 100%; min-width: 0; }
</style>
