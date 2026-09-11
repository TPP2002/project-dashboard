<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import { useAuditionStore } from '@/stores/audition'
import Icon from '@/components/Icon.vue'
import BatchShelf from '@/components/audition/BatchShelf.vue'
import AuditionStage from '@/components/audition/AuditionStage.vue'
import ListeningPanel from '@/components/audition/ListeningPanel.vue'
import NotesPanel from '@/components/audition/NotesPanel.vue'
import SourcesPanel from '@/components/audition/SourcesPanel.vue'
import DecisionsPanel from '@/components/audition/DecisionsPanel.vue'
import { blindLabel, blindOrder } from '@/utils/audition/random'
import { loadPreferences, savePreferences, validSeed } from '@/utils/audition/preferences'
import { useAuditionPlayback } from '@/utils/audition/playback'
import type { AuditionMark } from '@/types/audition'

const board = useBoardStore(), desk = useAuditionStore()
const preferences = ref(loadPreferences()), revealed = ref(false)
const currentGroup = ref(''), currentScene = ref(''), tab = ref('listen'), triggerText = ref(''), feedback = ref('')
const summaryExpanded = ref(false)
const tabs = [{ id: 'listen', label: '试听' }, { id: 'notes', label: '批注' }, { id: 'sources', label: '来源与授权' }, { id: 'decisions', label: '拍板' }]
const batch = computed(() => desk.payload?.batch ?? null)
const shortTitle = computed(() => Array.from(batch.value?.title || '').slice(0, 8).join(''))
const index = computed(() => board.currentProjectId ? desk.indexes[board.currentProjectId] : null)
const hidden = computed(() => preferences.value.blind && !revealed.value)
const groups = computed(() => preferences.value.blind ? blindOrder(batch.value?.groups || [], preferences.value.seed) : batch.value?.groups || [])
const labels = computed(() => Object.fromEntries(groups.value.map((group, i) => [group.id, hidden.value ? blindLabel(i, batch.value?.groupNoun || '方向') : group.name])))
const screen = computed(() => {
  const scene = batch.value?.scenes.find(s => s.id === currentScene.value)
  return batch.value?.screens.find(s => s.id === (scene?.screen || batch.value?.defaultScreen)) ?? null
})
const contextKey = computed(() => JSON.stringify([board.currentProjectId, desk.currentKey]))
const playback = useAuditionPlayback(() => desk.project && desk.payload ? { project: desk.project, payload: desk.payload, seed: preferences.value.seed } : null,
  step => { currentGroup.value = step.group; currentScene.value = step.scene })
const { playing, status, notice } = playback

async function boot() {
  playback.stop(); triggerText.value = ''; feedback.value = ''; revealed.value = false
  await desk.openProject(board.modules.audition ? board.currentProjectId : null)
}
watch(() => [board.currentProjectId, board.modules.audition], boot, { immediate: true })
watch(batch, value => {
  playback.stop(); revealed.value = false; triggerText.value = ''; notice.value = ''
  summaryExpanded.value = false
  currentGroup.value = groups.value[0]?.id || ''; currentScene.value = value?.scenes[0]?.id || ''
})
watch(preferences, value => {
  playback.setVolume(value.volume)
  if (!savePreferences(value)) feedback.value = '浏览器暂时记不住设置，本次试听仍可使用。'
}, { deep: true })
playback.setVolume(preferences.value.volume)
function chooseBatch(key: string) {
  playback.stop(); feedback.value = ''; tab.value = 'listen'
  void desk.openBatch(key)
}
function chooseGroup(id: string) { playback.stop(); currentGroup.value = id; triggerText.value = ''; notice.value = '' }
function selectScene(id: string) { playback.stop(); currentScene.value = id; triggerText.value = ''; notice.value = '' }
function playScene(id: string) {
  currentScene.value = id
  void playback.run([{ group: currentGroup.value, scene: id }], 'single')
}
function compare() { void playback.run(groups.value.map(group => ({ group: group.id, scene: currentScene.value })), 'compare') }
function playlist(group = currentGroup.value) {
  currentGroup.value = group
  void playback.run((batch.value?.scenes || []).map(scene => ({ group, scene: scene.id })), 'group')
}
function fatigue() { void playback.run(Array.from({ length: 20 }, () => ({ group: currentGroup.value, scene: currentScene.value })), 'fatigue') }
function setSeed(raw: string) {
  const seed = raw.trim() ? Number(raw) : NaN
  if (!validSeed(seed)) { feedback.value = '种子请填范围内的整数。'; return }
  playback.stop(); preferences.value.seed = seed; revealed.value = false; triggerText.value = ''
  currentGroup.value = groups.value[0]?.id || ''
}
function setBlind(value: boolean) {
  playback.stop(); preferences.value.blind = value; revealed.value = false; triggerText.value = ''
  currentGroup.value = groups.value[0]?.id || ''
}
function triggered(id: string) {
  const scene = batch.value?.scenes.find(s => s.id === id)
  if (!scene) { notice.value = '画面触发的场景还没放进这一批，暂时不播放'; return }
  triggerText.value = `画面触发：${scene.name}（${labels.value[currentGroup.value] || '尚未选组'}）`
  if (!batch.value?.clips.some(c => c.scene === id && c.group === currentGroup.value && c.files.length)) {
    playback.stop(); currentScene.value = id
    notice.value = '这一组没有所选场景的声音，暂时无法播放'
    return
  }
  playScene(id)
}
async function mark(scene: string, value: AuditionMark) {
  const context = contextKey.value
  try { await desk.mutate('mark', { scene, group: currentGroup.value, value }) }
  catch { if (context === contextKey.value) feedback.value = '标记未能保存，请稍后重试。' }
}
onUnmounted(() => { desk.leave(); void playback.dispose().catch(() => { /* 页面已离开，声音资源不再使用。 */ }) })
</script>

