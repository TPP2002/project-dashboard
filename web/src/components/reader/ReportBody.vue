<script setup lang="ts">
// 报告正文:干净读法为主(负责人 2026-09-05 拍),改动段只留左侧细条;点条看旧文。
// 其它读法(标记改动 / 只看改动 / 并排)与边注摆法(折叠 / 全展 / 只在右栏)由 prefs 切换。
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { DocBlock } from '@/utils/reader/diff'
import type { ReaderNoteLayer, ReaderAnno } from '@/api/reader'
import type { DiffMode, NotesLayout } from '@/stores/reader'
import { renderMarkdown } from '@/utils/reader/markdown'
import { anchorMatch, plainText } from '@/utils/reader/anchors'

const props = defineProps<{
  blocks: DocBlock[]
  noteLayers: ReaderNoteLayer[]
  annos: ReaderAnno[]
  mode: DiffMode
  notesLayout: NotesLayout
  fontSize: number
  prevLabel?: string
  scrollTo?: string | null
}>()
const emit = defineEmits<{
  (e: 'active-heading', id: string | null): void
  (e: 'progress', ratio: number): void
  (e: 'add-anno', payload: { blockId: string; anchor: string; quote: string; text: string }): void
  (e: 'delete-anno', id: string): void
}>()

const root = ref<HTMLElement | null>(null)
const openOld = ref<Set<string>>(new Set())
const openNotes = ref<Set<string>>(new Set())
const composing = ref<string | null>(null)
const draft = ref('')

/** 每段的渲染 HTML(缓存按 block id) */
const html = computed(() => {
  const m = new Map<string, string>()
  for (const b of props.blocks) {
    if (b.kind === 'removed') { m.set(b.id, renderMarkdown(b.old || '')); continue }
    m.set(b.id, renderMarkdown(b.md))
  }
  return m
})
const oldHtml = computed(() => {
  const m = new Map<string, string>()
  for (const b of props.blocks) if (b.old && b.kind !== 'removed') m.set(b.id, renderMarkdown(b.old))
  return m
})

/** 全篇提示 + 每个标题块挂的边注 */
type NoteWithLayer = { anchor: string; kind: string; text: string; layerId: string; layerName: string }
const allNotes = computed<NoteWithLayer[]>(() =>
  props.noteLayers.flatMap((l) => l.notes.map((n) => ({ ...n, layerId: l.id, layerName: l.name }))),
)
const globalNotes = computed(() => allNotes.value.filter((n) => n.anchor === '全篇'))
const notesByBlock = computed(() => {
  const m = new Map<string, NoteWithLayer[]>()
  const pending = allNotes.value.filter((n) => n.anchor !== '全篇')
  const used = new Set<NoteWithLayer>()
  for (const b of props.blocks) {
    if (!b.heading) continue
    const mine = pending.filter((n) => !used.has(n) && anchorMatch(n.anchor, b.heading!.text))
    if (mine.length) { m.set(b.id, mine); mine.forEach((n) => used.add(n)) }
  }
  return m
})
/** 没匹配到任何标题的边注,归到全篇提示末尾(和旧阅读台一致) */
const orphanNotes = computed(() => {
  const used = new Set<NoteWithLayer>()
  for (const arr of notesByBlock.value.values()) arr.forEach((n) => used.add(n))
  return allNotes.value.filter((n) => n.anchor !== '全篇' && !used.has(n))
})
const annosByBlock = computed(() => {
  const m = new Map<string, ReaderAnno[]>()
  for (const a of props.annos) { const arr = m.get(a.blockId) || []; arr.push(a); m.set(a.blockId, arr) }
  return m
})
/** 每段所在的最近标题(给「只看改动」当上下文、给批注当锚) */
const sectionOf = computed(() => {
  const m = new Map<string, string>()
  let cur = ''
  for (const b of props.blocks) { if (b.heading) cur = b.heading.text; m.set(b.id, cur) }
  return m
})

const kindClass = (k: string) => ({ 纠正: 'n-fix', 冲突: 'n-conf', 改判: 'n-over', 提示: 'n-info', 现状: 'n-now' } as Record<string, string>)[k] || 'n-info'
const heavy = (b: DocBlock) => (b.charDiff?.ratio ?? 0) > 0.5

