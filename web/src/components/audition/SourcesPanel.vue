<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AuditionBatch } from '@/types/audition'
import SourceList from './SourceList.vue'

const props = defineProps<{ batch: AuditionBatch; scene: string; group: string; labels: Record<string, string>; hidden: boolean }>()
const dialog = ref<HTMLDialogElement | null>(null), copyMessage = ref(''), manualCopy = ref(false)
const clip = computed(() => props.batch.clips.find(c => c.scene === props.scene && c.group === props.group))
const attribution = computed(() => props.batch.clips.flatMap(c => c.sources.map(s => `${s.title || '未填标题'} — ${s.author || '未填作者'} — ${s.license || '未填授权'} — ${s.url || '未填链接'}`)).join('\n'))
function showAll() { if (!props.hidden) dialog.value?.showModal() }
async function copy() {
  if (props.hidden) return
  try { await navigator.clipboard.writeText(attribution.value); copyMessage.value = '署名清单已复制。'; manualCopy.value = false }
  catch { copyMessage.value = '未能自动复制，可以选中下方文字后复制。'; manualCopy.value = true }
}
watch(() => props.hidden, hidden => { if (hidden) { dialog.value?.close(); manualCopy.value = false; copyMessage.value = '' } })
</script>
<template>
  <section class="sources">
    <p v-if="hidden">盲听时先隐藏说明与来源，揭晓后就能查看。</p>
    <template v-else>
      <h3>{{ labels[group] || '尚未选组' }} · {{ batch.scenes.find(s => s.id === scene)?.name || '尚未选场景' }}</h3>
      <div class="actions"><button class="btn" @click="showAll">全部来源与授权</button><button class="btn" @click="copy">复制署名清单</button></div>
      <p v-if="copyMessage" role="status">{{ copyMessage }}</p>
      <label v-if="manualCopy">署名清单<textarea readonly rows="6" :value="attribution" /></label>
      <template v-if="clip"><p class="description">{{ clip.desc || '还没有填写这段声音的说明。' }}</p><SourceList :sources="clip.sources" /></template>
      <p v-else>这一组没有当前场景的声音。</p>
    </template>
    <dialog ref="dialog" class="all-sources" aria-label="全部来源与授权" @click="($event.target === dialog) && dialog?.close()">
      <template v-if="!hidden">
        <header><h2>全部来源与授权</h2><button class="btn" @click="dialog?.close()">关闭</button></header>
        <button class="btn" @click="copy">复制署名清单</button><p role="status">{{ copyMessage }}</p>
        <label v-if="manualCopy">署名清单<textarea readonly rows="6" :value="attribution" /></label>
        <p v-if="!batch.clips.length">本批次还没有声音片段。</p>
        <section v-for="(item, index) in batch.clips" :key="index" class="clip">
          <h3>{{ labels[item.group] || '未定义的组' }} · {{ batch.scenes.find(s => s.id === item.scene)?.name || '未定义的场景' }}</h3>
          <p class="description">{{ item.desc }}</p><SourceList :sources="item.sources" />
        </section>
      </template>
    </dialog>
  </section>
</template>
<style scoped>
.sources { display: grid; gap: var(--s3); }
h2, h3, p { margin: 0; } h3 { font-size: var(--fs-base); }
.actions, header { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
header { justify-content: space-between; margin-bottom: var(--s3); }
.description { white-space: pre-wrap; color: var(--text-2); }
.all-sources { width: min(800px, 90vw); max-height: 85vh; padding: var(--s5); border: 1px solid var(--line); border-radius: var(--r-lg); color: var(--text); background: var(--surface); }
.all-sources::backdrop { background: var(--overlay); }
.clip { padding-block: var(--s4); border-bottom: 1px solid var(--line); }
.clip h3 { margin-bottom: var(--s2); } textarea { width: 100%; }
</style>