<template>
  <div class="audition" @pointerdown.capture="playback.unlock" @keydown.capture="playback.unlock">
    <header class="page-heading"><Icon name="activity" :size="24" /><div><h1>试听台</h1><p>在游戏画面上点着听，挑声音、留批注、做决定。</p></div></header>
    <p v-if="!board.currentProjectId" class="empty">先在顶栏选择一个项目。</p>
    <p v-else-if="!board.modules.audition" class="empty">试听台还没开启，请在菜单设置里打开。</p>
    <div v-else-if="!index && !desk.loading" class="empty"><p>{{ desk.error || '本项目还没有试听清单' }}</p><button class="btn" @click="boot">重新读取</button></div>
    <div v-else class="desk" :data-shelf-collapsed="preferences.shelfCollapsed" :data-rail-collapsed="preferences.railCollapsed">
      <BatchShelf :entries="index?.index.batches || []" :summaries="index?.summaries || {}" :selected="desk.currentKey" :loading="desk.loading"
        :collapsed="preferences.shelfCollapsed" @toggle="preferences.shelfCollapsed = !preferences.shelfCollapsed" @select="chooseBatch" @refresh="boot" />
      <template v-if="batch && desk.project">
        <AuditionStage :project="desk.project" :screen="screen" @trigger="triggered" @gesture="playback.unlock" />
        <aside class="rail" :data-collapsed="preferences.railCollapsed" aria-label="试听侧栏">
          <div class="rail-heading">
            <h2 v-show="!preferences.railCollapsed">{{ batch.title }}</h2>
            <button class="btn btn-sm rail-toggle" :aria-expanded="!preferences.railCollapsed" :aria-label="preferences.railCollapsed ? '展开试听侧栏' : '收起试听侧栏'"
              @click="preferences.railCollapsed = !preferences.railCollapsed">{{ preferences.railCollapsed ? '展开' : '收起' }}</button>
          </div>
          <strong v-if="preferences.railCollapsed" class="rail-short-title" :title="batch.title" :aria-label="`当前批次：${batch.title}`">{{ shortTitle }}</strong>
          <nav v-show="!preferences.railCollapsed" class="tabs" aria-label="试听台侧栏">
            <button v-for="item in tabs" :key="item.id" :data-selected="tab === item.id" :aria-pressed="tab === item.id" @click="tab = item.id">{{ item.label }}</button>
          </nav>
          <div v-show="!preferences.railCollapsed" class="panel">
            <div v-if="batch.summary" class="batch-summary">
              <button class="summary-toggle" :aria-expanded="summaryExpanded" @click="summaryExpanded = !summaryExpanded">
                <span class="summary-preview">{{ batch.summary }}</span><span>{{ summaryExpanded ? '收起' : '展开' }}</span>
              </button>
              <p v-if="summaryExpanded">{{ batch.summary }}</p>
            </div>
            <div class="messages" aria-live="polite"><p v-if="triggerText">{{ triggerText }}</p><p v-if="notice">{{ notice }}</p><p v-if="feedback">{{ feedback }}</p></div>
            <details v-if="desk.payload?.problems.length" class="problems"><summary>清单有 {{ desk.payload.problems.length }} 处需要留意</summary><ul><li v-for="(problem, i) in desk.payload.problems" :key="i">{{ problem }}</li></ul></details>
            <ListeningPanel v-show="tab === 'listen'" :key="'listen' + contextKey" :batch="batch" :groups="groups" :group="currentGroup" :scene="currentScene" :labels="labels"
              :hidden="hidden" :preferences="preferences" :state="desk.state" :playing="playing" :status="status"
              @group="chooseGroup" @scene="playScene" @select-scene="selectScene" @compare="compare" @playlist="playlist()" @fatigue="fatigue" @stop="playback.stop"
              @volume="preferences.volume = $event" @seed="setSeed" @blind="setBlind" @reveal="revealed = true; triggerText = ''" @mark="mark" />
            <NotesPanel v-show="tab === 'notes'" :key="'notes' + contextKey" :batch="batch" :scene="currentScene" :group="currentGroup" :labels="labels" />
            <SourcesPanel v-show="tab === 'sources'" :key="'sources' + contextKey" :batch="batch" :scene="currentScene" :group="currentGroup" :labels="labels" :hidden="hidden" />
            <DecisionsPanel v-show="tab === 'decisions'" :key="'decisions' + contextKey" :project="desk.project" :batch="batch" :hidden="hidden" @listen="playlist" />
          </div>
          <div v-if="playing" class="running"><span role="status">{{ status }}</span><button class="btn" @click="playback.stop">停止</button></div>
        </aside>
      </template>
      <div v-else class="empty"><p>{{ desk.loading ? '正在读取试听清单…' : desk.error || '这份清单还没有批次。' }}</p></div>
    </div>
  </div>