function toggleOld(id: string) { const s = new Set(openOld.value); s.has(id) ? s.delete(id) : s.add(id); openOld.value = s }
function toggleNotes(id: string) { const s = new Set(openNotes.value); s.has(id) ? s.delete(id) : s.add(id); openNotes.value = s }
function startAnno(id: string) { composing.value = id; draft.value = ''; nextTick(() => root.value?.querySelector<HTMLTextAreaElement>(`#anno-editor-${id} textarea`)?.focus()) }
function submitAnno(b: DocBlock) {
  const text = draft.value.trim()
  if (!text) return
  emit('add-anno', { blockId: b.id, anchor: sectionOf.value.get(b.id) || '', quote: plainText(b.md || b.old || '').slice(0, 120), text })
  composing.value = null
  draft.value = ''
}
const fmtAt = (iso: string) => iso.replace('T', ' ').slice(0, 16)

// 滚动:进度 + 当前标题
let raf = 0
function onScroll() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    const el = root.value
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    emit('progress', max > 0 ? el.scrollTop / max : 1)
    let cur: string | null = null
    for (const b of props.blocks) {
      if (!b.heading) continue
      const node = el.querySelector<HTMLElement>(`#${b.id}`)
      if (!node) continue
      if (node.offsetTop - el.scrollTop <= 80) cur = b.id
      else break
    }
    emit('active-heading', cur)
  })
}
watch(() => props.scrollTo, (id) => {
  if (!id) return
  nextTick(() => {
    const node = root.value?.querySelector<HTMLElement>(`#${id}`)
    node?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    if (notesByBlock.value.has(id)) { const s = new Set(openNotes.value); s.add(id); openNotes.value = s }
  })
})
watch(() => props.blocks, () => { openOld.value = new Set(); openNotes.value = new Set(); composing.value = null; root.value?.scrollTo({ top: 0 }) })
onMounted(() => root.value?.addEventListener('scroll', onScroll, { passive: true }))
onBeforeUnmount(() => root.value?.removeEventListener('scroll', onScroll))
</script>

<template>
  <section ref="root" class="doc" :class="[`mode-${mode}`, `notes-${notesLayout}`]" :style="{ fontSize: fontSize + 'px' }">
    <div class="paper">
      <div v-if="globalNotes.length || orphanNotes.length" class="notes open global">
        <b>全篇提示</b>
        <ul>
          <li v-for="(n, i) in [...globalNotes, ...orphanNotes]" :key="i">
            <span class="n-k" :class="kindClass(n.kind)">{{ n.kind }}</span>{{ n.text }}<span class="n-layer">{{ n.layerName }}</span>
          </li>
        </ul>
      </div>

      <template v-for="b in blocks" :key="b.id">
        <div v-if="mode === 'changes' && b.kind === 'changed' && !b.heading" class="ctx">所在节:{{ sectionOf.get(b.id) || '(开头)' }}</div>
        <div
          :id="b.id"
          class="blk"
          :class="[b.kind, { open: openOld.has(b.id), 'has-anno': annosByBlock.has(b.id), heavy: heavy(b) }]"
        >
          <span
            class="gut"
            :title="b.kind === 'changed' ? `这段相对${prevLabel || '上一版'}有改动,点开看旧文` : b.kind === 'added' ? '这段是新版新增的' : b.kind === 'removed' ? '这段在新版被删掉了' : ''"
            @click="b.kind === 'changed' && toggleOld(b.id)"
          />
          <div class="ptools">
            <button type="button" title="写批注" @click="startAnno(b.id)">✎</button>
            <button v-if="b.kind === 'changed'" type="button" title="看旧文" @click="toggleOld(b.id)">⇄</button>
          </div>

          <div v-if="b.kind === 'removed'" class="old shown">
            <span class="tag">{{ prevLabel || '上一版' }} 已删</span>
            <div v-html="html.get(b.id)" />
          </div>
          <template v-else>
            <div class="new">
              <template v-if="b.kind === 'changed' && b.charDiff && !heavy(b) && (mode === 'marks' || mode === 'changes' || mode === 'split')">
                <p v-html="b.charDiff.newHtml" />
              </template>
              <div v-else v-html="html.get(b.id)" />
              <button
                v-if="b.heading && notesByBlock.has(b.id) && notesLayout !== 'rail'"
                type="button"
                class="hmark"
                :title="`这一节有 ${notesByBlock.get(b.id)!.length} 条边注,点开`"
                @click="toggleNotes(b.id)"
              >ⓘ {{ notesByBlock.get(b.id)!.length }}</button>
            </div>
            <div v-if="b.kind === 'changed'" class="old">
              <span class="tag">{{ prevLabel || '上一版' }} 旧文</span>
              <div v-if="b.charDiff && !heavy(b)" class="old-text" v-html="b.charDiff.oldHtml" />
              <div v-else v-html="oldHtml.get(b.id)" />
            </div>
          </template>

          <div
            v-if="b.heading && notesByBlock.has(b.id) && notesLayout !== 'rail'"
            class="notes"
            :class="{ open: notesLayout === 'always' || openNotes.has(b.id) }"
          >
            <ul>
              <li v-for="(n, i) in notesByBlock.get(b.id)" :key="i">
                <span class="n-k" :class="kindClass(n.kind)">{{ n.kind }}</span>{{ n.text }}<span class="n-layer">{{ n.layerName }}</span>
              </li>
            </ul>
          </div>

          <div v-if="annosByBlock.has(b.id)" class="annos">
            <div v-for="a in annosByBlock.get(b.id)" :key="a.id" class="anno-card">
              <span class="who">{{ a.author }} · {{ fmtAt(a.at) }}</span>{{ a.text }}
              <button type="button" class="del" title="删除这条批注" @click="emit('delete-anno', a.id)">×</button>
            </div>
          </div>
          <div v-if="composing === b.id" :id="`anno-editor-${b.id}`" class="anno-card editor">
            <textarea v-model="draft" rows="3" placeholder="对这一段的意见:不对在哪 / 要外脑改什么 / 认可" @keydown.ctrl.enter.prevent="submitAnno(b)" />
            <div class="row">
              <button type="button" class="btn btn-sm primary" @click="submitAnno(b)">保存批注</button>
              <button type="button" class="btn btn-sm quiet" @click="composing = null">取消</button>
              <span class="lite">存到看板本机账本并同步到对应任务卡;Ctrl+Enter 保存</span>
            </div>
          </div>
        </div>
      </template>
      <div class="tail" />
    </div>
  </section>
