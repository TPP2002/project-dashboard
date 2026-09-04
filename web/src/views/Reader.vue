<script setup lang="ts">
// 审阅台:读审计/外脑报告的地方(READER-INTO-BOARD,替代 docs/design/审计回流 的单文件阅读台)。
// 三栏:报告架 | 正文(干净读法,改动只留边条) | 右栏(目录/提示/批注/拍板)。阅读偏好在「阅读设置」里,是个性化项。
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useBoardStore } from '@/stores/board'
import { useReaderStore, type DiffMode, type NotesLayout } from '@/stores/reader'
import ReportShelf from '@/components/reader/ReportShelf.vue'
import ReportBody from '@/components/reader/ReportBody.vue'
import ReaderRail from '@/components/reader/ReaderRail.vue'
import type { Task } from '@/types'

const board = useBoardStore()
const reader = useReaderStore()

const settingsOpen = ref(false)
const activeHeading = ref<string | null>(null)
const progress = ref(0)
const jumpTo = ref<string | null>(null)
const toast = ref<string | null>(null)
const deciding = reactive<Record<string, boolean>>({})
const decideErrors = reactive<Record<string, string>>({})
let toastTimer: ReturnType<typeof setTimeout> | null = null
function say(msg: string) {
  toast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 2400)
}

const MODES: { id: DiffMode; label: string; hint: string }[] = [
  { id: 'clean', label: '干净', hint: '只显示当前版;改动处只留左侧细条,点条看旧文' },
  { id: 'marks', label: '标记改动', hint: '当前版上把改动处的新字浅底标出' },
  { id: 'changes', label: '只看改动', hint: '只列改过的段落,旧文直接摆在下面' },
  { id: 'split', label: '并排', hint: '改过的段落左旧右新并排,没改的段照常' },
]
const NOTE_LAYOUTS: { id: NotesLayout; label: string; hint: string }[] = [
  { id: 'fold', label: '折叠小标', hint: '标题旁一枚小标,点开才展' },
  { id: 'always', label: '全展', hint: '直接摆在标题下' },
  { id: 'rail', label: '只在右栏', hint: '正文里不出现,右栏「提示」页里看' },
]

const project = computed(() => board.currentProjectId)
const task = computed<Task | null>(() => {
  const rep = reader.currentReport
  if (!rep || !project.value) return null
  const b = board.boards[rep.project || project.value] ?? board.boards[project.value]
  return b?.tasks.find((t) => t.id === rep.task) ?? null
})
const diffPill = computed(() => {
  if (!reader.payload) return ''
  if (!reader.payload.prevMd) return '单版本'
  const s = reader.stats
  const parts = [`较${reader.currentReport?.prevLabel?.split('(')[0] || '上一版'}改了 ${s.changed} 段`]
  if (s.added) parts.push(`新增 ${s.added}`)
  if (s.removed) parts.push(`删除 ${s.removed}`)
  return parts.join(' · ')
})

async function boot() {
  if (!project.value) return
  await reader.loadManifest(project.value)
  const first = reader.reportsFlat.find((r) => (r.status || '待审阅') === '待审阅') ?? reader.reportsFlat[0]
  if (first && (!reader.currentKey || !reader.reportsFlat.some((r) => r.key === reader.currentKey))) await reader.openReport(first.key)
}
onMounted(boot)
watch(project, boot)

function select(key: string) { if (key !== reader.currentKey) reader.openReport(key) }
function jump(id: string) { jumpTo.value = null; requestAnimationFrame(() => { jumpTo.value = id }) }

async function addAnno(p: { blockId: string; anchor: string; quote: string; text: string }) {
  try {
    const res = await reader.addAnno({ ...p, author: '负责人' })
    say(res.mirror ? `批注已存,并同步到看板卡 ${res.task}` : `批注已存;同步看板卡失败:${res.mirrorError || '未知'}`)
  } catch (e) { say('保存失败:' + (e instanceof Error ? e.message : String(e))) }
}
async function deleteAnno(id: string) {
  try { await reader.removeAnno(id); say('已删除') } catch (e) { say('删除失败:' + (e instanceof Error ? e.message : String(e))) }
}
async function exportAnnos() {
  try { const r = await reader.exportAnnos(); say(`已导出 ${r.count} 条到仓库 ${r.path}(未 commit,回流对话随 PR 提交)`) }
  catch (e) { say('导出失败:' + (e instanceof Error ? e.message : String(e))) }
}
async function decide(p: { did: string; answer: string }) {
  const t = task.value
  const rep = reader.currentReport
  if (!t || !rep) return
  deciding[p.did] = true
  delete decideErrors[p.did]
  try { await board.decide(rep.project || project.value!, t.id, p.did, p.answer, '负责人·审阅台'); say(`${p.did} 已写回看板`) }
  catch (e) { decideErrors[p.did] = e instanceof Error ? e.message : String(e) }
  finally { deciding[p.did] = false }
}
</script>