</template>

<style scoped>
.audition { display: grid; grid-template-rows: auto minmax(0, 1fr); gap: var(--s4); height: 100%; min-height: 0; }
.page-heading { display: flex; align-items: center; gap: var(--s3); }
h1 { font-size: var(--fs-xl); margin: 0; } .page-heading p { color: var(--text-2); margin: var(--s1) 0 0; }
.desk { display: grid; grid-template-columns: var(--shelf-width, 190px) minmax(0, 1fr) var(--rail-width, 390px); grid-template-rows: minmax(0, 1fr); gap: var(--s3); min-height: 0; min-width: 0; }
.desk[data-shelf-collapsed="true"] { --shelf-width: 64px; }
.desk[data-rail-collapsed="true"] { --rail-width: 64px; }
.rail { display: flex; flex-direction: column; min-height: 0; min-width: 0; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); }
.rail-heading { display: flex; align-items: center; gap: var(--s2); padding: var(--s3); flex: none; }.rail-heading h2 { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-md); overflow-wrap: anywhere; }
.rail-toggle { flex: none; }
.rail[data-collapsed="true"] .rail-heading { justify-content: center; padding: var(--s2); }
.rail-short-title { align-self: center; min-height: 0; overflow: hidden; writing-mode: vertical-rl; text-orientation: upright; font-size: var(--fs-sm); color: var(--text-2); letter-spacing: .1em; }
.tabs { display: grid; grid-template-columns: repeat(4, 1fr); border-block: 1px solid var(--line); flex: none; }
.tabs button { border: 0; background: var(--surface-2); color: var(--text-2); padding: var(--s3) var(--s1); cursor: pointer; font: inherit; font-size: var(--fs-sm); }
.tabs button[data-selected="true"] { color: var(--info); background: var(--info-bg); }
.panel { padding: var(--s3); flex: 1; overflow: auto; min-height: 0; min-width: 0; }
.batch-summary { margin-bottom: var(--s3); color: var(--text-2); font-size: var(--fs-sm); }
.summary-toggle { display: flex; gap: var(--s2); width: 100%; min-width: 0; border: 0; padding: var(--s1) 0; color: var(--text-2); background: var(--surface); font: inherit; text-align: left; cursor: pointer; }
.summary-preview { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.summary-toggle > span:last-child { flex: none; color: var(--info); }
.batch-summary p { margin: var(--s2) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.messages:empty { display: none; }.messages { margin-bottom: var(--s2); color: var(--info); font-size: var(--fs-sm); overflow-wrap: anywhere; }.messages p { margin: var(--s1) 0; }
.problems { padding: var(--s2); margin-bottom: var(--s3); color: var(--warn); background: var(--warn-bg); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.empty { padding: var(--s6); color: var(--text-2); background: var(--surface); border-radius: var(--r-lg); }
.running { display: flex; flex: none; align-items: center; justify-content: space-between; padding: var(--s3); gap: var(--s2); border-top: 1px solid var(--line); }
.running span { min-width: 0; overflow-wrap: anywhere; }.running button { flex: none; }
.rail[data-collapsed="true"] .running { flex-direction: column; margin-top: auto; padding: var(--s2); }
@media (max-width: 1200px) {
  .desk { grid-template-columns: var(--shelf-width, 155px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
  .rail { grid-column: 1 / -1; }
  .desk[data-rail-collapsed="true"] { grid-template-columns: var(--shelf-width, 155px) minmax(0, 1fr) var(--rail-width); grid-template-rows: minmax(0, 1fr); }
  .desk[data-rail-collapsed="true"] .rail { grid-column: 3; grid-row: 1; }
}
@media (max-width: 750px) {
  .desk { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 2fr); }
  .desk[data-shelf-collapsed="true"] { grid-template-rows: auto minmax(0, 1fr) minmax(0, 1fr); }
  .rail { grid-column: auto; }
  .desk[data-rail-collapsed="true"] { grid-template-columns: minmax(0, 1fr) var(--rail-width); grid-template-rows: minmax(0, 1fr) minmax(0, 2fr); }
  .desk[data-rail-collapsed="true"] :deep(.shelf) { grid-column: 1 / -1; }
  .desk[data-rail-collapsed="true"] .rail { grid-column: 2; grid-row: 2; }
  .desk[data-shelf-collapsed="true"][data-rail-collapsed="true"] { grid-template-rows: auto minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) { .audition :deep(*) { scroll-behavior: auto; } }
</style>