</template>

<style scoped>
.doc { position: relative; overflow: auto; min-height: 0; scroll-behavior: smooth; line-height: 1.7; }
.paper { max-width: 780px; margin: 0 auto; padding: var(--s5) var(--s6) 0; }
.tail { height: 40vh; }
.blk { position: relative; padding-left: 14px; margin: 0 0 2px; }
.blk > .gut { position: absolute; left: 0; top: 4px; bottom: 4px; width: 3px; border-radius: 2px; background: transparent; }
.blk.changed > .gut { background: var(--info); cursor: pointer; opacity: .8; }
.blk.changed > .gut:hover { width: 5px; left: -1px; opacity: 1; }
.blk.changed.open > .gut { background: var(--warn); }
.blk.added > .gut { background: var(--ok); }
.blk.removed > .gut { background: var(--bad); }
.mode-clean .blk.changed > .gut { opacity: .35; }
.blk :deep(h1), .blk :deep(h2), .blk :deep(h3), .blk :deep(h4) { margin: var(--s5) 0 var(--s2); scroll-margin-top: 24px; }
.blk :deep(h1) { font-size: 1.45em; } .blk :deep(h2) { font-size: 1.25em; } .blk :deep(h3) { font-size: 1.05em; }
.blk :deep(p), .blk :deep(li) { margin: 0 0 var(--s2); }
.blk :deep(ul), .blk :deep(ol) { padding-left: 1.4em; }
.blk :deep(table) { border-collapse: collapse; width: 100%; font-size: .9em; margin: var(--s2) 0; }
.blk :deep(th), .blk :deep(td) { border: 1px solid var(--line); padding: 4px 8px; vertical-align: top; text-align: left; }
.blk :deep(th) { background: var(--surface-2); }
.blk :deep(blockquote) { margin: 0 0 var(--s2); padding: var(--s1) var(--s3); border-left: 3px solid var(--line-strong); color: var(--text-2); background: var(--surface-2); border-radius: 0 var(--r-sm) var(--r-sm) 0; }
.blk :deep(ins) { text-decoration: none; }
.blk :deep(del) { color: var(--bad); }
.new { position: relative; }
.hmark { display: inline-flex; align-items: center; gap: 4px; margin: 0 0 var(--s2) 0; padding: 0 8px; border-radius: 10px; border: 1px solid var(--line-strong); background: var(--surface-2); color: var(--text-2); font: inherit; font-family: var(--mono); font-size: var(--fs-xs); cursor: pointer; line-height: 1.7; }
.hmark:hover { background: var(--surface-3); color: var(--text); }
.old { display: none; margin: 0 0 var(--s3); padding: var(--s2) var(--s3); border-radius: var(--r-sm); background: var(--warn-bg); color: var(--text-2); font-size: .92em; border-left: 3px solid var(--warn); }
.old .tag { display: inline-block; font-family: var(--mono); font-size: var(--fs-xs); color: var(--warn); margin-right: var(--s2); }
.old.shown, .blk.open .old { display: block; }
.old :deep(p) { margin: 0; }
.old :deep(h1), .old :deep(h2), .old :deep(h3), .old :deep(h4) { font-size: 1em; margin: 0; font-weight: 600; }
/* 标记改动 */
.mode-marks .blk.changed, .mode-marks .blk.added { background: var(--info-bg); border-radius: var(--r-sm); }
.mode-marks .blk :deep(ins) { background: color-mix(in srgb, var(--info) 22%, transparent); border-bottom: 1px solid var(--info); }
/* 只看改动 */
.mode-changes .blk.same { display: none; }
.mode-changes .blk.changed, .mode-changes .blk.added, .mode-changes .blk.removed { background: var(--info-bg); border-radius: var(--r-sm); margin-bottom: var(--s3); padding-top: 4px; padding-bottom: 4px; }
.mode-changes .blk.changed .old { display: block; }
.mode-changes .blk :deep(ins) { background: color-mix(in srgb, var(--info) 22%, transparent); }
.ctx { display: none; color: var(--text-3); font-size: var(--fs-xs); margin: var(--s3) 0 var(--s1) 14px; }
.mode-changes .ctx { display: block; }
/* 并排 */
.mode-split .paper { max-width: none; padding-left: var(--s4); padding-right: var(--s4); }
.mode-split .blk.changed { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s4); background: var(--info-bg); border-radius: var(--r-sm); padding: var(--s2) var(--s2) var(--s2) 14px; margin-bottom: var(--s3); }
.mode-split .blk.changed .old { display: block; margin: 0; order: -1; }
.mode-split .blk.changed .new { order: 1; }
.mode-split .blk.changed .notes, .mode-split .blk.changed .annos, .mode-split .blk.changed .editor { grid-column: 1 / 3; }
.mode-split .blk :deep(ins) { background: color-mix(in srgb, var(--info) 22%, transparent); }
.blk.heavy .old :deep(del) { text-decoration: none; color: inherit; }
/* 段落工具 */
.ptools { position: absolute; right: -36px; top: 2px; display: none; gap: 2px; }
.blk:hover .ptools { display: flex; }
.ptools button { width: 26px; height: 26px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); color: var(--text-2); cursor: pointer; font-size: 13px; }
.ptools button:hover { background: var(--surface-3); color: var(--text); }
.blk.has-anno { border-right: 2px solid var(--chart-4); }
/* 边注 */
.notes { display: none; margin: 0 0 var(--s3); padding: var(--s2) var(--s3); border: 1px dashed var(--line-strong); border-radius: var(--r); background: var(--surface-2); font-size: .9em; }
.notes.open { display: block; }
.notes.global { margin-top: 0; }
.notes ul { margin: 0; padding-left: 1.2em; } .notes li { margin: 4px 0; }
.n-k { font-family: var(--mono); font-size: var(--fs-xs); padding: 0 5px; border-radius: 3px; margin-right: 6px; }
.n-fix { background: var(--bad-bg); color: var(--bad); } .n-conf { background: var(--warn-bg); color: var(--warn); }
.n-over { background: var(--info-bg); color: var(--chart-4); } .n-info { background: var(--info-bg); color: var(--info); } .n-now { background: var(--warn-bg); color: var(--warn); }
.n-layer { color: var(--text-3); font-family: var(--mono); font-size: var(--fs-xs); margin-left: 6px; }
/* 批注 */
.anno-card { position: relative; margin: var(--s1) 0 var(--s3); padding: var(--s2) var(--s3); background: var(--info-bg); border-left: 3px solid var(--chart-4); border-radius: 0 var(--r-sm) var(--r-sm) 0; font-size: .9em; }
.anno-card .who { color: var(--chart-4); font-family: var(--mono); font-size: var(--fs-xs); margin-right: var(--s2); }
.anno-card .del { position: absolute; right: 6px; top: 4px; border: 0; background: transparent; color: var(--text-3); cursor: pointer; font-size: 14px; }
.anno-card .del:hover { color: var(--bad); }
.anno-card textarea { width: 100%; border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--surface); color: var(--text); font: inherit; padding: var(--s2); resize: vertical; }
.anno-card .row { display: flex; gap: var(--s2); align-items: center; margin-top: var(--s2); flex-wrap: wrap; }
.lite { color: var(--text-3); font-size: var(--fs-xs); }
</style>