<template>
  <div class="reader">
    <header class="rhead">
      <div class="title">
        <h1>
          <span aria-hidden="true">📖</span>
          {{ reader.currentReport?.title || '审阅台' }}
          <span v-if="reader.currentReport?.version" class="badge info">{{ reader.currentReport.version }}</span>
          <span v-if="diffPill" class="badge n">{{ diffPill }}</span>
        </h1>
        <p class="sub">
          <template v-if="reader.payload">{{ reader.payload.batch.name }}<template v-if="reader.payload.batch.baseline"> · {{ reader.payload.batch.baseline }}</template><template v-if="reader.statusLine"> · <span class="mono" :title="reader.statusLine">仓库状态行已收起</span></template></template>
          <template v-else>读审计与外脑报告的地方:先读内容,认可就往下,不对就在段落旁写批注;拍板项在右栏最后一页。</template>
        </p>
      </div>
      <span class="spacer" />
      <div class="head-actions">
        <button type="button" class="btn btn-sm" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen">⚙︎ 阅读设置</button>
        <button type="button" class="btn btn-sm" :disabled="!reader.annos.length" title="把本报告的批注写成仓库 docs 下的 JSON(不 commit)" @click="exportAnnos">导出批注 {{ reader.annos.length || '' }}</button>
      </div>
      <section v-if="settingsOpen" class="settings card" role="dialog" aria-label="阅读设置">
        <div class="sg">
          <div class="sl">版本对照读法</div>
          <div class="seg">
            <button v-for="m in MODES" :key="m.id" type="button" :class="{ on: reader.prefs.mode === m.id }" :title="m.hint" @click="reader.setPrefs({ mode: m.id })">{{ m.label }}</button>
          </div>
          <div class="hint">{{ MODES.find(m => m.id === reader.prefs.mode)?.hint }}</div>
        </div>
        <div class="sg">
          <div class="sl">边注摆法</div>
          <div class="seg">
            <button v-for="n in NOTE_LAYOUTS" :key="n.id" type="button" :class="{ on: reader.prefs.notesLayout === n.id }" :title="n.hint" @click="reader.setPrefs({ notesLayout: n.id })">{{ n.label }}</button>
          </div>
          <div class="hint">{{ NOTE_LAYOUTS.find(n => n.id === reader.prefs.notesLayout)?.hint }}</div>
        </div>
        <div class="sg">
          <div class="sl">边注层</div>
          <div class="seg">
            <button v-for="l in reader.noteLayers" :key="l.id" type="button" :class="{ on: !reader.prefs.hiddenLayers.includes(l.id) }" @click="reader.toggleLayer(l.id)">{{ l.name }}</button>
          </div>
        </div>
        <div class="sg">
          <div class="sl">正文字号</div>
          <div class="seg">
            <button v-for="f in [14, 15, 16, 18]" :key="f" type="button" :class="{ on: reader.prefs.fontSize === f }" @click="reader.setPrefs({ fontSize: f })">{{ f }}</button>
          </div>
        </div>
        <label class="sg row"><input type="checkbox" :checked="reader.prefs.showPendingIntake" @change="reader.setPrefs({ showPendingIntake: ($event.target as HTMLInputElement).checked })"> 报告架里显示「待接入」的报告</label>
        <div class="hint">这些都是你个人的阅读习惯,只存在这台电脑的浏览器里。</div>
      </section>
    </header>

    <div class="progress" aria-hidden="true"><i :style="{ width: (progress * 100).toFixed(1) + '%' }" /></div>

    <ReportShelf
      :manifest="reader.manifest"
      :anno-counts="reader.annoCounts"
      :current-key="reader.currentKey"
      :show-pending-intake="reader.prefs.showPendingIntake"
      @select="select"
    />

    <div v-if="reader.manifestError" class="center card">
      <b>读不到报告清单。</b>
      <p class="lite">{{ reader.manifestError }}</p>
      <p class="lite">审阅台从项目仓库的 <span class="mono">docs/design/审计回流/reader.json</span> 读报告清单;这个项目还没有这份清单,或看板注册的仓库路径不对。</p>
    </div>
    <div v-else-if="reader.error" class="center card"><b>报告打不开。</b><p class="lite">{{ reader.error }}</p></div>
    <div v-else-if="reader.loading && !reader.payload" class="center"><div class="loading-line" /></div>
    <ReportBody
      v-else-if="reader.payload"
      :blocks="reader.blocks"
      :note-layers="reader.visibleNoteLayers"
      :annos="reader.annos"
      :mode="reader.prefs.mode"
      :notes-layout="reader.prefs.notesLayout"
      :font-size="reader.prefs.fontSize"
      :prev-label="reader.currentReport?.prevLabel"
      :scroll-to="jumpTo"
      @active-heading="activeHeading = $event"
      @progress="progress = $event"
      @add-anno="addAnno"
      @delete-anno="deleteAnno"
    />
    <div v-else class="center card"><p class="lite">从左边选一份报告开始读。</p></div>

    <ReaderRail
      :blocks="reader.blocks"
      :active-heading="activeHeading"
      :note-layers="reader.noteLayers"
      :hidden-layers="reader.prefs.hiddenLayers"
      :annos="reader.annos"
      :report="reader.currentReport"
      :task="task"
      :deciding="deciding"
      :decide-errors="decideErrors"
      @jump="jump"
      @toggle-layer="reader.toggleLayer"
      @delete-anno="deleteAnno"
      @decide="decide"
    />

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
/* 占满主区:抵消 area-main 的内边距,让三栏顶到边 */
.reader { display: grid; grid-template-columns: 252px minmax(0, 1fr) 312px; grid-template-rows: auto 3px minmax(0, 1fr); height: calc(100vh - 52px); margin: calc(-1 * var(--s4)) calc(-1 * var(--s5)); position: relative; }
.rhead { grid-column: 1 / 4; position: relative; display: flex; align-items: flex-start; gap: var(--s3); padding: var(--s3) var(--s4); border-bottom: 1px solid var(--line); background: var(--surface); }
.rhead h1 { font-size: var(--fs-lg); display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
.rhead .sub { margin: 2px 0 0; color: var(--text-2); font-size: var(--fs-sm); }
.spacer { flex: 1; }
.head-actions { display: flex; gap: var(--s2); align-items: center; }
.settings { position: absolute; right: var(--s4); top: calc(100% + 6px); z-index: 20; width: 420px; display: grid; gap: var(--s3); box-shadow: 0 12px 32px rgba(0, 0, 0, .18); }
.sg { display: grid; gap: 4px; }
.sg.row { grid-template-columns: auto 1fr; align-items: center; gap: var(--s2); font-size: var(--fs-sm); }
.sl { font-size: var(--fs-xs); color: var(--text-3); letter-spacing: .04em; }
.seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--line-strong); border-radius: var(--r); overflow: hidden; width: fit-content; }
.seg button { border: 0; border-right: 1px solid var(--line); background: var(--surface-2); color: var(--text-2); padding: var(--s1) var(--s3); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
.seg button:last-child { border-right: 0; }
.seg button.on { background: var(--text); color: var(--bg); }
.hint { color: var(--text-3); font-size: var(--fs-xs); }
.progress { grid-column: 1 / 4; height: 3px; background: var(--surface-3); border-radius: 0; }
.progress > i { display: block; height: 100%; background-image: var(--spectrum); background-size: 220% 100%; animation: slide 3.4s linear infinite; transition: width .14s ease; }
.center { display: grid; place-items: center; align-content: start; padding: var(--s6); text-align: center; }
.center.card { margin: var(--s5); }
.lite { color: var(--text-3); font-size: var(--fs-sm); }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: var(--s2) var(--s4); border-radius: var(--r); font-size: var(--fs-sm); z-index: 60; box-shadow: var(--shadow); }
@media (max-width: 1280px) { .reader { grid-template-columns: 220px minmax(0, 1fr) 280px; } }
</style>
